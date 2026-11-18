// Decides which brands are actionable: only those with a qualifying, publicly sourced email. Computed from stored
// facts every time, so a bounce, an opt-out or a removed source takes effect at once and nothing can be marked by hand.
// HIGH and MEDIUM mean "credibly published for this brand". Neither means the mailbox exists: DNS and formatting
// cannot show that. Only a reply from the address counts as delivery evidence.
import { all, get, type DB } from '../db'
import { emailDomain, normalizeEmail, normalizeUrl } from '../core/normalize'
import { contactEligibility, getProspect, type Contact, type Prospect } from './prospects'
import { classifyEmail } from '../research/extract'
import { SIGNAL_LABELS } from '../research/evidence'
import { classifyProgram, PROGRAM_LABELS, type EvidenceItem, type ProgramType } from '../pitch/programType'
import type { MailDomainStatus } from '../research/mailDomain'

export type LeadConfidence = 'high' | 'medium' | 'unverified'

export interface QualifyInput {
  contact: Pick<Contact, 'email' | 'source_url' | 'verification_status' | 'contact_tier' | 'agency_confirmed' | 'confidence' | 'evidence' | 'decision_note'>
  prospectDomain: string | null
  mailDomain: MailDomainStatus | null      // null = not checked yet
  suppression: string | null               // suppressions.source for this address, if any
}

export interface Qualification {
  confidence: LeadConfidence
  qualifies: boolean
  reasons: string[]
  failure: 'bounced' | 'suppressed' | 'invalid_domain' | 'domain_unchecked' | 'unverified' | null
}

export function qualifyContact(i: QualifyInput): Qualification {
  const c = i.contact
  const email = normalizeEmail(c.email)
  const reasons: string[] = []
  let failure: Qualification['failure'] = null
  const fail = (kind: NonNullable<Qualification['failure']>, reason: string) => { failure ??= kind; reasons.push(reason) }

  if (i.suppression === 'bounce') fail('bounced', 'This address has a known hard bounce.')
  else if (i.suppression) fail('suppressed', 'This address is on your do-not-contact list.')
  if (i.mailDomain === 'invalid' || i.mailDomain === 'no_mail') fail('invalid_domain', 'The email domain does not exist or cannot receive mail.')
  if (!email) fail('unverified', 'Not a valid email address.')
  else {
    const cls = classifyEmail(email, emailDomain(email) ?? '')
    if (cls.kind === 'placeholder') fail('unverified', 'Example or placeholder address.')
    if (cls.kind === 'free_mail') fail('unverified', 'Free email provider, so the connection to the brand cannot be established.')
    // press@www.brand.com: the website's host, almost always a typo for press@brand.com. Never guessed or corrected.
    if (/@www\./.test(email)) fail('invalid_domain', 'The address uses the website host (www.), which is not a mail domain. It was not corrected or guessed.')
  }
  if (!normalizeUrl(c.source_url)) fail('unverified', 'No source URL showing where this address was published.')
  if (c.verification_status !== 'verified') fail('unverified', c.verification_status === 'failed' ? 'No longer published at its source, or failed verification.' : 'Not verified against a public source.')
  if (c.contact_tier === 'PUBLIC_UNVERIFIED') fail('unverified', 'Public address whose connection to the brand has not been verified.')
  if (c.contact_tier === 'VERIFIED_PORTAL') fail('unverified', 'Application portal or contact form, not an email address.')
  if (c.contact_tier === 'VERIFIED_AGENCY' && !c.agency_confirmed) fail('unverified', 'Agency address not confirmed as representing the brand.')
  const onDomain = !!email && !!i.prospectDomain && emailDomain(email) === i.prospectDomain
  if (!onDomain && !c.evidence && !c.decision_note) fail('unverified', 'Off-domain address with no documented connection to the brand.')
  if (!i.mailDomain && !failure) fail('domain_unchecked', 'The email domain has not been checked yet.')
  else if (i.mailDomain === 'unknown' && !failure) fail('domain_unchecked', 'The email domain could not be checked yet (DNS lookup failed).')

  if (failure) return { confidence: 'unverified', qualifies: false, reasons, failure }
  const high = c.contact_tier === 'VERIFIED_DIRECT' && onDomain && c.confidence === 'high'
  return { confidence: high ? 'high' : 'medium', qualifies: true, reasons: [], failure: null }
}

// Who to write to first: creator teams, then partnerships, marketing, PR, agencies, and general mailboxes last.
export function departmentOf(c: Pick<Contact, 'email' | 'contact_tier' | 'contact_type'>): { rank: number; label: string } {
  if (c.contact_tier === 'VERIFIED_AGENCY' || c.contact_type === 'agency') return { rank: 50, label: 'Authorized agency' }
  const tokens = (c.email ?? '').split('@')[0].toLowerCase().split(/[._+-]+/)
  const has = (re: RegExp) => tokens.some((t) => re.test(t))
  if (has(/^(influencers?|creators?|creatorpartnerships|ambassadors?|talent|streamers?)$/)) return { rank: 10, label: 'Influencer / creator partnerships' }
  if (has(/^(partnerships?|partners?|brandpartnerships?|sponsorships?|sponsors?|collabs?|collaborations?)$/)) return { rank: 20, label: 'Brand partnerships / sponsorships' }
  if (has(/^(affiliates?|affiliate|program)$/)) return { rank: 25, label: 'Affiliate program' }
  if (has(/^(marketing|mktg|social|community|brand|brands|advertising|ads|events|creative|growth|content|ugc|video|studio)$/)) return { rank: 30, label: 'Marketing / social' }
  if (has(/^(pr|press|media|news|newsroom)$/)) return { rank: 40, label: 'PR / media relations' }
  return { rank: 60, label: 'General business' }
}

// ---------- One contact, for drafting and sending ----------

export function contactQualification(db: DB, contact: Contact, prospectDomain: string | null): Qualification {
  const d = contact.email ? emailDomain(contact.email) : null
  return qualifyContact({
    contact, prospectDomain,
    mailDomain: d ? get<{ status: MailDomainStatus }>(db, 'SELECT status FROM mail_domains WHERE domain = ?', d)?.status ?? null : null,
    suppression: contact.email ? get<{ source: string }>(db, "SELECT source FROM suppressions WHERE kind = 'email' AND value = ?", contact.email)?.source ?? null : null,
  })
}

// Why an email to this contact must not be drafted or queued. Empty = allowed. Sending limits and the rest of the
// safeguards are checked at the send step as before.
export function emailGate(db: DB, prospectId: number, contact: Contact | null): string[] {
  const p = getProspect(db, prospectId)
  if (!contact?.email) return [`${p.company_name} has no qualifying public email.`]
  const reasons = contactQualification(db, contact, p.domain).reasons.slice()
  const eligibility = contactEligibility(db, contact, p)
  if (eligibility.status === 'ineligible') reasons.push(...eligibility.reasons)
  const prior = get<{ status: string; recipient: string }>(db, "SELECT status, recipient FROM send_attempts WHERE prospect_id = ? AND kind = 'initial' AND status IN ('sending', 'sent', 'uncertain')", prospectId)
  if (prior) reasons.push(`A first email to ${p.company_name} is already ${prior.status} (${prior.recipient}).`)
  return [...new Set(reasons)]
}

// ---------- Every brand ----------

export type ExclusionCode = 'suppressed' | 'bounced' | 'invalid_domain' | 'domain_unchecked' | 'unverified_email' | 'form_only' | 'social_only' | 'no_email' | 'already_contacted' | 'rejected' | 'closed'
export const EXCLUSION_LABELS: Record<ExclusionCode, string> = {
  suppressed: 'Opted out or on your do-not-contact list',
  bounced: 'Known bounced address',
  invalid_domain: 'Email domain cannot receive mail',
  domain_unchecked: 'Email domain not checked yet',
  unverified_email: 'Only unverified addresses',
  form_only: 'Contact form or portal only',
  social_only: 'Social media profiles only',
  no_email: 'No email discovered',
  already_contacted: 'Already contacted',
  rejected: 'Rejected by you',
  closed: 'Closed or paused',
}
const NO_USABLE_EMAIL: ExclusionCode[] = ['bounced', 'invalid_domain', 'domain_unchecked', 'unverified_email', 'form_only', 'social_only', 'no_email']

export type OutreachStatus = 'needs_review' | 'ready_to_draft' | 'pitch_drafted' | 'pitch_approved' | 'gmail_draft' | 'contacted' | 'replied' | 'closed'
export type Relevance = 'high' | 'medium' | 'none'

export interface Lead {
  id: number
  company_name: string
  website: string | null
  domain: string | null
  category_id: number | null
  category_name: string | null
  campaign_type: Prospect['campaign_type']
  fit_score: number | null
  review_status: Prospect['review_status']
  stage: string
  actionable: boolean
  has_qualifying_email: boolean
  exclusion: { code: ExclusionCode; label: string; detail: string } | null
  contact_id: number | null
  email: string | null
  department: string | null
  source_url: string | null
  verified_at: string | null
  confidence: LeadConfidence | null
  delivery_evidence: string
  bounce_status: 'none' | 'bounced'
  relevance: Relevance
  relevance_label: string
  outreach_status: OutreachStatus
  previously_contacted: boolean
  last_contacted_at: string | null
  needs_before_send: string[]            // what you must still confirm before this can be sent
}

const CLOSED = ['won', 'lost', 'not_interested', 'opted_out', 'paused']
const AFTER_CONTACT = ['contacted', 'replied', 'negotiating', 'proposal_sent', 'won', 'lost', 'not_interested']
const SIGNAL_BY_LABEL = Object.fromEntries(Object.entries(SIGNAL_LABELS).map(([k, v]) => [v, k]))
const RELEVANCE: Record<ProgramType, Relevance> = { paid_sponsorship: 'high', creator_partnerships: 'high', affiliate_only: 'medium', unknown: 'none' }

export function listLeads(db: DB): Lead[] {
  const prospects = all<Prospect & { category_name: string | null }>(db, 'SELECT p.*, c.name AS category_name FROM prospects p LEFT JOIN categories c ON c.id = p.category_id')
  const byProspect = <T extends { prospect_id: number }>(rows: T[]) => {
    const m = new Map<number, T[]>()
    for (const r of rows) m.set(r.prospect_id, [...(m.get(r.prospect_id) ?? []), r])
    return m
  }
  const contacts = byProspect(all<Contact>(db, 'SELECT * FROM contacts'))
  const sources = byProspect(all<{ prospect_id: number; title: string | null; snippet: string | null }>(db, "SELECT prospect_id, title, snippet FROM research_sources WHERE kind IN ('sponsorship_evidence', 'partnership_page')"))
  const pitches = byProspect(all<{ prospect_id: number; status: string }>(db, "SELECT prospect_id, status FROM pitches WHERE channel = 'email' AND status IN ('draft', 'approved')"))
  const mail = new Map(all<{ domain: string; status: MailDomainStatus }>(db, 'SELECT domain, status FROM mail_domains').map((r) => [r.domain, r.status]))
  const suppressedEmails = new Map(all<{ value: string; source: string }>(db, "SELECT value, source FROM suppressions WHERE kind = 'email'").map((r) => [r.value, r.source]))
  const suppressedDomains = new Set(all<{ value: string }>(db, "SELECT value FROM suppressions WHERE kind = 'domain'").map((r) => r.value))
  const sent = new Set(all<{ prospect_id: number }>(db, "SELECT DISTINCT prospect_id FROM send_attempts WHERE kind = 'initial' AND status IN ('sending', 'sent', 'uncertain') AND prospect_id IS NOT NULL").map((r) => r.prospect_id))
  const submitted = new Set(all<{ prospect_id: number }>(db, "SELECT prospect_id FROM manual_applications WHERE status IN ('submitted', 'responded', 'accepted', 'declined', 'no_response')").map((r) => r.prospect_id))
  const drafts = new Set(all<{ prospect_id: number }>(db, "SELECT DISTINCT prospect_id FROM gmail_drafts WHERE kind = 'pitch' AND status IN ('creating', 'created', 'uncertain') AND prospect_id IS NOT NULL").map((r) => r.prospect_id))
  const socials = new Set(all<{ prospect_id: number }>(db, "SELECT DISTINCT prospect_id FROM contact_findings WHERE kind = 'social'").map((r) => r.prospect_id))
  const repliedFrom = new Set(all<{ from_email: string }>(db, "SELECT DISTINCT from_email FROM email_messages WHERE direction = 'inbound' AND kind = 'reply' AND from_email IS NOT NULL").map((r) => r.from_email))

  return prospects.map((p): Lead => {
    const own = contacts.get(p.id) ?? []
    const scored = own.filter((c) => c.email).map((c) => {
      const d = emailDomain(c.email!)
      return { c, q: qualifyContact({ contact: c, prospectDomain: p.domain, mailDomain: d ? mail.get(d) ?? null : null, suppression: suppressedEmails.get(c.email!) ?? null }), dept: departmentOf(c) }
    }).sort((a, b) => a.dept.rank - b.dept.rank || b.c.is_primary - a.c.is_primary || a.c.id - b.c.id)
    const best = scored.find((s) => s.q.qualifies) ?? null
    const shown = best ?? scored.find((s) => s.q.failure === 'bounced') ?? scored[0] ?? null

    const contacted = sent.has(p.id) || submitted.has(p.id) || !!p.first_contacted_at || AFTER_CONTACT.includes(p.stage)
    const exclude = (): { code: ExclusionCode; detail: string } | null => {
      if (p.stage === 'opted_out' || (p.domain && suppressedDomains.has(p.domain))) return { code: 'suppressed', detail: 'The company opted out or its domain is suppressed.' }
      if (!best) {
        const failing = scored.find((s) => s.q.failure === 'suppressed') ? 'suppressed' : scored.find((s) => s.q.failure === 'bounced') ? 'bounced'
          : scored.find((s) => s.q.failure === 'domain_unchecked') ? 'domain_unchecked' : scored.find((s) => s.q.failure === 'unverified') ? 'unverified_email' : scored.length ? 'invalid_domain' : null
        if (failing) return { code: failing as ExclusionCode, detail: scored[0].q.reasons[0] ?? '' }
        if (own.some((c) => c.contact_form_url)) return { code: 'form_only', detail: 'The brand publishes a form or application portal, not an address.' }
        if (socials.has(p.id)) return { code: 'social_only', detail: 'Only social profiles were found. They need a login, so they are not read.' }
        return { code: 'no_email', detail: 'No published business email was found.' }
      }
      if (contacted) return { code: 'already_contacted', detail: 'Your outreach rule allows one sequence per company.' }
      if (p.review_status === 'rejected') return { code: 'rejected', detail: p.review_note ?? 'Rejected in review.' }
      if (CLOSED.includes(p.stage)) return { code: 'closed', detail: `Stage: ${p.stage.replace(/_/g, ' ')}.` }
      return null
    }
    const ex = exclude()

    const evidence: EvidenceItem[] = (sources.get(p.id) ?? []).filter((s) => s.title && SIGNAL_BY_LABEL[s.title]).map((s) => ({ signal: SIGNAL_BY_LABEL[s.title!], snippet: s.snippet }))
    const program = p.program_type_override ?? classifyProgram(evidence).type
    const openPitches = pitches.get(p.id) ?? []
    const outreach_status: OutreachStatus = ['replied', 'negotiating', 'proposal_sent'].includes(p.stage) ? 'replied' : CLOSED.includes(p.stage) ? 'closed' : contacted ? 'contacted'
      : p.review_status === 'pending' ? 'needs_review' : drafts.has(p.id) ? 'gmail_draft' : openPitches.some((x) => x.status === 'approved') ? 'pitch_approved' : openPitches.length ? 'pitch_drafted' : 'ready_to_draft'
    const bounced = scored.some((s) => s.q.failure === 'bounced')
    const elig = best ? contactEligibility(db, best.c, p) : null
    return {
      id: p.id, company_name: p.company_name, website: p.website, domain: p.domain, category_id: p.category_id, category_name: p.category_name, campaign_type: p.campaign_type, fit_score: p.fit_score,
      review_status: p.review_status, stage: p.stage,
      actionable: !ex, has_qualifying_email: !!best,
      exclusion: ex ? { ...ex, label: EXCLUSION_LABELS[ex.code] } : null,
      contact_id: shown?.c.id ?? null, email: shown?.c.email ?? null, department: shown?.dept.label ?? null, source_url: shown?.c.source_url ?? null,
      verified_at: shown?.c.verified_at ?? null, confidence: shown?.q.confidence ?? null,
      delivery_evidence: shown?.c.email && repliedFrom.has(shown.c.email) ? 'Confirmed: this address replied' : bounced ? 'Bounced' : 'Not confirmed',
      bounce_status: bounced ? 'bounced' : 'none',
      relevance: RELEVANCE[program], relevance_label: PROGRAM_LABELS[program],
      outreach_status, previously_contacted: contacted, last_contacted_at: p.last_contacted_at,
      needs_before_send: !ex && elig && elig.status !== 'eligible' ? elig.reasons : [],
    }
  }).sort((a, b) => Number(b.actionable) - Number(a.actionable) || ({ high: 0, medium: 1, none: 2 }[a.relevance] - { high: 0, medium: 1, none: 2 }[b.relevance]) || (b.fit_score ?? -1) - (a.fit_score ?? -1) || a.company_name.localeCompare(b.company_name))
}

export function leadMetrics(db: DB, leads = listLeads(db)) {
  const count = (f: (l: Lead) => boolean) => leads.filter(f).length
  const r = get<{ researched: number; qualifying: number; duplicates: number }>(db, `SELECT
    count(CASE WHEN status IN ('done', 'duplicate', 'unreachable', 'blocked', 'failed') THEN 1 END) AS researched,
    count(CASE WHEN qualified = 1 THEN 1 END) AS qualifying,
    count(CASE WHEN status = 'duplicate' THEN 1 END) AS duplicates FROM research_candidates`)!
  const withEmail = count((l) => l.has_qualifying_email)
  const excluded: Partial<Record<ExclusionCode, number>> = {}
  for (const l of leads) if (l.exclusion) excluded[l.exclusion.code] = (excluded[l.exclusion.code] ?? 0) + 1
  return {
    totalBrands: leads.length,
    actionable: count((l) => l.actionable),
    withQualifyingEmail: withEmail,
    withoutUsableEmail: count((l) => !l.has_qualifying_email && (!l.exclusion || NO_USABLE_EMAIL.includes(l.exclusion.code) || l.exclusion.code === 'suppressed')),
    alreadyContacted: count((l) => l.previously_contacted),
    awaitingOutreach: count((l) => l.actionable && l.outreach_status !== 'needs_review'),
    awaitingReview: count((l) => l.actionable && l.outreach_status === 'needs_review'),
    discoveryRate: leads.length ? withEmail / leads.length : 0,
    excluded,
    research: { ...r, rejected: Math.max(0, r.researched - r.qualifying - r.duplicates), rate: r.researched - r.duplicates > 0 ? r.qualifying / (r.researched - r.duplicates) : 0 },
  }
}

// ---------- Bounces ----------

// A mail server's report: 4.x.x / 4xx is temporary (mailbox full, greylisted). Anything else, including a report
// with no readable code, is treated as a hard bounce: the cost of a wrong guess is one lost lead, not a damaged sender.
export function bounceSeverity(text: string): 'temporary' | 'permanent' {
  const permanent = /\b5\.\d{1,3}\.\d{1,3}\b|\b55\d\b/.test(text)
  const temporary = /\b4\.\d{1,3}\.\d{1,3}\b|\b4[25]\d\b/.test(text)
  return temporary && !permanent ? 'temporary' : 'permanent'
}

// The address that bounced is the one this app sent to in that conversation, never one read out of the report.
export function bouncedRecipient(db: DB, gmailThreadId: string): string | null {
  return get<{ recipient: string }>(db, "SELECT recipient FROM send_attempts WHERE gmail_thread_id = ? AND status = 'sent' ORDER BY id DESC LIMIT 1", gmailThreadId)?.recipient ?? null
}
