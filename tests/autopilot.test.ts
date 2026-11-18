import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../apps/server/src/app'
import { all, get, getSetting, run, setSetting, type DB } from '../packages/db'
import { addContact, createProspect, deleteProspect } from '../packages/crm/prospects'
import { importMediaKit } from '../packages/mediakit/store'
import { forgetAccessTokens, type GmailDeps } from '../packages/gmail/account'
import { GoogleApi } from '../packages/gmail/google'
import { parseMessage } from '../packages/gmail/mime'
import { memoryStore } from '../packages/gmail/secrets'
import { ensureMailDomains } from '../packages/research/mailDomain'
import { ensureReports, tick } from '../packages/outreach/autopilot'
import { fakeGoogle } from './fakeGoogle'
import { fakePdf, freshDb, tempDir } from './helpers'

const H = { host: '127.0.0.1:5181', 'x-outreach-client': 'dashboard' }
const CLIENT = { client_id: '1234567890-abc.apps.googleusercontent.com', client_secret: 'GOCSPX-test-secret-value' }
const ADDRESS = '123 Example St, Suite 4, Los Angeles, CA 90001'

let db: DB, app: FastifyInstance, google: ReturnType<typeof fakeGoogle>, gmail: GmailDeps, dir: string, cleanup: () => void

beforeEach(async () => {
  const t = tempDir()
  dir = t.dir
  cleanup = t.cleanup
  db = freshDb()
  importMediaKit(db, dir, { buffer: fakePdf('media kit'), originalFilename: 'Media Kit.pdf' })
  setSetting(db, 'business.postalAddress', ADDRESS)
  // Always inside sending hours, and no spacing between emails, so tests do not depend on the clock.
  setSetting(db, 'outreach.businessHours', { timezone: 'America/Los_Angeles', start: '00:00', end: '23:59', days: [0, 1, 2, 3, 4, 5, 6] })
  setSetting(db, 'outreach.autopilot', { dryRun: false, newPerDay: 5, sendGapMinutes: 0, syncEveryMinutes: 15, maxErrorsPerDay: 3, maxBouncesPerWeek: 2 })
  google = fakeGoogle()
  forgetAccessTokens()
  gmail = { api: new GoogleApi(google.fetchImpl), secrets: memoryStore(), redirectUri: 'http://127.0.0.1:5181/api/gmail/oauth/callback' }
  app = await buildApp({ db, dataDir: dir, gmail })
})
afterEach(async () => {
  await app.close()
  cleanup()
})

const req = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: H, ...(payload !== undefined ? { payload: payload as object } : {}) })

async function connectAndGoLive() {
  await req('POST' as never, '/api/gmail/client', CLIENT).catch(() => undefined)
  await app.inject({ method: 'PUT', url: '/api/gmail/client', headers: H, payload: CLIENT })
  const { url } = (await req('POST', '/api/gmail/connect', {})).json()
  const state = new URL(url).searchParams.get('state')!
  await app.inject({ url: `/api/gmail/oauth/callback?state=${state}&code=x`, headers: { host: '127.0.0.1:5181' } })
  expect((await req('POST', '/api/outreach/live-sending', { enable: true, phrase: 'ENABLE MANUAL SENDING' })).statusCode).toBe(200)
}
const enable = () => req('POST', '/api/outreach/autopilot', { enable: true, phrase: 'ENABLE AUTOPILOT' })

// A researched brand with a qualifying public email (mock recipient on a .test domain), not yet reviewed.
async function lead(i: number, o: { email?: string; jurisdiction?: string; domain?: string } = {}) {
  const domain = o.domain ?? `brand${i}.test`
  const p = createProspect(db, { company_name: `Brand ${i}`, website: `https://${domain}`, category_id: 1, products: 'Gaming mice', campaign_concept: 'A clutch-play Short featuring the mouse.' })
  run(db, 'INSERT INTO research_sources (prospect_id, url, title, kind, retrieved_at, snippet) VALUES (?, ?, ?, ?, ?, ?)',
    p.id, `https://${domain}/creators`, 'Creator program', 'sponsorship_evidence', new Date().toISOString(), `Join the Brand ${i} Creator Program.`)
  const email = o.email ?? `partnerships@${domain}`
  addContact(db, p.id, { email, source_url: `https://${domain}/creators`, verification_status: 'verified', jurisdiction: o.jurisdiction ?? 'US', is_primary: true, discovered_by: 'research' })
  await ensureMailDomains(db, p.id)
  return { id: p.id, email }
}
const run1 = (holder = 'test') => tick(db, gmail, { dataDir: dir, holder })
const sends = () => all<{ recipient: string; kind: string; status: string; initiated_by: string }>(db, 'SELECT recipient, kind, status, initiated_by FROM send_attempts ORDER BY id')
const events = (kind: string) => all<{ detail: string }>(db, 'SELECT detail FROM autopilot_events WHERE kind = ? ORDER BY id', kind).map((e) => e.detail)

describe('switching autopilot on', () => {
  it('refuses until Gmail works, live sending is on and the phrase is typed', async () => {
    let r = await enable()
    expect(r.statusCode).toBe(409)
    expect(r.json().error.message).toMatch(/Gmail authorization works right now/)
    await connectAndGoLive()
    expect((await req('POST', '/api/outreach/autopilot', { enable: true, phrase: 'yes' })).statusCode).toBe(400)
    r = await enable()
    expect(r.statusCode).toBe(200)
    expect(getSetting(db, 'outreach.autopilotEnabled')).toBe(true)
    expect((await req('GET', '/api/health')).json().autopilot).toBe(true)
  })

  it('caps new first emails at 5 a day unless you change the code', async () => {
    const cfg = { ...getSetting<Record<string, unknown>>(db, 'outreach.autopilot'), sendGapMinutes: 20 }
    expect((await req('PATCH', '/api/settings', { 'outreach.autopilot': { ...cfg, newPerDay: 6 } })).statusCode).toBe(400)
    expect((await req('PATCH', '/api/settings', { 'outreach.autopilot': { ...cfg, newPerDay: 3 } })).statusCode).toBe(200)
    expect((await req('PATCH', '/api/settings', { 'outreach.autopilotEnabled': true })).statusCode).toBe(409)
  })

  it('does nothing while switched off', async () => {
    await connectAndGoLive()
    await lead(1)
    expect(await run1()).toMatchObject({ ran: false, note: 'Autopilot is off.' })
    expect(sends()).toEqual([])
  })
})

describe('dry run', () => {
  it('plans against real data without sending or creating anything in Gmail', async () => {
    await connectAndGoLive()
    await lead(1)
    await lead(2, { jurisdiction: 'unknown' })
    const before = google.state.requests.length
    const r = (await req('POST', '/api/outreach/autopilot/dry-run', {})).json()
    expect(r).toMatchObject({ ran: true, dryRun: true, actions: ['first email → partnerships@brand1.test (Brand 1)'] })
    expect(google.state.requests.length).toBe(before)
    expect(sends()).toEqual([])
    expect(all(db, 'SELECT * FROM pitches')).toEqual([])
    expect(events('dry_run')[0]).toMatch(/Would email Brand 1 at partnerships@brand1.test/)
  })

  it('in dry-run mode, the schedule sends nothing even when switched on', async () => {
    await connectAndGoLive()
    setSetting(db, 'outreach.autopilot', { ...getSetting<object>(db, 'outreach.autopilot'), dryRun: true })
    await enable()
    await lead(1)
    expect((await run1()).dryRun).toBe(true)
    expect(sends()).toEqual([])
    expect(google.sentMessages()).toEqual([])
  })
})

describe('automatic sending', () => {
  it('approves, drafts and sends to qualifying brands, at most 5 a day, with media kit, signature and opt-out', async () => {
    await connectAndGoLive()
    await enable()
    for (let i = 1; i <= 7; i++) await lead(i)
    for (let i = 0; i < 7; i++) await run1()
    expect(sends()).toHaveLength(5)
    expect(sends().every((s) => s.status === 'sent' && s.initiated_by === 'autopilot' && s.kind === 'initial')).toBe(true)
    expect((await run1()).note).toMatch(/daily limit reached/i)
    const msg = parseMessage(google.sentMessages()[0].raw)
    expect(msg.parts.find((x) => x.contentType === 'application/pdf')?.filename).toBe('Media Kit.pdf')
    const text = msg.parts.find((x) => x.contentType === 'text/plain')!.data.toString('utf8').replace(/\r\n/g, '\n')
    expect(text).toContain('Best,\nCarter')
    expect(text).toContain(ADDRESS)
    expect(text).toMatch(/not interested|unsubscribe|opt out|reply/i)
    expect(msg.headers.subject).not.toMatch(/^(re|fwd?):/i)
    expect(get(db, "SELECT review_status, review_note FROM prospects WHERE id = 1")).toMatchObject({ review_status: 'approved', review_note: expect.stringMatching(/autopilot/) })
    expect(all(db, "SELECT 1 FROM follow_ups")).toHaveLength(10)
  })

  it('skips brands that need something from you, such as an unknown recipient country', async () => {
    await connectAndGoLive()
    await enable()
    await lead(1, { jurisdiction: 'unknown' })
    await run1()
    expect(sends()).toEqual([])
  })

  it('never acts twice when the job runs twice at the same time', async () => {
    await connectAndGoLive()
    await enable()
    await lead(1)
    await lead(2)
    const [a, b] = await Promise.all([run1('worker-a'), run1('worker-b')])
    expect([a.note, b.note]).toContain('Another autopilot run is in progress.')
    expect(sends()).toHaveLength(1)
    expect(google.sentRequests()).toHaveLength(1)
  })

  it('never emails the same person twice, even through a separate company record', async () => {
    await connectAndGoLive()
    await enable()
    await lead(1)
    await run1()
    expect(sends()).toHaveLength(1)
    deleteProspect(db, 1)
    await lead(9, { email: 'partnerships@brand1.test', domain: 'brand1.test' })
    await run1()
    expect(sends()).toHaveLength(1)
    expect(events('skipped').join(' ')).toMatch(/Never emailed this person before/)
  })

  it('STOP ALL OUTREACH stops autopilot immediately', async () => {
    await connectAndGoLive()
    await enable()
    await lead(1)
    await req('POST', '/api/outreach/stop', { reason: 'test' })
    expect((await run1()).note).toMatch(/STOP ALL OUTREACH/)
    expect(sends()).toEqual([])
  })

  it('sends nothing outside business hours', async () => {
    await connectAndGoLive()
    await enable()
    await lead(1)
    setSetting(db, 'outreach.businessHours', { timezone: 'America/Los_Angeles', start: '09:00', end: '17:00', days: [] })
    expect((await run1()).note).toMatch(/Outside business hours/)
    expect(sends()).toEqual([])
  })
})

describe('follow-ups', () => {
  async function firstEmail() {
    await connectAndGoLive()
    await enable()
    const l = await lead(1)
    await run1()
    run(db, "UPDATE follow_ups SET due_at = '2020-01-01T00:00:00.000Z' WHERE sequence = 1")
    return l
  }

  it('sends the first follow-up in the same thread when due, and never before', async () => {
    await connectAndGoLive()
    await enable()
    await lead(1)
    await run1()
    await run1()
    expect(sends()).toHaveLength(1)
    run(db, "UPDATE follow_ups SET due_at = '2020-01-01T00:00:00.000Z' WHERE sequence = 1")
    await run1()
    expect(sends().map((s) => s.kind)).toEqual(['initial', 'follow_up'])
    const [first, follow] = all<{ gmail_thread_id: string }>(db, 'SELECT gmail_thread_id FROM send_attempts ORDER BY id')
    expect(follow.gmail_thread_id).toBe(first.gmail_thread_id)
    expect(get(db, 'SELECT status FROM follow_ups WHERE sequence = 1')).toEqual({ status: 'sent' })
  })

  it('a leftover unsent pitch draft in Gmail never blocks the follow-up, and still blocks a second first email', async () => {
    const l = await firstEmail()
    const acct = get<{ id: number }>(db, 'SELECT id FROM mail_accounts')!.id
    run(db, `INSERT INTO gmail_drafts (kind, prospect_id, account_id, status, local_ref, rfc822_message_id, gmail_draft_id, recipient, subject, content_sha256, created_at, updated_at)
      VALUES ('pitch', 1, ?, 'created', 'leftover', '<x@y>', 'r-leftover', ?, 'Old copy', 'x', ?, ?)`, acct, l.email, new Date().toISOString(), new Date().toISOString())
    await run1()
    expect(sends().map((s) => s.kind)).toEqual(['initial', 'follow_up'])
    const { createDraft } = await import('../packages/gmail/drafts')
    await expect(createDraft(db, gmail, dir, { kind: 'pitch', pitchId: null, prospectId: 1, to: l.email, subject: 's', body: 'b', kitId: null })).rejects.toThrow(/already has a Gmail draft/)
  })

  it('stops when the brand replies', async () => {
    const l = await firstEmail()
    const thread = get<{ gmail_thread_id: string }>(db, 'SELECT gmail_thread_id FROM send_attempts')!.gmail_thread_id
    google.receive({ from: l.email, text: 'Thanks, we will think about it.', threadId: thread })
    await run1()
    expect(sends()).toHaveLength(1)
    expect(all<{ status: string }>(db, 'SELECT status FROM follow_ups').map((f) => f.status)).toEqual(['cancelled', 'cancelled'])
    expect(get(db, 'SELECT stage FROM prospects WHERE id = 1')).toEqual({ stage: 'replied' })
  })

  it('stops when the brand opts out, and suppresses the address', async () => {
    const l = await firstEmail()
    const thread = get<{ gmail_thread_id: string }>(db, 'SELECT gmail_thread_id FROM send_attempts')!.gmail_thread_id
    google.receive({ from: l.email, text: 'Please remove me from your list.', threadId: thread })
    await run1()
    expect(sends()).toHaveLength(1)
    expect(get(db, "SELECT source FROM suppressions WHERE value = ?", l.email)).toEqual({ source: 'opt_out' })
  })

  it('stops when the address bounces', async () => {
    const l = await firstEmail()
    const thread = get<{ gmail_thread_id: string }>(db, 'SELECT gmail_thread_id FROM send_attempts')!.gmail_thread_id
    google.receive({ from: 'mailer-daemon@googlemail.com', text: '550 5.1.1 The email account does not exist.', threadId: thread })
    await run1()
    expect(sends()).toHaveLength(1)
    expect(get(db, "SELECT source FROM suppressions WHERE value = ?", l.email)).toEqual({ source: 'bounce' })
  })
})

describe('safety brakes', () => {
  it('a lost send response pauses autopilot and is never retried', async () => {
    await connectAndGoLive()
    await enable()
    await lead(1)
    await lead(2)
    google.state.loseNextSendResponse = true
    await run1()
    expect(sends()).toEqual([expect.objectContaining({ status: 'uncertain' })])
    expect(getSetting(db, 'outreach.autopilotEnabled')).toBe(false)
    expect(getSetting<{ reason: string }>(db, 'outreach.autopilotPause').reason).toMatch(/not retried/)
    await run1()
    expect(google.sentRequests()).toHaveLength(1)
  })

  it('stops for the rest of the day after repeated errors, without switching off', async () => {
    await connectAndGoLive()
    await enable()
    await lead(1)
    for (let i = 0; i < 3; i++) run(db, "INSERT INTO autopilot_events (day_key, kind, detail, created_at) VALUES (?, 'error', 'x', ?)", new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }), new Date().toISOString())
    expect((await run1()).note).toBe('Stopped for today: errors.')
    expect((await run1()).note).toMatch(/^Waiting until/)
    expect(sends()).toEqual([])
    expect(getSetting(db, 'outreach.autopilotEnabled')).toBe(true)
  })

  it('pauses when Gmail sending permissions are missing', async () => {
    await connectAndGoLive()
    await enable()
    await lead(1)
    run(db, "UPDATE mail_accounts SET scopes = ?", JSON.stringify(['https://www.googleapis.com/auth/gmail.compose']))
    await run1()
    expect(sends()).toEqual([])
    expect(getSetting<{ reason: string }>(db, 'outreach.autopilotPause').reason).toMatch(/Reconnect Gmail/)
  })
})

describe('reports', () => {
  it('writes each daily summary and weekly report once, however often it runs', () => {
    run(db, "INSERT INTO autopilot_events (day_key, kind, detail, created_at) VALUES ('2026-10-01', 'enabled', 'on', '2026-10-01T16:00:00.000Z')")
    const now = new Date('2026-11-11T20:00:00.000Z')
    ensureReports(db, now)
    ensureReports(db, now)
    expect(all(db, "SELECT period_key FROM autopilot_reports WHERE kind = 'daily'")).toHaveLength(7)
    expect(all<{ period_key: string; text: string }>(db, "SELECT period_key, text FROM autopilot_reports WHERE kind = 'weekly'")).toEqual([
      { period_key: '2026-11-02', text: expect.stringMatching(/^Week of 2026-11-02: .*All time/) },
    ])
  })
})
