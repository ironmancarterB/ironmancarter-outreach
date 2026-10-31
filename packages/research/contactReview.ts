// Your part of contact discovery: adding a business contact you found yourself (with its source and evidence),
// verifying or rejecting public contacts, and confirming agency relationships. The tier rules are the same as
// automated research: only a brand address (or an agency address confirmed independently) can ever be emailed.
import { all, get, logActivity, nowIso, run, type DB } from '../db'
import { AppError, invalid, notFound } from '../core/errors'
import { emailDomain, normalizeDomain, normalizeEmail, normalizeUrl } from '../core/normalize'
import { addContact, CONTACT_SOURCE_CATEGORIES, getProspect, updateContact, type Contact, type ContactTier } from '../crm/prospects'
import { isDomainSuppressed, isEmailSuppressed } from '../crm/suppressions'
import { classifyEmail } from './extract'
import { contactStatus } from './contacts'

const PORTAL_HOSTS = /(^|\.)(creatoriq\.com|impact\.com|partnerstack\.com|typeform\.com|grin\.co|aspire\.io|aspireiq\.com|upfluence\.com|shareasale\.com|awin\.com|cj\.com|rakutenadvertising\.com|refersion\.com|tapfiliate\.com|goaffpro\.com|tally\.so|jotform\.com|airtable\.com|hsforms\.com|hubspot\.com|tagger\.media|later\.com|mavely\.com|levanta\.io)$/i

// Domains the brand owns: its own, plus any domain its research redirected through.
function brandDomains(db: DB, prospectId: number, domain: string | null) {
  const owned = new Set<string>(domain ? [domain] : [])
  for (const r of all<{ url: string; final_url: string | null }>(db, 'SELECT url, final_url FROM research_fetches WHERE prospect_id = ?', prospectId)) {
    const a = normalizeDomain(r.url), b = normalizeDomain(r.final_url)
    if (a && b && a !== b && (a === domain || b === domain)) { owned.add(a); owned.add(b) }
  }
  for (const c of all<{ email: string }>(db, "SELECT email FROM contacts WHERE prospect_id = ? AND contact_tier = 'VERIFIED_DIRECT' AND email IS NOT NULL", prospectId)) {
    const d = emailDomain(c.email)
    if (d) owned.add(d)
  }
  return owned
}

function recordFinding(db: DB, prospectId: number, kind: string, value: string, sourceUrl: string, decision: string, tier: string | null, reason: string, evidence: string | null, contactId: number | null) {
  run(db, `INSERT INTO contact_findings (prospect_id, kind, value, source_url, decision, tier, reason, evidence, contact_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    prospectId, kind, value, sourceUrl, decision, tier, reason, evidence, contactId, nowIso())
}

export interface ManualContactInput {
  email?: unknown
  portal_url?: unknown
  source_url?: unknown
  source_category?: unknown
  evidence?: unknown
  contact_type?: unknown
  agency_name?: unknown
  brand_confirmation?: unknown     // for agencies: where the brand itself confirms the agency (URL or note)
  official_profile?: unknown       // for social sources: you confirmed the profile is the brand's official one
}

export function addManualContact(db: DB, prospectId: number, input: ManualContactInput) {
  const p = getProspect(db, prospectId)
  const source = typeof input.source_url === 'string' ? normalizeUrl(input.source_url) : null
  if (!source) throw invalid('Add the exact page where this contact is published (source URL).')
  const category = typeof input.source_category === 'string' ? input.source_category : ''
  if (!(CONTACT_SOURCE_CATEGORIES as readonly string[]).includes(category)) throw invalid('Choose where you found it (source category).')
  const evidence = typeof input.evidence === 'string' ? input.evidence.trim() : ''
  if (evidence.length < 10) throw invalid('Add the evidence: the text on the source page that shows this contact belongs to the brand.')
  const owned = brandDomains(db, p.id, p.domain)
  const sourceOnBrand = !!normalizeDomain(source) && owned.has(normalizeDomain(source)!)
  const type = typeof input.contact_type === 'string' && input.contact_type.trim() ? input.contact_type.trim().slice(0, 40) : 'general'

  if (input.portal_url) {
    const url = typeof input.portal_url === 'string' ? normalizeUrl(input.portal_url) : null
    if (!url) throw invalid('The application URL is not a valid web address.')
    const host = new URL(url).host
    const official = (owned.has(normalizeDomain(url)!) || PORTAL_HOSTS.test(host)) && sourceOnBrand
    if (!official) throw invalid(`An official portal must be linked from ${p.company_name}'s own site: use a source page on ${p.domain}.`)
    if (all<{ contact_form_url: string }>(db, 'SELECT contact_form_url FROM contacts WHERE prospect_id = ? AND contact_form_url IS NOT NULL', p.id).some((c) => normalizeUrl(c.contact_form_url) === url)) {
      throw new AppError(409, 'duplicate', 'That application link is already on record.')
    }
    const c = addContact(db, p.id, {
      contact_form_url: url, source_url: source, role: 'Application portal (added by you)', discovered_by: 'manual', contact_tier: 'VERIFIED_PORTAL', contact_type: 'portal',
      source_category: category, evidence, confidence: 'high', manually_verified: true, decision_note: `Linked from ${p.company_name}'s site (${source}); added by you.`, last_checked_at: nowIso(),
    })
    recordFinding(db, p.id, 'portal', url, source, 'accepted', 'VERIFIED_PORTAL', 'Added by you with source evidence.', evidence, c.id)
    return { contact: c, status: contactStatus(db, p.id) }
  }

  const email = normalizeEmail(typeof input.email === 'string' ? input.email : null)
  if (!email) throw invalid('Enter a business email address or an application URL.')
  if (isEmailSuppressed(db, email) || isDomainSuppressed(db, email) || isDomainSuppressed(db, p.domain)) throw new AppError(409, 'suppressed', `${email} or ${p.company_name} is on your do-not-contact list.`)
  const cls = classifyEmail(email, p.domain ?? '', owned)
  if (cls.kind === 'placeholder') throw invalid('That looks like an example address, not a real contact.')
  if (cls.kind === 'free_mail') throw invalid('Free email providers (Gmail, Outlook…) are not accepted as official business contacts.')
  if (cls.kind === 'excluded') throw invalid(`${cls.reason}. Support, legal, careers and similar mailboxes are not used for pitches.`)
  const named = cls.kind === 'personal'
  if (named && !['agency', 'professional_profile'].includes(category)) {
    throw invalid('That looks like a person’s own address. Only team mailboxes are accepted, except a named business contact published by an agency or on a professional profile.')
  }
  const onBrand = cls.kind === 'role' || (named && owned.has(emailDomain(email)!))
  let tier: ContactTier = 'PUBLIC_UNVERIFIED'
  let agencyConfirmed: 'manual' | null = null
  let note = ''
  if (onBrand && !named && (sourceOnBrand || (category === 'social' && input.official_profile === true))) {
    tier = 'VERIFIED_DIRECT'
    note = sourceOnBrand ? `Published on ${p.company_name}'s own site; verified by you.` : `Published on ${p.company_name}'s official profile (you confirmed it is official).`
  } else if (!onBrand && category === 'agency') {
    tier = 'VERIFIED_AGENCY'
    const conf = typeof input.brand_confirmation === 'string' ? input.brand_confirmation.trim() : ''
    agencyConfirmed = conf.length >= 10 ? 'manual' : null
    note = agencyConfirmed ? `Agency contact; you confirmed the relationship independently (${conf.slice(0, 150)}).` : 'Agency contact; the relationship still needs independent confirmation before it can be emailed.'
  } else {
    note = onBrand ? `The source is not ${p.company_name}'s own site; verify it before use.` : 'Not on the brand’s domain and not confirmed as its agency; verify before use.'
  }
  const agency = typeof input.agency_name === 'string' && input.agency_name.trim() ? input.agency_name.trim().slice(0, 120) : tier === 'VERIFIED_AGENCY' ? emailDomain(email) : null
  const c = addContact(db, p.id, {
    email, source_url: source, role: tier === 'VERIFIED_AGENCY' ? `Agency (${agency})` : type.replace('_', ' '), discovered_by: 'manual',
    verification_status: tier === 'PUBLIC_UNVERIFIED' ? 'unverified' : 'verified', verified_at: tier === 'PUBLIC_UNVERIFIED' ? null : nowIso(), jurisdiction: 'unknown',
    contact_tier: tier, contact_type: tier === 'VERIFIED_AGENCY' ? 'agency' : type, source_category: category, evidence, confidence: tier === 'PUBLIC_UNVERIFIED' ? 'low' : 'high',
    agency_name: agency, agency_confirmed: agencyConfirmed, manually_verified: tier !== 'PUBLIC_UNVERIFIED', decision_note: note, last_checked_at: nowIso(),
  })
  recordFinding(db, p.id, tier === 'VERIFIED_AGENCY' ? 'agency' : 'email', email, source, tier === 'PUBLIC_UNVERIFIED' || (tier === 'VERIFIED_AGENCY' && !agencyConfirmed) ? 'needs_review' : 'accepted', tier, note, evidence, c.id)
  logActivity(db, 'contacts.manual_added', `You added ${email} (${tier.replace('_', ' ').toLowerCase()})`, { prospectId: p.id })
  return { contact: c, status: contactStatus(db, p.id) }
}

// Verify a public contact (after checking it yourself), confirm an agency, or reject a contact.
export function reviewContact(db: DB, contactId: number, input: { decision?: unknown; evidence?: unknown; agency_name?: unknown; brand_confirmation?: unknown }) {
  const c = get<Contact>(db, 'SELECT * FROM contacts WHERE id = ?', contactId)
  if (!c) throw notFound('Contact')
  const p = getProspect(db, c.prospect_id)
  const evidence = typeof input.evidence === 'string' ? input.evidence.trim() : ''
  if (input.decision === 'reject') {
    const why = evidence || 'Rejected by you'
    updateContact(db, c.id, { verification_status: 'failed', decision_note: `Rejected by you: ${why}`.slice(0, 300) })
    recordFinding(db, p.id, c.email ? 'email' : 'portal', c.email ?? c.contact_form_url ?? '', c.source_url ?? '', 'rejected', c.contact_tier, `Rejected by you: ${why}`, null, c.id)
    logActivity(db, 'contacts.rejected', `You rejected ${c.email ?? c.contact_form_url}`, { prospectId: p.id })
    return get<Contact>(db, 'SELECT * FROM contacts WHERE id = ?', c.id)!
  }
  if (input.decision !== 'verify' && input.decision !== 'confirm_agency') throw invalid('Choose verify, confirm_agency or reject')
  if (evidence.length < 10) throw invalid('Describe what you checked (for example: "Shown on the Contact page under Partnerships").')
  if (!c.email) throw invalid('Portals are verified when added; there is nothing to verify.')
  if (!c.source_url) throw invalid('Add the source URL first.')
  if (isEmailSuppressed(db, c.email) || isDomainSuppressed(db, c.email)) throw new AppError(409, 'suppressed', `${c.email} is on your do-not-contact list.`)
  const owned = brandDomains(db, p.id, p.domain)
  const onBrand = owned.has(emailDomain(c.email)!)
  let update: Parameters<typeof updateContact>[2]
  if (input.decision === 'verify' && onBrand) {
    update = { contact_tier: 'VERIFIED_DIRECT', verification_status: 'verified', manually_verified: true, confidence: 'high', decision_note: `Verified by you: ${evidence}`.slice(0, 300), last_checked_at: nowIso() }
  } else {
    const conf = typeof input.brand_confirmation === 'string' ? input.brand_confirmation.trim() : ''
    if (conf.length < 10) throw invalid(`${c.email} is not on ${p.company_name}'s domain. To use it as an agency contact, say where the brand confirms the agency (URL or note).`)
    const agency = typeof input.agency_name === 'string' && input.agency_name.trim() ? input.agency_name.trim().slice(0, 120) : c.agency_name ?? emailDomain(c.email)
    update = { contact_tier: 'VERIFIED_AGENCY', agency_name: agency, agency_confirmed: 'manual', verification_status: 'verified', manually_verified: true, confidence: 'medium',
      contact_type: 'agency', decision_note: `Agency confirmed by you: ${conf}`.slice(0, 300), last_checked_at: nowIso() }
  }
  const out = updateContact(db, c.id, { ...update, evidence: c.evidence ? `${c.evidence}\nYou: ${evidence}`.slice(0, 1000) : evidence })
  recordFinding(db, p.id, out.contact_tier === 'VERIFIED_AGENCY' ? 'agency' : 'email', c.email, c.source_url, 'accepted', out.contact_tier, out.decision_note ?? '', evidence, c.id)
  logActivity(db, 'contacts.verified', `You verified ${c.email} as ${out.contact_tier.replace('_', ' ').toLowerCase()}`, { prospectId: p.id })
  return out
}

// ---------- Dashboard ----------

export const STATUS_LABELS = {
  VERIFIED_DIRECT: 'Verified email', VERIFIED_AGENCY: 'Verified agency', VERIFIED_PORTAL: 'Official portal / form', PUBLIC_UNVERIFIED: 'Needs manual verification', NO_CONTACT: 'No contact method',
} as const

export function contactDiscovery(db: DB) {
  const prospects = all<{ id: number; company_name: string; domain: string | null; review_status: string; stage: string; fit_score: number | null; last_researched_at: string | null }>(db,
    "SELECT id, company_name, domain, review_status, stage, fit_score, last_researched_at FROM prospects WHERE stage NOT IN ('opted_out') ORDER BY company_name")
  const rows = prospects.map((p) => {
    const contacts = all<Contact>(db, 'SELECT * FROM contacts WHERE prospect_id = ? ORDER BY CASE contact_tier WHEN \'VERIFIED_DIRECT\' THEN 0 WHEN \'VERIFIED_AGENCY\' THEN 1 WHEN \'VERIFIED_PORTAL\' THEN 2 ELSE 3 END, id', p.id)
    const lastRun = get<{ id: number; status: string; queued_at: string; finished_at: string | null; summary: string | null; error: string | null }>(db,
      'SELECT id, status, queued_at, finished_at, summary, error FROM contact_research_runs WHERE prospect_id = ? ORDER BY id DESC LIMIT 1', p.id)
    return {
      ...p, status: contactStatus(db, p.id), contacts,
      lastRun: lastRun ? { ...lastRun, summary: lastRun.summary ? JSON.parse(lastRun.summary) : null } : null,
      findings: get<{ n: number }>(db, 'SELECT count(*) AS n FROM contact_findings WHERE prospect_id = ?', p.id)!.n,
    }
  })
  const counts = Object.fromEntries(Object.keys(STATUS_LABELS).map((k) => [k, rows.filter((r) => r.status === k).length]))
  return { counts, rows, queue: get<{ n: number }>(db, "SELECT count(*) AS n FROM contact_research_runs WHERE status IN ('queued', 'running')")!.n }
}

export const contactFindings = (db: DB, prospectId: number) =>
  all(db, 'SELECT * FROM contact_findings WHERE prospect_id = ? ORDER BY id DESC LIMIT 300', prospectId)
