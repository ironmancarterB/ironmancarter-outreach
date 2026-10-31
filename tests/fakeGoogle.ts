// An in-memory stand-in for Google's OAuth and Gmail draft endpoints. Records every request.
import { randomUUID } from 'node:crypto'

interface FakeDraft { id: string; messageId: string; threadId: string; raw: Buffer }

export function fakeGoogle(opts: { email?: string; scope?: string } = {}) {
  const state = {
    email: opts.email ?? 'ironmancarterbusiness@gmail.com',
    scope: opts.scope ?? 'https://www.googleapis.com/auth/gmail.compose',
    drafts: new Map<string, FakeDraft>(),
    requests: [] as { method: string; url: string }[],
    revoked: [] as string[],
    refreshInvalid: false,
    // Applies the next draft create at Google but loses the answer (as a timeout would).
    loseNextCreateResponse: false,
    failNextCreateWith: null as number | null,
  }
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const headerOf = (raw: Buffer, name: string) => raw.toString('latin1').split(/\r\n\r\n/)[0].split(/\r\n/).find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`))?.split(/:\s*/).slice(1).join(':') ?? null
  // Like real Gmail: drops any Message-ID the client set and assigns its own; everything else is kept.
  const store = (body: unknown) => {
    const raw = Buffer.from(body as Uint8Array).toString('latin1')
    const [head, ...rest] = raw.split('\r\n\r\n')
    const headers = head.split('\r\n').filter((l) => !/^message-id:/i.test(l))
    headers.push(`Message-Id: <${randomUUID()}@mail.gmail.com>`)
    return Buffer.from([headers.join('\r\n'), ...rest].join('\r\n\r\n'), 'latin1')
  }
  const draftJson = (d: FakeDraft, format: string) => ({
    id: d.id,
    message: {
      id: d.messageId, threadId: d.threadId, labelIds: ['DRAFT'],
      ...(format === 'raw' ? { raw: d.raw.toString('base64url') } : {}),
      ...(format === 'metadata' ? { payload: { headers: ['Message-ID', 'To', 'Subject', 'Content-Type'].map((n) => ({ name: n, value: headerOf(d.raw, n) })) } } : {}),
    },
  })

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
    if (path === '/profile') return json(200, { emailAddress: state.email, historyId: '1' })
    if (path === '/drafts' && method === 'POST') {
      if (state.failNextCreateWith) {
        const status = state.failNextCreateWith
        state.failNextCreateWith = null
        return json(status, { error: { message: 'Invalid To header', status: 'INVALID_ARGUMENT' } })
      }
      const d: FakeDraft = { id: `r-${randomUUID().slice(0, 8)}`, messageId: randomUUID().slice(0, 16), threadId: randomUUID().slice(0, 16), raw: store(body) }
      state.drafts.set(d.id, d)
      if (state.loseNextCreateResponse) {
        state.loseNextCreateResponse = false
        throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
      }
      return json(200, draftJson(d, 'minimal'))
    }
    if (path === '/drafts' && method === 'GET') {
      const to = (url.searchParams.get('q') ?? '').replace(/^to:/, '')
      const list = [...state.drafts.values()].filter((d) => !to || (headerOf(d.raw, 'To') ?? '').includes(to))
      return json(200, list.length ? { drafts: list.map((d) => ({ id: d.id, message: { id: d.messageId, threadId: d.threadId } })) } : {})
    }
    const m = path.match(/^\/drafts\/([^/?]+)$/)
    if (m) {
      const d = state.drafts.get(decodeURIComponent(m[1]))
      if (!d) return json(404, { error: { message: 'Requested entity was not found.', status: 'NOT_FOUND' } })
      if (method === 'PUT') {
        d.raw = store(body)
        d.messageId = randomUUID().slice(0, 16)
        return json(200, draftJson(d, 'minimal'))
      }
      return json(200, draftJson(d, url.searchParams.get('format') ?? 'full'))
    }
    return json(404, { error: { message: `Not handled: ${method} ${path}` } })
  }) as typeof fetch

  return {
    state,
    fetchImpl,
    // What you would do in Gmail yourself.
    editInGmail(draftId: string) { state.drafts.get(draftId)!.messageId = randomUUID().slice(0, 16) },
    deleteInGmail(draftId: string) { state.drafts.delete(draftId) },
  }
}
