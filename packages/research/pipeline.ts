// Researches one candidate brand: fetch its official site (obeying robots.txt), look for creator
// partnership evidence and published business contacts, score it, and add it to the CRM for review.
// Nothing is guessed: every contact and every piece of evidence stores the page URL and fetch time.
import { all, get, getSetting, logActivity, nowIso, run, tx, type DB } from '../db'
import { AppError } from '../core/errors'
import { nameKey, normalizeDomain } from '../core/normalize'
import { runAI, type RouterDeps } from '../ai/router'
import { addContact, createProspect, findDuplicates } from '../crm/prospects'
import { departmentOf } from '../crm/leads'
import { classifyEmail, extractPage, type ExtractedPage } from './extract'
import { COMMON_PATHS, detectSignals, evidencePriority, pageSignals, rankLinks, SIGNAL_LABELS, type Finding, type Signal } from './evidence'
import type { Fetcher, FetchResult } from './fetcher'
import { CONCEPT_TEMPLATES, scoreResearch } from './score'
import { queueContactResearch } from './contacts'
import { conceptText, detectUgcSignals, productLine, scoreUgc, ugcConcepts, UGC_SIGNAL_LABELS, type UgcSignal } from '../ugc/research'

export interface Candidate {
  id: number
  batch_id: number
  pool_id: number
  company_name: string
  website: string
  domain: string
  category_id: number
}

export type CandidateOutcome = 'done' | 'duplicate' | 'unreachable' | 'blocked' | 'failed'

export interface ResearchResult {
  status: CandidateOutcome
  message: string
  prospectId?: number
  qualified?: boolean
  exclusionReason?: string | null
}

export interface ResearchDeps {
  fetcher: Fetcher
  ai?: RouterDeps
}

// Signals about who the brand serves, not evidence of sponsorships.
const AUDIENCE_SIGNALS: Signal[] = ['gaming_audience', 'streaming_audience', 'league_of_legends']

interface FoundEmail {
  email: string
  rank: number
  label: string
  sourceUrl: string
  fetchedAt: string
}

function logFetch(db: DB, candidateId: number | null, prospectId: number | null, r: FetchResult, title: string | null) {
  run(db, `INSERT INTO research_fetches (candidate_id, prospect_id, url, final_url, status_code, outcome, bytes, title, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, candidateId, prospectId, r.url, r.finalUrl, r.status, r.outcome, r.bytes, title, r.fetchedAt)
}

function describeFailure(r: FetchResult): { status: CandidateOutcome; message: string } {
  if (r.outcome === 'robots_disallowed') return { status: 'blocked', message: 'robots.txt does not allow automated access to this page. Not bypassed.' }
  if (r.outcome === 'http_error' && [401, 403, 429, 503].includes(r.status ?? 0)) {
    return { status: 'blocked', message: `The site refused automated access (HTTP ${r.status}). Not bypassed; research it by hand if you like.` }
  }
  if (r.outcome === 'http_error') return { status: 'unreachable', message: `Homepage returned HTTP ${r.status}.` }
  if (r.outcome === 'timeout') return { status: 'unreachable', message: 'Homepage timed out.' }
  return { status: 'unreachable', message: `Homepage could not be read (${r.outcome}${r.error ? `: ${r.error}` : ''}).` }
}

const titleMatches = (name: string, domain: string, page: ExtractedPage) => {
  const hay = nameKey(`${page.title ?? ''} ${page.description ?? ''}`)
  const key = nameKey(name)
  const label = nameKey(domain.split('.')[0])
  return (!!key && hay.includes(key)) || (!!label && label.length >= 3 && hay.includes(label))
}

async function campaignConcept(db: DB, deps: ResearchDeps, input: { name: string; categorySlug: string; categoryName: string; description: string | null; findings: Finding[] }) {
  const template = CONCEPT_TEMPLATES[input.categorySlug] ?? 'Sponsored short-form integration with a recurring monthly option.'
  const provider = getSetting<string>(db, 'ai.provider')
  if (provider === 'mock' || !getSetting<boolean>(db, 'research.useAiForConcepts')) return { concept: template, note: null as string | null }
  const facts = [
    `Brand: ${input.name}`,
    `Category: ${input.categoryName}`,
    input.description ? `The brand describes itself as: ${input.description}` : null,
    ...input.findings.slice(0, 4).map((f) => `Published on their site: "${f.snippet}"`),
  ].filter(Boolean).join('\n')
  try {
    const r = await runAI(db, {
      purpose: 'campaign_concept',
      tier: 'routine',
      maxOutputTokens: 160,
      system: 'You suggest sponsorship content ideas for IronmanCarter, a comedic League of Legends and gaming creator (YouTube Shorts, Instagram Reels, TikTok, Twitch; audience mostly men aged 18–34). Use ONLY the facts provided. Do not invent products, claims, prices or past partnerships. No health, performance, privacy or security claims. Reply with one or two sentences, no preamble.',
      prompt: facts,
    }, deps.ai)
    const text = r.text.trim().replace(/^["']|["']$/g, '')
    return text ? { concept: `${text} (AI draft from ${r.provider}; check before using)`, note: null } : { concept: template, note: 'AI returned nothing; used the template' }
  } catch (err) {
    return { concept: template, note: `Local AI unavailable (${(err as Error).message.slice(0, 120)}); used the template` }
  }
}

export async function researchCandidate(db: DB, cand: Candidate, deps: ResearchDeps): Promise<ResearchResult> {
  // 1. Already in the CRM?
  const pre = findDuplicates(db, { domain: cand.domain, name: cand.company_name })
  if (pre.length) {
    const d = pre[0]
    return { status: 'duplicate', prospectId: d.prospect_id, message: d.reason === 'name' ? `Similar name to ${d.company_name} already in the CRM; add it by hand if it is a different company.` : `Already in the CRM as ${d.company_name}.` }
  }

  // 2. Homepage.
  const home = await deps.fetcher.get(cand.website)
  const homePage = home.outcome === 'ok' && home.html ? extractPage(home.html, home.finalUrl) : null
  logFetch(db, cand.id, null, home, homePage?.title ?? null)
  if (!homePage) return describeFailure(home)

  const siteDomain = normalizeDomain(home.finalUrl) ?? cand.domain
  if (siteDomain !== cand.domain) {
    const redirected = findDuplicates(db, { domain: siteDomain })
    if (redirected.length) {
      return { status: 'duplicate', prospectId: redirected[0].prospect_id, message: `${cand.website} redirects to ${siteDomain}, already in the CRM as ${redirected[0].company_name}.` }
    }
  }
  const sameSite = (url: string) => normalizeDomain(url) === siteDomain

  // 3. Visit the most promising pages, then common partnership/contact paths.
  const maxPages = getSetting<number>(db, 'research.maxPagesPerSite')
  const origin = new URL(home.finalUrl).origin
  const queue: string[] = []
  const seen = new Set([home.finalUrl.replace(/\/$/, ''), home.url.replace(/\/$/, '')])
  for (const u of [...rankLinks(homePage.links, sameSite), ...COMMON_PATHS.map((p) => origin + p)]) {
    const key = u.replace(/\/$/, '')
    if (!seen.has(key) && queue.length < maxPages - 1) { seen.add(key); queue.push(u) }
  }

  const pages: { url: string; fetchedAt: string; page: ExtractedPage }[] = [{ url: home.finalUrl, fetchedAt: home.fetchedAt, page: homePage }]
  for (const url of queue) {
    const r = await deps.fetcher.get(url)
    const page = r.outcome === 'ok' && r.html && sameSite(r.finalUrl) ? extractPage(r.html, r.finalUrl) : null
    logFetch(db, cand.id, null, r, page?.title ?? null)
    if (page && !pages.some((p) => p.url === r.finalUrl)) pages.push({ url: r.finalUrl, fetchedAt: r.fetchedAt, page })
  }

  // 4. Evidence and contacts.
  const findings: Finding[] = []
  const signals = new Set<Signal>()
  const byPriority = [...pages].sort((a, b) => evidencePriority(a.url, home.finalUrl) - evidencePriority(b.url, home.finalUrl))
  for (const p of byPriority) {
    const pageFindings = [
      ...(p.url === home.finalUrl ? [] : pageSignals(p.url, p.page.title)),
      ...detectSignals(p.page.mainText || p.page.text, p.url),
    ]
    for (const f of pageFindings) {
      if (!signals.has(f.signal)) findings.push(f)
      signals.add(f.signal)
    }
  }
  const found = new Map<string, FoundEmail>()
  const skipped = { personal: 0, excluded: 0, offDomain: 0 }
  let formUrl: { url: string; fetchedAt: string } | null = null
  // The domain research started from belongs to the brand too (runwayml.com redirects to runway.com).
  const owned = new Set([siteDomain, cand.domain])
  for (const p of pages) {
    for (const email of p.page.emails) {
      const c = classifyEmail(email, siteDomain, owned)
      if (c.kind === 'role') {
        if (!found.has(email)) found.set(email, { email, rank: c.rank, label: c.label, sourceUrl: p.url, fetchedAt: p.fetchedAt })
      } else if (c.kind === 'personal') skipped.personal++
      else if (c.kind === 'excluded') skipped.excluded++
      else if (c.kind === 'off_domain') skipped.offDomain++
    }
    if (!formUrl && p.page.hasContactForm && /contact|partner|creator|influencer|affiliate|sponsor|press/i.test(new URL(p.url).pathname)
      && !/enterprise|sales|support|demo|consult|reseller/i.test(new URL(p.url).pathname)) {
      formUrl = { url: p.url, fetchedAt: p.fetchedAt }
    }
  }
  // Addresses already attached to another company are never reused.
  const rankOf = (email: string) => departmentOf({ email, contact_tier: 'VERIFIED_DIRECT', contact_type: null }).rank
  const emails = [...found.values()].sort((a, b) => rankOf(a.email) - rankOf(b.email) || a.rank - b.rank).filter((e) => !get(db, 'SELECT 1 FROM contacts WHERE email = ?', e.email)).slice(0, 3)

  // 5. Score, concept, and save.
  const category = get<{ slug: string; name: string; campaign_type: 'sponsorship' | 'ugc' }>(db, 'SELECT slug, name, campaign_type FROM categories WHERE id = ?', cand.category_id)!
  const ugc = category.campaign_type === 'ugc'
  const bestEmailRank = emails.length ? Math.min(...emails.map((e) => e.rank)) : null
  // UGC: signals of video marketing and creator use, read from the same pages (no extra requests).
  const ugcFindings = ugc ? detectUgcSignals(pages, siteDomain, category.slug) : []
  const ugcSignals = new Set<UgcSignal>(ugcFindings.map((f) => f.signal))
  const scored = ugc
    ? scoreUgc({ categorySlug: category.slug, ugc: ugcSignals, shared: signals, bestEmailRank, hasContactForm: !!formUrl })
    : scoreResearch({ categorySlug: category.slug, categoryName: category.name, signals, bestEmailRank, hasContactForm: !!formUrl })
  const matches = titleMatches(cand.company_name, siteDomain, homePage)
  const programSignal = (['creator_program', 'affiliate_program', 'ambassador_program', 'influencer_mentions'] as Signal[]).some((s) => signals.has(s))
  const confidence = !matches ? 'low' : programSignal || emails.length ? 'high' : 'medium'
  const evidenceSignals = findings.filter((f) => !AUDIENCE_SIGNALS.includes(f.signal))
  const product = ugc ? productLine(cand.company_name, homePage) : null
  const concepts = ugc ? ugcConcepts({ name: cand.company_name, categorySlug: category.slug, product, sourceUrl: home.finalUrl, ugc: ugcSignals }) : []
  const concept = ugc
    ? { concept: conceptText(concepts), note: null as string | null }
    : await campaignConcept(db, deps, { name: cand.company_name, categorySlug: category.slug, categoryName: category.name, description: homePage.description, findings: evidenceSignals })

  const notes: string[] = []
  if (!matches) notes.push(`The homepage title ("${homePage.title ?? 'none'}") does not clearly match ${cand.company_name}; confirm this is the official site.`)
  if (siteDomain !== cand.domain) notes.push(`${cand.website} redirected to ${home.finalUrl}.`)
  if (skipped.personal) notes.push(`${skipped.personal} personal-looking address(es) were seen and deliberately not stored.`)
  if (skipped.excluded) notes.push(`${skipped.excluded} support/legal/careers address(es) were skipped as unsuitable for pitches.`)
  if (skipped.offDomain) notes.push(`${skipped.offDomain} address(es) on other domains were ignored.`)
  if (found.size > emails.length) notes.push(`${found.size - emails.length} business address(es) were not added (already in the CRM or beyond the top 3).`)
  if (concept.note) notes.push(concept.note)

  try {
    const prospectId = tx(db, () => {
      const p = createProspect(db, {
        company_name: cand.company_name,
        website: home.finalUrl,
        category_id: cand.category_id,
        products: homePage.description,
        sponsorship_evidence: evidenceSignals.length ? evidenceSignals.map((f) => `${SIGNAL_LABELS[f.signal]}: ${f.url}`).join('\n') : null,
        campaign_concept: concept.concept,
        fit_breakdown: scored.breakdown,
        fit_explanation: scored.explanation,
        research_confidence: confidence,
        stage: 'discovered',
        source: 'research',
      }, { allowSimilarName: false, contactEmails: emails.map((e) => e.email) })
      const now = nowIso()
      run(db, 'UPDATE prospects SET last_researched_at = ? WHERE id = ?', now, p.id)
      if (ugc) run(db, "UPDATE prospects SET campaign_type = 'ugc', ugc_concepts = ?, products = COALESCE(?, products) WHERE id = ?", JSON.stringify(concepts), product, p.id)
      emails.forEach((e, i) => addContact(db, p.id, {
        email: e.email, role: e.label, source_url: e.sourceUrl, verification_status: 'verified', verified_at: e.fetchedAt,
        jurisdiction: 'unknown', is_primary: i === 0, discovered_by: 'research',
      }))
      if (!emails.length && formUrl) {
        addContact(db, p.id, { contact_form_url: formUrl.url, source_url: formUrl.url, role: 'Contact form', is_primary: true, discovered_by: 'research' })
      }
      const addSource = (url: string, kind: string, title: string | null, snippet: string | null, at: string) => {
        if (get(db, 'SELECT 1 FROM research_sources WHERE prospect_id = ? AND url = ? AND kind = ?', p.id, url, kind)) return
        run(db, 'INSERT INTO research_sources (prospect_id, url, title, kind, retrieved_at, snippet) VALUES (?, ?, ?, ?, ?, ?)', p.id, url, title, kind, at, snippet)
      }
      addSource(home.finalUrl, 'website', homePage.title, homePage.description, home.fetchedAt)
      for (const f of findings) {
        const at = pages.find((x) => x.url === f.url)?.fetchedAt ?? home.fetchedAt
        const audience = AUDIENCE_SIGNALS.includes(f.signal)
        const kind = audience ? 'other' : f.signal === 'partnership_inquiries' ? 'partnership_page' : 'sponsorship_evidence'
        addSource(f.url, kind, audience ? `Audience signal: ${SIGNAL_LABELS[f.signal]}` : SIGNAL_LABELS[f.signal], f.snippet, at)
      }
      // Several UGC signals can come from one page, so these are kept per signal, not per page.
      for (const f of ugcFindings) {
        const at = pages.find((x) => x.url === f.url)?.fetchedAt ?? home.fetchedAt
        const title = `UGC signal: ${UGC_SIGNAL_LABELS[f.signal]}`
        if (!get(db, 'SELECT 1 FROM research_sources WHERE prospect_id = ? AND title = ?', p.id, title)) {
          run(db, 'INSERT INTO research_sources (prospect_id, url, title, kind, retrieved_at, snippet) VALUES (?, ?, ?, ?, ?, ?)', p.id, f.url, title, 'other', at, f.snippet)
        }
      }
      for (const e of emails) addSource(e.sourceUrl, 'contact', `Published address: ${e.email}`, null, e.fetchedAt)
      if (formUrl && !emails.length) addSource(formUrl.url, 'contact', 'Contact form', null, formUrl.fetchedAt)
      if (notes.length) run(db, 'INSERT INTO notes (prospect_id, body, created_at) VALUES (?, ?, ?)', p.id, `Research notes:\n• ${notes.join('\n• ')}`, now)
      run(db, 'UPDATE research_fetches SET prospect_id = ? WHERE candidate_id = ?', p.id, cand.id)
      // No published address yet: queue the deeper contact research (portals, press pages, agencies).
      if (!emails.length) queueContactResearch(db, p.id, { reason: 'new_brand' })
      logActivity(db, 'research.completed', `Researched ${pages.length} page(s): score ${scored.score}, ${emails.length} verified email(s)${!emails.length && formUrl ? ', contact form' : ''}`,
        { prospectId: p.id, data: { batch: cand.batch_id, signals: [...signals] } })
      return p.id
    })
    const summary = [`${ugc ? 'UGC lead score' : 'score'} ${scored.score}`, emails.length ? `${emails.length} verified email(s)` : formUrl ? 'contact form only' : 'no contact found', `${evidenceSignals.length} evidence signal(s)`]
    return { status: 'done', prospectId, message: summary.join(', ') }
  } catch (err) {
    if (err instanceof AppError && (err.code === 'duplicate' || err.code === 'possible_duplicate')) return { status: 'duplicate', message: err.message }
    throw err
  }
}

// Re-checks research-found contacts against the page they were published on (research freshness).
export async function reverifyContacts(db: DB, prospectId: number, fetcher: Fetcher) {
  const contacts = all<{ id: number; email: string; source_url: string }>(db,
    "SELECT id, email, source_url FROM contacts WHERE prospect_id = ? AND email IS NOT NULL AND source_url IS NOT NULL", prospectId)
  const results: { email: string; result: 'still_published' | 'not_found' | 'could_not_check'; detail: string }[] = []
  for (const c of contacts) {
    const r = await fetcher.get(c.source_url)
    const page = r.outcome === 'ok' && r.html ? extractPage(r.html, r.finalUrl) : null
    logFetch(db, null, prospectId, r, page?.title ?? null)
    if (!page) {
      results.push({ email: c.email, result: 'could_not_check', detail: `${r.outcome}${r.status ? ` (HTTP ${r.status})` : ''}` })
      continue
    }
    if (page.emails.includes(c.email)) {
      run(db, "UPDATE contacts SET verification_status = 'verified', verified_at = ?, updated_at = ? WHERE id = ?", r.fetchedAt, nowIso(), c.id)
      results.push({ email: c.email, result: 'still_published', detail: c.source_url })
    } else {
      run(db, "UPDATE contacts SET verification_status = 'failed', updated_at = ? WHERE id = ?", nowIso(), c.id)
      results.push({ email: c.email, result: 'not_found', detail: `No longer on ${c.source_url}` })
    }
  }
  logActivity(db, 'contacts.reverified', `Re-checked ${results.length} contact(s): ${results.map((r) => `${r.email} ${r.result.replace(/_/g, ' ')}`).join('; ') || 'none to check'}`, { prospectId })
  return results
}
