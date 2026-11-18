import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../apps/server/src/app'
import { all, get, getSetting, run, setSetting, type DB } from '../packages/db'
import { addContact, createProspect, reviewProspect, setStage } from '../packages/crm/prospects'
import { addSuppression } from '../packages/crm/suppressions'
import { contactQualification } from '../packages/crm/leads'
import { importMediaKit, getDefaultMediaKit } from '../packages/mediakit/store'
import { forgetAccessTokens, type GmailDeps } from '../packages/gmail/account'
import { GoogleApi } from '../packages/gmail/google'
import { parseMessage } from '../packages/gmail/mime'
import { memoryStore } from '../packages/gmail/secrets'
import { ensureMailDomains } from '../packages/research/mailDomain'
import { addPoolCandidate, createBatch } from '../packages/research/batches'
import { createFetcher } from '../packages/research/fetcher'
import { researchCandidate, type Candidate } from '../packages/research/pipeline'
import { applyUgcMinimum } from '../packages/research/worker'
import { approvePitch, evaluatePitch, generatePitch, getPitch, updatePitch } from '../packages/pitch/service'
import { tick } from '../packages/outreach/autopilot'
import { syncConversations } from '../packages/outreach/sync'
import { checkPortfolio, portfolioStatus, setPortfolioUrl } from '../packages/ugc/portfolio'
import { ugcCosts, ugcMetrics, ugcOverview, ugcPipeline } from '../packages/ugc/dashboard'
import { createDeal, updateDeal } from '../packages/ugc/deals'
import { prepareUgcDrafts } from '../packages/ugc/drafting'
import { ugcDailyStep } from '../packages/ugc/daily'
import { fakeGoogle } from './fakeGoogle'
import { fakeWeb, html } from './fakeWeb'
import { fakePdf, freshDb, tempDir } from './helpers'

const H = { host: '127.0.0.1:5181', 'x-outreach-client': 'dashboard' }
const CLIENT = { client_id: '1234567890-abc.apps.googleusercontent.com', client_secret: 'GOCSPX-test-secret-value' }
const ADDRESS = 'Elevate Productions\n1968 S. Coast Hwy #2323\nLaguna Beach, CA 92651'
const PORTFOLIO = 'https://carter.test/ugc'
const PORTFOLIO_PAGE = html('Carter | UGC Portfolio', '<h1>UGC portfolio</h1><video src="/a.mp4"></video><p>Short-form product demos, software walkthroughs and ad-ready edits for gaming and tech brands.</p>')

let db: DB, app: FastifyInstance, google: ReturnType<typeof fakeGoogle>, gmail: GmailDeps, dir: string, cleanup: () => void
let web: ReturnType<typeof fakeWeb>

beforeEach(async () => {
  const t = tempDir()
  dir = t.dir
  cleanup = t.cleanup
  db = freshDb()
  importMediaKit(db, dir, { buffer: fakePdf('media kit'), originalFilename: 'Media Kit.pdf' })
  setSetting(db, 'business.postalAddress', ADDRESS)
  setSetting(db, 'outreach.businessHours', { timezone: 'America/Los_Angeles', start: '00:00', end: '23:59', days: [0, 1, 2, 3, 4, 5, 6] })
  setSetting(db, 'outreach.autopilot', { dryRun: false, newPerDay: 5, sendGapMinutes: 0, syncEveryMinutes: 15, maxErrorsPerDay: 3, maxBouncesPerWeek: 2 })
  google = fakeGoogle()
  forgetAccessTokens()
  gmail = { api: new GoogleApi(google.fetchImpl), secrets: memoryStore(), redirectUri: 'http://127.0.0.1:5181/api/gmail/oauth/callback' }
  web = fakeWeb({ [PORTFOLIO]: PORTFOLIO_PAGE })
  app = await buildApp({ db, dataDir: dir, gmail, fetchImpl: web.fetchImpl })
})
afterEach(async () => {
  await app.close()
  cleanup()
})

const req = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: H, ...(payload !== undefined ? { payload: payload as object } : {}) })

async function connectAndGoLive() {
  await app.inject({ method: 'PUT', url: '/api/gmail/client', headers: H, payload: CLIENT })
  const { url } = (await req('POST', '/api/gmail/connect', {})).json()
  const state = new URL(url).searchParams.get('state')!
  await app.inject({ url: `/api/gmail/oauth/callback?state=${state}&code=x`, headers: { host: '127.0.0.1:5181' } })
  expect((await req('POST', '/api/outreach/live-sending', { enable: true, phrase: 'ENABLE MANUAL SENDING' })).statusCode).toBe(200)
}
const verifyPortfolio = async () => {
  const r = await req('POST', '/api/ugc/portfolio', { url: PORTFOLIO })
  expect(r.json().usable).toBe(true)
}
const cat = (slug: string) => get<{ id: number }>(db, 'SELECT id FROM categories WHERE slug = ?', slug)!.id

const CONCEPTS = [
  { title: 'Problem to solution demo', outline: 'Opens on a relatable frustration, then a quick screen-recorded walkthrough of how Flowly handles it.', basis: 'Their site' },
  { title: 'Setup in one take', outline: 'A fast "how I set up Flowly" video for new users, recorded at my desk with screen capture.', basis: 'Their site' },
]

// A researched UGC company with a published, sourced business email (mock recipient on a .test domain).
async function ugcLead(i: number, o: { jurisdiction?: string; score?: number; email?: string } = {}) {
  const domain = `ugc${i}.test`
  const p = createProspect(db, { company_name: `Flowly ${i}`, website: `https://${domain}`, category_id: cat('ugc-saas'), products: 'Flowly turns meeting notes into tasks automatically' })
  run(db, "UPDATE prospects SET campaign_type = 'ugc', ugc_concepts = ?, campaign_concept = 'x', fit_score = ? WHERE id = ?",
    JSON.stringify(CONCEPTS.map((c) => ({ ...c, title: c.title, outline: c.outline.replace(/Flowly/g, `Flowly ${i}`) }))), o.score ?? 70, p.id)
  run(db, 'INSERT INTO research_sources (prospect_id, url, title, kind, retrieved_at, snippet) VALUES (?, ?, ?, ?, ?, ?)',
    p.id, `https://${domain}/`, 'Flowly', 'website', new Date().toISOString(), 'Flowly turns meeting notes into tasks automatically')
  run(db, 'INSERT INTO research_sources (prospect_id, url, title, kind, retrieved_at, snippet) VALUES (?, ?, ?, ?, ?, ?)',
    p.id, `https://${domain}/`, 'UGC signal: On TikTok (linked from their site)', 'other', new Date().toISOString(), 'https://www.tiktok.com/@flowly')
  const email = o.email ?? `marketing@${domain}`
  addContact(db, p.id, { email, source_url: `https://${domain}/contact`, verification_status: 'verified', jurisdiction: o.jurisdiction ?? 'US', is_primary: true, discovered_by: 'research' })
  await ensureMailDomains(db, p.id)
  return { id: p.id, email }
}

async function sponsorshipLead(domain: string) {
  const p = createProspect(db, { company_name: 'Sponsor Co', website: `https://${domain}`, category_id: 1, products: 'Gaming mice', campaign_concept: 'A clutch-play Short featuring the mouse.' })
  run(db, 'INSERT INTO research_sources (prospect_id, url, title, kind, retrieved_at, snippet) VALUES (?, ?, ?, ?, ?, ?)',
    p.id, `https://${domain}/creators`, 'Creator program', 'sponsorship_evidence', new Date().toISOString(), 'Join the Creator Program.')
  addContact(db, p.id, { email: `partnerships@${domain}`, source_url: `https://${domain}/creators`, verification_status: 'verified', jurisdiction: 'US', is_primary: true, discovered_by: 'research' })
  await ensureMailDomains(db, p.id)
  return p
}

const prepare = async (payload: object) => (await req('POST', '/api/outreach/send/prepare', payload)).json()
const confirmFrom = (p: { token: string; preview: { to: string; subject: string }; contentSha256: string }) =>
  req('POST', '/api/outreach/send/confirm', { token: p.token, recipient: p.preview.to, subject: p.preview.subject, contentSha256: p.contentSha256 })
const failing = (p: { checks: { label: string; ok: boolean }[] }) => p.checks.filter((c) => !c.ok).map((c) => c.label)

async function sentUgc(i = 1, setup = true) {
  if (setup) {
    await connectAndGoLive()
    await verifyPortfolio()
  }
  const l = await ugcLead(i)
  const pitch = await generatePitch(db, l.id, { channel: 'email' })
  expect((await req('POST', `/api/pitches/${pitch.id}/gmail-draft`, { confirm: true })).statusCode).toBe(201)
  approvePitch(db, pitch.id)
  const p = await prepare({ pitchId: pitch.id })
  expect(p.ready, JSON.stringify(failing(p))).toBe(true)
  expect((await confirmFrom(p)).statusCode).toBe(200)
  return { ...l, pitchId: pitch.id }
}

// ---------------------------------------------------------------------------------------------

describe('campaign separation', () => {
  it('seeds UGC categories, templates and candidates without touching sponsorship data', () => {
    expect(all(db, "SELECT slug FROM categories WHERE campaign_type = 'ugc'")).toHaveLength(8)
    expect(all(db, 'SELECT slug FROM email_templates')).toHaveLength(10)
    const ugcPool = get<{ n: number }>(db, "SELECT count(*) AS n FROM candidate_pool cp JOIN categories c ON c.id = cp.category_id WHERE c.campaign_type = 'ugc'")!.n
    expect(ugcPool).toBeGreaterThan(120)
    // Every existing row is a sponsorship row.
    expect(get(db, "SELECT count(*) AS n FROM categories WHERE campaign_type = 'sponsorship'")).toEqual({ n: 8 })
    expect(getDefaultMediaKit(db)?.kind).toBe('sponsorship')
  })

  it('research batches stay inside their campaign', () => {
    const ugc = createBatch(db, { size: 25, campaign: 'ugc' })
    const ugcCats = new Set(all<{ id: number }>(db, "SELECT id FROM categories WHERE campaign_type = 'ugc'").map((c) => c.id))
    expect(ugc.batch.campaign_type).toBe('ugc')
    expect(ugc.candidates.length).toBe(25)
    expect(ugc.candidates.every((c) => ugcCats.has(c.category_id))).toBe(true)
    run(db, "UPDATE research_batches SET status = 'cancelled'")
    const sp = createBatch(db, { size: 20 })
    expect(sp.batch.campaign_type).toBe('sponsorship')
    expect(sp.candidates.every((c) => !ugcCats.has(c.category_id))).toBe(true)
    run(db, "UPDATE research_batches SET status = 'cancelled'")
    expect(() => createBatch(db, { size: 25 })).toThrow(/Batch size must be one of/)
    expect(() => createBatch(db, { size: 0, campaign: 'ugc' })).toThrow(/1 to 200/)
    expect(() => createBatch(db, { size: 20, campaign: 'ugc', categoryIds: [1] })).toThrow(/No enabled UGC categories/)
  })

  it('a company can only be in one campaign: a sponsorship domain cannot become a UGC candidate or prospect', async () => {
    await sponsorshipLead('shared.test')
    expect(() => addPoolCandidate(db, { company_name: 'Shared', website: 'https://shared.test', category_id: cat('ugc-ai-tools') })).toThrow(/already in the CRM/)
    expect(() => createProspect(db, { company_name: 'Shared again', website: 'https://www.shared.test', category_id: cat('ugc-ai-tools') })).toThrow(/Already in the CRM/)
  })

  it('sponsorship revenue on the Overview excludes UGC, and UGC revenue comes only from booked deals', async () => {
    const s = await sponsorshipLead('sp.test')
    reviewProspect(db, s.id, 'approved')
    run(db, "UPDATE prospects SET stage = 'won', negotiated_value_cents = 50000, payment_status = 'paid' WHERE id = ?", s.id)
    const u = await ugcLead(1)
    reviewProspect(db, u.id, 'approved')
    createDeal(db, u.id, { status: 'negotiating', quoted_usd: 650, video_count: 3 })
    let o = ugcOverview(db)
    expect(o.totals.revenueBookedCents).toBe(0) // an offer under negotiation is never revenue
    expect(o.sponsorship.revenueBookedCents).toBe(50000)
    const d = createDeal(db, u.id, { status: 'booked', negotiated_usd: 600, video_count: 3, contract_status: 'signed' })
    updateDeal(db, d.id, { payment_status: 'paid', amount_paid_usd: 600 })
    o = ugcOverview(db)
    expect(o.totals.revenueBookedCents).toBe(60000)
    expect(o.totals.revenueCollectedCents).toBe(60000)
    expect(o.sponsorship.revenueBookedCents).toBe(50000)
    const overview = (await req('GET', '/api/overview')).json()
    expect(JSON.stringify(overview)).not.toContain('110000')
  })
})

describe('UGC research', () => {
  const SITE = {
    'https://notely.test/robots.txt': 'User-agent: *\nAllow: /',
    'https://notely.test/': html('Notely | AI meeting notes', '<p>Start for free. Watch the demo to see it in action.</p><a href="https://www.tiktok.com/@notelyapp">TikTok</a><a href="https://apps.apple.com/us/app/notely/id123">App Store</a><a href="/contact">Contact</a>',
      'Notely writes your meeting notes for you, so you can focus on the conversation.'),
    'https://notely.test/contact': html('Contact Notely', '<p>Brand and creator partnerships: <a href="mailto:marketing@notely.test">marketing@notely.test</a>. Help: support@notely.test</p>'),
  }
  const fetcher = (w: ReturnType<typeof fakeWeb>) => createFetcher({ fetchImpl: w.fetchImpl, sleep: async () => {}, delayMs: 0 })
  function candidate(name: string, website: string, slug: string): Candidate {
    const pool = addPoolCandidate(db, { company_name: name, website, category_id: cat(slug) }) as { id: number; domain: string; website: string }
    const batchId = run(db, "INSERT INTO research_batches (requested_size, category_ids, status, ai_provider, created_at, campaign_type) VALUES (25, '[]', 'running', 'mock', '2026-11-17', 'ugc')").lastId
    const id = run(db, 'INSERT INTO research_candidates (batch_id, pool_id, company_name, website, domain, category_id) VALUES (?, ?, ?, ?, ?, ?)',
      batchId, pool.id, name, pool.website, pool.domain, cat(slug)).lastId
    return { id, batch_id: batchId, pool_id: pool.id, company_name: name, website: pool.website, domain: pool.domain, category_id: cat(slug) }
  }

  it('records video-marketing signals, a UGC lead score and concepts built from the site', async () => {
    const r = await researchCandidate(db, candidate('Notely', 'https://notely.test', 'ugc-ai-tools'), { fetcher: fetcher(fakeWeb(SITE)) })
    expect(r.status).toBe('done')
    const p = get<{ campaign_type: string; ugc_concepts: string; fit_score: number; fit_breakdown: string; products: string; fit_explanation: string }>(db, 'SELECT * FROM prospects WHERE id = ?', r.prospectId!)!
    expect(p.campaign_type).toBe('ugc')
    expect(p.products).toBe('Notely writes your meeting notes for you, so you can focus on the conversation')
    const concepts = JSON.parse(p.ugc_concepts) as { title: string; outline: string; basis: string }[]
    expect(concepts).toHaveLength(2)
    expect(concepts[0].outline).toContain('Notely')
    expect(concepts[0].basis).toContain('meeting notes')
    expect(concepts[1].title).toBe('App install ad') // App Store link on the site
    const signals = all<{ title: string; snippet: string }>(db, "SELECT title, snippet FROM research_sources WHERE prospect_id = ? AND title LIKE 'UGC signal:%'", r.prospectId!).map((s) => s.title)
    expect(signals).toEqual(expect.arrayContaining(['UGC signal: On TikTok (linked from their site)', 'UGC signal: Free plan or free trial (easy to demo on camera)', 'UGC signal: Uses video on their site (demo or product video)']))
    expect(JSON.parse(p.fit_breakdown).evidence).toBeGreaterThan(0)
    expect(p.fit_explanation).toMatch(/TikTok/)
    expect(all(db, 'SELECT email FROM contacts WHERE prospect_id = ?', r.prospectId!)).toEqual([{ email: 'marketing@notely.test' }])
  })

  it('never qualifies an address on the website host (www.), and never corrects it', async () => {
    const l = await ugcLead(1, { email: 'press@www.ugc1.test' })
    const c = get<Parameters<typeof contactQualification>[1]>(db, 'SELECT * FROM contacts WHERE prospect_id = ?', l.id)!
    const q = contactQualification(db, c, 'ugc1.test')
    expect(q.qualifies).toBe(false)
    expect(q.reasons.join(' ')).toMatch(/website host/)
    expect(get(db, 'SELECT email FROM contacts WHERE prospect_id = ?', l.id)).toEqual({ email: 'press@www.ugc1.test' })
  })

  it('does not count a qualified lead below the minimum lead score', async () => {
    const l = await ugcLead(1, { score: 30 })
    run(db, "UPDATE prospects SET fit_breakdown = '{\"audience\":10,\"evidence\":0,\"recurring\":10,\"product\":5,\"contact\":5,\"integration\":0}' WHERE id = ?", l.id)
    expect(applyUgcMinimum(db, l.id, true)).toMatch(/below your minimum of 50/)
    expect(applyUgcMinimum(db, l.id, false)).toBeNull()
  })
})

describe('portfolio link', () => {
  it('is used only after a live check passes, and rejects unfinished or broken pages', async () => {
    expect(portfolioStatus(db).usable).toBe(false)
    expect((await req('PATCH', '/api/settings', { 'ugc.portfolioUrl': PORTFOLIO })).statusCode).toBe(409)
    expect((await req('POST', '/api/ugc/portfolio', { url: 'http://carter.test/ugc' })).statusCode).toBe(400)
    await verifyPortfolio()
    expect(portfolioStatus(db).link).toBe(PORTFOLIO)

    const bad = fakeWeb({
      'https://carter.test/soon': html('Coming soon', '<p>Coming soon</p>'),
    })
    for (const [url, why] of [['https://carter.test/soon', /unfinished/], ['https://carter.test/missing', /HTTP 404/]] as const) {
      setPortfolioUrl(db, url)
      const s = await checkPortfolio(db, bad.fetchImpl)
      expect(s.usable).toBe(false)
      expect(s.check.detail).toMatch(why)
    }
  })
})

describe('UGC pitches', () => {
  it('leads with what you make, uses researched concepts and the live portfolio link, and never the sponsorship media kit', async () => {
    await verifyPortfolio()
    const l = await ugcLead(1)
    const pitch = await generatePitch(db, l.id, { channel: 'email' })
    expect(pitch.subject).toBe('Product demo videos for Flowly 1')
    expect(pitch.body).toContain('Hi Flowly 1 team,')
    expect(pitch.body).toContain('- Problem to solution demo:')
    expect(pitch.body).toContain(PORTFOLIO)
    expect(pitch.body).toContain('Your site describes Flowly 1 as "Flowly turns meeting notes into tasks automatically"')
    expect(pitch.body).toMatch(/You're already on TikTok/)
    expect(pitch.body).toMatch(/Best,\nCarter$/)
    expect(pitch.body).not.toMatch(/followers|views|subscribers|media kit/i)
    expect(pitch.media_kit_id).toBeNull()
    const { checks } = evaluatePitch(db, pitch)
    expect(checks.filter((c) => c.level === 'blocker')).toEqual([])
    // The company was pending review: approving the UGC pitch approves the company.
    expect(get(db, 'SELECT review_status FROM prospects WHERE id = ?', l.id)).toEqual({ review_status: 'pending' })
    approvePitch(db, pitch.id)
    expect(get(db, 'SELECT review_status, stage FROM prospects WHERE id = ?', l.id)).toEqual({ review_status: 'approved', stage: 'awaiting_approval' })
  })

  it('cannot be approved without a verified portfolio link', async () => {
    const l = await ugcLead(1)
    const pitch = await generatePitch(db, l.id, { channel: 'email' })
    expect(pitch.body).not.toContain('https://')
    expect(JSON.parse(pitch.flags).map((f: { code: string }) => f.code)).toContain('no_portfolio')
    expect(() => approvePitch(db, pitch.id)).toThrow(/portfolio link/)
  })

  it('blocks claims about using the product or past clients, and warns about follower counts', async () => {
    await verifyPortfolio()
    const l = await ugcLead(1)
    const pitch = await generatePitch(db, l.id, { channel: 'email' })
    const codes = (body: string) => evaluatePitch(db, updatePitch(db, pitch.id, { body })).checks.map((c) => `${c.level}:${c.code}`)
    expect(codes(pitch.body.replace('Two demo ideas', "I've been using Flowly 1 for months. Two demo ideas"))).toContain('blocker:product_use')
    expect(codes(pitch.body.replace('Two demo ideas', 'My past clients loved these. Two demo ideas'))).toContain('blocker:past_clients')
    expect(codes(pitch.body.replace('Two demo ideas', 'I have lots of followers. Two demo ideas'))).toContain('warning:followers')
    expect(codes(pitch.body.replace(PORTFOLIO, 'https://carter.test/other'))).toContain('blocker:portfolio')
  })

  it('attaches the UGC rate card when you have one, never the sponsorship media kit', async () => {
    await verifyPortfolio()
    const ugcKit = importMediaKit(db, dir, { buffer: fakePdf('ugc rates'), originalFilename: 'UGC Rates.pdf', kind: 'ugc' }).kit
    expect(getDefaultMediaKit(db)?.original_filename).toBe('Media Kit.pdf') // sponsorship default unchanged
    expect(getDefaultMediaKit(db, 'ugc')?.id).toBe(ugcKit.id)
    const l = await ugcLead(1)
    expect((await generatePitch(db, l.id, { channel: 'email' })).media_kit_id).toBe(ugcKit.id)
  })

  it('suppressed or opted-out contacts are never drafted', async () => {
    await verifyPortfolio()
    const l = await ugcLead(1)
    addSuppression(db, 'email', l.email, 'Asked not to be contacted', 'opt_out')
    await expect(generatePitch(db, l.id, { channel: 'email' })).rejects.toThrow(/Cannot draft this email/)
  })
})

describe('Gmail drafts and sending', () => {
  it('creates a readable Gmail draft for review before approval, without any attachment', async () => {
    await connectAndGoLive()
    await verifyPortfolio()
    const l = await ugcLead(1)
    const pitch = await generatePitch(db, l.id, { channel: 'email' })
    const r = await req('POST', `/api/pitches/${pitch.id}/gmail-draft`, { confirm: true })
    expect(r.statusCode).toBe(201)
    const draft = [...google.state.drafts.values()][0]
    const msg = parseMessage(google.state.messages.get(draft.messageId)!.raw)
    expect(msg.headers.to).toContain(l.email)
    expect(msg.parts.filter((p) => p.filename)).toEqual([])
    const text = msg.parts.find((p) => p.contentType === 'text/plain')!.data.toString('utf8')
    expect(text).toContain(PORTFOLIO)
    expect(text).toContain('Laguna Beach, CA 92651')
    expect(text).toMatch(/unsubscribe/)
  })

  it('sending requires your approval and the separate confirmation', async () => {
    await connectAndGoLive()
    await verifyPortfolio()
    const l = await ugcLead(1)
    const pitch = await generatePitch(db, l.id, { channel: 'email' })
    await req('POST', `/api/pitches/${pitch.id}/gmail-draft`, { confirm: true })
    let p = await prepare({ pitchId: pitch.id })
    expect(p.ready).toBe(false)
    expect(failing(p)).toEqual(expect.arrayContaining(['Brand approved', 'Pitch approved and passes every check']))
    expect(google.sentMessages()).toEqual([])
    approvePitch(db, pitch.id)
    p = await prepare({ pitchId: pitch.id })
    expect(p.ready, JSON.stringify(failing(p))).toBe(true)
    expect((await confirmFrom(p)).statusCode).toBe(200)
    expect(google.sentMessages()).toHaveLength(1)
  })

  it('schedules UGC follow-ups on the UGC cadence from your UGC templates', async () => {
    const l = await sentUgc(1)
    const f = all<{ sequence: number; body: string; due_at: string }>(db, 'SELECT sequence, body, due_at FROM follow_ups WHERE prospect_id = ? ORDER BY sequence', l.id)
    expect(f).toHaveLength(2)
    expect(f[0].body).toMatch(/Following up on my note from .* about UGC videos for Flowly 1/)
    expect(f[0].body).toContain('"Problem to solution demo"')
    expect(f[1].body).toMatch(/One last check-in/)
    expect(f[1].body).toMatch(/Best,\nCarter$/)
  })

  it('never sends a second first email to the same company, whatever the campaign', async () => {
    const l = await sentUgc(1)
    const again = await generatePitch(db, l.id, { channel: 'email' }).catch((e: Error) => e)
    expect(String(again)).toMatch(/already|contacted|Cannot draft/i)
    expect(google.sentMessages()).toHaveLength(1)
  })

  it('autopilot never sends UGC first emails or UGC follow-ups', async () => {
    await connectAndGoLive()
    await verifyPortfolio()
    expect((await req('POST', '/api/outreach/autopilot', { enable: true, phrase: 'ENABLE AUTOPILOT' })).statusCode).toBe(200)
    const l = await ugcLead(1)
    await tick(db, gmail, { dataDir: dir, holder: 't' })
    expect(google.sentMessages()).toEqual([])
    expect(all(db, 'SELECT * FROM pitches WHERE prospect_id = ?', l.id)).toEqual([])
    // A UGC follow-up that is due is left for you.
    await req('POST', '/api/outreach/autopilot', { enable: false })
    const sent = await sentUgc(2, false)
    run(db, "UPDATE follow_ups SET due_at = '2020-01-01T00:00:00.000Z', status = 'approved' WHERE prospect_id = ?", sent.id)
    await req('POST', '/api/outreach/autopilot', { enable: true, phrase: 'ENABLE AUTOPILOT' })
    await tick(db, gmail, { dataDir: dir, holder: 't' })
    expect(google.sentMessages()).toHaveLength(1)
  })
})

describe('replies, opt-outs and the UGC pipeline', () => {
  it('a reply moves the company to Replied and stops its follow-ups', async () => {
    const l = await sentUgc(1)
    expect(ugcPipeline(db).find((r) => r.id === l.id)?.stage).toBe('email_sent')
    const thread = get<{ gmail_thread_id: string }>(db, 'SELECT gmail_thread_id FROM send_attempts')!.gmail_thread_id
    google.receive({ from: l.email, text: 'Thanks, we will think about it.', threadId: thread })
    await syncConversations(db, gmail)
    expect(ugcPipeline(db).find((r) => r.id === l.id)?.stage).toBe('replied')
    expect(all<{ status: string }>(db, 'SELECT status FROM follow_ups').map((f) => f.status)).toEqual(['cancelled', 'cancelled'])
  })

  it('an interested reply shows as Interested; an opt-out suppresses the address', async () => {
    const a = await sentUgc(1)
    const thread = get<{ gmail_thread_id: string }>(db, 'SELECT gmail_thread_id FROM send_attempts WHERE prospect_id = ?', a.id)!.gmail_thread_id
    google.receive({ from: a.email, text: "Sounds great, we'd love to chat. Are you free Thursday?", threadId: thread })
    await syncConversations(db, gmail)
    expect(ugcPipeline(db).find((r) => r.id === a.id)?.stage).toBe('interested')

    const b = await ugcLead(2)
    approvePitch(db, (await generatePitch(db, b.id, { channel: 'email' })).id)
    google.receive({ from: b.email, text: 'Please remove me from your list.', subject: 'unsubscribe' })
    addSuppression(db, 'email', b.email, 'Opted out', 'opt_out')
    const p = await prepare({ pitchId: get<{ id: number }>(db, "SELECT id FROM pitches WHERE prospect_id = ? AND status = 'approved'", b.id)!.id })
    expect(failing(p)).toContain('Recipient not on the do-not-contact list')
  })

  it('deals drive the pipeline: negotiating → booked → paid → recurring, with usage-rights guardrails', async () => {
    const l = await ugcLead(1)
    reviewProspect(db, l.id, 'approved')
    setStage(db, l.id, 'contacted')
    expect(() => createDeal(db, l.id, { status: 'booked', quoted_usd: 650 })).toThrow(/agreed price/)
    expect(() => createDeal(db, l.id, { usage_rights: 'perpetual' })).toThrow(/license fee/)
    expect(() => createDeal(db, l.id, { usage_rights: 'paid_ads' })).toThrow(/duration/)
    const d = createDeal(db, l.id, { status: 'negotiating', quoted_usd: 650, video_count: 3, usage_rights: 'paid_ads', paid_ads_duration: '30 days', usage_fee_usd: 150 })
    expect(ugcPipeline(db)[0].stage).toBe('negotiating')
    expect(get(db, 'SELECT stage FROM prospects WHERE id = ?', l.id)).toEqual({ stage: 'negotiating' })
    updateDeal(db, d.id, { status: 'booked', negotiated_usd: 600 })
    expect(ugcPipeline(db)[0].stage).toBe('project_booked')
    expect(ugcOverview(db).totals.revenueBookedCents).toBe(75000)
    expect(() => updateDeal(db, d.id, { payment_status: 'paid' })).toThrow(/amount paid/)
    updateDeal(db, d.id, { payment_status: 'paid', amount_paid_usd: 750 })
    expect(ugcPipeline(db)[0].stage).toBe('payment_received')
    createDeal(db, l.id, { status: 'booked', negotiated_usd: 900, recurring: true, title: 'Monthly' })
    expect(ugcPipeline(db)[0].stage).toBe('recurring_client')
    const sponsorship = await sponsorshipLead('sp2.test')
    expect(() => createDeal(db, sponsorship.id, {})).toThrow(/sponsorship company/)
  })

  it('a declined deal closes the company and stops outreach', async () => {
    const l = await sentUgc(1)
    createDeal(db, l.id, { status: 'declined' })
    expect(get(db, 'SELECT stage FROM prospects WHERE id = ?', l.id)).toEqual({ stage: 'not_interested' })
    expect(ugcPipeline(db)[0].stage).toBe('declined')
  })
})

describe('batch drafting', () => {
  it('drafts the best qualified leads only, never pads with weak ones, and copies to Gmail once the portfolio is live', async () => {
    await connectAndGoLive()
    await ugcLead(1, { score: 80 })
    await ugcLead(2, { score: 60 })
    await ugcLead(3, { score: 40 }) // below the minimum of 50
    let r = await prepareUgcDrafts(db, { count: 10, gmail, dataDir: dir })
    expect(r.pitches.map((p) => p.company)).toEqual(['Flowly 1', 'Flowly 2'])
    expect(r.gmailDrafts).toEqual([])
    expect(r.notes.join(' ')).toMatch(/2 of 10 drafted/)
    expect(r.notes.join(' ')).toMatch(/not copied to Gmail/)
    await verifyPortfolio()
    r = (await req('POST', '/api/ugc/gmail-drafts', {})).json()
    expect((r as unknown as { created: unknown[] }).created).toHaveLength(2)
    expect(google.state.drafts.size).toBe(2)
    expect(google.sentMessages()).toEqual([])
    // Every draft was rewritten with the link and is still waiting for approval.
    for (const p of all<{ body: string; status: string }>(db, "SELECT body, status FROM pitches WHERE status IN ('draft', 'approved')")) {
      expect(p.body).toContain(PORTFOLIO)
      expect(p.status).toBe('draft')
    }
  })

  it('rejects batch sizes outside 1 to 100', async () => {
    expect((await req('POST', '/api/ugc/drafts', { count: 0 })).statusCode).toBe(400)
    expect((await req('POST', '/api/ugc/drafts', { count: 101 })).statusCode).toBe(400)
  })
})

describe('dashboard, templates, settings and the daily run', () => {
  it('reports metrics, conversion rates and $0 research costs', async () => {
    await sentUgc(1)
    const m = ugcMetrics(db, 'day')
    expect(m).toMatchObject({ sent: 1, pitchesDrafted: 1, gmailDrafts: 1, approved: 1 })
    expect(ugcMetrics(db, 'week').sent).toBe(1)
    expect(ugcMetrics(db, 'month').sent).toBe(1)
    const c = ugcCosts(db)
    expect(c.estimatedUsd).toBe(0)
    expect(c.lines.find((x) => x.item === 'Email verification service')?.usd).toBe(0)
    const o = (await req('GET', '/api/ugc/overview')).json()
    expect(o.totals).toMatchObject({ prospects: 1, emailsSent: 1 })
    expect(o.stages).toHaveLength(14)
  })

  it('templates are editable, validated and resettable', async () => {
    expect((await req('PATCH', '/api/ugc/templates/ugc_initial', { body: 'Hi {{company}} {{followers}}' })).statusCode).toBe(400)
    const r = await req('PATCH', '/api/ugc/templates/ugc_initial', { body: '{{greeting}}\n\nShort and specific for {{company}}.\n\n{{concepts}}\n\n{{portfolio_line}}' })
    expect(r.statusCode).toBe(200)
    expect((await req('PATCH', '/api/ugc/templates/ugc_initial', { reset: true })).json().body).toContain("I'm Carter")
    const rendered = (await (async () => {
      const l = await ugcLead(1)
      reviewProspect(db, l.id, 'approved')
      const d = createDeal(db, l.id, { status: 'interested', video_count: 3 })
      return (await req('GET', `/api/ugc/deals/${d.id}/template/ugc_pricing_proposal`)).json()
    })())
    expect(rendered.body).toContain('1 video: $250')
    expect(rendered.body).toContain('Paid ad usage, whitelisting, raw footage and exclusivity are quoted separately')
    expect(rendered.body).toMatch(/Best,\nCarter$/)
  })

  it('validates UGC settings; prospecting targets never touch sending limits', async () => {
    const limits = getSetting(db, 'outreach.dailyLimits')
    expect((await req('PATCH', '/api/settings', { 'ugc.research': { dailyTarget: 100, autoDaily: true, minScore: 50, autoDraft: true } })).statusCode).toBe(200)
    expect((await req('PATCH', '/api/settings', { 'ugc.research': { dailyTarget: 500, autoDaily: true, minScore: 50, autoDraft: true } })).statusCode).toBe(400)
    expect((await req('PATCH', '/api/settings', { 'ugc.followUps': { firstAfterBusinessDays: 6, secondAfterBusinessDays: 5, max: 2 } })).statusCode).toBe(400)
    expect(getSetting(db, 'outreach.dailyLimits')).toEqual(limits)
  })

  it('the daily run starts one UGC batch per business day, sized to the target', async () => {
    const now = new Date('2026-11-17T18:00:00Z') // a Tuesday
    let s = await ugcDailyStep(db, { gmail: null, dataDir: dir, now, fetchImpl: web.fetchImpl })
    expect(s.batchId).toBeGreaterThan(0)
    expect(get(db, 'SELECT requested_size, campaign_type, origin FROM research_batches WHERE id = ?', s.batchId)).toEqual({ requested_size: 25, campaign_type: 'ugc', origin: 'daily' })
    s = await ugcDailyStep(db, { gmail: null, dataDir: dir, now, fetchImpl: web.fetchImpl })
    expect(get(db, 'SELECT count(*) AS n FROM research_batches')).toEqual({ n: 1 })
    // Not on weekends.
    setSetting(db, 'ugc.lastDaily', null)
    run(db, "UPDATE research_batches SET status = 'completed'")
    setSetting(db, 'outreach.businessHours', { timezone: 'America/Los_Angeles', start: '09:00', end: '17:00', days: [1, 2, 3, 4, 5] })
    await ugcDailyStep(db, { gmail: null, dataDir: dir, now: new Date('2026-11-21T18:00:00Z'), fetchImpl: web.fetchImpl })
    expect(get(db, 'SELECT count(*) AS n FROM research_batches')).toEqual({ n: 1 })
  })

  it('existing sponsorship pitches are unchanged', async () => {
    const s = await sponsorshipLead('sp3.test')
    reviewProspect(db, s.id, 'approved')
    const pitch = await generatePitch(db, s.id, { channel: 'email' })
    expect(pitch.media_kit_id).toBe(getDefaultMediaKit(db)!.id)
    expect(pitch.body.toLowerCase()).toContain('media kit')
    expect(getPitch(db, pitch.id).body).not.toContain(PORTFOLIO)
  })
})
