import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../apps/server/src/app'
import { all, get, getSetting, run, setSetting, type DB } from '../packages/db'
import { addContact, createProspect } from '../packages/crm/prospects'
import { addSuppression } from '../packages/crm/suppressions'
import { importMediaKit } from '../packages/mediakit/store'
import { forgetAccessTokens, type GmailDeps } from '../packages/gmail/account'
import { GoogleApi } from '../packages/gmail/google'
import { memoryStore } from '../packages/gmail/secrets'
import { ensureMailDomains } from '../packages/research/mailDomain'
import { dualStatus, setCampaignPaused, tick } from '../packages/outreach/autopilot'
import { campaignBudget } from '../packages/outreach/send'
import { fakeGoogle } from './fakeGoogle'
import { fakePdf, freshDb, tempDir } from './helpers'

const H = { host: '127.0.0.1:5181', 'x-outreach-client': 'dashboard' }
const CLIENT = { client_id: '1234567890-abc.apps.googleusercontent.com', client_secret: 'GOCSPX-test-secret-value' }
const PORTFOLIO = 'https://carter.test/ugc'

let db: DB, app: FastifyInstance, google: ReturnType<typeof fakeGoogle>, gmail: GmailDeps, dir: string, cleanup: () => void

beforeEach(async () => {
  const t = tempDir()
  dir = t.dir
  cleanup = t.cleanup
  db = freshDb()
  importMediaKit(db, dir, { buffer: fakePdf('media kit'), originalFilename: 'Media Kit.pdf' })
  setSetting(db, 'business.postalAddress', 'Elevate Productions\n1968 S. Coast Hwy #2323\nLaguna Beach, CA 92651')
  setSetting(db, 'outreach.businessHours', { timezone: 'America/Los_Angeles', start: '00:00', end: '23:59', days: [0, 1, 2, 3, 4, 5, 6] })
  setSetting(db, 'outreach.autopilot', { dryRun: false, newPerDay: 5, sendGapMinutes: 0, syncEveryMinutes: 15, maxErrorsPerDay: 3, maxBouncesPerWeek: 2 })
  setSetting(db, 'ugc.autopilot', { newPerDay: 5, rampMax: 5, maxBouncesPerWeek: 2 })
  setSetting(db, 'ugc.portfolioUrl', PORTFOLIO)
  setSetting(db, 'ugc.portfolioCheck', { url: PORTFOLIO, ok: true, status: 200, detail: 'Live', checkedAt: new Date().toISOString() })
  setSetting(db, 'ugc.launchGate', { ok: true, checks: [{ label: 'test', ok: true, detail: 'mock' }], checkedAt: new Date().toISOString() })
  google = fakeGoogle()
  forgetAccessTokens()
  gmail = { api: new GoogleApi(google.fetchImpl), secrets: memoryStore(), redirectUri: 'http://127.0.0.1:5181/api/gmail/oauth/callback' }
  app = await buildApp({ db, dataDir: dir, gmail })
})
afterEach(async () => {
  await app.close()
  cleanup()
})

const req = (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: H, ...(payload !== undefined ? { payload: payload as object } : {}) })

async function goLive(tier = 'dual_campaign') {
  await app.inject({ method: 'PUT', url: '/api/gmail/client', headers: H, payload: CLIENT })
  const { url } = (await req('POST', '/api/gmail/connect', {})).json()
  const state = new URL(url).searchParams.get('state')!
  await app.inject({ url: `/api/gmail/oauth/callback?state=${state}&code=x`, headers: { host: '127.0.0.1:5181' } })
  expect((await req('POST', '/api/outreach/live-sending', { enable: true, phrase: 'ENABLE MANUAL SENDING' })).statusCode).toBe(200)
  expect((await req('POST', '/api/outreach/tier', { confirm: true, tier, note: 'Approved by me for two campaigns' })).statusCode).toBe(200)
  setSetting(db, 'outreach.autopilotEnabled', true)
  setSetting(db, 'ugc.autopilotEnabled', true)
}
const cat = (slug: string) => get<{ id: number }>(db, 'SELECT id FROM categories WHERE slug = ?', slug)!.id

async function sponsor(i: number) {
  const domain = `brand${i}.test`
  const p = createProspect(db, { company_name: `Brand ${i}`, website: `https://${domain}`, category_id: 1, products: 'Gaming mice', campaign_concept: 'A clutch-play Short featuring the mouse.' })
  run(db, 'INSERT INTO research_sources (prospect_id, url, title, kind, retrieved_at, snippet) VALUES (?, ?, ?, ?, ?, ?)',
    p.id, `https://${domain}/creators`, 'Creator program', 'sponsorship_evidence', new Date().toISOString(), `Join the Brand ${i} Creator Program.`)
  addContact(db, p.id, { email: `partnerships@${domain}`, source_url: `https://${domain}/creators`, verification_status: 'verified', jurisdiction: 'US', is_primary: true, discovered_by: 'research' })
  await ensureMailDomains(db, p.id)
  return p.id
}
async function ugc(i: number, jurisdiction = 'US') {
  const domain = `ugc${i}.test`
  const p = createProspect(db, { company_name: `Flowly ${i}`, website: `https://${domain}`, category_id: cat('ugc-saas'), products: 'Flowly turns meeting notes into tasks automatically' })
  run(db, "UPDATE prospects SET campaign_type = 'ugc', ugc_concepts = ?, campaign_concept = 'x', fit_score = 70 WHERE id = ?",
    JSON.stringify([{ title: 'Problem to solution demo', outline: 'Opens on a frustration, then a quick walkthrough.', basis: 'Their site' }]), p.id)
  run(db, 'INSERT INTO research_sources (prospect_id, url, title, kind, retrieved_at, snippet) VALUES (?, ?, ?, ?, ?, ?)',
    p.id, `https://${domain}/`, 'Flowly', 'website', new Date().toISOString(), 'Flowly turns meeting notes into tasks automatically')
  addContact(db, p.id, { email: `marketing@${domain}`, source_url: `https://${domain}/contact`, verification_status: 'verified', jurisdiction, is_primary: true, discovered_by: 'research' })
  await ensureMailDomains(db, p.id)
  return p.id
}
const runN = async (n: number, holder = 'w') => { for (let i = 0; i < n; i++) await tick(db, gmail, { dataDir: dir, holder }) }
const sentBy = () => all<{ campaign_type: string; n: number }>(db, `SELECT p.campaign_type, count(*) AS n FROM send_attempts s JOIN prospects p ON p.id = s.prospect_id
  WHERE s.kind = 'initial' AND s.status = 'sent' GROUP BY 1 ORDER BY 1`)

describe('shared sending budget', () => {
  it('the tier change needs a confirmation and a reason, and is recorded', async () => {
    expect((await req('POST', '/api/outreach/tier', { tier: 'dual_campaign', note: 'Approved by me' })).statusCode).toBe(400)
    expect((await req('POST', '/api/outreach/tier', { confirm: true, tier: 'dual_campaign', note: 'ok' })).statusCode).toBe(400)
    expect((await req('PATCH', '/api/settings', { 'outreach.sendingTier': 'dual_campaign' })).statusCode).toBe(409)
    expect((await req('POST', '/api/outreach/tier', { confirm: true, tier: 'dual_campaign', note: 'Approved by me for two campaigns' })).statusCode).toBe(200)
    expect(getSetting(db, 'outreach.sendingTier')).toBe('dual_campaign')
    expect(get(db, "SELECT summary FROM activities WHERE type = 'outreach.tier_changed'")).toEqual({ summary: expect.stringMatching(/10 new emails a day, 50 a week/) })
  })

  it('5 sponsorship + 5 UGC: each campaign sends its own 5, together 10', async () => {
    await goLive()
    for (let i = 1; i <= 7; i++) { await sponsor(i); await ugc(i) }
    await runN(30)
    expect(sentBy()).toEqual([{ campaign_type: 'sponsorship', n: 5 }, { campaign_type: 'ugc', n: 5 }])
    const d = dualStatus(db)
    expect(d.combined).toEqual({ sent: 10, limit: 10 })
    expect(d.sponsorship.today).toMatchObject({ sent: 5, allocated: 5, remaining: 0 })
    expect(d.ugc.today).toMatchObject({ sent: 5, allocated: 5, remaining: 0 })
  })

  it('one campaign never uses the other’s unused slots unless you allow it', async () => {
    await goLive()
    for (let i = 1; i <= 8; i++) await ugc(i)
    await runN(20)
    expect(sentBy()).toEqual([{ campaign_type: 'ugc', n: 5 }])
    expect(campaignBudget(db).campaigns.ugc.remaining).toBe(0)
    setSetting(db, 'outreach.allocation', { sponsorship: 5, ugc: 5, redistributeUnused: true })
    expect(campaignBudget(db).campaigns.ugc.remaining).toBe(5) // sponsorship's unused 5, inside the global 10
  })

  it('the combined daily cap of 10 holds whatever the allocation says', async () => {
    await goLive()
    expect((await req('PATCH', '/api/settings', { 'outreach.allocation': { sponsorship: 8, ugc: 8, redistributeUnused: false } })).statusCode).toBe(200)
    setSetting(db, 'outreach.autopilot', { ...getSetting<object>(db, 'outreach.autopilot'), newPerDay: 5 })
    setSetting(db, 'ugc.autopilot', { newPerDay: 8, rampMax: 8, maxBouncesPerWeek: 2 })
    for (let i = 1; i <= 9; i++) { await sponsor(i); await ugc(i) }
    await runN(40)
    const total = sentBy().reduce((a, b) => a + b.n, 0)
    expect(total).toBe(10)
  })

  it('the combined weekly cap of 50 holds', async () => {
    await goLive()
    const acct = get<{ id: number }>(db, 'SELECT id FROM mail_accounts')!.id
    const day = (d: number) => new Date(Date.now() - d * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })
    for (let i = 0; i < 48; i++) {
      const p = createProspect(db, { company_name: `Old ${i}`, website: `https://old${i}.test`, category_id: 1 })
      run(db, `INSERT INTO send_attempts (kind, prospect_id, account_id, idempotency_key, recipient, content_sha256, status, day_key, confirmed_at, sent_at, created_at, updated_at, initiated_by)
        VALUES ('initial', ?, ?, ?, ?, 'x', 'sent', ?, '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01', 'autopilot')`, p.id, acct, `old${i}`, `old${i}@x.test`, day(1 + (i % 5)))
    }
    for (let i = 1; i <= 5; i++) { await sponsor(i); await ugc(i) }
    await runN(20)
    expect(all(db, "SELECT 1 FROM send_attempts WHERE recipient NOT LIKE 'old%'")).toHaveLength(2)
    expect(dualStatus(db).week).toMatchObject({ sent: 50, limit: 50 })
  })

  it('manual sends count against the same campaign slots', async () => {
    await goLive()
    setSetting(db, 'outreach.allocation', { sponsorship: 5, ugc: 0, redistributeUnused: false })
    const id = await ugc(1)
    const { generatePitch, approvePitch } = await import('../packages/pitch/service')
    const p = approvePitch(db, (await generatePitch(db, id, { channel: 'email' })).id)
    await req('POST', `/api/pitches/${p.id}/gmail-draft`, { confirm: true })
    const prep = (await req('POST', '/api/outreach/send/prepare', { pitchId: p.id })).json()
    expect(prep.checks.filter((c: { ok: boolean }) => !c.ok).map((c: { label: string }) => c.label)).toEqual(["UGC share of today's new emails"])
  })
})

describe('independent controls and reliability', () => {
  it('pausing one campaign leaves the other running; STOP ALL stops both', async () => {
    await goLive()
    for (let i = 1; i <= 3; i++) { await sponsor(i); await ugc(i) }
    setCampaignPaused(db, 'sponsorship', true)
    await runN(10)
    expect(sentBy()).toEqual([{ campaign_type: 'ugc', n: 3 }])
    expect((await req('POST', '/api/outreach/campaigns/sponsorship/pause', { paused: false })).json().sponsorship.paused).toBe(false)
    await req('POST', '/api/outreach/stop', { reason: 'test' })
    await runN(5)
    expect(sentBy()).toEqual([{ campaign_type: 'ugc', n: 3 }])
  })

  it('never sends to unconfirmed countries or suppressed addresses, and shows why they are blocked', async () => {
    await goLive()
    await ugc(1, 'unknown')
    const s = await sponsor(2)
    addSuppression(db, 'email', `partnerships@brand2.test`, 'Opted out', 'opt_out')
    await runN(5)
    expect(sentBy()).toEqual([])
    const d = dualStatus(db)
    expect(d.ugc.blocked[0].reason).toMatch(/country|jurisdiction/i)
    expect(d.sponsorship.blocked.map((b) => b.reason).join(' ')).toMatch(/do-not-contact|suppress/i)
    expect(s).toBeGreaterThan(0)
  })

  it('a brief Gmail outage waits and retries; it never switches anything off', async () => {
    await goLive()
    await ugc(1)
    forgetAccessTokens()
    const real = gmail.api.refresh.bind(gmail.api)
    gmail.api.refresh = async () => { throw new Error('ECONNRESET') }
    const r = await tick(db, gmail, { dataDir: dir, holder: 'w' })
    expect(r.note).toMatch(/retrying in 5 minutes/)
    expect(getSetting(db, 'ugc.autopilotEnabled')).toBe(true)
    expect(getSetting(db, 'outreach.autopilotEnabled')).toBe(true)
    gmail.api.refresh = real
    expect((await tick(db, gmail, { dataDir: dir, holder: 'w' })).note).toMatch(/Waiting until/)
    run(db, "UPDATE settings SET value = 'null' WHERE key = 'autopilot.backoffUntil'")
    const last = await tick(db, gmail, { dataDir: dir, holder: 'w' })
    expect(sentBy(), JSON.stringify(last)).toEqual([{ campaign_type: 'ugc', n: 1 }])
  })

  it('a revoked Gmail authorization pauses both campaigns', async () => {
    await goLive()
    await ugc(1)
    forgetAccessTokens()
    google.state.refreshInvalid = true
    await tick(db, gmail, { dataDir: dir, holder: 'w' })
    expect(getSetting(db, 'ugc.autopilotEnabled')).toBe(false)
    expect(getSetting(db, 'outreach.autopilotEnabled')).toBe(false)
  })

  it('after a restart, a stale lock expires and nothing is sent twice', async () => {
    await goLive()
    await ugc(1)
    // A worker that crashed while holding the lock.
    setSetting(db, 'autopilot.lock', { holder: 'crashed', until: Date.now() + 60_000 })
    expect((await tick(db, gmail, { dataDir: dir, holder: 'new' })).note).toBe('Another autopilot run is in progress.')
    setSetting(db, 'autopilot.lock', { holder: 'crashed', until: Date.now() - 1 })
    await runN(3, 'new')
    await runN(3, 'another')
    expect(google.sentRequests()).toHaveLength(1)
  })
})
