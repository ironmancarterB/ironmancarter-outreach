import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../apps/server/src/app'
import { all, get, getSetting, run, setSetting, type DB } from '../packages/db'
import { addContact, createProspect } from '../packages/crm/prospects'
import { addSuppression } from '../packages/crm/suppressions'
import { importMediaKit } from '../packages/mediakit/store'
import { forgetAccessTokens, type GmailDeps } from '../packages/gmail/account'
import { GoogleApi } from '../packages/gmail/google'
import { parseMessage } from '../packages/gmail/mime'
import { memoryStore } from '../packages/gmail/secrets'
import { ensureMailDomains } from '../packages/research/mailDomain'
import { tick, ugcCap, ugcCandidates } from '../packages/outreach/autopilot'
import { autopilotSend } from '../packages/outreach/send'
import { generatePitch } from '../packages/pitch/service'
import { runLaunchGate } from '../packages/ugc/gate'
import { discoverCompanies } from '../packages/ugc/discovery'
import { ugcDailyStep } from '../packages/ugc/daily'
import { fakeGoogle } from './fakeGoogle'
import { fakeWeb, html, type FakeRoute } from './fakeWeb'
import { fakePdf, freshDb, tempDir } from './helpers'

const H = { host: '127.0.0.1:5181', 'x-outreach-client': 'dashboard' }
const CLIENT = { client_id: '1234567890-abc.apps.googleusercontent.com', client_secret: 'GOCSPX-test-secret-value' }
const ORIGIN = 'https://carter.test'
const PORTFOLIO = `${ORIGIN}/ugc`
const EMAIL = 'ironmancarterbusiness@gmail.com'
const MANIFEST = JSON.stringify({ categories: [], videos: [
  { title: 'One', type: 'file', src: '/videos/one.mp4' }, { title: 'Two', type: 'file', src: '/videos/two.mp4' }, { title: 'Three', type: 'file', src: '/videos/three.mp4' },
] })
const VIDEO: FakeRoute = { status: 206, type: 'video/mp4', body: 'x' }
const SITE: Record<string, FakeRoute | string> = {
  [PORTFOLIO]: html('UGC Video Services | Carter', `<h1>UGC</h1><img src="/a.jpg"><p>Videos and services.</p><a href="mailto:${EMAIL}">${EMAIL}</a>`),
  [`${ORIGIN}/data/portfolio.json`]: { body: MANIFEST, type: 'application/json' },
  [`${ORIGIN}/videos/one.mp4`]: VIDEO, [`${ORIGIN}/videos/two.mp4`]: VIDEO, [`${ORIGIN}/videos/three.mp4`]: VIDEO,
}

let db: DB, app: FastifyInstance, google: ReturnType<typeof fakeGoogle>, gmail: GmailDeps, dir: string, cleanup: () => void
let routes: Record<string, FakeRoute | string>

beforeEach(async () => {
  const t = tempDir()
  dir = t.dir
  cleanup = t.cleanup
  db = freshDb()
  importMediaKit(db, dir, { buffer: fakePdf('media kit'), originalFilename: 'Media Kit.pdf' })
  setSetting(db, 'business.postalAddress', 'Elevate Productions\n1968 S. Coast Hwy #2323\nLaguna Beach, CA 92651')
  setSetting(db, 'outreach.businessHours', { timezone: 'America/Los_Angeles', start: '00:00', end: '23:59', days: [0, 1, 2, 3, 4, 5, 6] })
  setSetting(db, 'outreach.autopilot', { dryRun: false, newPerDay: 5, sendGapMinutes: 0, syncEveryMinutes: 15, maxErrorsPerDay: 3, maxBouncesPerWeek: 2 })
  setSetting(db, 'ugc.portfolioUrl', PORTFOLIO)
  google = fakeGoogle()
  forgetAccessTokens()
  gmail = { api: new GoogleApi(google.fetchImpl), secrets: memoryStore(), redirectUri: 'http://127.0.0.1:5181/api/gmail/oauth/callback' }
  routes = { ...SITE }
  // fakeWeb copies its table, so tests that change the site rebuild it through this indirection.
  const fetchImpl = ((u: string | URL, i?: RequestInit) => fakeWeb(routes).fetchImpl(u, i)) as typeof fetch
  app = await buildApp({ db, dataDir: dir, gmail, fetchImpl })
  ;(globalThis as { __ugcFetch?: typeof fetch }).__ugcFetch = fetchImpl
})
afterEach(async () => {
  await app.close()
  cleanup()
})

const siteFetch = () => (globalThis as { __ugcFetch?: typeof fetch }).__ugcFetch!
const req = (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: H, ...(payload !== undefined ? { payload: payload as object } : {}) })

async function connectAndGoLive() {
  await app.inject({ method: 'PUT', url: '/api/gmail/client', headers: H, payload: CLIENT })
  const { url } = (await req('POST', '/api/gmail/connect', {})).json()
  const state = new URL(url).searchParams.get('state')!
  await app.inject({ url: `/api/gmail/oauth/callback?state=${state}&code=x`, headers: { host: '127.0.0.1:5181' } })
  expect((await req('POST', '/api/outreach/live-sending', { enable: true, phrase: 'ENABLE MANUAL SENDING' })).statusCode).toBe(200)
}
const confirmPermission = () => req('POST', '/api/ugc/videos-permission', { note: 'All three videos are my own content.' })
const enableUgc = () => req('POST', '/api/ugc/autopilot', { enable: true, phrase: 'ENABLE UGC AUTOPILOT' })
async function readyUgc() {
  await connectAndGoLive()
  await confirmPermission()
  const r = await enableUgc()
  expect(r.statusCode, r.body).toBe(200)
}
const cat = (slug: string) => get<{ id: number }>(db, 'SELECT id FROM categories WHERE slug = ?', slug)!.id
const CONCEPTS = [{ title: 'Problem to solution demo', outline: 'Opens on a frustration, then a quick walkthrough of the product.', basis: 'Their site' }]

async function ugcLead(i: number, o: { jurisdiction?: string; email?: string; score?: number } = {}) {
  const domain = `ugc${i}.test`
  const p = createProspect(db, { company_name: `Flowly ${i}`, website: `https://${domain}`, category_id: cat('ugc-saas'), products: 'Flowly turns meeting notes into tasks automatically' })
  run(db, "UPDATE prospects SET campaign_type = 'ugc', ugc_concepts = ?, campaign_concept = 'x', fit_score = ? WHERE id = ?", JSON.stringify(CONCEPTS), o.score ?? 70, p.id)
  run(db, 'INSERT INTO research_sources (prospect_id, url, title, kind, retrieved_at, snippet) VALUES (?, ?, ?, ?, ?, ?)',
    p.id, `https://${domain}/`, 'Flowly', 'website', new Date().toISOString(), 'Flowly turns meeting notes into tasks automatically')
  const email = o.email ?? `marketing@${domain}`
  addContact(db, p.id, { email, source_url: `https://${domain}/contact`, verification_status: 'verified', jurisdiction: o.jurisdiction ?? 'US', is_primary: true, discovered_by: 'research' })
  await ensureMailDomains(db, p.id)
  return { id: p.id, email }
}
const run1 = (holder = 'test') => tick(db, gmail, { dataDir: dir, holder })
const sends = () => all<{ recipient: string; kind: string; status: string; initiated_by: string }>(db, 'SELECT recipient, kind, status, initiated_by FROM send_attempts ORDER BY id')

// ---------------------------------------------------------------------------------------------

describe('launch gate', () => {
  it('passes only with a live portfolio, playable videos, confirmed permission and the right contact email', async () => {
    let g = await runLaunchGate(db, siteFetch())
    expect(g.ok).toBe(false)
    expect(g.checks.find((c) => !c.ok)?.label).toBe('Videos are cleared for public display')
    await confirmPermission()
    g = await runLaunchGate(db, siteFetch())
    expect(g.ok, JSON.stringify(g.checks)).toBe(true)
    expect(g.checks.find((c) => c.label === 'Portfolio shows real video examples')?.detail).toBe('3 published videos')

    routes[`${ORIGIN}/videos/two.mp4`] = { status: 404 }
    g = await runLaunchGate(db, siteFetch())
    expect(g.checks.find((c) => c.label === 'Every portfolio video loads')).toMatchObject({ ok: false })
    routes[`${ORIGIN}/videos/two.mp4`] = VIDEO
    routes[`${ORIGIN}/data/portfolio.json`] = { body: '{"videos":[]}', type: 'application/json' }
    g = await runLaunchGate(db, siteFetch())
    expect(g.checks.find((c) => c.label === 'Portfolio shows real video examples')).toMatchObject({ ok: false })
    routes[`${ORIGIN}/data/portfolio.json`] = { body: MANIFEST, type: 'application/json' }
    routes[PORTFOLIO] = html('UGC Video Services | Carter', '<h1>UGC</h1><img src="/a.jpg"><p>Videos and services, contact someone@else.test</p>')
    g = await runLaunchGate(db, siteFetch())
    expect(g.checks.find((c) => c.label === 'Contact details on the site match your business email')).toMatchObject({ ok: false })
  })

  it('UGC autopilot cannot be switched on while the gate fails, without the phrase, or without Gmail', async () => {
    let r = await enableUgc()
    expect(r.statusCode).toBe(409)
    expect(r.json().error.message).toMatch(/Gmail authorization works right now/)
    await connectAndGoLive()
    r = await enableUgc()
    expect(r.json().error.message).toMatch(/cleared for public display/)
    await confirmPermission()
    expect((await req('POST', '/api/ugc/autopilot', { enable: true, phrase: 'yes' })).statusCode).toBe(400)
    expect((await req('PATCH', '/api/settings', { 'ugc.autopilotEnabled': true })).statusCode).toBe(409)
    expect((await enableUgc()).statusCode).toBe(200)
    expect(getSetting(db, 'ugc.autopilotEnabled')).toBe(true)
  })
})

describe('independent campaign controls', () => {
  it('UGC autopilot runs with sponsorship autopilot off, and never touches sponsorship settings', async () => {
    const before = { cfg: getSetting(db, 'outreach.autopilot'), on: getSetting(db, 'outreach.autopilotEnabled') }
    await readyUgc()
    const l = await ugcLead(1)
    await run1()
    expect(sends()).toEqual([{ recipient: l.email, kind: 'initial', status: 'sent', initiated_by: 'autopilot' }])
    const msg = parseMessage(google.sentMessages()[0].raw)
    const text = msg.parts.find((p) => p.contentType === 'text/plain')!.data.toString('utf8')
    expect(text).toContain(PORTFOLIO)
    expect(text).toMatch(/Best,\r?\nCarter/)
    expect(text).toMatch(/unsubscribe/)
    expect(msg.parts.filter((p) => p.filename)).toEqual([]) // never the sponsorship media kit
    expect(text).not.toMatch(/\$\d/)
    expect({ cfg: getSetting(db, 'outreach.autopilot'), on: getSetting(db, 'outreach.autopilotEnabled') }).toEqual(before)
  })

  it('sponsorship autopilot alone never sends UGC emails, and UGC sends refuse while UGC autopilot is off', async () => {
    await connectAndGoLive()
    expect((await req('POST', '/api/outreach/autopilot', { enable: true, phrase: 'ENABLE AUTOPILOT' })).statusCode).toBe(200)
    const l = await ugcLead(1)
    await run1()
    expect(sends()).toEqual([])
    const pitch = await generatePitch(db, l.id, { channel: 'email' })
    await expect(autopilotSend(db, gmail, { kind: 'initial', pitchId: pitch.id })).rejects.toThrow(/UGC autopilot is switched off/)
  })

  it('switching UGC autopilot off stops it; switching live sending off stops both', async () => {
    await readyUgc()
    expect((await req('POST', '/api/ugc/autopilot', { enable: false })).json().enabled).toBe(false)
    await ugcLead(1)
    await run1()
    expect(sends()).toEqual([])
    await enableUgc()
    await req('POST', '/api/outreach/live-sending', { enable: false })
    expect(getSetting(db, 'ugc.autopilotEnabled')).toBe(false)
  })
})

describe('recipient verification and safety', () => {
  it('never sends to an unconfirmed country, a suppressed address or below the minimum lead score', async () => {
    await readyUgc()
    await ugcLead(1, { jurisdiction: 'unknown' })
    const b = await ugcLead(2)
    await ugcLead(3, { score: 30 })
    addSuppression(db, 'email', b.email, 'Opted out', 'opt_out')
    expect(ugcCandidates(db)).toEqual([])
    await run1()
    expect(sends()).toEqual([])
    const status = (await req('GET', '/api/ugc/autopilot')).json()
    expect(status.waiting.map((w: { company_name: string }) => w.company_name)).toContain('Flowly 1')
  })

  it('your country confirmation (and only yours) makes a lead sendable', async () => {
    await readyUgc()
    const l = await ugcLead(1, { jurisdiction: 'unknown' })
    const contact = get<{ id: number }>(db, 'SELECT id FROM contacts WHERE prospect_id = ?', l.id)!.id
    expect((await req('POST', '/api/ugc/confirm-countries', { contactIds: [contact], jurisdiction: 'usa' })).statusCode).toBe(400)
    expect((await req('POST', '/api/ugc/confirm-countries', { contactIds: [contact], jurisdiction: 'US' })).json().updated).toBe(1)
    await run1()
    expect(sends().map((s) => s.recipient)).toEqual([l.email])
  })

  it('never emails a company twice, and never a domain already in the sponsorship campaign', async () => {
    await readyUgc()
    await ugcLead(1)
    await run1()
    await run1()
    run(db, 'DELETE FROM autopilot_holds')
    await run1()
    expect(sends()).toHaveLength(1)
    expect(() => createProspect(db, { company_name: 'Same Co', website: 'https://www.ugc1.test', category_id: 1 })).toThrow(/Already in the CRM/)
  })

  it('STOP ALL OUTREACH blocks UGC autopilot immediately', async () => {
    await readyUgc()
    await ugcLead(1)
    await req('POST', '/api/outreach/stop', { confirm: true, reason: 'test' })
    expect((await run1()).note).toBe('STOP ALL OUTREACH is active.')
    expect(sends()).toEqual([])
  })

  it('caps UGC first emails at the UGC limit and inside the shared account limits', async () => {
    await readyUgc()
    for (let i = 1; i <= 6; i++) await ugcLead(i)
    for (let i = 0; i < 8; i++) await run1()
    expect(sends()).toHaveLength(3) // UGC starts at 3 a day
    setSetting(db, 'ugc.autopilotRamp', { cap: 5, reviewedAt: new Date().toISOString() })
    setSetting(db, 'ugc.autopilot', { newPerDay: 3, rampMax: 10, maxBouncesPerWeek: 2 })
    for (let i = 0; i < 8; i++) await run1()
    expect(sends()).toHaveLength(5) // the testing tier allows 5 new emails a day across both campaigns
  })

  it('two workers never send at the same time (lease lock), and a lost send pauses both campaigns', async () => {
    await readyUgc()
    await ugcLead(1)
    await ugcLead(2)
    const [a, b] = await Promise.all([run1('worker-a'), run1('worker-b')])
    expect([a.note, b.note]).toContain('Another autopilot run is in progress.')
    expect(sends()).toHaveLength(1)
    google.state.loseNextSendResponse = true
    await run1()
    expect(sends().map((s) => s.status)).toContain('uncertain')
    expect(getSetting(db, 'ugc.autopilotEnabled')).toBe(false)
    expect(getSetting<{ reason: string }>(db, 'ugc.autopilotPause').reason).toMatch(/not retried/)
  })
})

describe('follow-ups and replies', () => {
  async function firstEmail() {
    await readyUgc()
    const l = await ugcLead(1)
    await run1()
    run(db, "UPDATE follow_ups SET due_at = '2020-01-01T00:00:00.000Z' WHERE sequence = 1")
    return l
  }

  it('sends UGC follow-ups automatically when due, in the same thread, at most two', async () => {
    await firstEmail()
    await run1()
    expect(sends().map((s) => s.kind)).toEqual(['initial', 'follow_up'])
    run(db, "UPDATE follow_ups SET due_at = '2020-01-01T00:00:00.000Z' WHERE sequence = 2")
    await run1()
    await run1()
    expect(sends().map((s) => s.kind)).toEqual(['initial', 'follow_up', 'follow_up'])
    const threads = new Set(all<{ gmail_thread_id: string }>(db, 'SELECT gmail_thread_id FROM send_attempts').map((r) => r.gmail_thread_id))
    expect(threads.size).toBe(1)
  })

  it('a positive reply stops follow-ups, marks the brand Interested and notifies you; nothing is answered', async () => {
    const l = await firstEmail()
    const thread = get<{ gmail_thread_id: string }>(db, 'SELECT gmail_thread_id FROM send_attempts')!.gmail_thread_id
    google.receive({ from: l.email, text: "Sounds great, we'd love to chat about a few videos.", threadId: thread })
    run(db, "DELETE FROM gmail_sync_runs")
    await run1()
    expect(sends()).toHaveLength(1)
    expect(all<{ status: string }>(db, 'SELECT status FROM follow_ups').map((f) => f.status)).toEqual(['cancelled', 'cancelled'])
    expect(get(db, 'SELECT status, negotiated_cents, quoted_cents FROM ugc_deals WHERE prospect_id = ?', l.id)).toEqual({ status: 'interested', negotiated_cents: null, quoted_cents: null })
    expect(all<{ detail: string }>(db, "SELECT detail FROM autopilot_events WHERE campaign = 'ugc' AND detail LIKE 'INTERESTED%'")).toHaveLength(1)
    expect(google.sentMessages()).toHaveLength(1)
  })

  it('opt-outs and bounces stop follow-ups and suppress the address', async () => {
    const l = await firstEmail()
    const thread = get<{ gmail_thread_id: string }>(db, 'SELECT gmail_thread_id FROM send_attempts')!.gmail_thread_id
    google.receive({ from: 'mailer-daemon@googlemail.com', text: '550 5.1.1 The email account does not exist.', threadId: thread })
    run(db, "DELETE FROM gmail_sync_runs")
    await run1()
    expect(sends()).toHaveLength(1)
    expect(get(db, 'SELECT source FROM suppressions WHERE value = ?', l.email)).toEqual({ source: 'bounce' })
  })
})

describe('sending limits grow only with good delivery', () => {
  it('raises the UGC limit by one after a clean week with volume, lowers it after a bounce', async () => {
    const now = new Date('2026-12-01T18:00:00Z')
    setSetting(db, 'ugc.autopilotRamp', { cap: 3, reviewedAt: '2026-11-20T18:00:00Z' })
    expect(ugcCap(db, now)).toBe(3) // no volume yet: unchanged
    setSetting(db, 'ugc.autopilotRamp', { cap: 3, reviewedAt: '2026-11-20T18:00:00Z' })
    const acct = run(db, "INSERT INTO mail_accounts (provider, email, status, scopes, secret_ref, connected_at, created_at, updated_at) VALUES ('gmail', 'a@b.test', 'connected', '', 'x', ?, ?, ?)", now.toISOString(), now.toISOString(), now.toISOString()).lastId
    for (let i = 0; i < 9; i++) {
      const p = createProspect(db, { company_name: `Sent ${i}`, website: `https://sent${i}.test`, category_id: cat('ugc-saas') })
      run(db, "UPDATE prospects SET campaign_type = 'ugc' WHERE id = ?", p.id)
      run(db, `INSERT INTO send_attempts (kind, prospect_id, account_id, idempotency_key, recipient, content_sha256, status, day_key, confirmed_at, sent_at, created_at, updated_at, initiated_by)
        VALUES ('initial', ?, ?, ?, ?, 'x', 'sent', '2026-11-28', ?, ?, ?, ?, 'autopilot')`, p.id, acct, `k${i}`, `r${i}@x.test`, now.toISOString(), '2026-11-28T18:00:00Z', now.toISOString(), now.toISOString())
    }
    expect(ugcCap(db, now)).toBe(4)
    addSuppression(db, 'email', 'r1@x.test', 'Bounced', 'bounce')
    run(db, "UPDATE suppressions SET created_at = '2026-11-30T00:00:00.000Z'")
    setSetting(db, 'ugc.autopilotRamp', { cap: 4, reviewedAt: '2026-11-20T18:00:00Z' })
    expect(ugcCap(db, now)).toBe(3)
  })
})

describe('discovery and the daily run', () => {
  it('adds real companies from Wikidata with their source, skipping known domains and social sites', async () => {
    const bindings = [
      { item: { value: 'http://www.wikidata.org/entity/Q1' }, itemLabel: { value: 'New AI Co' }, website: { value: 'https://newai.test/' } },
      { item: { value: 'http://www.wikidata.org/entity/Q2' }, itemLabel: { value: 'Copy Co' }, website: { value: 'https://www.copy.ai' } },
      { item: { value: 'http://www.wikidata.org/entity/Q3' }, itemLabel: { value: 'Social Only' }, website: { value: 'https://twitter.com/x' } },
      { item: { value: 'http://www.wikidata.org/entity/Q4' }, itemLabel: { value: 'Q4' }, website: { value: 'https://unnamed.test' } },
    ]
    const fetchImpl = (async (u: string) => new Response(JSON.stringify({ results: { bindings: String(u).includes('Q11660') ? bindings : [] } }), { status: 200 })) as unknown as typeof fetch
    const r = await discoverCompanies(db, 40, fetchImpl)
    expect(r.total).toBe(1)
    expect(get(db, "SELECT company_name, origin, source_url FROM candidate_pool WHERE domain = 'newai.test'")).toEqual({ company_name: 'New AI Co', origin: 'discovery', source_url: 'http://www.wikidata.org/entity/Q1' })
    expect(getSetting<{ cursors: Record<string, number> }>(db, 'ugc.discovery').cursors['ugc-ai-tools']).toBe(4)
  })

  it('pauses UGC autopilot when the daily launch gate fails', async () => {
    await readyUgc()
    routes[`${ORIGIN}/videos/one.mp4`] = { status: 404 }
    await ugcDailyStep(db, { gmail, dataDir: dir, fetchImpl: siteFetch(), now: new Date('2026-11-18T18:00:00Z') })
    expect(getSetting(db, 'ugc.autopilotEnabled')).toBe(false)
    expect(getSetting<{ reason: string }>(db, 'ugc.autopilotPause').reason).toMatch(/launch gate failed/)
  })

  it('the dry run plans UGC emails without sending or touching Gmail', async () => {
    await connectAndGoLive()
    await confirmPermission()
    await runLaunchGate(db, siteFetch())
    await ugcLead(1)
    const before = google.state.requests.length
    const r = (await req('POST', '/api/ugc/autopilot/dry-run', {})).json()
    expect(r.actions).toEqual(['UGC first email → marketing@ugc1.test (Flowly 1)'])
    expect(google.state.requests.length).toBe(before)
    expect(sends()).toEqual([])
  })
})
