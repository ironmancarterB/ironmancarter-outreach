import { describe, expect, it, vi } from 'vitest'
import { all, get, run, setSetting, type DB } from '../packages/db'
import { addContact, createProspect, getProspectDetail, reviewProspect, setStage } from '../packages/crm/prospects'
import { importCsv } from '../packages/crm/csvio'
import { addPoolCandidate, cancelBatch, createBatch, getBatch } from '../packages/research/batches'
import { createFetcher } from '../packages/research/fetcher'
import { researchCandidate, reverifyContacts, type Candidate } from '../packages/research/pipeline'
import { claimNext, MAX_ATTEMPTS, processOne, recoverStale } from '../packages/research/worker'
import type { AIProvider } from '../packages/ai/types'
import { freshDb } from './helpers'
import { fakeWeb, html } from './fakeWeb'

const fetcherFor = (fetchImpl: typeof fetch) => createFetcher({ fetchImpl, sleep: async () => {}, delayMs: 0 })

// A brand site with a creator program page, a partnerships mailbox, a person's address and a support address.
const BRAND_SITE = {
  'https://brand-a.test/robots.txt': 'User-agent: *\nDisallow: /account',
  'https://brand-a.test/': html('Brand A | Gaming Mice', '<a href="/creators">Creators</a> <a href="/account">Account</a> <p>Built for gaming and esports.</p>', 'Lightweight gaming mice'),
  'https://brand-a.test/creators': html('Creator Program', '<p>Join the Brand A Creator Program. We partner with streamers on Twitch and YouTube.</p><p>Email <a href="mailto:partnerships@brand-a.test">partnerships@brand-a.test</a>. Founder: jane.doe@brand-a.test. Help: support@brand-a.test</p>'),
}

function candidate(db: DB, name: string, website: string, category = 1): Candidate {
  const pool = addPoolCandidate(db, { company_name: name, website, category_id: category }) as { id: number; domain: string; website: string }
  const batchId = run(db, "INSERT INTO research_batches (requested_size, category_ids, status, ai_provider, created_at) VALUES (20, '[1]', 'running', 'mock', '2026-10-30')").lastId
  const id = run(db, 'INSERT INTO research_candidates (batch_id, pool_id, company_name, website, domain, category_id) VALUES (?, ?, ?, ?, ?, ?)',
    batchId, pool.id, name, pool.website, pool.domain, category).lastId
  return { id, batch_id: batchId, pool_id: pool.id, company_name: name, website: pool.website, domain: pool.domain, category_id: category }
}

describe('research pipeline', () => {
  it('creates a sourced, scored prospect awaiting review, storing only business mailboxes', async () => {
    const db = freshDb()
    const web = fakeWeb(BRAND_SITE)
    const r = await researchCandidate(db, candidate(db, 'Brand A', 'https://brand-a.test'), { fetcher: fetcherFor(web.fetchImpl) })
    expect(r.status).toBe('done')
    const d = getProspectDetail(db, r.prospectId!)
    expect(d.prospect).toMatchObject({ source: 'research', stage: 'discovered', review_status: 'pending', domain: 'brand-a.test', products: 'Lightweight gaming mice', research_confidence: 'high' })
    expect(d.prospect.fit_score).toBeGreaterThanOrEqual(70)
    expect(d.prospect.fit_explanation).toMatch(/creator program/)
    expect(d.prospect.sponsorship_evidence).toContain('https://brand-a.test/creators')

    // Only the partnerships mailbox is stored, verified against the page it was published on.
    expect(d.contacts.map((c) => c.email)).toEqual(['partnerships@brand-a.test'])
    expect(d.contacts[0]).toMatchObject({ verification_status: 'verified', source_url: 'https://brand-a.test/creators', jurisdiction: 'unknown' })
    expect(d.contacts[0].verified_at).toBeTruthy()
    expect(d.contacts[0].eligibility.status).toBe('needs_review') // jurisdiction unknown → your review
    expect(JSON.stringify(d)).not.toContain('jane.doe')
    expect(d.notes[0].body).toMatch(/1 personal-looking address/)

    // Sources carry the exact sentence and retrieval time; robots.txt was respected.
    const evidence = d.sources.find((s) => s.kind === 'sponsorship_evidence' && s.title === 'Creator program')!
    expect(evidence.snippet).toContain('Creator Program')
    expect(evidence.retrieved_at).toBeTruthy()
    expect(web.calls).not.toContain('https://brand-a.test/account')
    expect(d.fetches.length).toBeGreaterThanOrEqual(2)
  })

  it('records robots-blocked and bot-protected sites without bypassing them', async () => {
    const db = freshDb()
    const web = fakeWeb({
      'https://closed.test/robots.txt': 'User-agent: *\nDisallow: /',
      'https://guarded.test/': { status: 403, body: 'Access denied' },
    })
    const f = fetcherFor(web.fetchImpl)
    const a = await researchCandidate(db, candidate(db, 'Closed', 'https://closed.test'), { fetcher: f })
    const b = await researchCandidate(db, candidate(db, 'Guarded', 'https://guarded.test'), { fetcher: f })
    expect(a).toMatchObject({ status: 'blocked', message: expect.stringMatching(/robots\.txt/) })
    expect(b).toMatchObject({ status: 'blocked', message: expect.stringMatching(/HTTP 403/) })
    expect(web.calls.filter((u) => u.startsWith('https://closed.test/') && !u.endsWith('robots.txt'))).toEqual([])
    expect(all(db, 'SELECT * FROM prospects')).toHaveLength(0)
  })

  it('skips brands already in the CRM, including through redirects, without fetching', async () => {
    const db = freshDb()
    createProspect(db, { company_name: 'Existing', website: 'existing.test' })
    const web = fakeWeb({ 'https://alias.test/': { status: 301, location: 'https://existing.test/' }, 'https://existing.test/': html('Existing', '<p>Hi</p>') })
    const f = fetcherFor(web.fetchImpl)
    const cand = candidate(db, 'Alias', 'https://alias.test')
    const r = await researchCandidate(db, cand, { fetcher: f })
    expect(r).toMatchObject({ status: 'duplicate', message: expect.stringMatching(/redirects to existing\.test/) })
    // Same domain as a CRM record: no network at all.
    const calls = web.calls.length
    const dup = await researchCandidate(db, { ...cand, id: cand.id, company_name: 'Existing Inc', website: 'https://existing.test', domain: 'existing.test' }, { fetcher: f })
    expect(dup.status).toBe('duplicate')
    expect(web.calls.length).toBe(calls)
  })

  it('puts contact-form-only brands in the manual queue', async () => {
    const db = freshDb()
    const web = fakeWeb({
      'https://formy.test/': html('Formy', '<a href="/contact">Contact us</a>'),
      'https://formy.test/contact': html('Contact', '<form><input type="email" name="email"><textarea name="message"></textarea></form>'),
    })
    const r = await researchCandidate(db, candidate(db, 'Formy', 'https://formy.test'), { fetcher: fetcherFor(web.fetchImpl) })
    const [c] = getProspectDetail(db, r.prospectId!).contacts
    expect(c).toMatchObject({ email: null, contact_form_url: 'https://formy.test/contact' })
    expect(c.eligibility.status).toBe('ineligible')
  })

  it('never reuses an address that belongs to another company', async () => {
    const db = freshDb()
    const other = createProspect(db, { company_name: 'Agency', website: 'agency.test' })
    addContact(db, other.id, { email: 'partnerships@brand-a.test' })
    const r = await researchCandidate(db, candidate(db, 'Brand A', 'https://brand-a.test'), { fetcher: fetcherFor(fakeWeb(BRAND_SITE).fetchImpl) })
    expect(getProspectDetail(db, r.prospectId!).contacts).toHaveLength(0)
  })

  it('uses local AI for the campaign concept when selected, and the template if it fails (never a paid provider)', async () => {
    const db = freshDb()
    setSetting(db, 'ai.provider', 'ollama')
    const paid = vi.fn()
    const local: AIProvider = { id: 'ollama', billing: 'free_local', model: () => 'gemma', generate: async () => ({ text: 'A ranked-climb series with Brand A mice.', model: 'gemma', inputTokens: 10, outputTokens: 10 }) }
    const r = await researchCandidate(db, candidate(db, 'Brand A', 'https://brand-a.test'), {
      fetcher: fetcherFor(fakeWeb(BRAND_SITE).fetchImpl),
      ai: { providers: { ollama: local, anthropic: { id: 'anthropic', billing: 'paid_api', model: () => 'x', generate: paid } } },
    })
    expect(getProspectDetail(db, r.prospectId!).prospect.campaign_concept).toMatch(/^A ranked-climb series.*AI draft from ollama/)

    const broken: AIProvider = { ...local, generate: async () => { throw new Error('connection refused') } }
    const r2 = await researchCandidate(db, candidate(db, 'Brand B', 'https://brand-b.test'), {
      fetcher: fetcherFor(fakeWeb({ 'https://brand-b.test/': html('Brand B', '<p>Gaming headsets</p>') }).fetchImpl),
      ai: { providers: { ollama: broken, anthropic: { id: 'anthropic', billing: 'paid_api', model: () => 'x', generate: paid } } },
    })
    const d2 = getProspectDetail(db, r2.prospectId!)
    expect(d2.prospect.campaign_concept).toMatch(/clutch play/)
    expect(d2.notes[0].body).toMatch(/Local AI unavailable/)
    expect(paid).not.toHaveBeenCalled()
  })
})

describe('research batches', () => {
  it('fills a batch by category priority within quotas and records any shortfall', () => {
    const db = freshDb()
    run(db, 'UPDATE categories SET enabled = 0')
    run(db, "UPDATE categories SET enabled = 1, priority = 1, research_quota = 3 WHERE slug = 'vpn-privacy'")
    run(db, "UPDATE categories SET enabled = 1, priority = 2, research_quota = 2 WHERE slug = 'gaming-peripherals'")
    createProspect(db, { company_name: 'NordVPN', website: 'nordvpn.com' })
    const { batch, candidates } = createBatch(db, { size: 20 })
    expect(batch.total).toBe(5)
    expect(candidates.slice(0, 3).every((c) => c.category_name === 'VPN and Digital Privacy')).toBe(true)
    expect(candidates.map((c) => c.domain)).not.toContain('nordvpn.com')
    expect(batch.shortfall_note).toMatch(/Only 5 of 20/)
  })

  it('mixes categories that share a priority instead of filling one category first', () => {
    const db = freshDb()
    const { candidates } = createBatch(db, { size: 20 })
    const perCategory = new Map<string, number>()
    for (const c of candidates) perCategory.set(c.category_name, (perCategory.get(c.category_name) ?? 0) + 1)
    expect(perCategory.size).toBe(8)
    expect(Math.max(...perCategory.values()) - Math.min(...perCategory.values())).toBeLessThanOrEqual(1)
  })

  it('validates size, allows one active batch, and returns unstarted brands on cancel', () => {
    const db = freshDb()
    expect(() => createBatch(db, { size: 30 })).toThrow(/20, 50, 100, 200, 500/)
    const { batch } = createBatch(db, { size: 20 })
    expect(batch.total).toBe(20)
    expect(() => createBatch(db, { size: 20 })).toThrow(/already running/)
    cancelBatch(db, batch.id)
    expect(get(db, "SELECT count(*) AS n FROM candidate_pool WHERE status = 'queued'")).toEqual({ n: 0 })
    expect(getBatch(db, batch.id).batch.status).toBe('cancelled')
  })

  it('rejects duplicate candidates', () => {
    const db = freshDb()
    expect(() => addPoolCandidate(db, { company_name: 'Razer again', website: 'https://www.razer.com/store', category_id: 1 })).toThrow(/already a candidate/)
    createProspect(db, { company_name: 'Mine', website: 'mine.test' })
    expect(() => addPoolCandidate(db, { company_name: 'Mine', website: 'mine.test', category_id: 1 })).toThrow(/already in the CRM/)
  })
})

describe('worker crash recovery', () => {
  function oneCandidateBatch(db: DB) {
    run(db, 'UPDATE categories SET enabled = 0')
    run(db, "UPDATE categories SET enabled = 1, research_quota = 1 WHERE slug = 'gaming-peripherals'")
    run(db, "UPDATE candidate_pool SET status = 'excluded'")
    addPoolCandidate(db, { company_name: 'Brand A', website: 'https://brand-a.test', category_id: 1 })
    return createBatch(db, { size: 20 })
  }

  it('resumes interrupted candidates and gives up after repeated crashes', () => {
    const db = freshDb()
    oneCandidateBatch(db)
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      expect(claimNext(db)).not.toBeNull()   // worker claims, then "crashes"
      recoverStale(db)
    }
    const c = get<{ status: string; attempts: number }>(db, 'SELECT status, attempts FROM research_candidates')!
    expect(c).toEqual({ status: 'failed', attempts: MAX_ATTEMPTS })
    expect(get(db, 'SELECT status FROM research_batches')).toEqual({ status: 'completed' })
  })

  it('processes a batch end to end and never redoes finished work', async () => {
    const db = freshDb()
    const { batch } = oneCandidateBatch(db)
    const fetcher = fetcherFor(fakeWeb(BRAND_SITE).fetchImpl)
    expect(await processOne(db, { fetcher })).toBe(true)
    expect(await processOne(db, { fetcher })).toBe(false)
    recoverStale(db)
    expect(await processOne(db, { fetcher })).toBe(false)
    const b = getBatch(db, batch.id)
    expect(b.batch).toMatchObject({ status: 'completed', done: 1 })
    expect(get(db, 'SELECT status FROM candidate_pool WHERE domain = ?', 'brand-a.test')).toEqual({ status: 'researched' })
    expect(all(db, 'SELECT * FROM prospects')).toHaveLength(1)
  })
})

describe('review before outreach', () => {
  it('blocks outreach stages until approved', () => {
    const db = freshDb()
    const p = createProspect(db, { company_name: 'Brand', website: 'brand.test' })
    expect(() => setStage(db, p.id, 'draft_ready')).toThrow(/Approve Brand/)
    expect(() => setStage(db, p.id, 'contacted')).toThrow(/Approve Brand/)
    const approved = reviewProspect(db, p.id, 'approved')
    expect(approved).toMatchObject({ review_status: 'approved', stage: 'qualified' })
    expect(setStage(db, p.id, 'draft_ready').stage).toBe('draft_ready')
  })

  it('requires a reason to reject and pauses the company', () => {
    const db = freshDb()
    const p = createProspect(db, { company_name: 'Brand', website: 'brand.test' })
    expect(() => reviewProspect(db, p.id, 'rejected')).toThrow(/reason/)
    expect(reviewProspect(db, p.id, 'rejected', 'Not a fit')).toMatchObject({ review_status: 'rejected', stage: 'paused', review_note: 'Not a fit' })
    expect(() => setStage(db, p.id, 'draft_ready')).toThrow(/Approve/)
  })

  it('does not let new or imported companies skip review', () => {
    const db = freshDb()
    expect(() => createProspect(db, { company_name: 'X', stage: 'contacted' })).toThrow(/unreviewed/)
    const r = importCsv(db, 'company_name,stage\nY,draft_ready\n', { dryRun: false })
    expect(r.results[0]).toMatchObject({ status: 'error', message: expect.stringMatching(/unreviewed/) })
  })
})

describe('contact re-verification (freshness)', () => {
  it('re-confirms addresses still published and fails ones that disappeared', async () => {
    const db = freshDb()
    const r = await researchCandidate(db, candidate(db, 'Brand A', 'https://brand-a.test'), { fetcher: fetcherFor(fakeWeb(BRAND_SITE).fetchImpl) })
    const still = await reverifyContacts(db, r.prospectId!, fetcherFor(fakeWeb(BRAND_SITE).fetchImpl))
    expect(still).toEqual([{ email: 'partnerships@brand-a.test', result: 'still_published', detail: 'https://brand-a.test/creators' }])
    const gone = await reverifyContacts(db, r.prospectId!, fetcherFor(fakeWeb({ ...BRAND_SITE, 'https://brand-a.test/creators': html('Creators', '<p>Applications closed.</p>') }).fetchImpl))
    expect(gone[0].result).toBe('not_found')
    expect(getProspectDetail(db, r.prospectId!).contacts[0].verification_status).toBe('failed')
  })
})
