// The sign-off on every outbound sponsorship email (Settings → Business → Email signature, default "Best,\nCarter").
// applySignature() removes whatever sign-off a body already ends with and adds the configured one once, so
// regenerating or editing can never stack two signatures. The compliance footer is added separately, below it.
import { getSetting, type DB } from '../db'

export const DEFAULT_SIGNATURE = 'Best,\nCarter'

export const getSignature = (db: DB) => normalizeSignature(getSetting<string>(db, 'business.signature'))

export const normalizeSignature = (s: string) => s.replace(/\r\n/g, '\n').split('\n').map((l) => l.trimEnd()).join('\n').trim()

const CLOSING = /^(best|best regards|best wishes|kind regards|regards|warm regards|warmly|thanks|thank you|many thanks|thanks so much|cheers|talk soon|sincerely|all the best)[,.!]?$/i
// Lines that belonged to earlier default sign-offs (creator name variants and the business email).
const OLD_SIGNOFF_LINE = /^(ironmancarter( outreach|ttv)?|carter|[\w.+-]+@[\w-]+(\.[\w-]+)+)$/i
const MAX_SIGNOFF_LINES = 6

// A trailing "P.S." paragraph belongs below the signature and is kept as written.
function splitPostscript(text: string) {
  const lines = text.split('\n')
  const at = lines.findLastIndex((l) => /^p\.?\s?s\.?\b/i.test(l.trim()))
  if (at <= 0 || lines.length - at > 8) return { main: text, ps: '' }
  return { main: lines.slice(0, at).join('\n').trimEnd(), ps: lines.slice(at).join('\n').trim() }
}

// Removes sign-off blocks from the end until none is left (so stacked duplicates all go).
function stripMain(text: string, signature?: string) {
  for (let guard = 0; guard < 10; guard++) {
    const next = stripOnce(text, signature)
    if (next === text) return text
    text = next
  }
  return text
}

function stripOnce(text: string, signature?: string) {
  if (signature) {
    while (text.endsWith(signature)) text = text.slice(0, -signature.length).trimEnd()
  }
  const lines = text.split('\n')
  // A closing line ("Best,", "Thanks,") within the last few lines starts the sign-off block, when only short
  // name-like lines (a name, a handle, an email) follow it.
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - MAX_SIGNOFF_LINES); i--) {
    if (CLOSING.test(lines[i].trim()) && lines.slice(i + 1).every((l) => !l.trim() || (l.trim().length <= 60 && !/[.!?]$/.test(l.trim()) || OLD_SIGNOFF_LINE.test(l.trim())))) {
      return lines.slice(0, i).join('\n').trimEnd()
    }
  }
  // Or a bare old sign-off ("IronmanCarter" / the business email) with no closing line.
  while (lines.length && (OLD_SIGNOFF_LINE.test(lines[lines.length - 1].trim()) || !lines[lines.length - 1].trim())) lines.pop()
  return lines.join('\n').trimEnd()
}

// The body without any sign-off (and without a trailing P.S.).
export const stripSignature = (body: string, signature?: string) => stripMain(splitPostscript(body.replace(/\r\n/g, '\n').trimEnd()).main, signature)

export function applySignature(body: string, signature: string) {
  const { main, ps } = splitPostscript(body.replace(/\r\n/g, '\n').trimEnd())
  return `${stripMain(main, signature)}\n\n${signature}${ps ? `\n\n${ps}` : ''}`
}

export const endsWithSignature = (body: string, signature: string) => splitPostscript(body.replace(/\r\n/g, '\n').trimEnd()).main.endsWith(signature)
