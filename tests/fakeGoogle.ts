// An in-memory stand-in for Google's OAuth and Gmail endpoints, modelled on Gmail's real behaviour:
// it replaces client Message-IDs, removes a draft when it is sent, puts the sent message in the draft's
// thread with the SENT label, and supports thread/message reads and simple searches. Records every request.
import { randomUUID } from 'node:crypto'
import { parseMessage } from '../packages/gmail/mime'

interface FakeMessage { id: string; threadId: string; labelIds: string[]; raw: Buffer; internalDate: number }
interface FakeDraft { id: string; messageId: string }

const COMPOSE = 'https://www.googleapis.com/auth/gmail.compose'
const READONLY = 'https://www.googleapis.com/auth/gmail.readonly'

export function fakeGoogle(opts: { email?: string; scope?: string } = {}) {
  const state = {
    email: opts.email ?? 'ironmancarterbusiness@gmail.com',
    scope: opts.scope ?? `${COMPOSE} ${READONLY}`,
    drafts: new Map<string, FakeDraft>(),
    messages: new Map<string, FakeMessage>(),
    requests: [] as { method: string; url: string }[],
    revoked: [] as string[],
    refreshInvalid: false,
    clock: Date.now(),
    // Applies the next draft create at Google but loses the answer (as a timeout would).
    loseNextCreateResponse: false,
    failNextCreateWith: null as number | null,
    // Sends the draft but loses the answer.
    loseNextSendResponse: false,
    // Loses the answer without sending.
    dropNextSendRequest: false,
    failNextSendWith: null as number | null,
  }
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const headBlock = (raw: Buffer) => raw.toString('latin1').split(/\r\n\r\n/)[0].replace(/\r\n[ \t]+/g, ' ').split(/\r\n/)
  const headerOf = (raw: Buffer, name: string) => headBlock(raw).find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`))?.split(/:\s*/).slice(1).join(':') ?? null
  const id16 = () => randomUUID().replace(/-/g, '').slice(0, 16)

  // Like real Gmail: drops any Message-ID the client set and assigns its own; everything else is kept.
  const store = (raw: Buffer) => {
    const [head, ...rest] = raw.toString('latin1').split('\r\n\r\n')
    const headers = head.split('\r\n').filter((l) => !/^message-id:/i.test(l))
    headers.push(`Message-Id: <${randomUUID()}@mail.gmail.com>`)
    return Buffer.from([headers.join('\r\n'), ...rest].join('\r\n\r\n'), 'latin1')
  }
  const tick = () => (state.clock += 1000)

  const payloadOf = (m: FakeMessage, format: string) => {
    const headers = headBlock(m.raw).map((l) => ({ name: l.split(':')[0], value: l.split(/:\s*/).slice(1).join(':') }))
    if (format !== 'full') return { headers }
    const parsed = parseMessage(m.raw)
    const part = (p: (typeof parsed.parts)[number]) => ({ mimeType: p.contentType, filename: p.filename ?? '', body: { data: p.data.toString('base64url'), size: p.data.length } })
    return parsed.parts.length === 1 ? { headers, ...part(parsed.parts[0]) } : { headers, mimeType: 'multipart/mixed', parts: parsed.parts.map(part) }
  }
  const messageJson = (m: FakeMessage, format: string) => ({
    id: m.id, threadId: m.threadId, labelIds: m.labelIds, internalDate: String(m.internalDate), snippet: '',
    ...(format === 'raw' ? { raw: m.raw.toString('base64url') } : format === 'minimal' ? {} : { payload: payloadOf(m, format) }),
  })
  const draftJson = (d: FakeDraft, format: string) => {
    const m = state.messages.get(d.messageId)!
    if (format === 'metadata') {
      return { id: d.id, message: { id: m.id, threadId: m.threadId, labelIds: m.labelIds, payload: { headers: ['Message-ID', 'To', 'Subject', 'Content-Type'].map((n) => ({ name: n, value: headerOf(m.raw, n) })) } } }
    }
    return { id: d.id, message: { id: m.id, threadId: m.threadId, labelIds: m.labelIds, ...(format === 'raw' ? { raw: m.raw.toString('base64url') } : {}) } }
  }
  const newDraft = (raw: Buffer, threadId?: string) => {
    const m: FakeMessage = { id: id16(), threadId: threadId ?? id16(), labelIds: ['DRAFT'], raw: store(raw), internalDate: tick() }
    state.messages.set(m.id, m)
    const d: FakeDraft = { id: `r-${id16()}`, messageId: m.id }
    state.drafts.set(d.id, d)
    return d
  }
  const matches = (m: FakeMessage, q: string) => {
    for (const tok of q.split(/\s+(?=\w+:)/)) {
      const [k, ...v] = tok.split(':')
      const val = v.join(':').replace(/^"|"$/g, '')
      if (k === 'from' && !(headerOf(m.raw, 'From') ?? '').toLowerCase().includes(val.toLowerCase())) return false
      if (k === 'to' && !(headerOf(m.raw, 'To') ?? '').toLowerCase().includes(val.toLowerCase())) return false
      if (k === 'in' && val === 'sent' && !m.labelIds.includes('SENT')) return false
      if (k === 'after' && m.internalDate < Number(val) * 1000) return false
      if (k === 'subject' && !(headerOf(m.raw, 'Subject') ?? '').includes(val)) return false
    }
    return true
  }

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    state.requests.push({ method, url: url.toString() })
    const body = init?.body
    if (url.href.startsWith('https://oauth2.googleapis.com/token')) {
      const p = new URLSearchParams(String(body))
      if (p.get('grant_type') === 'refresh_token' && state.refreshInvalid) return json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' })
      return json(200, { access_token: `at-${randomUUID()}`, expires_in: 3599, scope: state.scope, token_type: 'Bearer', ...(p.get('grant_type') === 'authorization_code' ? { refresh_token: 'rt-secret' } : {}) })
    }
    if (url.href.startsWith('https://oauth2.googleapis.com/revoke')) {
      state.revoked.push(new URLSearchParams(String(body)).get('token') ?? '')
      return json(200, {})
    }
    if (!url.host.endsWith('gmail.googleapis.com')) return json(404, { error: { message: 'unknown host' } })
    const path = url.pathname.replace(/^\/(upload\/)?gmail\/v1\/users\/me/, '')
    const readOnly = ['/messages', '/threads'].some((x) => path.startsWith(x))
    if (readOnly && !state.scope.includes(READONLY)) return json(403, { error: { message: 'Request had insufficient authentication scopes.', status: 'PERMISSION_DENIED' } })
    const format = url.searchParams.get('format') ?? 'full'

    if (path === '/profile') return json(200, { emailAddress: state.email, historyId: '1' })
    if (path === '/drafts/send' && method === 'POST') {
      if (state.dropNextSendRequest) {
        state.dropNextSendRequest = false
        throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
      }
      if (state.failNextSendWith) {
        const status = state.failNextSendWith
        state.failNextSendWith = null
        return json(status, { error: { message: 'Invalid recipient', status: 'INVALID_ARGUMENT' } })
      }
      const { id } = JSON.parse(String(body)) as { id: string }
      const d = state.drafts.get(id)
      if (!d) return json(404, { error: { message: 'Requested entity was not found.', status: 'NOT_FOUND' } })
      state.drafts.delete(id)
      const old = state.messages.get(d.messageId)!
      state.messages.delete(d.messageId)
      const sent: FakeMessage = { ...old, id: id16(), labelIds: ['SENT'], internalDate: tick() }
      state.messages.set(sent.id, sent)
      if (state.loseNextSendResponse) {
        state.loseNextSendResponse = false
        throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
      }
      return json(200, messageJson(sent, 'minimal'))
    }
    if (path === '/drafts' && method === 'POST') {
      if (state.failNextCreateWith) {
        const status = state.failNextCreateWith
        state.failNextCreateWith = null
        return json(status, { error: { message: 'Invalid To header', status: 'INVALID_ARGUMENT' } })
      }
      const isJson = (init?.headers as Record<string, string>)['content-type'] === 'application/json'
      const d = isJson
        ? (() => { const b = JSON.parse(String(body)) as { message: { raw: string; threadId?: string } }; return newDraft(Buffer.from(b.message.raw, 'base64url'), b.message.threadId) })()
        : newDraft(Buffer.from(body as Uint8Array))
      if (state.loseNextCreateResponse) {
        state.loseNextCreateResponse = false
        throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
      }
      return json(200, draftJson(d, 'minimal'))
    }
    if (path === '/drafts' && method === 'GET') {
      const q = url.searchParams.get('q') ?? ''
      const list = [...state.drafts.values()].filter((d) => matches(state.messages.get(d.messageId)!, q))
      return json(200, list.length ? { drafts: list.map((d) => ({ id: d.id, message: { id: d.messageId, threadId: state.messages.get(d.messageId)!.threadId } })) } : {})
    }
    const dm = path.match(/^\/drafts\/([^/?]+)$/)
    if (dm) {
      const d = state.drafts.get(decodeURIComponent(dm[1]))
      if (!d) return json(404, { error: { message: 'Requested entity was not found.', status: 'NOT_FOUND' } })
      if (method === 'PUT') {
        const isJson = (init?.headers as Record<string, string>)['content-type'] === 'application/json'
        const raw = isJson ? Buffer.from((JSON.parse(String(body)) as { message: { raw: string } }).message.raw, 'base64url') : Buffer.from(body as Uint8Array)
        const old = state.messages.get(d.messageId)!
        state.messages.delete(d.messageId)
        const m: FakeMessage = { id: id16(), threadId: old.threadId, labelIds: ['DRAFT'], raw: store(raw), internalDate: tick() }
        state.messages.set(m.id, m)
        d.messageId = m.id
        return json(200, draftJson(d, 'minimal'))
      }
      return json(200, draftJson(d, format))
    }
    const tm = path.match(/^\/threads\/([^/?]+)$/)
    if (tm) {
      const msgs = [...state.messages.values()].filter((m) => m.threadId === decodeURIComponent(tm[1])).sort((a, b) => a.internalDate - b.internalDate)
      if (!msgs.length) return json(404, { error: { message: 'Requested entity was not found.', status: 'NOT_FOUND' } })
      return json(200, { id: tm[1], messages: msgs.map((m) => messageJson(m, format)) })
    }
    if (path === '/messages' && method === 'GET') {
      const q = url.searchParams.get('q') ?? ''
      const list = [...state.messages.values()].filter((m) => !m.labelIds.includes('DRAFT') && matches(m, q))
      return json(200, list.length ? { messages: list.map((m) => ({ id: m.id, threadId: m.threadId })) } : {})
    }
    const mm = path.match(/^\/messages\/([^/?]+)$/)
    if (mm) {
      const m = state.messages.get(decodeURIComponent(mm[1]))
      if (!m) return json(404, { error: { message: 'Requested entity was not found.', status: 'NOT_FOUND' } })
      return json(200, messageJson(m, format))
    }
    return json(404, { error: { message: `Not handled: ${method} ${path}` } })
  }) as typeof fetch

  const sentRequests = () => state.requests.filter((r) => r.method === 'POST' && new URL(r.url).pathname.endsWith('/drafts/send'))

  return {
    state,
    fetchImpl,
    sentRequests,
    draftRaw: (draftId: string) => state.messages.get(state.drafts.get(draftId)!.messageId)!.raw,
    sentMessages: () => [...state.messages.values()].filter((m) => m.labelIds.includes('SENT')),
    // What you (or a brand) would do in Gmail.
    editInGmail(draftId: string) {
      const d = state.drafts.get(draftId)!
      const m = state.messages.get(d.messageId)!
      state.messages.delete(m.id)
      const copy = { ...m, id: id16() }
      state.messages.set(copy.id, copy)
      d.messageId = copy.id
    },
    deleteInGmail(draftId: string) {
      const d = state.drafts.get(draftId)
      if (d) state.messages.delete(d.messageId)
      state.drafts.delete(draftId)
    },
    sendFromGmail(draftId: string) {
      const d = state.drafts.get(draftId)!
      state.drafts.delete(draftId)
      const m = state.messages.get(d.messageId)!
      state.messages.delete(m.id)
      const sent = { ...m, id: id16(), labelIds: ['SENT'], internalDate: tick() }
      state.messages.set(sent.id, sent)
      return sent
    },
    // An incoming message; threadId omitted = a new thread.
    receive(o: { from: string; text: string; subject?: string; threadId?: string; headers?: Record<string, string> }) {
      const extra = Object.entries(o.headers ?? {}).map(([k, v]) => `${k}: ${v}`)
      const raw = Buffer.from([`From: ${o.from}`, `To: ${state.email}`, `Subject: ${o.subject ?? 'Re: hello'}`, `Message-Id: <${randomUUID()}@brand.test>`, ...extra,
        'Content-Type: text/plain; charset="UTF-8"', '', o.text].join('\r\n'), 'utf8')
      const m: FakeMessage = { id: id16(), threadId: o.threadId ?? id16(), labelIds: ['INBOX'], raw, internalDate: tick() }
      state.messages.set(m.id, m)
      return m
    },
  }
}
