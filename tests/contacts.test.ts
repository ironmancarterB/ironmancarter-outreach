import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../apps/server/src/app'
import { all, get, run, type DB } from '../packages/db'
import { addContact, contactEligibility, createProspect, getProspect, reviewProspect, type Contact } from '../packages/crm/prospects'
import { addSuppression } from '../packages/crm/suppressions'
import { evaluateEligibility } from '../packages/core/eligibility'
import { createFetcher } from '../packages/research/fetcher'
import { contactStatus, discoverContacts, processContactRun, queueContactResearch } from '../packages/research/contacts'
import { addManualContact, reviewContact } from '../packages/research/contactReview'
import { suggestApplicationUrl } from '../packages/pitch/facts'
import { updateApplication } from '../packages/pitch/applications'
import { approvePitch, generatePitch } from '../packages/pitch/service'
import { fakeWeb, html } from './fakeWeb'
import { freshDb } from './helpers'

const quiet = { sleep: async () => {}, delayMs: 0 }
let db: DB
beforeEach(() => { db = freshDb() })

const brand = (domain = 'brand.test', name = 'Brand Co') => createProspect(db, { company_name: name, website: `https://${domain}/`, category_id: 1 })
const contactsOf = (pid: number) => all<Contact>(db, 'SELECT * FROM contacts WHERE prospect_id = ? ORDER BY id', pid)
const findingsOf = (pid: number) => all<{ kind: string; value: string | null; decision: string; tier: string | null; reason: string }>(db, 'SELECT * FROM contact_findings WHERE prospect_id = ? ORDER BY id', pid)
async function discover(pid: number, routes: Parameters<typeof fakeWeb>[0], refresh = false) {
  const web = fakeWeb(routes)
  const summary = await discoverContacts(db, pid, { fetcher: createFetcher({ fetchImpl: web.fetchImpl, ...quiet }) }, { refresh })
  return { summary, calls: web.calls }
}
const eligibility = (c: Contact, pid: number) => contactEligibility(db, c, getProspect(db, pid)).status

describe('contact source verification', () => {
  it('accepts business mailboxes published on the brand’s pages and rejects everything else with a reason', async () => {
    const p = brand()
    const { summary } = await discover(p.id, {
      'https://brand.test/': html('Brand Co', '<a href="/contact">Contact</a> <a href="https://www.instagram.com/brandco">Instagram</a>'),
      'https://brand.test/contact': html('Contact Brand Co', `<p>Partnership inquiries: <a href="mailto:partnerships@brand.test">partnerships@brand.test</a></p>
        <p>Order help: support@brand.test. Our founder: jane.doe@brand.test. Fan mail: brandfans@gmail.com. Example: you@example.com</p>`),
    })
    expect(summary).toMatchObject({ newDirect: 1, status: 'VERIFIED_DIRECT' })
    const [c] = contactsOf(p.id)
    expect(c).toMatchObject({ email: 'partnerships@brand.test', contact_tier: 'VERIFIED_DIRECT', confidence: 'high', source_url: 'https://brand.test/contact', source_category: 'official_contact', verification_status: 'verified' })
    expect(c.evidence).toContain('Partnership inquiries')
    expect(c.decision_note).toMatch(/Partnerships mailbox published/)
    const f = findingsOf(p.id)
    expect(f.find((x) => x.value === 'support@brand.test')).toMatchObject({ decision: 'rejected', reason: expect.stringMatching(/support/) })
    expect(f.find((x) => x.reason.includes('person'))).toMatchObject({ decision: 'rejected', value: 'j••••••@brand.test' })
    expect(f.find((x) => x.reason.includes('Free email'))).toMatchObject({ value: 'b••••••@gmail.com' })
    expect(f.find((x) => x.value === 'you@example.com')).toMatchObject({ decision: 'rejected', reason: expect.stringMatching(/placeholder/) })
    expect(f.find((x) => x.kind === 'social')).toMatchObject({ decision: 'needs_review', value: 'https://www.instagram.com/brandco' })
    // Personal and free-mail addresses are never stored anywhere.
    const everything = JSON.stringify([...all(db, 'SELECT * FROM contacts'), ...all(db, 'SELECT * FROM contact_findings'), ...all(db, 'SELECT * FROM activities')])
    expect(everything).not.toContain('jane.doe')
    expect(everything).not.toContain('brandfans')
  })

  it('accepts addresses on a domain the brand owns (its original domain that redirects to the current one)', async () => {
    const p = brand('runway.test', 'Runway')
    run(db, "INSERT INTO research_fetches (prospect_id, url, final_url, status_code, outcome, bytes, fetched_at) VALUES (?, 'https://runwayml.test/', 'https://runway.test/', 200, 'ok', 1, 'now')", p.id)
    await discover(p.id, { 'https://runway.test/': html('Runway', '<footer>Press: press@runwayml.test · Partnerships: partnerships@runwayml.test</footer>') })
    expect(contactsOf(p.id).map((c) => [c.email, c.contact_tier, c.confidence])).toEqual([
      ['partnerships@runwayml.test', 'VERIFIED_DIRECT', 'medium'], ['press@runwayml.test', 'VERIFIED_DIRECT', 'medium']])
    expect(contactsOf(p.id)[0].decision_note).toMatch(/runwayml\.test, a domain the brand uses/)
  })

  it('treats structured contact data as direct, but addresses only in page scripts as needing your verification', async () => {
    const p = brand()
    await discover(p.id, {
      'https://brand.test/': html('Brand Co', '<a href="/creator-program">Creators</a><script type="application/ld+json">{"@type":"Organization","contactPoint":{"email":"marketing@brand.test"}}</script>'),
      'https://brand.test/creator-program': html('Creator Program', '<div id="app"></div><script>window.__DATA__={"contact":"creator.program@brand.test","qa":"test_store@brand.test"}</script>'),
    })
    const byEmail = Object.fromEntries(contactsOf(p.id).map((c) => [c.email, c]))
    expect(byEmail['marketing@brand.test']).toMatchObject({ contact_tier: 'VERIFIED_DIRECT', confidence: 'medium' })
    expect(byEmail['creator.program@brand.test']).toMatchObject({ contact_tier: 'PUBLIC_UNVERIFIED', verification_status: 'unverified' })
    expect(byEmail['creator.program@brand.test'].decision_note).toMatch(/embedded data/)
    expect(byEmail['test_store@brand.test']).toBeUndefined()
    expect(eligibility(byEmail['creator.program@brand.test'], p.id)).toBe('ineligible')
  })

  it('records official application portals linked from program pages, not newsletters or social links', async () => {
    const p = brand()
    reviewProspect(db, p.id, 'approved')
    await discover(p.id, {
      'https://brand.test/': html('Brand Co', '<a href="/creator-program">Creator program</a>'),
      'https://brand.test/creator-program': html('Creator Program', `<a href="https://brandco-connect.creatoriq.com/connect/">APPLY NOW</a>
        <a href="/emailsignup">Sign up for emails</a> <a href="https://discord.com/invite/x">Join our Discord</a>`),
    })
    const [portal] = contactsOf(p.id)
    expect(portal).toMatchObject({ contact_form_url: 'https://brandco-connect.creatoriq.com/connect/', contact_tier: 'VERIFIED_PORTAL', contact_type: 'portal', confidence: 'high', source_url: 'https://brand.test/creator-program' })
    expect(contactsOf(p.id)).toHaveLength(1)
    expect(contactStatus(db, p.id)).toBe('VERIFIED_PORTAL')
    // The manual application workflow uses the portal, even though it is on another site.
    expect(suggestApplicationUrl(db, p.id)?.url).toBe('https://brandco-connect.creatoriq.com/connect/')
    expect(updateApplication(db, p.id, { application_url: 'https://brandco-connect.creatoriq.com/connect/' })!.application_url).toBe('https://brandco-connect.creatoriq.com/connect/')
    expect(() => updateApplication(db, p.id, { application_url: 'https://random-forms.test/apply' })).toThrow(/official portal/)
  })

  it('adds a portal once even when linked several times, and ignores non-creator programs and sales forms', async () => {
    const p = brand()
    await discover(p.id, {
      'https://brand.test/': html('Brand Co', '<a href="/creators">Creators</a> <a href="/contact">Contact</a> <a href="/enterprise-contact">Talk to sales</a>'),
      'https://brand.test/creators': html('Creators', `<a href="https://brand.creatoriq.com/apply">Apply now</a> <a href="https://brand.creatoriq.com/apply">APPLY NOW</a>
        <a href="/consulting-partners">Get started</a> <a href="https://dash.partnerstack.com/brand">Get started</a>`),
      'https://brand.test/contact': html('Contact', '<a href="/s/partnerships">Partnership Application</a>'),
      'https://brand.test/enterprise-contact': html('Sales', '<form><textarea name="m"></textarea></form>'),
    })
    const urls = contactsOf(p.id).map((c) => c.contact_form_url).sort()
    expect(urls).toEqual(['https://brand.creatoriq.com/apply', 'https://dash.partnerstack.com/brand'])
    // The contact page's partnership application link is used when the run still has room for it.
    const q = brand('second.test', 'Second Co')
    await discover(q.id, {
      'https://second.test/': html('Second Co', '<a href="/s/contact">Contact</a>'),
      'https://second.test/s/contact': html('Contact', '<a href="/s/partnerships">Partnership Application</a> <p>Sales: sales@reseller.test</p>'),
    })
    expect(contactsOf(q.id).map((c) => c.contact_form_url)).toEqual(['https://second.test/s/partnerships'])
    expect(findingsOf(q.id).find((f) => f.value === 'sales@reseller.test')).toMatchObject({ decision: 'rejected', reason: expect.stringMatching(/Another organisation/) })
    // Partner directories list other companies' addresses; they are not contacts for the brand.
    const r = brand('third.test', 'Third Co')
    await discover(r.id, {
      'https://third.test/': html('Third Co', '<a href="/data-center/colocation-partners/">Colocation partners</a> <a href="/partners/">Partner network</a>'),
      'https://third.test/data-center/colocation-partners/': html('Partners', '<p>Contact: marketing@colo.test</p>'),
      'https://third.test/partners/': html('Partner network', '<form><textarea></textarea></form>'),
    })
    expect(contactsOf(r.id)).toHaveLength(0)
  })

  it('obeys robots.txt and never decodes protected addresses', async () => {
    const p = brand()
    const { calls } = await discover(p.id, {
      'https://brand.test/robots.txt': 'User-agent: *\nDisallow: /contact',
      'https://brand.test/': html('Brand Co', '<a href="/contact">Contact</a> <a href="/press">Press</a>'),
      'https://brand.test/press': html('Press', '<a href="/cdn-cgi/l/email-protection#abc"><span class="__cf_email__" data-cfemail="abc">[email protected]</span></a>'),
    })
    expect(calls).not.toContain('https://brand.test/contact')
    expect(findingsOf(p.id).find((f) => f.kind === 'protected_email')).toMatchObject({ decision: 'needs_review', value: null })
    expect(contactsOf(p.id)).toHaveLength(0)
    expect(contactStatus(db, p.id)).toBe('NO_CONTACT')
  })
})

describe('agency relationship verification', () => {
  it('accepts an agency address the brand itself names for inquiries', async () => {
    const p = brand()
    await discover(p.id, { 'https://brand.test/': html('Brand Co', '<a href="/press">Press</a>'),
      'https://brand.test/press': html('Press', '<p>For press and creator partnerships, please contact our agency, Bright PR: brandco@brightpr.test</p>') })
    const [c] = contactsOf(p.id)
    expect(c).toMatchObject({ email: 'brandco@brightpr.test', contact_tier: 'VERIFIED_AGENCY', agency_confirmed: 'brand_site', agency_name: 'brightpr.test' })
    expect(eligibility(c, p.id)).not.toBe('ineligible')
  })

  it('confirms an agency linked from the brand’s site only when the agency names the brand', async () => {
    const yes = brand()
    await discover(yes.id, {
      'https://brand.test/': html('Brand Co', '<a href="/press">Press</a>'),
      'https://brand.test/press': html('Press', '<a href="https://agency.test/clients">Our PR agency</a>'),
      'https://agency.test/clients': html('Agency', '<p>We represent Brand Co and others. Reach us at hello@agency.test</p>'),
    })
    expect(contactsOf(yes.id)[0]).toMatchObject({ email: 'hello@agency.test', contact_tier: 'VERIFIED_AGENCY', agency_confirmed: 'brand_site' })
    const no = brand('other.test', 'Other Co')
    await discover(no.id, {
      'https://other.test/': html('Other Co', '<a href="/press">Press</a>'),
      'https://other.test/press': html('Press', '<a href="https://agency2.test/">Our PR agency</a>'),
      'https://agency2.test/': html('Agency 2', '<p>Talk to us: hello@agency2.test</p>'),
    })
    const [c] = contactsOf(no.id)
    expect(c).toMatchObject({ contact_tier: 'PUBLIC_UNVERIFIED' })
    expect(eligibility(c, no.id)).toBe('ineligible')
  })

  it('keeps an unexplained other-domain address blocked for manual verification', async () => {
    const p = brand()
    await discover(p.id, { 'https://brand.test/': html('Brand Co', '<a href="/contact">Contact</a>'),
      'https://brand.test/contact': html('Contact', '<p>Creator partnerships: partnerships@thirdparty.test</p>') })
    const [c] = contactsOf(p.id)
    expect(c).toMatchObject({ contact_tier: 'PUBLIC_UNVERIFIED' })
    expect(contactStatus(db, p.id)).toBe('PUBLIC_UNVERIFIED')
  })
})

describe('duplicates, caching and outdated sources', () => {
  const site = {
    'https://brand.test/': html('Brand Co', '<a href="/contact">Contact</a>'),
    'https://brand.test/contact': html('Contact', '<p>partnerships@brand.test</p>'),
  }
  it('never adds an address twice or to two companies, and reuses cached pages until you refresh', async () => {
    const p = brand()
    const first = await discover(p.id, site)
    const second = await discover(p.id, site)
    expect(contactsOf(p.id)).toHaveLength(1)
    expect(second.calls.filter((u) => !u.endsWith('robots.txt') && !u.endsWith('sitemap.xml'))).toHaveLength(0)
    expect(second.summary.pagesCached).toBeGreaterThan(0)
    expect(first.calls.length).toBeGreaterThan(second.calls.length)
    const refreshed = await discover(p.id, site, true)
    expect(refreshed.calls.some((u) => u.endsWith('/contact'))).toBe(true)
    // Same address on a different company's site.
    const other = brand('brand-shop.test', 'Brand Shop')
    await discover(other.id, { 'https://brand-shop.test/': html('Brand Shop', '<p>Partnerships: partnerships@brand.test</p>') })
    expect(contactsOf(other.id)).toHaveLength(0)
    expect(findingsOf(other.id).some((f) => f.decision === 'rejected' && /Already on Brand Co|Another organisation/.test(f.reason))).toBe(true)
  })

  it('marks research contacts no longer on their source page as failed, but never touches ones you verified', async () => {
    const p = brand()
    addContact(db, p.id, { email: 'partnerships@brand.test', source_url: 'https://brand.test/contact', verification_status: 'verified', discovered_by: 'research' })
    addContact(db, p.id, { email: 'press@brand.test', source_url: 'https://brand.test/contact', verification_status: 'verified', discovered_by: 'manual' })
    const { summary } = await discover(p.id, { 'https://brand.test/': html('Brand Co', '<a href="/contact">Contact</a>'), 'https://brand.test/contact': html('Contact', '<p>We moved!</p>') }, true)
    expect(summary.stale).toBe(1)
    const byEmail = Object.fromEntries(contactsOf(p.id).map((c) => [c.email, c]))
    expect(byEmail['partnerships@brand.test']).toMatchObject({ verification_status: 'failed', decision_note: expect.stringMatching(/No longer published/) })
    expect(byEmail['press@brand.test']).toMatchObject({ verification_status: 'verified', manually_verified: 1, contact_tier: 'VERIFIED_DIRECT' })
  })

  it('skips suppressed addresses and companies', async () => {
    const p = brand()
    addSuppression(db, 'email', 'partnerships@brand.test', 'Asked not to be contacted', 'opt_out')
    await discover(p.id, site)
    expect(contactsOf(p.id)).toHaveLength(0)
    expect(findingsOf(p.id).find((f) => f.value === 'partnerships@brand.test')).toMatchObject({ decision: 'rejected', reason: expect.stringMatching(/do-not-contact/) })
  })
})

describe('contact confidence and manual verification', () => {
  it('requires a source and evidence for manual entries and applies the tier rules', () => {
    const p = brand()
    expect(() => addManualContact(db, p.id, { email: 'partnerships@brand.test', source_category: 'official_contact', evidence: 'Shown on contact page' })).toThrow(/source URL/)
    expect(() => addManualContact(db, p.id, { email: 'partnerships@brand.test', source_url: 'https://brand.test/contact', source_category: 'official_contact' })).toThrow(/evidence/)
    expect(() => addManualContact(db, p.id, { email: 'brand@gmail.com', source_url: 'https://brand.test/contact', source_category: 'official_contact', evidence: 'Listed on the contact page' })).toThrow(/Free email/)
    expect(() => addManualContact(db, p.id, { email: 'sam.smith@brand.test', source_url: 'https://brand.test/team', source_category: 'official_site', evidence: 'Listed on the team page' })).toThrow(/person/)
    const direct = addManualContact(db, p.id, { email: 'partnerships@brand.test', source_url: 'https://brand.test/contact', source_category: 'official_contact', evidence: 'Partnerships: partnerships@brand.test on the Contact page' })
    expect(direct.contact).toMatchObject({ contact_tier: 'VERIFIED_DIRECT', manually_verified: 1, discovered_by: 'manual' })
    // A directory listing is not enough on its own.
    const dir = addManualContact(db, p.id, { email: 'press@brand.test', source_url: 'https://directory.test/brand', source_category: 'directory', evidence: 'Listed in a business directory' })
    expect(dir.contact.contact_tier).toBe('PUBLIC_UNVERIFIED')
    expect(eligibility(dir.contact, p.id)).toBe('ineligible')
    // Verify it after checking the brand's site yourself.
    expect(() => reviewContact(db, dir.contact.id, { decision: 'verify' })).toThrow(/what you checked/)
    expect(reviewContact(db, dir.contact.id, { decision: 'verify', evidence: 'Also on brand.test/press under Media contacts' })).toMatchObject({ contact_tier: 'VERIFIED_DIRECT', manually_verified: 1 })
  })

  it('needs independent confirmation before an agency contact can be emailed', () => {
    const p = brand()
    const ag = addManualContact(db, p.id, { email: 'talent@agency.test', source_url: 'https://agency.test/clients', source_category: 'agency', evidence: 'Agency client list names Brand Co', agency_name: 'Agency Ltd' })
    expect(ag.contact).toMatchObject({ contact_tier: 'VERIFIED_AGENCY', agency_confirmed: null })
    expect(eligibility(ag.contact, p.id)).toBe('ineligible')
    expect(() => reviewContact(db, ag.contact.id, { decision: 'confirm_agency', evidence: 'Agency page lists the brand' })).toThrow(/brand confirms/)
    const ok = reviewContact(db, ag.contact.id, { decision: 'confirm_agency', evidence: 'Agency page lists the brand', brand_confirmation: 'brand.test/press names Agency Ltd as its PR agency' })
    expect(ok).toMatchObject({ contact_tier: 'VERIFIED_AGENCY', agency_confirmed: 'manual' })
    expect(eligibility(ok, p.id)).not.toBe('ineligible')
  })

  it('classifies confidence and blocks every unverified tier from sending', () => {
    const base = { email: 'x@brand.test', source_url: 'https://brand.test/c', verification_status: 'verified' as const, verified_at: new Date().toISOString(), jurisdiction: 'US' }
    const input = (contact: object) => ({ contact: { ...base, ...contact }, prospect: { domain: 'brand.test', stage: 'qualified' as const }, suppressedEmail: false, suppressedDomain: false, freshnessDays: 90, autoJurisdictions: ['US'] })
    expect(evaluateEligibility(input({ contact_tier: 'VERIFIED_DIRECT' })).status).toBe('eligible')
    expect(evaluateEligibility(input({ contact_tier: 'PUBLIC_UNVERIFIED' })).status).toBe('ineligible')
    expect(evaluateEligibility(input({ contact_tier: 'VERIFIED_AGENCY', email: 'a@agency.test' })).status).toBe('ineligible')
    expect(evaluateEligibility(input({ contact_tier: 'VERIFIED_AGENCY', email: 'a@agency.test', agency_confirmed: 'manual' })).status).toBe('eligible')
    // Country is still required: unknown stays in review, even for a direct address.
    expect(evaluateEligibility(input({ contact_tier: 'VERIFIED_DIRECT', jurisdiction: 'unknown' })).status).toBe('needs_review')
  })

  it('will not approve a pitch to a public, unverified contact', async () => {
    const p = brand()
    run(db, 'INSERT INTO research_sources (prospect_id, url, title, kind, retrieved_at, snippet) VALUES (?, ?, ?, ?, ?, ?)', p.id, 'https://brand.test/creators', 'Creator program', 'sponsorship_evidence', new Date().toISOString(), 'Join the Brand Co Creator Program.')
    addManualContact(db, p.id, { email: 'press@brand.test', source_url: 'https://directory.test/brand', source_category: 'directory', evidence: 'Listed in a business directory' })
    reviewProspect(db, p.id, 'approved')
    const pitch = await generatePitch(db, p.id, { channel: 'email' })
    expect(() => approvePitch(db, pitch.id)).toThrow(/manual verification/)
  })
})

describe('contact discovery queue and dashboard', () => {
  let app: FastifyInstance
  const H = { host: '127.0.0.1:5181', 'x-outreach-client': 'dashboard' }
  beforeEach(async () => { app = await buildApp({ db, dataDir: '/tmp/unused-outreach' }) })
  afterEach(async () => { await app.close() })

  it('queues one run per company, processes it in the worker, and backfills only companies without a verified email', async () => {
    const a = brand()
    const b = brand('verified.test', 'Verified Co')
    addContact(db, b.id, { email: 'partnerships@verified.test', source_url: 'https://verified.test/contact', verification_status: 'verified', discovered_by: 'research' })
    const r1 = await app.inject({ method: 'POST', url: `/api/prospects/${a.id}/find-contacts`, headers: H, payload: {} })
    expect(r1.statusCode).toBe(202)
    expect((await app.inject({ method: 'POST', url: `/api/prospects/${a.id}/find-contacts`, headers: H, payload: {} })).json().alreadyQueued).toBe(true)
    const backfill = (await app.inject({ method: 'POST', url: '/api/contact-discovery/backfill', headers: H, payload: {} })).json()
    expect(backfill).toEqual({ queued: 0, considered: 1 }) // a is already queued; b has a verified email
    const web = fakeWeb({ 'https://brand.test/': html('Brand Co', '<p>partnerships@brand.test</p>') })
    expect(await processContactRun(db, { fetcher: createFetcher({ fetchImpl: web.fetchImpl, ...quiet }) })).toBe(true)
    expect(get(db, 'SELECT status FROM contact_research_runs WHERE prospect_id = ?', a.id)).toEqual({ status: 'done' })
    const d = (await app.inject({ url: '/api/contact-discovery', headers: H })).json()
    expect(d.counts).toMatchObject({ VERIFIED_DIRECT: 2, NO_CONTACT: 0 })
    expect((await app.inject({ url: `/api/prospects/${a.id}/contact-findings`, headers: H })).json()[0]).toMatchObject({ decision: 'accepted' })
    expect(queueContactResearch(db, a.id).alreadyQueued).toBe(false)
  })

  it('accepts manual contacts and reviews through the API', async () => {
    const p = brand()
    const r = await app.inject({ method: 'POST', url: `/api/prospects/${p.id}/contacts/manual`, headers: H,
      payload: { email: 'creators@brand.test', source_url: 'https://brand.test/creators', source_category: 'official_creator', evidence: 'Email creators@brand.test on the creators page' } })
    expect(r.statusCode).toBe(201)
    expect(r.json()).toMatchObject({ contact: { contact_tier: 'VERIFIED_DIRECT' }, status: 'VERIFIED_DIRECT' })
    const rej = await app.inject({ method: 'POST', url: `/api/contacts/${r.json().contact.id}/review`, headers: H, payload: { decision: 'reject', evidence: 'Mailbox bounces' } })
    expect(rej.json()).toMatchObject({ verification_status: 'failed' })
    expect(contactStatus(db, p.id)).toBe('NO_CONTACT')
  })
})
