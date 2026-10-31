import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../apps/server/src/app'
import { all, get, run, type DB } from '../packages/db'
import { addContact, createProspect, reviewProspect } from '../packages/crm/prospects'
import { importMediaKit } from '../packages/mediakit/store'
import { approvePitch, generatePitch, updatePitch } from '../packages/pitch/service'
import { forgetAccessTokens } from '../packages/gmail/account'
import { GoogleApi, GoogleError } from '../packages/gmail/google'
import { boundaryFor, boundaryOf, buildMessage, parseMessage, sha256 } from '../packages/gmail/mime'
import { memoryStore } from '../packages/gmail/secrets'
import { fakeGoogle } from './fakeGoogle'
import { fakePdf, freshDb, tempDir } from './helpers'

const H = { host: '127.0.0.1:5181', 'x-outreach-client': 'dashboard' }
const CLIENT = { client_id: '1234567890-abc.apps.googleusercontent.com', client_secret: 'GOCSPX-test-secret-value' }

let db: DB
let app: FastifyInstance
let google: ReturnType<typeof fakeGoogle>
let secrets: ReturnType<typeof memoryStore>
let cleanup: () => void
let kitPdf: Buffer

async function boot() {
  app = await buildApp({ db, dataDir: dir, gmail: { api: new GoogleApi(google.fetchImpl), secrets, redirectUri: 'http://127.0.0.1:5181/api/gmail/oauth/callback' } })
}
let dir: string

beforeEach(async () => {
  const t = tempDir()
  dir = t.dir
  cleanup = t.cleanup
  db = freshDb()
  kitPdf = fakePdf('media kit')
  importMediaKit(db, dir, { buffer: kitPdf, originalFilename: 'Content Media Kit Final (corrected email).pdf' })
  google = fakeGoogle()
  secrets = memoryStore()
  await boot()
})
afterEach(async () => {
  await app.close()
  cleanup()
})

const req = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: H, ...(payload !== undefined ? { payload: payload as object } : {}) })

async function connect(query: Record<string, string> = {}) {
  await req('PUT', '/api/gmail/client', CLIENT)
  const start = (await req('POST', '/api/gmail/connect', {})).json()
  const state = new URL(start.url).searchParams.get('state')!
  const qs = new URLSearchParams({ state, code: 'auth-code', scope: google.state.scope, ...query })
  return app.inject({ method: 'GET', url: `/api/gmail/oauth/callback?${qs}`, headers: { host: '127.0.0.1:5181' } })
}

async function approvedPitch(name = 'Brand A', domain = 'brand-a.test') {
  const p = createProspect(db, { company_name: name, website: `https://${domain}`, category_id: 1, products: 'Gaming mice' })
  run(db, 'INSERT INTO research_sources (prospect_id, url, title, kind, retrieved_at, snippet) VALUES (?, ?, ?, ?, ?, ?)',
    p.id, `https://${domain}/creators`, 'Creator program', 'sponsorship_evidence', '2026-10-30T12:00:00.000Z', `Join the ${name} Creator Program.`)
  addContact(db, p.id, { email: `partnerships@${domain}`, source_url: `https://${domain}/creators`, verification_status: 'verified', jurisdiction: 'US', is_primary: true, discovered_by: 'research' })
  reviewProspect(db, p.id, 'approved')
  const pitch = await generatePitch(db, p.id, { channel: 'email' })
  return { prospect: p, pitch: approvePitch(db, pitch.id) }
}

const createDraft = (pitchId: number) => req('POST', `/api/pitches/${pitchId}/gmail-draft`, { confirm: true })
const creates = () => google.state.requests.filter((r) => r.method === 'POST' && r.url.includes('/drafts'))

describe('MIME message', () => {
  it('round-trips the body, an encoded subject and the PDF byte for byte', () => {
    const raw = buildMessage({
      from: { name: 'IronmanCarter', email: 'me@gmail.com' }, to: 'partners@brand.test', subject: 'Brand × IronmanCarter — a Shorts idea',
      body: 'Hi team,\n\nLine two.\n\nBest,\nIronmanCarter', boundary: boundaryFor('1234-abcd'),
      attachment: { filename: 'Kit.pdf', mimeType: 'application/pdf', data: kitPdf },
    })
    const parsed = parseMessage(raw)
    expect(parsed.headers.subject).toBe('Brand × IronmanCarter — a Shorts idea')
    expect(boundaryOf(parsed.headers['content-type'])).toBe('=_ic_1234abcd')
    const pdf = parsed.parts.find((p) => p.filename === 'Kit.pdf')!
    expect(sha256(pdf.data)).toBe(sha256(kitPdf))
    expect(parsed.parts.find((p) => p.contentType === 'text/plain')!.data.toString('utf8')).toBe('Hi team,\r\n\r\nLine two.\r\n\r\nBest,\r\nIronmanCarter')
  })

  it('refuses header injection', () => {
    expect(() => buildMessage({ from: { name: 'x', email: 'me@gmail.com' }, to: 'a@b.test\r\nBcc: c@d.test', subject: 's', body: 'b' })).toThrow(/line breaks/)
  })
})

describe('Google client safety', () => {
  it('refuses any Gmail send endpoint', async () => {
    const api = new GoogleApi(google.fetchImpl) as unknown as { request: (u: string, i: RequestInit) => Promise<Response> }
    await expect(api.request('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST' })).rejects.toThrow(/never sends/)
    await expect(api.request('https://gmail.googleapis.com/gmail/v1/users/me/drafts/send', { method: 'POST' })).rejects.toThrow(/never sends/)
    expect(google.state.requests).toHaveLength(0)
  })

  it('classifies a timeout as unknown and a 400 as a definite refusal', async () => {
    const api = new GoogleApi((async () => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }) }) as unknown as typeof fetch)
    await expect(api.profile('t')).rejects.toMatchObject({ outcome: 'unknown' })
    google.state.failNextCreateWith = 400
    await expect(new GoogleApi(google.fetchImpl).createDraft('t', Buffer.from('x'))).rejects.toBeInstanceOf(GoogleError)
  })
})

describe('connecting Gmail (OAuth)', () => {
  it('requests only the drafts scope with PKCE and the expected account as a hint', async () => {
    expect((await req('POST', '/api/gmail/connect', {})).statusCode).toBe(409)
    expect((await req('PUT', '/api/gmail/client', { json: JSON.stringify({ web: CLIENT }) })).json().error.message).toMatch(/Desktop app/)
    expect((await req('PUT', '/api/gmail/client', { json: JSON.stringify({ installed: CLIENT }) })).statusCode).toBe(200)
    const { url } = (await req('POST', '/api/gmail/connect', {})).json()
    const u = new URL(url)
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(u.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/gmail.compose')
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
    expect(u.searchParams.get('login_hint')).toBe('ironmancarterbusiness@gmail.com')
    expect(u.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:5181/api/gmail/oauth/callback')
  })

  it('connects, keeping tokens out of the database', async () => {
    const r = await connect()
    expect(r.statusCode).toBe(200)
    expect(r.body).toContain('Connected ironmancarterbusiness@gmail.com')
    const s = (await req('GET', '/api/gmail/status')).json()
    expect(s.account).toMatchObject({ email: 'ironmancarterbusiness@gmail.com', status: 'connected', scopes: ['https://www.googleapis.com/auth/gmail.compose'] })
    expect(s.sendingEnabled).toBe(false)
    expect(secrets.values.get('gmail-refresh-token:ironmancarterbusiness@gmail.com')).toBe('rt-secret')
    const dump = JSON.stringify(all(db, 'SELECT * FROM mail_accounts')) + JSON.stringify(all(db, 'SELECT * FROM gmail_operations')) + JSON.stringify(all(db, 'SELECT * FROM activities'))
    expect(dump).not.toContain('rt-secret')
    expect(dump).not.toContain(CLIENT.client_secret)
  })

  it('refuses a different Google account and revokes its access', async () => {
    google.state.email = 'someone.else@gmail.com'
    const r = await connect()
    expect(r.statusCode).toBe(409)
    expect(r.body).toContain('only accepts ironmancarterbusiness@gmail.com')
    expect(google.state.revoked).toEqual(['rt-secret'])
    expect(get(db, 'SELECT 1 FROM mail_accounts')).toBeUndefined()
    expect(secrets.values.size).toBe(1) // only the OAuth client
  })

  it('refuses a connection without the drafts permission, or with extra permissions', async () => {
    google.state.scope = 'openid'
    expect((await connect()).body).toContain('was not granted')
    google.state.scope = 'https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/gmail.readonly'
    expect((await connect()).body).toContain('did not ask for')
    expect(get(db, 'SELECT 1 FROM mail_accounts')).toBeUndefined()
  })

  it('rejects reused or forged state values and a declined consent', async () => {
    await req('PUT', '/api/gmail/client', CLIENT)
    const forged = await app.inject({ url: '/api/gmail/oauth/callback?state=forged&code=x', headers: { host: '127.0.0.1:5181' } })
    expect(forged.statusCode).toBe(400)
    const { url } = (await req('POST', '/api/gmail/connect', {})).json()
    const state = new URL(url).searchParams.get('state')!
    const declined = await app.inject({ url: `/api/gmail/oauth/callback?state=${state}&error=access_denied`, headers: { host: '127.0.0.1:5181' } })
    expect(declined.body).toContain('You declined access')
    const reused = await app.inject({ url: `/api/gmail/oauth/callback?state=${state}&code=x`, headers: { host: '127.0.0.1:5181' } })
    expect(reused.statusCode).toBe(400)
  })

  it('locks the sending account while connected, and disconnecting revokes and deletes the token', async () => {
    await connect()
    expect((await req('PATCH', '/api/settings', { 'gmail.expectedAccount': 'new@brand-domain.test' })).statusCode).toBe(409)
    expect((await req('POST', '/api/gmail/disconnect', {})).statusCode).toBe(400)
    expect((await req('POST', '/api/gmail/disconnect', { confirm: true })).json().revoked).toMatch(/revoked/)
    expect(secrets.values.has('gmail-refresh-token:ironmancarterbusiness@gmail.com')).toBe(false)
    expect((await req('PATCH', '/api/settings', { 'gmail.expectedAccount': 'new@brand-domain.test' })).statusCode).toBe(200)
  })

  it('asks you to reconnect when Google expires the refresh token', async () => {
    await connect()
    const { pitch } = await approvedPitch()
    google.state.refreshInvalid = true
    forgetAccessTokens()
    const r = await createDraft(pitch.id)
    expect(r.json().error.code).toBe('needs_reconnect')
    expect(get(db, 'SELECT status FROM mail_accounts')).toEqual({ status: 'needs_reconnect' })
    expect(creates()).toHaveLength(0)
  })
})

describe('Gmail drafts from approved pitches', () => {
  it('only approved email pitches can become drafts, and only with confirmation', async () => {
    await connect()
    const { pitch } = await approvedPitch()
    expect((await req('POST', `/api/pitches/${pitch.id}/gmail-draft`, {})).statusCode).toBe(400)
    updatePitch(db, pitch.id, { subject: 'Brand A x IronmanCarter: League Shorts' }) // edit withdraws approval
    expect((await createDraft(pitch.id)).json().error.code).toBe('not_approved')
    expect(creates()).toHaveLength(0)
  })

  it('creates the draft with recipient, subject, body and the default media kit, then verifies it from Gmail', async () => {
    await connect()
    const { pitch, prospect } = await approvedPitch()
    const r = await createDraft(pitch.id)
    expect(r.statusCode).toBe(201)
    const g = r.json().gmail
    expect(g.draft).toMatchObject({ status: 'created', recipient: 'partnerships@brand-a.test', subject: pitch.subject, outOfDate: false })
    expect(g.draft.openUrl).toMatch(/^https:\/\/mail\.google\.com\/mail\/u\/\?authuser=ironmancarterbusiness%40gmail\.com#drafts\?compose=/)
    expect(g.draft.verification.ok).toBe(true)
    expect(g.draft.verification.checks.map((c: { label: string }) => c.label)).toContain('Body matches what the app wrote')
    expect(r.json().attachment.gmailAttachmentVerified).toBe(true)

    const stored = [...google.state.drafts.values()][0]
    const parsed = parseMessage(stored.raw)
    expect(parsed.headers.from).toBe('"IronmanCarter" <ironmancarterbusiness@gmail.com>')
    expect(parsed.headers.to).toBe('partnerships@brand-a.test')
    expect(sha256(parsed.parts.find((p) => p.contentType === 'application/pdf')!.data)).toBe(sha256(kitPdf))
    // Gmail assigns its own Message-ID; the app records that one for matching replies later.
    expect(get(db, 'SELECT rfc822_message_id AS m FROM gmail_drafts')).toEqual({ m: parsed.headers['message-id'] })
    expect(get(db, 'SELECT rfc822_message_id AS m FROM email_messages')).toEqual({ m: parsed.headers['message-id'] })

    // Conversation tracking groundwork and the audit trail.
    expect(get(db, 'SELECT prospect_id, status FROM email_threads')).toEqual({ prospect_id: prospect.id, status: 'draft' })
    expect(get(db, 'SELECT direction, kind FROM email_messages')).toEqual({ direction: 'outbound', kind: 'draft' })
    expect(all<{ operation: string; status: string }>(db, 'SELECT operation, status FROM gmail_operations ORDER BY id').map((o) => `${o.operation}:${o.status}`))
      .toEqual(['connect:ok', 'create_draft:ok', 'get_draft:ok'])
    expect(get<{ summary: string }>(db, "SELECT summary FROM activities WHERE type = 'gmail.draft_created'")!.summary).toMatch(/Nothing was sent/)
  })

  it('never creates a duplicate draft for the same pitch or company', async () => {
    await connect()
    const { pitch, prospect } = await approvedPitch()
    await createDraft(pitch.id)
    expect((await createDraft(pitch.id)).json().error.code).toBe('duplicate')
    // A regenerated, re-approved pitch for the same company must update the existing draft instead.
    const v2 = await generatePitch(db, prospect.id, { channel: 'email' })
    approvePitch(db, v2.id)
    expect((await createDraft(v2.id)).json().error.code).toBe('duplicate')
    const view = (await req('GET', `/api/pitches/${v2.id}`)).json()
    expect(view.gmail.draft.status).toBe('created')
    expect(creates()).toHaveLength(1)
    expect(google.state.drafts.size).toBe(1)
  })

  it('marks a lost response as uncertain, never retries, and finds the draft by its MIME boundary', async () => {
    await connect()
    const { pitch } = await approvedPitch()
    google.state.loseNextCreateResponse = true
    const r = await createDraft(pitch.id)
    expect(r.statusCode).toBe(504)
    expect(r.json().error.message).toMatch(/not retried/)
    expect(creates()).toHaveLength(1)
    expect((await createDraft(pitch.id)).json().error.code).toBe('duplicate')
    expect(creates()).toHaveLength(1)
    const row = get<{ id: number; status: string }>(db, 'SELECT id, status FROM gmail_drafts')!
    expect(row.status).toBe('uncertain')
    const check = (await req('POST', `/api/gmail/drafts/${row.id}/check`, {})).json()
    expect(check.found).toBe(true)
    expect(check.row.status).toBe('created')
    expect(google.state.drafts.size).toBe(1)
  })

  it('lets you mark an uncertain draft as not created only after checking Gmail', async () => {
    await connect()
    const { pitch } = await approvedPitch()
    google.state.loseNextCreateResponse = true
    await createDraft(pitch.id)
    google.deleteInGmail([...google.state.drafts.keys()][0]) // as if Google never kept it
    const row = get<{ id: number }>(db, 'SELECT id FROM gmail_drafts')!
    expect((await req('POST', `/api/gmail/drafts/${row.id}/not-created`, { confirm: true })).json().error.code).toBe('check_first')
    expect((await req('POST', `/api/gmail/drafts/${row.id}/check`, {})).json().found).toBe(false)
    expect((await req('POST', `/api/gmail/drafts/${row.id}/not-created`, { confirm: true })).json().status).toBe('failed')
    expect((await createDraft(pitch.id)).statusCode).toBe(201)
  })

  it('frees the slot when Google definitely refused the request', async () => {
    await connect()
    const { pitch } = await approvedPitch()
    google.state.failNextCreateWith = 400
    expect((await createDraft(pitch.id)).json().error.code).toBe('google')
    expect(get(db, 'SELECT status FROM gmail_drafts')).toEqual({ status: 'failed' })
    expect((await createDraft(pitch.id)).statusCode).toBe(201)
  })

  it('treats a draft left "creating" by a crash as uncertain on restart', async () => {
    await connect()
    const { pitch, prospect } = await approvedPitch()
    const accountId = get<{ id: number }>(db, 'SELECT id FROM mail_accounts')!.id
    run(db, `INSERT INTO gmail_drafts (kind, pitch_id, prospect_id, account_id, status, local_ref, rfc822_message_id, recipient, subject, content_sha256, created_at, updated_at)
      VALUES ('pitch', ?, ?, ?, 'creating', 'ref', '<ref@gmail.com>', 'partnerships@brand-a.test', 's', 'h', 'now', 'now')`, pitch.id, prospect.id, accountId)
    await app.close()
    await boot()
    expect(get(db, 'SELECT status FROM gmail_drafts')).toEqual({ status: 'uncertain' })
    expect((await createDraft(pitch.id)).json().error.code).toBe('duplicate')
    expect(creates()).toHaveLength(0)
  })

  it('syncs: notices drafts changed or removed in Gmail', async () => {
    await connect()
    const a = await approvedPitch('Brand A', 'brand-a.test')
    const b = await approvedPitch('Brand B', 'brand-b.test')
    await createDraft(a.pitch.id)
    await createDraft(b.pitch.id)
    const [da, dbb] = all<{ gmail_draft_id: string }>(db, 'SELECT gmail_draft_id FROM gmail_drafts ORDER BY id').map((r) => r.gmail_draft_id)
    google.editInGmail(da)
    google.deleteInGmail(dbb)
    expect((await req('POST', '/api/gmail/sync', {})).json()).toEqual({ checked: 2, gone: 1, edited: 1, errors: 0 })
    const ga = (await req('GET', `/api/pitches/${a.pitch.id}`)).json().gmail.draft
    expect(ga.editedInGmail).toBe(true)
    expect((await req('GET', `/api/pitches/${b.pitch.id}`)).json().gmail.draft.status).toBe('gone')
    // Updating a draft you changed in Gmail needs your explicit go-ahead.
    expect((await req('PUT', `/api/pitches/${a.pitch.id}/gmail-draft`, { confirm: true })).json().error.code).toBe('edited_in_gmail')
    expect((await req('PUT', `/api/pitches/${a.pitch.id}/gmail-draft`, { confirm: true, overwriteGmailEdits: true })).statusCode).toBe(200)
    // The removed one can be created again.
    expect((await createDraft(b.pitch.id)).statusCode).toBe(201)
  })

  it('updates the same Gmail draft after the pitch is edited and re-approved', async () => {
    await connect()
    const { pitch } = await approvedPitch()
    await createDraft(pitch.id)
    const draftId = get<{ gmail_draft_id: string }>(db, 'SELECT gmail_draft_id FROM gmail_drafts')!.gmail_draft_id
    updatePitch(db, pitch.id, { subject: 'Brand A x IronmanCarter: League Shorts' })
    approvePitch(db, pitch.id)
    expect((await req('GET', `/api/pitches/${pitch.id}`)).json().gmail.draft.outOfDate).toBe(true)
    const r = await req('PUT', `/api/pitches/${pitch.id}/gmail-draft`, { confirm: true })
    expect(r.json().gmail.draft).toMatchObject({ outOfDate: false, subject: 'Brand A x IronmanCarter: League Shorts' })
    expect(r.json().gmail.draft.verification.ok).toBe(true)
    expect([...google.state.drafts.keys()]).toEqual([draftId])
    expect(parseMessage(google.state.drafts.get(draftId)!.raw).headers.subject).toBe('Brand A x IronmanCarter: League Shorts')
  })

  it('refuses when the media kit file no longer matches its checksum', async () => {
    await connect()
    const { pitch } = await approvedPitch()
    run(db, "UPDATE media_kits SET sha256 = 'tampered'")
    expect((await createDraft(pitch.id)).json().error.code).toBe('media_kit_checksum')
    expect(creates()).toHaveLength(0)
  })

  it('creates one test draft addressed to your own account', async () => {
    await connect()
    expect((await req('POST', '/api/gmail/test-draft', {})).statusCode).toBe(400)
    const r = (await req('POST', '/api/gmail/test-draft', { confirm: true })).json()
    expect(r).toMatchObject({ kind: 'test', status: 'created', recipient: 'ironmancarterbusiness@gmail.com' })
    expect(r.verification.ok).toBe(true)
    expect((await req('POST', '/api/gmail/test-draft', { confirm: true })).json().error.code).toBe('duplicate')
  })

  it('never calls a send endpoint and exposes none', async () => {
    await connect()
    const { pitch } = await approvedPitch()
    await createDraft(pitch.id)
    await req('POST', '/api/gmail/sync', {})
    expect(google.state.requests.filter((r) => /\/send\b/.test(new URL(r.url).pathname))).toHaveLength(0)
    for (const path of [`/api/pitches/${pitch.id}/send`, '/api/gmail/send', `/api/gmail/drafts/1/send`]) {
      expect((await req('POST', path, {})).statusCode).toBe(404)
    }
    expect((await req('GET', '/api/health')).json()).toEqual({ ok: true, sendingCodePresent: false })
  })
})
