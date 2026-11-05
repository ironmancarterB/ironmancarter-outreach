// "Find more contacts" for one company. Bounded, cached and polite (same fetcher: robots.txt, 1.5 s per site,
// no logins, no JavaScript, no bypassing protection). Sources, in priority order:
//   1. official contact pages, 2. official creator/influencer pages, 3. ambassador/affiliate pages, 4. press/media
//   pages (including press sites on the brand's other domains), 5. official social profiles (listed for you to check;
//   they need a login, so they are not read), 6. agency pages the brand itself links to for PR/partnership inquiries,
//   7–8. professional profiles and business directories: manual entry with evidence (they require logins, forbid
//   automated access, or charge for data).
// Nothing is guessed: every accepted contact keeps its exact source URL, the text around it and why it was accepted.
// Personal-looking and free-mail addresses are never stored. Addresses are never derived from people's names.
import { all, get, logActivity, nowIso, run, tx, type DB } from '../db'
import { AppError, notFound } from '../core/errors'
import { emailDomain, nameKey, normalizeDomain, normalizeUrl } from '../core/normalize'
import { addContact, getProspect, updateContact, type Contact, type ContactTier, type Prospect } from '../crm/prospects'
import { isDomainSuppressed, isEmailSuppressed } from '../crm/suppressions'
import { classifyEmail, extractPage, roleOfLocal, type ExtractedPage, type PageLink } from './extract'
import { COMMON_PATHS, rankLinks } from './evidence'
import type { Fetcher } from './fetcher'

export const MAX_FETCHES = 14
export const MAX_AGENCY_PAGES = 2
export const CACHE_DAYS = 30
const MAX_EMAILS = 4
const MAX_PORTALS = 2

// Hosts of creator-application and affiliate platforms brands use for official programs.
const PORTAL_HOSTS = /(^|\.)(creatoriq\.com|impact\.com|partnerstack\.com|typeform\.com|grin\.co|aspire\.io|aspireiq\.com|upfluence\.com|shareasale\.com|awin\.com|cj\.com|rakutenadvertising\.com|refersion\.com|tapfiliate\.com|goaffpro\.com|tally\.so|jotform\.com|airtable\.com|hubspot\.com|hsforms\.com|tagger\.media|later\.com|mavely\.com|levanta\.io|everflow\.io|tune\.com|fourthwall\.com|linktr\.ee)$/i
const NOT_PORTAL = /(^|\.)(instagram|facebook|x|twitter|tiktok|youtube|discord|reddit|twitch|linkedin|threads|apple|google|play\.google)\.(com|gg|net|tv)$|newsletter|emailsignup|email-signup|subscribe|login|signin|sign-in|account|cart|checkout/i
const APPLY_TEXT = /\b(apply|application|join( now| the| our)?|sign ?up|become an? (creator|partner|affiliate|ambassador)|register|submit)\b/i
const WEAK_APPLY_TEXT = /\bget started\b/i     // only counts on known application platforms
const PROGRAM_PAGE = /creator|influencer|affiliate|ambassador|partner|sponsor|collab|programs?/i
// Programs that are not about creators or sponsorships (resellers, consultants, developers, enterprise sales).
const NOT_CREATOR_PROGRAM = /consult|reseller|solution|technology-partner|developer|integration|enterprise|channel-partner|isv|oem|distribut|sales|support|demo|careers|investor|colocation|directory|find-a-|where-to-buy|\b(?!creator|brand|influencer|affiliate|ambassador)[a-z]+-partners\b|\/partners\/?$/i
const ON_BRAND_PORTAL_PATH = /creator|influencer|affiliate|ambassador|sponsor|partnerships?\b|apply|application/i
const SOCIAL_HOSTS: [RegExp, string][] = [[/(^|\.)instagram\.com$/i, 'Instagram'], [/(^|\.)(x|twitter)\.com$/i, 'X'], [/(^|\.)tiktok\.com$/i, 'TikTok'],
  [/(^|\.)youtube\.com$/i, 'YouTube'], [/(^|\.)linkedin\.com$/i, 'LinkedIn'], [/(^|\.)twitch\.tv$/i, 'Twitch']]
const AGENCY_CONTEXT = /\b(agency|agencies|public relations|pr (firm|team|agency|contact)|represent(s|ed|ation|ing)?|on behalf of|press office|media contact|managed by|talent (management|agency)|influencer agency)\b/i

interface CachedPage {
  finalUrl: string
  fetchedAt: string
  title: string | null
  emails: string[]
  jsonLdEmails: string[]
  dataEmails: string[]
  protectedEmails: number
  contexts: Record<string, string>
  links: PageLink[]
  hasContactForm: boolean
  textSample: string
}

export interface DiscoverySummary {
  pagesFetched: number
  pagesCached: number
  pagesConsidered: number
  newDirect: number
  newAgency: number
  newPortals: number
  needsReview: number
  rejected: number
  stale: number
  status: 'VERIFIED_DIRECT' | 'VERIFIED_AGENCY' | 'VERIFIED_PORTAL' | 'PUBLIC_UNVERIFIED' | 'NO_CONTACT'
}

const mask = (email: string) => {
  const [l, d] = email.split('@')
  return `${l[0]}${'•'.repeat(Math.max(1, Math.min(6, l.length - 1)))}@${d}`
}
const labelOf = (domain: string) => domain.split('.')[0]

// Evidence keeps the text around an address, minus any OTHER address in it (people's addresses are never stored).
// Any fragment with an @ counts, including addresses cut off at the edge of the excerpt.
const scrub = (text: string | null, keep?: string) =>
  text ? text.replace(/[^\s<>"'(),;:]*@[^\s<>"'(),;:]*/g, (t) => (keep && t.toLowerCase().includes(keep) ? t : '[address removed]')) : null

// ---------- Page reading with a cache ----------

async function readPage(db: DB, fetcher: Fetcher, prospectId: number, url: string, refresh: boolean, counters: { fetched: number; cached: number }): Promise<CachedPage | null> {
  const cached = get<{ final_url: string | null; outcome: string; extracted: string | null; fetched_at: string }>(db, 'SELECT * FROM research_page_cache WHERE url = ?', url)
  if (cached && !refresh && Date.now() - new Date(cached.fetched_at).getTime() < CACHE_DAYS * 86_400_000) {
    counters.cached++
    return cached.outcome === 'ok' && cached.extracted ? (JSON.parse(cached.extracted) as CachedPage) : null
  }
  if (counters.fetched >= MAX_FETCHES) return null
  counters.fetched++
  const r = await fetcher.get(url)
  const page: ExtractedPage | null = r.outcome === 'ok' && r.html && !/^\s*<\?xml/.test(r.html) ? extractPage(r.html, r.finalUrl) : null
  run(db, `INSERT INTO research_fetches (candidate_id, prospect_id, url, final_url, status_code, outcome, bytes, title, fetched_at) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
    prospectId, r.url, r.finalUrl, r.status, r.outcome, r.bytes, page?.title ?? null, r.fetchedAt)
  const c: CachedPage | null = page ? {
    finalUrl: r.finalUrl, fetchedAt: r.fetchedAt, title: page.title, emails: page.emails, jsonLdEmails: page.jsonLdEmails, dataEmails: page.dataEmails,
    protectedEmails: page.protectedEmails, contexts: page.contexts, links: page.links.slice(0, 400), hasContactForm: page.hasContactForm,
    textSample: (page.mainText || page.text).slice(0, 20_000),
  } : null
  run(db, `INSERT INTO research_page_cache (url, final_url, outcome, status, extracted, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(url) DO UPDATE SET final_url = excluded.final_url, outcome = excluded.outcome, status = excluded.status, extracted = excluded.extracted, fetched_at = excluded.fetched_at`,
    url, r.finalUrl, c ? 'ok' : r.outcome, r.status, c ? JSON.stringify(c) : null, r.fetchedAt)
  return c
}

async function readSitemap(fetcher: Fetcher, origin: string, counters: { fetched: number }): Promise<string[]> {
  if (counters.fetched >= MAX_FETCHES) return []
  counters.fetched++
  const r = await fetcher.get(`${origin}/sitemap.xml`)
  if (r.outcome !== 'ok' || !r.html) return []
  const locs = [...r.html.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, '&'))
  return locs.filter((u) => !/\.xml(\.gz)?$/i.test(u)).slice(0, 5000)
}

// ---------- Which domains belong to the brand ----------

function ownedDomains(db: DB, p: Prospect): Set<string> {
  const owned = new Set<string>()
  if (p.domain) owned.add(p.domain)
  // Where research started and every redirect it followed (runwayml.com → runway.com).
  for (const r of all<{ url: string; final_url: string | null }>(db, 'SELECT url, final_url FROM research_fetches WHERE prospect_id = ?', p.id)) {
    const a = normalizeDomain(r.url), b = normalizeDomain(r.final_url)
    if (a && b && a !== b && (a === p.domain || b === p.domain)) { owned.add(a); owned.add(b) }
  }
  const pool = get<{ website: string }>(db, `SELECT cp.website FROM research_candidates rc JOIN candidate_pool cp ON cp.id = rc.pool_id WHERE rc.prospect_id = ? LIMIT 1`, p.id)
  const start = normalizeDomain(pool?.website)
  if (start) owned.add(start)
  return owned
}

// A domain the brand's own pages link to whose name contains the brand's name (makenotion.com for notion.com).
function brandNamed(domain: string, p: Prospect): boolean {
  const brand = p.domain ? labelOf(p.domain) : ''
  const key = nameKey(p.company_name)
  const l = labelOf(domain)
  return (brand.length >= 4 && l.includes(brand)) || (l.length >= 5 && brand.includes(l)) || (key.length >= 4 && l.includes(key))
}

// ---------- The run ----------

interface Candidate {
  kind: 'email' | 'portal' | 'form'
  value: string
  sourceUrl: string
  fetchedAt: string
  tier: ContactTier | null      // null = rejected
  decision: 'accepted' | 'needs_review' | 'rejected'
  reason: string
  evidence: string | null
  contactType: string
  sourceCategory: string
  confidence: 'high' | 'medium' | 'low'
  rank: number
  agencyName?: string | null
  agencyConfirmed?: 'brand_site' | null
  storeValue: boolean
}

const sourceCategoryOf = (url: string, sameBrand: boolean) => {
  if (!sameBrand) return 'agency'
  const path = new URL(url).pathname
  if (/creator|influencer/i.test(path)) return 'official_creator'
  if (/affiliate|ambassador/i.test(path)) return 'official_affiliate'
  if (/press|media|news/i.test(path) || /^(press|news|newsroom|media)\./i.test(new URL(url).host)) return 'official_press'
  if (/contact|partner|sponsor|business|collab/i.test(path)) return 'official_contact'
  return 'official_site'
}
const contactTypeOf = (label: string, url: string) => {
  if (/partner/i.test(label)) return 'partnerships'
  if (/creator|affiliate/i.test(label)) return /affiliate/i.test(url) ? 'affiliate' : 'creator_program'
  if (/press|marketing/i.test(label)) return 'press'
  return 'general'
}

export async function discoverContacts(db: DB, prospectId: number, deps: { fetcher: Fetcher }, opts: { refresh?: boolean; runId?: number | null } = {}): Promise<DiscoverySummary> {
  const p = getProspect(db, prospectId)
  if (!p.domain || !p.website) throw new AppError(409, 'no_website', `${p.company_name} has no website on record.`)
  const refresh = !!opts.refresh
  const counters = { fetched: 0, cached: 0 }
  const owned = ownedDomains(db, p)
  const isOwned = (host: string) => {
    const d = normalizeDomain(host)
    return !!d && owned.has(d)
  }

  // 1. Homepage, then pages in priority order.
  const home = await readPage(db, deps.fetcher, p.id, p.website, refresh, counters)
  const homeUrl = home?.finalUrl ?? p.website
  const origin = new URL(homeUrl).origin
  const prefix = new URL(homeUrl).pathname.match(/^\/([a-z]{2}(-[a-z]{2})?\/[a-z]{2}(-[a-z]{2})?|[a-z]{2}-[a-z]{2})(?=\/|$)/i)?.[0] ?? ''
  if (home) for (const l of home.links) { const d = normalizeDomain(l.url); if (d && !owned.has(d) && brandNamed(d, p)) owned.add(d) }

  const queue: { url: string; score: number }[] = []
  const add = (url: string, score: number) => {
    const u = normalizeUrl(url)
    if (!u || !/^https?:/.test(u)) return
    const host = new URL(u).host
    if (!isOwned(host)) return
    const existing = queue.find((q) => q.url.replace(/\/$/, '') === u.replace(/\/$/, ''))
    if (existing) existing.score = Math.max(existing.score, score)
    else queue.push({ url: u, score })
  }
  const SCORE: [RegExp, number][] = [[/contact/i, 100], [/(creator|influencer)/i, 95], [/(partner|sponsor|collab)/i, 90], [/(ambassador|affiliate)/i, 85], [/(press|media|newsroom|news\.)/i, 80], [/(business|marketing)/i, 60], [/about/i, 30]]
  const scoreOf = (url: string, text = '') => {
    const hay = `${new URL(url).host} ${new URL(url).pathname} ${text}`
    let s = 0
    for (const [re, pts] of SCORE) if (re.test(hay)) s = Math.max(s, pts)
    // Deep detail pages (an ambassador's bio, a product) rarely hold contacts.
    return s - Math.max(0, new URL(url).pathname.split('/').filter(Boolean).length - (prefix ? 4 : 2)) * 15
  }
  for (const s of all<{ url: string; kind: string }>(db, "SELECT url, kind FROM research_sources WHERE prospect_id = ? AND kind IN ('contact', 'partnership_page', 'sponsorship_evidence')", p.id)) add(s.url, scoreOf(s.url) + 5)
  if (home) for (const u of rankLinks(home.links, (x) => isOwned(new URL(x).host))) add(u, scoreOf(u, home.links.find((l) => l.url.replace(/\/$/, '') === u)?.text ?? ''))
  for (const path of COMMON_PATHS) {
    add(origin + path, scoreOf(origin + path) - 10)
    if (prefix) add(`${origin}/${prefix.replace(/^\//, '')}${path}`, scoreOf(origin + path) - 5)
  }
  for (const u of (await readSitemap(deps.fetcher, origin, counters)).filter((x) => /contact|partner|creator|influencer|affiliate|ambassador|sponsor|press|media/i.test(new URL(x).pathname)).slice(0, 40)) add(u, scoreOf(u) - 3)
  queue.sort((a, b) => b.score - a.score)

  const pages: CachedPage[] = home ? [home] : []
  for (const q of queue) {
    if (q.score <= 0) continue
    if (counters.fetched >= MAX_FETCHES && !get(db, 'SELECT 1 FROM research_page_cache WHERE url = ?', q.url)) break
    if (pages.some((x) => x.finalUrl.replace(/\/$/, '') === q.url.replace(/\/$/, ''))) continue
    const page = await readPage(db, deps.fetcher, p.id, q.url, refresh, counters)
    if (page && isOwned(new URL(page.finalUrl).host) && !pages.some((x) => x.finalUrl === page.finalUrl)) pages.push(page)
  }

  // 2. Classify everything seen.
  const cands: Candidate[] = []
  const brandKey = nameKey(p.company_name)
  const seenEmails = new Set<string>()
  for (const pg of pages) {
    const sameBrand = isOwned(new URL(pg.finalUrl).host)
    const category = sourceCategoryOf(pg.finalUrl, sameBrand)
    const relevantPage = PROGRAM_PAGE.test(new URL(pg.finalUrl).pathname) || /contact|press|media/i.test(new URL(pg.finalUrl).pathname)
    const emailSets: [string[], 'visible' | 'jsonld' | 'data'][] = [[pg.emails, 'visible'], [pg.jsonLdEmails, 'jsonld'], [pg.dataEmails, 'data']]
    for (const [list, where] of emailSets) {
      for (const email of list) {
        if (seenEmails.has(email)) continue
        seenEmails.add(email)
        const context = scrub(pg.contexts[email] ?? null, email)
        const cls = classifyEmail(email, p.domain, owned)
        const base = { kind: 'email' as const, value: email, sourceUrl: pg.finalUrl, fetchedAt: pg.fetchedAt, evidence: context, sourceCategory: category, storeValue: true }
        const masked = { value: mask(email), storeValue: false, evidence: scrub(context) }
        if (cls.kind === 'placeholder') { cands.push({ ...base, tier: null, decision: 'rejected', reason: 'Example or placeholder address, not a real contact.', contactType: 'general', confidence: 'low', rank: 99 }); continue }
        if (cls.kind === 'free_mail') { cands.push({ ...base, ...masked, tier: null, decision: 'rejected', reason: 'Free email provider (not an official business address); not stored.', contactType: 'general', confidence: 'low', rank: 99 }); continue }
        if (cls.kind === 'personal') { cands.push({ ...base, ...masked, tier: null, decision: 'rejected', reason: 'Looks like a person’s own address; personal addresses are never stored.', contactType: 'general', confidence: 'low', rank: 99 }); continue }
        if (cls.kind === 'excluded') { if (relevantPage || where === 'visible') cands.push({ ...base, tier: null, decision: 'rejected', reason: `${cls.reason}.`, contactType: 'general', confidence: 'low', rank: 99 }); continue }
        if (cls.kind === 'role') {
          const sisterDomain = emailDomain(email) !== p.domain
          const label = cls.label
          if (where === 'data') {
            cands.push({ ...base, tier: 'PUBLIC_UNVERIFIED', decision: 'needs_review', reason: 'Only in the page’s embedded data (the page is built with JavaScript), so the app cannot confirm it is shown to visitors. Open the page and confirm.', contactType: contactTypeOf(label, pg.finalUrl), confidence: 'medium', rank: cls.rank })
          } else {
            cands.push({ ...base, tier: 'VERIFIED_DIRECT', decision: 'accepted',
              reason: `${label} mailbox ${where === 'jsonld' ? 'declared in the site’s structured contact data' : 'published'} on ${p.company_name}'s official site${sisterDomain ? ` (on ${emailDomain(email)}, a domain the brand uses)` : ''}.`,
              contactType: contactTypeOf(label, pg.finalUrl), confidence: !sisterDomain && where === 'visible' && relevantPage ? 'high' : 'medium', rank: cls.rank })
          }
          continue
        }
        // Another domain: an agency the brand names for partnership/PR inquiries, or something to check by hand.
        const local = email.split('@')[0]
        // A mailbox named after the brand (brandco@agency.com) is a client mailbox, not a person.
        const role = brandKey.length >= 4 && nameKey(local).includes(brandKey) ? { kind: 'role' as const, rank: 2, label: 'Client mailbox' } : roleOfLocal(local)
        if (role.kind === 'personal') { cands.push({ ...base, ...masked, tier: null, decision: 'rejected', reason: 'Personal-looking address on another domain; not stored.', contactType: 'general', confidence: 'low', rank: 99 }); continue }
        if (role.kind === 'excluded') continue
        if (where === 'visible' && context && AGENCY_CONTEXT.test(context)) {
          const agency = emailDomain(email)!
          cands.push({ ...base, tier: 'VERIFIED_AGENCY', decision: 'accepted', agencyName: agency, agencyConfirmed: 'brand_site', contactType: 'agency', sourceCategory: 'agency',
            reason: `${p.company_name}'s own site names this ${agency} address for inquiries, which confirms the agency relationship.`, confidence: 'medium', rank: role.kind === 'role' ? role.rank + 1 : 5 })
        } else if (where === 'visible' && relevantPage && role.kind === 'role' && role.rank <= 3 && !NOT_CREATOR_PROGRAM.test(new URL(pg.finalUrl).pathname)) {
          cands.push({ ...base, tier: 'PUBLIC_UNVERIFIED', decision: 'needs_review', reason: `Published on ${p.company_name}'s ${new URL(pg.finalUrl).pathname} page but on another domain (${emailDomain(email)}) without saying who it belongs to. Check before using it.`, contactType: 'general', confidence: 'low', rank: 6 })
        } else if (where === 'visible') {
          cands.push({ ...base, tier: null, decision: 'rejected', reason: `Another organisation's address (${emailDomain(email)}) listed on the page, not a contact for ${p.company_name}.`, contactType: 'general', confidence: 'low', rank: 99 })
        }
      }
    }
    if (pg.protectedEmails && relevantPage) {
      run(db, `INSERT INTO contact_findings (prospect_id, run_id, kind, value, source_url, decision, reason, created_at) VALUES (?, ?, 'protected_email', NULL, ?, 'needs_review', ?, ?)`,
        p.id, opts.runId ?? null, pg.finalUrl, 'This page hides an email address behind anti-harvesting protection. The app does not get around it; open the page to read it, then add it by hand.', nowIso())
    }
    // Official application portals linked from the brand's program pages.
    const pagePath = new URL(pg.finalUrl).pathname
    if (sameBrand && (PROGRAM_PAGE.test(pagePath) || PROGRAM_PAGE.test(pg.title ?? '') || /contact/i.test(pagePath)) && !NOT_CREATOR_PROGRAM.test(pagePath)) {
      for (const l of pg.links) {
        let u: URL
        try { u = new URL(l.url) } catch { continue }
        const known = PORTAL_HOSTS.test(u.host)
        if (!(APPLY_TEXT.test(l.text) || (known && WEAK_APPLY_TEXT.test(l.text))) || NOT_PORTAL.test(u.host) || NOT_PORTAL.test(u.pathname)) continue
        if (NOT_CREATOR_PROGRAM.test(`${u.pathname} ${l.text}`)) continue
        const onBrand = isOwned(u.host) && ON_BRAND_PORTAL_PATH.test(`${u.host}${u.pathname}`)
        if (!known && !onBrand) continue
        const type = /affiliate/i.test(`${pg.finalUrl} ${l.url}`) ? 'affiliate' : /ambassador/i.test(`${pg.finalUrl} ${l.url}`) ? 'ambassador' : 'creator_program'
        cands.push({ kind: 'portal', value: l.url, sourceUrl: pg.finalUrl, fetchedAt: pg.fetchedAt, tier: 'VERIFIED_PORTAL', decision: 'accepted', storeValue: true,
          reason: `"${l.text.trim()}" on ${p.company_name}'s ${pagePath} page links here${known ? ` (${u.host}, an application platform)` : ''}.`,
          evidence: `Link text "${l.text}" on ${pg.finalUrl}`, contactType: type, sourceCategory: sourceCategoryOf(pg.finalUrl, true), confidence: known ? 'high' : 'medium',
          // Application platforms first, then the brand's own application pages.
          rank: (known ? 1 : 3) + (type === 'creator_program' ? 0 : 1) })
      }
    }
    if (sameBrand && pg.hasContactForm && /contact|partnership|creator|influencer|affiliate|sponsor|press|collab/i.test(pagePath) && !NOT_CREATOR_PROGRAM.test(pagePath)) {
      cands.push({ kind: 'form', value: pg.finalUrl, sourceUrl: pg.finalUrl, fetchedAt: pg.fetchedAt, tier: 'VERIFIED_PORTAL', decision: 'accepted', storeValue: true,
        reason: `Contact form on ${p.company_name}'s official ${new URL(pg.finalUrl).pathname} page.`, evidence: null, contactType: 'contact_form', sourceCategory: sourceCategoryOf(pg.finalUrl, true), confidence: 'high', rank: 3 })
    }
  }

  // 3. Agency pages the brand links to for press or partnership inquiries (bounded).
  let agencyPages = 0
  for (const pg of pages) {
    for (const l of pg.links) {
      if (agencyPages >= MAX_AGENCY_PAGES) break
      let u: URL
      try { u = new URL(l.url) } catch { continue }
      if (isOwned(u.host) || NOT_PORTAL.test(u.host) || PORTAL_HOSTS.test(u.host) || !AGENCY_CONTEXT.test(l.text)) continue
      agencyPages++
      const ag = await readPage(db, deps.fetcher, p.id, l.url, refresh, counters)
      if (!ag) continue
      const agencyDomain = normalizeDomain(ag.finalUrl)!
      const namesBrand = !!brandKey && nameKey(ag.textSample).includes(brandKey)
      for (const email of ag.emails) {
        if (emailDomain(email) !== agencyDomain || seenEmails.has(email)) continue
        seenEmails.add(email)
        const role = roleOfLocal(email.split('@')[0])
        if (role.kind !== 'role') continue
        cands.push({ kind: 'email', value: email, sourceUrl: ag.finalUrl, fetchedAt: ag.fetchedAt, storeValue: true, contactType: 'agency', sourceCategory: 'agency',
          tier: namesBrand ? 'VERIFIED_AGENCY' : 'PUBLIC_UNVERIFIED', decision: namesBrand ? 'accepted' : 'needs_review', agencyName: agencyDomain, agencyConfirmed: namesBrand ? 'brand_site' : null,
          reason: namesBrand
            ? `${p.company_name}'s page ${pg.finalUrl} links to ${agencyDomain} as "${l.text}", and the agency's page names ${p.company_name}.`
            : `Linked from ${p.company_name}'s site as "${l.text}", but the agency page does not mention ${p.company_name}. Confirm the relationship.`,
          evidence: `Link "${l.text}" on ${pg.finalUrl}`, confidence: namesBrand ? 'medium' : 'low', rank: role.rank + 1 })
      }
    }
  }

  // 4. Official social profiles: listed for you to check (they require a login, so the app does not read them).
  const socials = new Map<string, string>()
  for (const l of home?.links ?? []) {
    try {
      const host = new URL(l.url).host
      const hit = SOCIAL_HOSTS.find(([re]) => re.test(host))
      if (hit && !socials.has(hit[1]) && new URL(l.url).pathname.split('/').filter(Boolean).length >= 1) socials.set(hit[1], l.url)
    } catch { /* ignore */ }
  }

  // 5. Save: accepted contacts (deduplicated), findings with reasons, stale sources.
  const summary: DiscoverySummary = { pagesFetched: counters.fetched, pagesCached: counters.cached, pagesConsidered: pages.length, newDirect: 0, newAgency: 0, newPortals: 0, needsReview: 0, rejected: 0, stale: 0, status: 'NO_CONTACT' }
  const existing = all<Contact>(db, 'SELECT * FROM contacts WHERE prospect_id = ?', p.id)
  const now = nowIso()
  tx(db, () => {
    const finding = (c: Candidate, decision: string, reason: string, contactId: number | null = null) => run(db,
      `INSERT INTO contact_findings (prospect_id, run_id, kind, value, source_url, decision, tier, reason, evidence, contact_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      p.id, opts.runId ?? null, c.kind === 'email' && c.contactType === 'agency' ? 'agency' : c.kind, c.value, c.sourceUrl, decision, c.tier, reason, c.evidence?.slice(0, 500) ?? null, contactId, now)
    let emailsAdded = 0, portalsAdded = 0
    const added = new Set<string>()   // addresses and URLs saved in this run
    const ordered = [...cands].sort((a, b) => (a.decision === 'accepted' ? 0 : a.decision === 'needs_review' ? 1 : 2) - (b.decision === 'accepted' ? 0 : b.decision === 'needs_review' ? 1 : 2) || a.rank - b.rank)
    for (const c of ordered) {
      if (c.decision === 'rejected' || !c.tier) { finding(c, 'rejected', c.reason); summary.rejected++; continue }
      if (c.kind === 'email') {
        if (isEmailSuppressed(db, c.value) || isDomainSuppressed(db, c.value) || isDomainSuppressed(db, p.domain)) { finding(c, 'rejected', 'On your do-not-contact list; not added.'); summary.rejected++; continue }
        const other = get<{ company_name: string; prospect_id: number }>(db, 'SELECT p.company_name, c.prospect_id FROM contacts c JOIN prospects p ON p.id = c.prospect_id WHERE c.email = ?', c.value)
        if (other && other.prospect_id !== p.id) { finding(c, 'rejected', `Already on ${other.company_name}'s record; one address belongs to one company.`); summary.rejected++; continue }
        if (added.has(c.value)) continue
        const mine = existing.find((x) => x.email === c.value)
        if (mine) {
          // Already known. Refresh the check date on research contacts; never change one you entered or verified.
          if (!mine.manually_verified && mine.discovered_by === 'research' && c.decision === 'accepted' && mine.verification_status !== 'failed') {
            run(db, 'UPDATE contacts SET last_checked_at = ?, verified_at = ?, updated_at = ? WHERE id = ?', now, c.fetchedAt, now, mine.id)
          }
          finding(c, 'accepted', `Already on record (${mine.contact_tier.replace('_', ' ').toLowerCase()}); still published.`, mine.id)
          continue
        }
        if (emailsAdded >= MAX_EMAILS) { finding(c, 'rejected', `Not added: ${MAX_EMAILS} better addresses were found in this run.`); summary.rejected++; continue }
        const contact = addContact(db, p.id, {
          email: c.value, role: c.contactType === 'agency' ? `Agency (${c.agencyName})` : c.contactType.replace('_', ' '), source_url: c.sourceUrl,
          verification_status: c.tier === 'PUBLIC_UNVERIFIED' ? 'unverified' : 'verified', verified_at: c.tier === 'PUBLIC_UNVERIFIED' ? null : c.fetchedAt,
          jurisdiction: 'unknown', is_primary: !existing.some((x) => x.is_primary) && emailsAdded === 0 && c.tier === 'VERIFIED_DIRECT', discovered_by: 'research',
          contact_tier: c.tier, contact_type: c.contactType, source_category: c.sourceCategory, evidence: c.evidence?.slice(0, 1000) ?? null, confidence: c.confidence,
          agency_name: c.agencyName ?? null, agency_confirmed: c.agencyConfirmed ?? null, decision_note: c.reason.slice(0, 300), last_checked_at: now,
        })
        emailsAdded++
        added.add(c.value)
        finding(c, c.decision, c.reason, contact.id)
        if (c.tier === 'VERIFIED_DIRECT') summary.newDirect++
        else if (c.tier === 'VERIFIED_AGENCY') summary.newAgency++
        else summary.needsReview++
      } else {
        const url = normalizeUrl(c.value)!
        if (added.has(url)) continue
        const mine = existing.find((x) => x.contact_form_url && normalizeUrl(x.contact_form_url) === url)
        if (mine) { finding(c, 'accepted', 'Already on record.', mine.id); continue }
        // One contact form is enough; skip forms when a portal or form is already on record.
        if (portalsAdded >= MAX_PORTALS || (c.kind === 'form' && (portalsAdded > 0 || existing.some((x) => x.contact_tier === 'VERIFIED_PORTAL' && x.verification_status !== 'failed')))) continue
        const contact = addContact(db, p.id, {
          contact_form_url: url, source_url: c.sourceUrl, role: c.kind === 'form' ? 'Contact form' : `${c.contactType.replace('_', ' ')} application`, is_primary: false, discovered_by: 'research',
          contact_tier: 'VERIFIED_PORTAL', contact_type: c.kind === 'form' ? 'contact_form' : 'portal', source_category: c.sourceCategory, evidence: c.evidence, confidence: c.confidence,
          decision_note: c.reason.slice(0, 300), last_checked_at: now,
        })
        portalsAdded++
        added.add(url)
        summary.newPortals++
        finding(c, 'accepted', c.reason, contact.id)
      }
    }
    for (const [network, url] of socials) {
      run(db, `INSERT INTO contact_findings (prospect_id, run_id, kind, value, source_url, decision, reason, created_at) VALUES (?, ?, 'social', ?, ?, 'needs_review', ?, ?)`,
        p.id, opts.runId ?? null, url, homeUrl, `Official ${network} profile linked from the brand's homepage. Profiles need a login, so the app does not read them; check its bio for a business email and add it with the profile as the source.`, now)
    }
    // Research contacts whose source page was re-read and no longer shows them are marked failed (never manual ones).
    for (const c of existing.filter((x) => x.email && x.discovered_by === 'research' && !x.manually_verified && x.verification_status === 'verified' && x.source_url)) {
      const pg = pages.find((x) => x.finalUrl.replace(/\/$/, '') === c.source_url!.replace(/\/$/, ''))
      if (pg && !pg.emails.includes(c.email!) && !pg.jsonLdEmails.includes(c.email!) && !pg.dataEmails.includes(c.email!)) {
        updateContact(db, c.id, { verification_status: 'failed', decision_note: `No longer published on ${c.source_url} (checked ${now.slice(0, 10)}).` })
        summary.stale++
      }
    }
    run(db, 'UPDATE prospects SET last_researched_at = ? WHERE id = ?', now, p.id)
  })
  summary.status = contactStatus(db, p.id)
  logActivity(db, 'contacts.discovered', `Contact research: ${pages.length} page(s) (${counters.fetched} fetched, ${counters.cached} from cache): ${summary.newDirect} direct, ${summary.newAgency} agency, ${summary.newPortals} portal(s), ${summary.needsReview} to verify${summary.stale ? `, ${summary.stale} no longer published` : ''}`, { prospectId: p.id })
  return summary
}

// The best contact method a company has, for the dashboard.
export function contactStatus(db: DB, prospectId: number): DiscoverySummary['status'] {
  const rows = all<{ contact_tier: ContactTier; email: string | null; verification_status: string; agency_confirmed: string | null }>(db,
    'SELECT contact_tier, email, verification_status, agency_confirmed FROM contacts WHERE prospect_id = ?', prospectId)
  const ok = rows.filter((r) => r.verification_status !== 'failed')
  if (ok.some((r) => r.contact_tier === 'VERIFIED_DIRECT' && r.email)) return 'VERIFIED_DIRECT'
  if (ok.some((r) => r.contact_tier === 'VERIFIED_AGENCY' && r.email && r.agency_confirmed)) return 'VERIFIED_AGENCY'
  if (ok.some((r) => r.contact_tier === 'VERIFIED_PORTAL')) return 'VERIFIED_PORTAL'
  if (ok.some((r) => r.contact_tier === 'PUBLIC_UNVERIFIED' || r.contact_tier === 'VERIFIED_AGENCY')) return 'PUBLIC_UNVERIFIED'
  return 'NO_CONTACT'
}

// ---------- Queue (processed by the research worker) ----------

export function queueContactResearch(db: DB, prospectId: number, opts: { refresh?: boolean; reason?: string } = {}) {
  getProspect(db, prospectId)
  const active = get<{ id: number }>(db, "SELECT id FROM contact_research_runs WHERE prospect_id = ? AND status IN ('queued', 'running')", prospectId)
  if (active) return { id: active.id, alreadyQueued: true }
  const id = run(db, "INSERT INTO contact_research_runs (prospect_id, status, refresh, reason, queued_at) VALUES (?, 'queued', ?, ?, ?)", prospectId, opts.refresh ? 1 : 0, opts.reason ?? 'manual', nowIso()).lastId
  return { id, alreadyQueued: false }
}

// prospectId: run that company's queued research now (research batches need the answer before moving on).
export async function processContactRun(db: DB, deps: { fetcher: Fetcher }, prospectId?: number): Promise<boolean> {
  const runRow = tx(db, () => {
    const r = prospectId
      ? get<{ id: number; prospect_id: number; refresh: number }>(db, "SELECT id, prospect_id, refresh FROM contact_research_runs WHERE status = 'queued' AND prospect_id = ? ORDER BY id LIMIT 1", prospectId)
      : get<{ id: number; prospect_id: number; refresh: number }>(db, "SELECT id, prospect_id, refresh FROM contact_research_runs WHERE status = 'queued' ORDER BY id LIMIT 1")
    if (r) run(db, "UPDATE contact_research_runs SET status = 'running', attempts = attempts + 1, started_at = ? WHERE id = ?", nowIso(), r.id)
    return r
  })
  if (!runRow) return false
  try {
    const s = await discoverContacts(db, runRow.prospect_id, deps, { refresh: !!runRow.refresh, runId: runRow.id })
    run(db, "UPDATE contact_research_runs SET status = 'done', pages_fetched = ?, pages_cached = ?, summary = ?, finished_at = ? WHERE id = ?",
      s.pagesFetched, s.pagesCached, JSON.stringify(s), nowIso(), runRow.id)
  } catch (err) {
    run(db, "UPDATE contact_research_runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?", (err as Error).message.slice(0, 500), nowIso(), runRow.id)
  }
  return true
}

// After a crash, a run left "running" goes back to the queue (at most 3 attempts).
export function recoverContactRuns(db: DB) {
  run(db, "UPDATE contact_research_runs SET status = 'failed', error = 'Stopped repeatedly while running', finished_at = ? WHERE status = 'running' AND attempts >= 3", nowIso())
  return run(db, "UPDATE contact_research_runs SET status = 'queued' WHERE status = 'running'").changes
}

export const getRun = (db: DB, id: number) => {
  const r = get(db, 'SELECT * FROM contact_research_runs WHERE id = ?', id)
  if (!r) throw notFound('Research run')
  return r
}
