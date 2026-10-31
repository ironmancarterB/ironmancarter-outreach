// Builds the RFC 5322 message for a Gmail draft (plain-text body + PDF attachment), and parses a message
// read back from Gmail so the attachment can be checked byte for byte.
import { createHash, randomBytes } from 'node:crypto'

export interface OutgoingMessage {
  from: { name: string; email: string }
  to: string
  subject: string
  body: string
  // MIME boundary of the attachment message. Gmail replaces any Message-ID the app sets but keeps the boundary,
  // so the boundary carries the draft's unique reference (see boundaryFor).
  boundary?: string
  attachment?: { filename: string; mimeType: string; data: Buffer }
}

const isAscii = (s: string) => /^[\x20-\x7e]*$/.test(s)

// RFC 2047 encoded-word for non-ASCII header text, split so each line stays short.
export function encodeHeader(s: string): string {
  const clean = s.replace(/[\r\n]+/g, ' ')
  if (isAscii(clean)) return clean
  const words: string[] = []
  let chunk = ''
  for (const ch of clean) {
    if (Buffer.byteLength(chunk + ch, 'utf8') > 45) {
      words.push(chunk)
      chunk = ''
    }
    chunk += ch
  }
  if (chunk) words.push(chunk)
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ')
}

const base64Lines = (buf: Buffer) => buf.toString('base64').replace(/.{76}/g, '$&\r\n').replace(/\r\n$/, '')

const quotedName = (name: string) => (isAscii(name) ? `"${name.replace(/["\\]/g, '')}"` : encodeHeader(name))

const filenameParam = (name: string) =>
  isAscii(name) ? `filename="${name.replace(/["\\\r\n]/g, '')}"` : `filename*=UTF-8''${encodeURIComponent(name)}`

export const boundaryFor = (ref: string) => `=_ic_${ref.replace(/[^0-9a-z]/gi, '')}`

export const boundaryOf = (contentType: string | null | undefined) => param(contentType ?? undefined, 'boundary')

export function buildMessage(m: OutgoingMessage): Buffer {
  for (const v of [m.to, m.from.email]) if (/[\r\n]/.test(v)) throw new Error('Header values cannot contain line breaks')
  const headers = [
    `From: ${quotedName(m.from.name)} <${m.from.email}>`,
    `To: ${m.to}`,
    `Subject: ${encodeHeader(m.subject)}`,
    'MIME-Version: 1.0',
  ]
  const text = Buffer.from(m.body.replace(/\r?\n/g, '\r\n'), 'utf8')
  if (!m.attachment) {
    return Buffer.from([...headers, 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', base64Lines(text), ''].join('\r\n'))
  }
  const boundary = m.boundary ?? `=_ic_${randomBytes(12).toString('hex')}`
  const a = m.attachment
  return Buffer.from([
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(text),
    `--${boundary}`,
    `Content-Type: ${a.mimeType}; name="${a.filename.replace(/["\\\r\n]/g, '')}"`,
    `Content-Disposition: attachment; ${filenameParam(a.filename)}`,
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(a.data),
    `--${boundary}--`,
    '',
  ].join('\r\n'))
}

// ---------- Parsing (for verification) ----------

export interface ParsedPart {
  headers: Record<string, string>
  contentType: string
  filename: string | null
  data: Buffer
}

function splitHeaders(raw: string): { headers: Record<string, string>; body: string } {
  const idx = raw.search(/\r?\n\r?\n/)
  const head = idx < 0 ? raw : raw.slice(0, idx)
  const body = idx < 0 ? '' : raw.slice(idx).replace(/^\r?\n\r?\n/, '')
  const headers: Record<string, string> = {}
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const m = line.match(/^([^:]+):\s*(.*)$/)
    if (m) headers[m[1].toLowerCase()] = m[2]
  }
  return { headers, body }
}

const param = (header: string | undefined, name: string) => {
  if (!header) return null
  const star = header.match(new RegExp(`${name}\\*=(?:UTF-8|utf-8)''([^;]+)`))
  if (star) return decodeURIComponent(star[1])
  const m = header.match(new RegExp(`${name}="?([^";]+)"?`, 'i'))
  return m ? decodeHeader(m[1].trim()) : null
}

export function decodeHeader(s: string): string {
  return s.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=(\s+(?==\?))?/g, (_all, _cs, enc: string, text: string) =>
    enc.toUpperCase() === 'B'
      ? Buffer.from(text, 'base64').toString('utf8')
      : Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8'))
}

function decodeBody(body: string, encoding: string | undefined): Buffer {
  const enc = (encoding ?? '7bit').toLowerCase()
  if (enc === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64')
  if (enc === 'quoted-printable') {
    return Buffer.from(body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1')
  }
  return Buffer.from(body, 'latin1')
}

// Raw message (as text in latin1 so bytes survive) → top-level headers and every leaf part.
export function parseMessage(raw: Buffer): { headers: Record<string, string>; parts: ParsedPart[] } {
  const { headers, body } = splitHeaders(raw.toString('latin1'))
  const parts: ParsedPart[] = []
  const walk = (h: Record<string, string>, b: string) => {
    const ct = h['content-type'] ?? 'text/plain'
    const boundary = param(ct, 'boundary')
    if (/^multipart\//i.test(ct) && boundary) {
      const sections = b.split(`--${boundary}`)
      for (const section of sections.slice(1)) {
        if (section.startsWith('--')) break
        const sub = splitHeaders(section.replace(/^\r?\n/, ''))
        walk(sub.headers, sub.body.replace(/\r?\n$/, ''))
      }
      return
    }
    parts.push({
      headers: h,
      contentType: ct.split(';')[0].trim().toLowerCase(),
      filename: param(h['content-disposition'], 'filename') ?? param(ct, 'name'),
      data: decodeBody(b, h['content-transfer-encoding']),
    })
  }
  walk(headers, body)
  return { headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, decodeHeader(v)])), parts }
}

export const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')
