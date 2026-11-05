import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../apps/server/src/app'
import { all, get, run, type DB } from '../packages/db'
import { addContact, createProspect, reviewProspect, setStage } from '../packages/crm/prospects'
import { addSuppression } from '../packages/crm/suppressions'
import { bounceSeverity, departmentOf, emailGate, leadMetrics, listLeads, qualifyContact } from '../packages/crm/leads'
import { addPoolCandidate, createBatch, getBatch } from '../packages/research/batches'
import { createFetcher } from '../packages/research/fetcher'
import { checkDueMailDomains, checkMailDomain, ensureMailDomains, mailDomainStatus, type MailLookup } from '../packages/research/mailDomain'
import { processOne } from '../packages/research/worker'
import { approvePitch, evaluatePitch, generatePitch } from '../packages/pitch/service'
import { fakeWeb, html } from './fakeWeb'
import { freshDb } from './helpers'

let db: DB
beforeEach(() => { db = freshDb() })

const SOURCE = 'https://brand.test/partners'
const direct = { source_url: SOURCE, verification_status: 'verified' as const, discovered_by: 'research' as const, contact_tier: 'VERIFIED_DIRECT' as const, confidence: 'high' as const, verified_at: new Date().toISOString(), jurisdiction: 'US', decision_note: 'Published on the partners page.' }
const brand = (domain = 'brand.test', name = 'Brand Co') => createProspect(db, { company_name: name, website: `https://${domain}/`, category_id: 1 })
const lead = (id: number) => listLeads(db).find((l) => l.id === id)!
async function brandWithEmail(email = 'partnerships@brand.test', domain = 'brand.test', name = 'Brand Co') {
  const p = brand(domain, name)
  const contact = addContact(db, p.id, { ...direct, email, source_url: `https://${domain}/partners` })
  await ensureMailDomains(db, p.id)
  return { p, contact }
}
const base = { source_url: SOURCE, verification_status: 'verified', contact_tier: 'VERIFIED_DIRECT', agency_confirmed: null, confidence: 'high', evidence: null, decision_note: null }
const qualify = (over: Record<string, unknown>, ctx: Partial<{ prospectDomain: string | null; mailDomain: 'ok' | 'no_mail' | 'invalid' | 'unknown' | null; suppression: string | null }> = {}) =>
  qualifyContact({ contact: { email: 'partnerships@brand.test', ...base, ...over } as never, prospectDomain: 'brand.test', mailDomain: 'ok', suppression: null, ...ctx })

describe('confidence levels', () => {
  it('HIGH: listed by the brand on its own domain, sourced, domain passes, no bounce', () => {
    expect(qualify({})).toMatchObject({ confidence: 'high', qualifies: true })
  })

  it('MEDIUM: credible public source with a documented connection', () => {
    expect(qualify({ email: 'creators@sister.test', decision_note: 'Published on the brand site, on a domain the brand uses.' })).toMatchObject({ confidence: 'medium', qualifies: true })
    expect(qualify({ email: 'pr@agency.test', contact_tier: 'VERIFIED_AGENCY', agency_confirmed: 'brand_site', confidence: 'medium', evidence: 'Named on the brand site' })).toMatchObject({ confidence: 'medium', qualifies: true })
    expect(qualify({ confidence: 'medium' })).toMatchObject({ confidence: 'medium', qualifies: true })
  })

  it('UNVERIFIED: anything untraceable, guessed, undeliverable by DNS, bounced or unconnected', () => {
    const cases: [ReturnType<typeof qualify>, RegExp][] = [
      [qualify({ source_url: null }), /No source URL/],
      [qualify({ verification_status: 'unverified' }), /Not verified/],
      [qualify({ verification_status: 'failed' }), /No longer published/],
      [qualify({ contact_tier: 'PUBLIC_UNVERIFIED' }), /has not been verified/],
      [qualify({ contact_tier: 'VERIFIED_AGENCY', evidence: 'x' }), /not confirmed/],
      [qualify({ email: 'not-an-address' }), /valid email/],
      [qualify({ email: 'you@example.com' }), /placeholder/],
      [qualify({ email: 'brandco@gmail.com', decision_note: 'x' }), /Free email/],
      [qualify({ email: 'pr@elsewhere.test' }), /no documented connection/],
      [qualify({}, { mailDomain: 'invalid' }), /cannot receive mail/],
      [qualify({}, { mailDomain: 'no_mail' }), /cannot receive mail/],
      [qualify({}, { mailDomain: null }), /not been checked/],
      [qualify({}, { suppression: 'bounce' }), /hard bounce/],
      [qualify({}, { suppression: 'opt_out' }), /do-not-contact/],
    ]
    for (const [q, why] of cases) {
      expect(q).toMatchObject({ confidence: 'unverified', qualifies: false })
      expect(q.reasons.join(' ')).toMatch(why)
    }
  })

  it('never claims delivery from DNS or format: only a reply from the address is evidence', async () => {
    const { p } = await brandWithEmail()
    expect(lead(p.id)).toMatchObject({ confidence: 'high', delivery_evidence: 'Not confirmed' })
    const account = run(db, "INSERT INTO mail_accounts (provider, email, status, scopes, secret_ref, connected_at, created_at, updated_at) VALUES ('gmail', 'me@x.test', 'connected', '[]', 'x', '2026-01-01', '2026-01-01', '2026-01-01')").lastId
    const thread = run(db, "INSERT INTO email_threads (account_id, prospect_id, gmail_thread_id, created_at, updated_at) VALUES (?, ?, 't1', '2026-01-01', '2026-01-01')", account, p.id).lastId
    run(db, "INSERT INTO email_messages (thread_id, gmail_message_id, direction, kind, from_email, created_at) VALUES (?, 'm1', 'inbound', 'reply', 'partnerships@brand.test', '2026-01-01')", thread)
    expect(lead(p.id).delivery_evidence).toBe('Confirmed: this address replied')
  })
})

describe('actionable list', () => {
  it('excludes brands with no email, form-only and social-only brands, each with its reason', () => {
    const none = brand('none.test', 'No Contact')
    const form = brand('form.test', 'Form Only')
    addContact(db, form.id, { contact_form_url: 'https://form.test/contact', source_url: 'https://form.test/contact', discovered_by: 'research' })
    const social = brand('social.test', 'Social Only')
    run(db, "INSERT INTO contact_findings (prospect_id, kind, value, source_url, decision, reason, created_at) VALUES (?, 'social', 'https://instagram.com/x', 'https://social.test/', 'needs_review', 'Profile', '2026-01-01')", social.id)
    expect(lead(none.id)).toMatchObject({ actionable: false, exclusion: { code: 'no_email' } })
    expect(lead(form.id)).toMatchObject({ actionable: false, exclusion: { code: 'form_only' } })
    expect(lead(social.id)).toMatchObject({ actionable: false, exclusion: { code: 'social_only' } })
    expect(leadMetrics(db)).toMatchObject({ actionable: 0, withoutUsableEmail: 3, discoveryRate: 0 })
  })

  it('accepts a valid public business contact and saves everything the list shows', async () => {
    const { p } = await brandWithEmail()
    expect(lead(p.id)).toMatchObject({
      actionable: true, exclusion: null, email: 'partnerships@brand.test', department: 'Brand partnerships / sponsorships', source_url: 'https://brand.test/partners',
      confidence: 'high', bounce_status: 'none', previously_contacted: false, last_contacted_at: null, website: 'https://brand.test/', outreach_status: 'needs_review',
    })
    expect(lead(p.id).verified_at).toBeTruthy()
    expect(leadMetrics(db)).toMatchObject({ actionable: 1, withQualifyingEmail: 1, discoveryRate: 1, awaitingReview: 1, awaitingOutreach: 0 })
  })

  it('rejects a guessed address: no source means it can never qualify, even on the brand’s domain', async () => {
    const p = brand()
    addContact(db, p.id, { email: 'partnerships@brand.test', discovered_by: 'manual' })
    await ensureMailDomains(db, p.id)
    expect(lead(p.id)).toMatchObject({ actionable: false, confidence: 'unverified', exclusion: { code: 'unverified_email' } })
    expect(() => addContact(db, p.id, { email: 'hello@brand.test', verification_status: 'verified' })).toThrow(/source URL/)
  })

  it('excludes invalid domains and leaves unchecked ones out until checked', async () => {
    const p = brand()
    addContact(db, p.id, { ...direct, email: 'partnerships@brand.test' })
    expect(lead(p.id)).toMatchObject({ actionable: false, exclusion: { code: 'domain_unchecked' } })
    await checkMailDomain(db, 'brand.test', async () => ({ status: 'invalid', detail: 'Does not exist' }))
    expect(lead(p.id)).toMatchObject({ actionable: false, exclusion: { code: 'invalid_domain' } })
  })

  it('suppresses bounced addresses, and picks another qualifying address on the same brand if there is one', async () => {
    const { p } = await brandWithEmail()
    addSuppression(db, 'email', 'partnerships@brand.test', 'Hard bounce', 'bounce')
    expect(lead(p.id)).toMatchObject({ actionable: false, bounce_status: 'bounced', exclusion: { code: 'bounced' } })
    addContact(db, p.id, { ...direct, email: 'creators@brand.test' })
    expect(lead(p.id)).toMatchObject({ actionable: true, email: 'creators@brand.test' })
  })

  it('excludes opted-out contacts, suppressed domains, rejected brands and paused brands', async () => {
    const a = await brandWithEmail('partnerships@a.test', 'a.test', 'A')
    addSuppression(db, 'email', 'partnerships@a.test', 'Opted out', 'opt_out')
    const b = await brandWithEmail('partnerships@b.test', 'b.test', 'B')
    addSuppression(db, 'domain', 'b.test', 'Do not contact')
    const c = await brandWithEmail('partnerships@c.test', 'c.test', 'C')
    reviewProspect(db, c.p.id, 'rejected', 'not a fit')
    const d = await brandWithEmail('partnerships@d.test', 'd.test', 'D')
    setStage(db, d.p.id, 'paused')
    expect(lead(a.p.id).exclusion?.code).toBe('suppressed')
    expect(lead(b.p.id).exclusion?.code).toBe('suppressed')
    expect(lead(c.p.id).exclusion?.code).toBe('rejected')
    expect(lead(d.p.id).exclusion?.code).toBe('closed')
  })

  it('excludes brands already contacted, under the one-sequence-per-company rule', async () => {
    const { p } = await brandWithEmail()
    run(db, "UPDATE prospects SET first_contacted_at = '2026-10-01', last_contacted_at = '2026-10-01' WHERE id = ?", p.id)
    expect(lead(p.id)).toMatchObject({ actionable: false, has_qualifying_email: true, previously_contacted: true, last_contacted_at: '2026-10-01', exclusion: { code: 'already_contacted' } })
    expect(leadMetrics(db)).toMatchObject({ alreadyContacted: 1, withQualifyingEmail: 1, actionable: 0 })
  })

  it('offers the best department first and keeps general mailboxes for last', async () => {
    expect(departmentOf({ email: 'influencers@b.test', contact_tier: 'VERIFIED_DIRECT', contact_type: null }).rank).toBeLessThan(departmentOf({ email: 'partnerships@b.test', contact_tier: 'VERIFIED_DIRECT', contact_type: null }).rank)
    const p = brand()
    for (const email of ['info@brand.test', 'press@brand.test', 'marketing@brand.test', 'partnerships@brand.test', 'creators@brand.test']) addContact(db, p.id, { ...direct, email })
    await ensureMailDomains(db, p.id)
    expect(lead(p.id)).toMatchObject({ email: 'creators@brand.test', department: 'Influencer / creator partnerships' })
    run(db, "DELETE FROM contacts WHERE email IN ('creators@brand.test', 'partnerships@brand.test')")
    expect(lead(p.id).email).toBe('marketing@brand.test')
    run(db, "DELETE FROM contacts WHERE email IN ('marketing@brand.test', 'press@brand.test')")
    expect(lead(p.id)).toMatchObject({ email: 'info@brand.test', department: 'General business' })
  })

  it('still shows the unknown-country check instead of treating it as eligible', async () => {
    const p = brand()
    addContact(db, p.id, { ...direct, email: 'partnerships@brand.test', jurisdiction: 'unknown' })
    await ensureMailDomains(db, p.id)
    expect(lead(p.id).actionable).toBe(true)
    expect(lead(p.id).needs_before_send.join(' ')).toMatch(/jurisdiction is unknown/)
  })
})

describe('outreach gate', () => {
  const approved = async () => {
    const r = await brandWithEmail()
    reviewProspect(db, r.p.id, 'approved')
    run(db, 'INSERT INTO research_sources (prospect_id, url, title, kind, retrieved_at, snippet) VALUES (?, ?, ?, ?, ?, ?)', r.p.id, 'https://brand.test/creators', 'Creator program', 'sponsorship_evidence', new Date().toISOString(), 'Join our Creator Program.')
    run(db, "UPDATE prospects SET campaign_concept = 'A clutch-play Short featuring the product.', products = 'Mice' WHERE id = ?", r.p.id)
    return r
  }

  it('drafting still works for a qualifying contact, and picks it as the recipient', async () => {
    const { p } = await approved()
    const pitch = await generatePitch(db, p.id, { channel: 'email' })
    expect(pitch).toMatchObject({ status: 'draft', recipient_email: 'partnerships@brand.test' })
    expect(get(db, "SELECT count(*) AS n FROM send_attempts")).toEqual({ n: 0 })
  })

  it('checks the domain before drafting and refuses when it cannot receive mail', async () => {
    const p = brand()
    addContact(db, p.id, { ...direct, email: 'partnerships@brand.test' })
    reviewProspect(db, p.id, 'approved')
    const noMail: MailLookup = async () => ({ status: 'no_mail', detail: 'No mail servers' })
    await expect(generatePitch(db, p.id, { channel: 'email' }, { mailLookup: noMail })).rejects.toThrow(/cannot receive mail/)
    expect(mailDomainStatus(db, 'brand.test')?.status).toBe('no_mail')
  })

  it('refuses bounced and opted-out addresses, even when they are chosen explicitly', async () => {
    const { p, contact } = await approved()
    addSuppression(db, 'email', contact.email!, 'Hard bounce', 'bounce')
    await expect(generatePitch(db, p.id, { channel: 'email', contact_id: contact.id })).rejects.toThrow(/hard bounce/)
    const other = await brandWithEmail('partnerships@o.test', 'o.test', 'Other')
    reviewProspect(db, other.p.id, 'approved')
    addSuppression(db, 'email', other.contact.email!, 'Opted out', 'opt_out')
    await expect(generatePitch(db, other.p.id, { channel: 'email' })).rejects.toThrow(/do-not-contact/)
  })

  it('blocks approval and the Gmail step if the address stops qualifying after drafting', async () => {
    const { p, contact } = await approved()
    const pitch = await generatePitch(db, p.id, { channel: 'email' })
    addSuppression(db, 'email', contact.email!, 'Hard bounce', 'bounce')
    expect(evaluatePitch(db, pitch).checks.some((c) => c.code === 'contact_unqualified' && c.level === 'blocker')).toBe(true)
    expect(() => approvePitch(db, pitch.id)).toThrow(/hard bounce/)
  })

  it('prevents a second outreach sequence and preserves the history of the first', async () => {
    const { p, contact } = await approved()
    const pitch = await generatePitch(db, p.id, { channel: 'email' })
    const account = run(db, "INSERT INTO mail_accounts (provider, email, status, scopes, secret_ref, connected_at, created_at, updated_at) VALUES ('gmail', 'me@x.test', 'connected', '[]', 'x', '2026-01-01', '2026-01-01', '2026-01-01')").lastId
    const draft = run(db, `INSERT INTO gmail_drafts (account_id, kind, prospect_id, pitch_id, local_ref, rfc822_message_id, recipient, subject, content_sha256, status, created_at, updated_at)
      VALUES (?, 'pitch', ?, ?, 'r1', '<r1@x.test>', ?, 's', 'h', 'sent', '2026-01-01', '2026-01-01')`, account, p.id, pitch.id, contact.email).lastId
    run(db, `INSERT INTO send_attempts (kind, prospect_id, contact_id, pitch_id, draft_row_id, account_id, idempotency_key, recipient, content_sha256, status, day_key, confirmed_at, created_at, updated_at)
      VALUES ('initial', ?, ?, ?, ?, ?, 'initial:p1', ?, 'h', 'sent', '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`, p.id, contact.id, pitch.id, draft, account, contact.email)
    expect(emailGate(db, p.id, contact).join(' ')).toMatch(/already sent/)
    await expect(generatePitch(db, p.id, { channel: 'email' })).rejects.toThrow(/already sent/)
    expect(all(db, "SELECT * FROM send_attempts")).toHaveLength(1)
    expect(lead(p.id)).toMatchObject({ actionable: false, previously_contacted: true, exclusion: { code: 'already_contacted' } })
  })

  it('leaves manual portal submissions available for brands without an email', async () => {
    const p = brand()
    addContact(db, p.id, { contact_form_url: 'https://brand.test/apply', source_url: 'https://brand.test/apply', discovered_by: 'research' })
    reviewProspect(db, p.id, 'approved')
    await expect(generatePitch(db, p.id, { channel: 'manual_form' })).resolves.toMatchObject({ channel: 'manual_form' })
    expect(lead(p.id).actionable).toBe(false)
  })
})

describe('bounces', () => {
  it('tells temporary failures from permanent ones', () => {
    expect(bounceSeverity('550 5.1.1 The email account does not exist')).toBe('permanent')
    expect(bounceSeverity('452 4.2.2 Mailbox full; will retry')).toBe('temporary')
    expect(bounceSeverity('Your message could not be delivered')).toBe('permanent')
    expect(bounceSeverity('Tried 4.4.1, finally failed 5.4.1')).toBe('permanent')
  })
})

describe('research until the target is reached', () => {
  const quiet = (routes: Parameters<typeof fakeWeb>[0]) => createFetcher({ fetchImpl: fakeWeb(routes).fetchImpl, sleep: async () => {}, delayMs: 0 })
  const onlyCategory = (quota = 25) => {
    run(db, 'UPDATE categories SET enabled = 0')
    run(db, 'UPDATE categories SET enabled = 1, research_quota = ? WHERE id = 1', quota)
    run(db, "UPDATE candidate_pool SET status = 'excluded'")
  }
  const site = (d: string, email?: string) => ({
    [`https://${d}/`]: html(`Brand ${d}`, '<a href="/contact">Contact</a><p>Gaming gear for streamers.</p>'),
    [`https://${d}/contact`]: html('Contact', email ? `<p>Partnerships: <a href="mailto:${email}">${email}</a></p>` : '<p>Use our chat.</p>'),
  })
  const drain = async (fetcher: ReturnType<typeof createFetcher>) => { while (await processOne(db, { fetcher })) { /* next */ } }

  it('keeps researching past brands with no email, tops up, and stops once it has enough', async () => {
    onlyCategory()
    // 22 brands: the first 20 have no email, so only the top-up can reach any that do. Asks for 20, finds 2.
    const routes: Parameters<typeof fakeWeb>[0] = {}
    for (let i = 0; i < 20; i++) { addPoolCandidate(db, { company_name: `Empty ${i}`, website: `https://empty${i}.test`, category_id: 1 }); Object.assign(routes, site(`empty${i}.test`)) }
    for (let i = 0; i < 2; i++) { addPoolCandidate(db, { company_name: `Good ${i}`, website: `https://good${i}.test`, category_id: 1 }); Object.assign(routes, site(`good${i}.test`, `partnerships@good${i}.test`)) }
    const { batch } = createBatch(db, { size: 20 })
    expect(batch.total).toBe(20)
    await drain(quiet(routes))
    const b = getBatch(db, batch.id)
    expect(b.batch).toMatchObject({ status: 'completed', total: 22, researched: 22, qualified: 2 })
    expect(b.batch.shortfall_note).toMatch(/Found 2 of 20/)
    expect(b.batch.shortfall_note).toMatch(/rather than filled with unverified/)
    expect(listLeads(db).filter((l) => l.actionable).map((l) => l.email).sort()).toEqual(['partnerships@good0.test', 'partnerships@good1.test'])
    expect(leadMetrics(db).research).toMatchObject({ researched: 22, qualifying: 2, rejected: 20, duplicates: 0 })
    expect(leadMetrics(db).research.rate).toBeCloseTo(2 / 22)
  })

  it('stops at the target and returns unneeded brands to the pool', async () => {
    onlyCategory(30)
    const routes: Parameters<typeof fakeWeb>[0] = {}
    for (let i = 0; i < 25; i++) { addPoolCandidate(db, { company_name: `Good ${i}`, website: `https://good${i}.test`, category_id: 1 }); Object.assign(routes, site(`good${i}.test`, `partnerships@good${i}.test`)) }
    const { batch } = createBatch(db, { size: 20 })
    await drain(quiet(routes))
    const b = getBatch(db, batch.id).batch
    expect(b).toMatchObject({ status: 'completed', qualified: 20, researched: 20 })
    expect(b.shortfall_note).toBeNull()
    expect(all(db, "SELECT 1 FROM candidate_pool WHERE status = 'available' AND domain LIKE 'good%'")).toHaveLength(5)
  })

  it('never researches more than four times the target', async () => {
    onlyCategory(500)
    const routes: Parameters<typeof fakeWeb>[0] = {}
    for (let i = 0; i < 90; i++) { addPoolCandidate(db, { company_name: `Empty ${i}`, website: `https://empty${i}.test`, category_id: 1 }); Object.assign(routes, site(`empty${i}.test`)) }
    const { batch } = createBatch(db, { size: 20 })
    await drain(quiet(routes))
    expect(getBatch(db, batch.id).batch).toMatchObject({ status: 'completed', researched: 80, qualified: 0 })
  })

  it('does not research or count a duplicate brand as a lead', async () => {
    onlyCategory()
    addPoolCandidate(db, { company_name: 'Dupe', website: 'https://dupe.test', category_id: 1 })
    const { batch } = createBatch(db, { size: 20 })
    const existing = createProspect(db, { company_name: 'Dupe Inc', website: 'https://dupe.test/' })
    const web = fakeWeb(site('dupe.test', 'partnerships@dupe.test'))
    await drain(createFetcher({ fetchImpl: web.fetchImpl, sleep: async () => {}, delayMs: 0 }))
    expect(web.calls).toEqual([])
    expect(getBatch(db, batch.id).batch).toMatchObject({ duplicates: 1, qualified: 0 })
    expect(all(db, 'SELECT id FROM prospects')).toEqual([{ id: existing.id }])
    expect(leadMetrics(db).research).toMatchObject({ duplicates: 1, rejected: 0 })
  })

  it('finds an address on deeper pages before giving up on a brand', async () => {
    onlyCategory()
    addPoolCandidate(db, { company_name: 'Deep', website: 'https://deep.test', category_id: 1 })
    const { batch } = createBatch(db, { size: 20 })
    await drain(quiet({
      'https://deep.test/': html('Deep', '<p>Gaming gear.</p>'),
      'https://deep.test/sitemap.xml': '<urlset><url><loc>https://deep.test/team/media-kit</loc></url></urlset>',
      'https://deep.test/team/media-kit': html('Media', '<p>Press: <a href="mailto:press@deep.test">press@deep.test</a></p>'),
    }))
    const c = get<{ qualified: number; message: string }>(db, 'SELECT qualified, message FROM research_candidates WHERE batch_id = ?', batch.id)!
    expect(c.qualified).toBe(1)
    expect(c.message).toContain('press@deep.test')
    expect(all(db, "SELECT source_url FROM contacts WHERE email = 'press@deep.test'")).toEqual([{ source_url: 'https://deep.test/team/media-kit' }])
  })
})

describe('mail domain checks', () => {
  it('rechecks only when due and keeps a good result through a DNS hiccup', async () => {
    const p = brand()
    addContact(db, p.id, { ...direct, email: 'partnerships@brand.test' })
    let calls = 0
    const lookup: MailLookup = async () => { calls++; return { status: 'ok', detail: 'MX' } }
    expect(await checkDueMailDomains(db, { lookup })).toBe(1)
    expect(await checkDueMailDomains(db, { lookup })).toBe(0)
    expect(calls).toBe(1)
    await checkMailDomain(db, 'brand.test', async () => ({ status: 'unknown', detail: 'Timed out' }))
    expect(mailDomainStatus(db, 'brand.test')?.status).toBe('ok')
  })
})

describe('leads API', () => {
  let app: FastifyInstance
  const H = { host: '127.0.0.1:5181', 'x-outreach-client': 'dashboard' }
  beforeEach(async () => { app = await buildApp({ db, dataDir: '/tmp/unused-outreach' }) })
  afterEach(async () => { await app.close() })

  it('separates actionable from excluded and filters the CRM list', async () => {
    const good = await brandWithEmail()
    const none = brand('none.test', 'None')
    const r = (await app.inject({ url: '/api/leads', headers: H })).json()
    expect(r.actionable.map((l: { id: number }) => l.id)).toEqual([good.p.id])
    expect(r.excluded.map((l: { id: number }) => l.id)).toEqual([none.id])
    expect(r.metrics).toMatchObject({ actionable: 1, withoutUsableEmail: 1 })
    const ids = async (qs: string) => (await app.inject({ url: `/api/prospects?${qs}`, headers: H })).json().map((p: { id: number }) => p.id)
    expect(await ids('lead=actionable')).toEqual([good.p.id])
    expect((await ids('')).length).toBe(2)
    expect((await app.inject({ url: '/api/research/status', headers: H })).json().pendingReview).toBe(1)
  })
})
