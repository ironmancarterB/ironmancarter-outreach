import { all, get, getSetting, logActivity, nowIso, run, tx, type DB, type Param } from '../db'
import { AppError, invalid, notFound } from '../core/errors'
import { evaluateEligibility, type EligibilityResult } from '../core/eligibility'
import { nameKey, normalizeDomain, normalizeEmail, normalizeUrl } from '../core/normalize'
import { FIT_FACTORS, fitTier, scoreFit, type FitBreakdown } from '../core/scoring'
import { isStage, stageLabel, type StageId } from '../core/stages'
import { addSuppression, isDomainSuppressed, isEmailSuppressed } from './suppressions'

export interface Prospect {
  id: number
  company_name: string
  website: string | null
  domain: string | null
  category_id: number | null
  products: string | null
  sponsorship_evidence: string | null
  campaign_concept: string | null
  fit_score: number | null
  fit_breakdown: string | null
  fit_explanation: string | null
  research_confidence: 'low' | 'medium' | 'high' | null
  stage: StageId
  potential_value_cents: number | null
  negotiated_value_cents: number | null
  contract_duration: string | null
  deliverables: string | null
  usage_rights: string | null
  negotiation_notes: string | null
  outcome_note: string | null
  payment_status: 'none' | 'invoiced' | 'partial' | 'paid'
  renewal_date: string | null
  next_follow_up_date: string | null
  first_contacted_at: string | null
  last_contacted_at: string | null
  last_reply_at: string | null
  source: 'manual' | 'csv' | 'research'
  review_status: 'pending' | 'approved' | 'rejected'
  review_note: string | null
  reviewed_at: string | null
  last_researched_at: string | null
  program_type_override: 'paid_sponsorship' | 'creator_partnerships' | 'affiliate_only' | 'unknown' | null
  created_at: string
  updated_at: string
}

export interface Contact {
  id: number
  prospect_id: number
  name: string | null
  role: string | null
  email: string | null
  contact_form_url: string | null
  source_url: string | null
  verification_status: 'unverified' | 'verified' | 'failed'
  verified_at: string | null
  jurisdiction: string
  is_primary: number
  created_at: string
  updated_at: string
}

export type ProspectInput = Partial<{
  company_name: string
  website: string | null
  category_id: number | null
  products: string | null
  sponsorship_evidence: string | null
  campaign_concept: string | null
  fit_breakdown: FitBreakdown | null
  fit_explanation: string | null
  research_confidence: Prospect['research_confidence']
  potential_value_cents: number | null
  negotiated_value_cents: number | null
  contract_duration: string | null
  deliverables: string | null
  usage_rights: string | null
  negotiation_notes: string | null
  outcome_note: string | null
  payment_status: Prospect['payment_status']
  renewal_date: string | null
  next_follow_up_date: string | null
}>

export type ContactInput = Partial<{
  name: string | null
  role: string | null
  email: string | null
  contact_form_url: string | null
  source_url: string | null
  verification_status: Contact['verification_status']
  verified_at: string | null
  jurisdiction: string
  is_primary: boolean
  discovered_by: 'manual' | 'research' | 'csv'
}>

export interface DuplicateMatch {
  prospect_id: number
  company_name: string
  reason: 'domain' | 'email' | 'name'
  value: string
}

const TEXT_FIELDS = ['products', 'sponsorship_evidence', 'campaign_concept', 'fit_explanation', 'contract_duration', 'deliverables', 'usage_rights', 'negotiation_notes', 'outcome_note'] as const
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const text = (v: unknown, field: string, max = 5000): string | null => {
  if (v == null) return null
  if (typeof v !== 'string') throw invalid(`${field} must be text`)
  const s = v.trim()
  if (s.length > max) throw invalid(`${field} is too long (max ${max} characters)`)
  return s || null
}
const cents = (v: unknown, field: string): number | null => {
  if (v == null || v === '') return null
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw invalid(`${field} must be a whole number of cents, 0 or more`)
  return v
}
const date = (v: unknown, field: string): string | null => {
  if (v == null || v === '') return null
  if (typeof v !== 'string' || !DATE_RE.test(v)) throw invalid(`${field} must be a date (YYYY-MM-DD)`)
  return v
}

// Turns a (possibly partial) input into column values. Only keys present in the input are returned.
function toColumns(db: DB, input: ProspectInput): Record<string, Param> {
  const out: Record<string, Param> = {}
  const has = (k: keyof ProspectInput) => Object.prototype.hasOwnProperty.call(input, k)

  if (has('company_name')) {
    const name = text(input.company_name, 'Company name', 200)
    if (!name) throw invalid('Company name is required')
    out.company_name = name
    out.name_key = nameKey(name)
  }
  if (has('website')) {
    if (input.website == null || input.website === '') {
      out.website = null
      out.domain = null
    } else {
      const url = normalizeUrl(input.website)
      const domain = normalizeDomain(input.website)
      if (!url || !domain) throw invalid(`Website is not a valid URL: ${input.website}`)
      out.website = url
      out.domain = domain
    }
  }
  if (has('category_id')) {
    if (input.category_id == null) out.category_id = null
    else if (!get(db, 'SELECT 1 FROM categories WHERE id = ?', input.category_id)) throw invalid('Unknown category')
    else out.category_id = input.category_id
  }
  for (const f of TEXT_FIELDS) if (has(f)) out[f] = text(input[f], f.replace(/_/g, ' '))
  if (has('fit_breakdown')) {
    if (input.fit_breakdown == null) {
      out.fit_breakdown = null
      out.fit_score = null
    } else {
      const clean: FitBreakdown = {}
      for (const f of FIT_FACTORS) if (input.fit_breakdown[f.key] != null) clean[f.key] = Number(input.fit_breakdown[f.key])
      try {
        out.fit_score = scoreFit(clean)
      } catch (err) {
        throw invalid((err as Error).message)
      }
      out.fit_breakdown = JSON.stringify(clean)
    }
  }
  if (has('research_confidence')) {
    const v = input.research_confidence
    if (v != null && !['low', 'medium', 'high'].includes(v)) throw invalid('Research confidence must be low, medium or high')
    out.research_confidence = v ?? null
  }
  if (has('potential_value_cents')) out.potential_value_cents = cents(input.potential_value_cents, 'Potential value')
  if (has('negotiated_value_cents')) out.negotiated_value_cents = cents(input.negotiated_value_cents, 'Negotiated value')
  if (has('payment_status')) {
    if (!['none', 'invoiced', 'partial', 'paid'].includes(input.payment_status as string)) throw invalid('Unknown payment status')
    out.payment_status = input.payment_status!
  }
  if (has('renewal_date')) out.renewal_date = date(input.renewal_date, 'Renewal date')
  if (has('next_follow_up_date')) out.next_follow_up_date = date(input.next_follow_up_date, 'Follow-up date')
  return out
}

export function findDuplicates(db: DB, q: { domain?: string | null; name?: string | null; emails?: (string | null)[]; excludeId?: number }): DuplicateMatch[] {
  const matches: DuplicateMatch[] = []
  const exclude = q.excludeId ?? -1
  const domain = normalizeDomain(q.domain)
  if (domain) {
    for (const p of all<{ id: number; company_name: string }>(db, 'SELECT id, company_name FROM prospects WHERE domain = ? AND id != ?', domain, exclude)) {
      matches.push({ prospect_id: p.id, company_name: p.company_name, reason: 'domain', value: domain })
    }
  }
  for (const raw of q.emails ?? []) {
    const email = normalizeEmail(raw)
    if (!email) continue
    for (const p of all<{ id: number; company_name: string }>(db,
      'SELECT p.id, p.company_name FROM contacts c JOIN prospects p ON p.id = c.prospect_id WHERE c.email = ? AND p.id != ?', email, exclude)) {
      matches.push({ prospect_id: p.id, company_name: p.company_name, reason: 'email', value: email })
    }
  }
  const key = q.name ? nameKey(q.name) : ''
  if (key) {
    for (const p of all<{ id: number; company_name: string }>(db, 'SELECT id, company_name FROM prospects WHERE name_key = ? AND id != ?', key, exclude)) {
      if (!matches.some((m) => m.prospect_id === p.id)) matches.push({ prospect_id: p.id, company_name: p.company_name, reason: 'name', value: q.name! })
    }
  }
  return matches
}

export function createProspect(db: DB, input: ProspectInput & { stage?: StageId; source?: Prospect['source'] },
  opts: { allowSimilarName?: boolean; contactEmails?: (string | null)[] } = {}): Prospect {
  if (!input.company_name) throw invalid('Company name is required')
  const cols = toColumns(db, input)
  if (cols.fit_score != null && !cols.fit_explanation) throw invalid('A fit score needs a short explanation')
  const dupes = findDuplicates(db, { domain: cols.domain as string | null, name: input.company_name, emails: opts.contactEmails })
  const hard = dupes.filter((d) => d.reason !== 'name')
  if (hard.length) throw new AppError(409, 'duplicate', `Already in the CRM: ${hard[0].company_name} (same ${hard[0].reason})`, dupes)
  if (dupes.length && !opts.allowSimilarName) {
    throw new AppError(409, 'possible_duplicate', `A company with a similar name exists: ${dupes[0].company_name}`, dupes)
  }
  const stage = input.stage ?? 'discovered'
  if (!isStage(stage)) throw invalid('Unknown stage')
  if (REVIEW_REQUIRED_STAGES.includes(stage)) {
    throw new AppError(409, 'review_required', `New companies start unreviewed and cannot be placed in "${stageLabel(stage)}". Approve them first.`)
  }
  const now = nowIso()
  cols.stage = stage
  cols.source = input.source ?? 'manual'
  cols.created_at = now
  cols.updated_at = now
  const keys = Object.keys(cols)
  const { lastId } = run(db, `INSERT INTO prospects (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, ...keys.map((k) => cols[k]))
  logActivity(db, 'prospect.created', `Added ${cols.company_name} to the CRM`, { prospectId: lastId, data: { source: cols.source } })
  return getProspect(db, lastId)
}

export function getProspect(db: DB, id: number): Prospect {
  const p = get<Prospect>(db, 'SELECT * FROM prospects WHERE id = ?', id)
  if (!p) throw notFound('Company')
  return p
}

export function updateProspect(db: DB, id: number, input: ProspectInput): Prospect {
  const before = getProspect(db, id)
  const cols = toColumns(db, input)
  if (!Object.keys(cols).length) return before
  if ('domain' in cols && cols.domain && cols.domain !== before.domain) {
    const dupes = findDuplicates(db, { domain: cols.domain as string, excludeId: id })
    if (dupes.length) throw new AppError(409, 'duplicate', `Already in the CRM: ${dupes[0].company_name} (same domain)`, dupes)
  }
  const score = 'fit_score' in cols ? cols.fit_score : before.fit_score
  const explanation = 'fit_explanation' in cols ? cols.fit_explanation : before.fit_explanation
  if (score != null && !explanation) throw invalid('A fit score needs a short explanation')
  cols.updated_at = nowIso()
  const keys = Object.keys(cols)
  run(db, `UPDATE prospects SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => cols[k]), id)
  const changed = keys.filter((k) => k !== 'updated_at' && k !== 'name_key' && (before as unknown as Record<string, unknown>)[k] !== cols[k])
  if (changed.length) logActivity(db, 'prospect.updated', `Updated ${changed.join(', ').replace(/_/g, ' ')}`, { prospectId: id, data: { fields: changed } })
  return getProspect(db, id)
}

// Stages that need machinery from later phases (approval gate, live sending) cannot be set by hand.
const LOCKED_STAGES: Partial<Record<StageId, string>> = {
  approved_autopilot: 'Autopilot is not available: every email is sent manually after your confirmation.',
}

// Entering the outreach workflow requires your review approval.
export const REVIEW_REQUIRED_STAGES: StageId[] = ['draft_ready', 'awaiting_approval', 'approved_autopilot', 'contacted']

export function setStage(db: DB, id: number, stage: string, note?: string): Prospect {
  if (!isStage(stage)) throw invalid('Unknown stage')
  if (LOCKED_STAGES[stage]) throw new AppError(409, 'locked_stage', LOCKED_STAGES[stage]!)
  const before = getProspect(db, id)
  if (before.stage === stage) return before
  if (REVIEW_REQUIRED_STAGES.includes(stage) && before.review_status !== 'approved') {
    throw new AppError(409, 'review_required', `Approve ${before.company_name} in the review queue before moving it to "${stageLabel(stage)}".`)
  }
  return tx(db, () => {
    run(db, 'UPDATE prospects SET stage = ?, updated_at = ? WHERE id = ?', stage, nowIso(), id)
    logActivity(db, 'stage.changed', `${stageLabel(before.stage)} → ${stageLabel(stage)}`, { prospectId: id, data: { from: before.stage, to: stage, note } })
    // An opt-out suppresses every address on file for the company.
    if (stage === 'opted_out') {
      for (const c of all<{ email: string }>(db, 'SELECT email FROM contacts WHERE prospect_id = ? AND email IS NOT NULL', id)) {
        addSuppression(db, 'email', c.email, `Opted out (${before.company_name})`, 'opt_out')
      }
    }
    return getProspect(db, id)
  })
}

export function deleteProspect(db: DB, id: number) {
  const p = getProspect(db, id)
  tx(db, () => {
    run(db, 'DELETE FROM prospects WHERE id = ?', id)
    run(db, 'DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM prospect_tags)')
  })
  logActivity(db, 'prospect.deleted', `Deleted ${p.company_name}`, { data: { id, domain: p.domain } })
}

export interface ProspectListItem extends Prospect {
  category_name: string | null
  tags: string[]
  contact_count: number
  primary_email: string | null
  fit_tier: 'A' | 'B' | 'C' | null
}

export interface ListFilters {
  q?: string
  stage?: string
  category_id?: number
  tag?: string
  tier?: 'A' | 'B' | 'C'
  review?: 'pending' | 'approved' | 'rejected'
  source?: Prospect['source']
  sort?: 'updated' | 'created' | 'name' | 'score' | 'value'
  dir?: 'asc' | 'desc'
}

const SORTS: Record<NonNullable<ListFilters['sort']>, string> = {
  updated: 'p.updated_at',
  created: 'p.created_at',
  name: 'p.company_name COLLATE NOCASE',
  score: 'COALESCE(p.fit_score, -1)',
  value: 'COALESCE(p.negotiated_value_cents, p.potential_value_cents, -1)',
}

export function listProspects(db: DB, f: ListFilters = {}): ProspectListItem[] {
  const where: string[] = []
  const params: Param[] = []
  if (f.q) {
    const like = `%${f.q.trim().toLowerCase()}%`
    where.push(`(lower(p.company_name) LIKE ? OR p.domain LIKE ? OR lower(COALESCE(p.products, '')) LIKE ?
      OR EXISTS (SELECT 1 FROM contacts c WHERE c.prospect_id = p.id AND c.email LIKE ?)
      OR EXISTS (SELECT 1 FROM prospect_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.prospect_id = p.id AND lower(t.name) LIKE ?))`)
    params.push(like, like, like, like, like)
  }
  if (f.stage) { where.push('p.stage = ?'); params.push(f.stage) }
  if (f.category_id) { where.push('p.category_id = ?'); params.push(f.category_id) }
  if (f.tag) {
    where.push('EXISTS (SELECT 1 FROM prospect_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.prospect_id = p.id AND t.name = ? COLLATE NOCASE)')
    params.push(f.tag)
  }
  if (f.tier === 'A') where.push('p.fit_score >= 80')
  if (f.tier === 'B') where.push('p.fit_score BETWEEN 60 AND 79')
  if (f.tier === 'C') where.push('p.fit_score < 60')
  if (f.review) { where.push('p.review_status = ?'); params.push(f.review) }
  if (f.source) { where.push('p.source = ?'); params.push(f.source) }
  const order = `${SORTS[f.sort ?? 'updated'] ?? SORTS.updated} ${f.dir === 'asc' ? 'ASC' : 'DESC'}, p.id DESC`
  const rows = all<Prospect & { category_name: string | null; tag_list: string | null; contact_count: number; primary_email: string | null }>(db, `
    SELECT p.*, cat.name AS category_name,
      (SELECT group_concat(t.name, '\u001f') FROM prospect_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.prospect_id = p.id) AS tag_list,
      (SELECT count(*) FROM contacts c WHERE c.prospect_id = p.id) AS contact_count,
      (SELECT c.email FROM contacts c WHERE c.prospect_id = p.id AND c.email IS NOT NULL ORDER BY c.is_primary DESC, c.id LIMIT 1) AS primary_email
    FROM prospects p LEFT JOIN categories cat ON cat.id = p.category_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY ${order}`, ...params)
  return rows.map(({ tag_list, ...p }) => ({
    ...p,
    tags: tag_list ? tag_list.split('\u001f').sort((a, b) => a.localeCompare(b)) : [],
    fit_tier: fitTier(p.fit_score),
  }))
}

export interface ContactWithEligibility extends Contact {
  eligibility: EligibilityResult
}

export function contactEligibility(db: DB, contact: Contact, prospect: Prospect): EligibilityResult {
  return evaluateEligibility({
    contact,
    prospect,
    suppressedEmail: isEmailSuppressed(db, contact.email),
    suppressedDomain: isDomainSuppressed(db, prospect.domain) || isDomainSuppressed(db, contact.email),
    freshnessDays: getSetting<number>(db, 'outreach.researchFreshnessDays'),
    autoJurisdictions: getSetting<string[]>(db, 'outreach.autoEligibleJurisdictions'),
  })
}

export function getProspectDetail(db: DB, id: number) {
  const prospect = getProspect(db, id)
  const contacts = all<Contact>(db, 'SELECT * FROM contacts WHERE prospect_id = ? ORDER BY is_primary DESC, id', id)
    .map((c): ContactWithEligibility => ({ ...c, eligibility: contactEligibility(db, c, prospect) }))
  return {
    prospect: { ...prospect, fit_tier: fitTier(prospect.fit_score), fit_breakdown: prospect.fit_breakdown ? JSON.parse(prospect.fit_breakdown) as FitBreakdown : null },
    category: prospect.category_id ? get<{ id: number; name: string; compliance_note: string | null }>(db, 'SELECT id, name, compliance_note FROM categories WHERE id = ?', prospect.category_id) ?? null : null,
    contacts,
    tags: all<{ name: string }>(db, 'SELECT t.name FROM prospect_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.prospect_id = ? ORDER BY t.name COLLATE NOCASE', id).map((t) => t.name),
    notes: all<{ id: number; body: string; created_at: string }>(db, 'SELECT id, body, created_at FROM notes WHERE prospect_id = ? ORDER BY created_at DESC, id DESC', id),
    sources: all<{ id: number; url: string; title: string | null; kind: string; retrieved_at: string; notes: string | null; snippet: string | null }>(db,
      'SELECT id, url, title, kind, retrieved_at, notes, snippet FROM research_sources WHERE prospect_id = ? ORDER BY retrieved_at DESC, id', id),
    activities: all<{ id: number; type: string; summary: string; created_at: string }>(db,
      'SELECT id, type, summary, created_at FROM activities WHERE prospect_id = ? ORDER BY created_at DESC, id DESC LIMIT 200', id),
    fetches: all<{ id: number; url: string; final_url: string | null; status_code: number | null; outcome: string; title: string | null; fetched_at: string }>(db,
      'SELECT id, url, final_url, status_code, outcome, title, fetched_at FROM research_fetches WHERE prospect_id = ? ORDER BY id', id),
  }
}

// Your decision on a company before it may enter any outreach workflow.
export function reviewProspect(db: DB, id: number, decision: 'approved' | 'rejected' | 'pending', note?: string | null): Prospect {
  if (!['approved', 'rejected', 'pending'].includes(decision)) throw invalid('Decision must be approved, rejected or pending')
  const before = getProspect(db, id)
  const clean = text(note ?? null, 'Review note', 2000)
  if (decision === 'rejected' && !clean) throw invalid('Add a short reason when rejecting')
  return tx(db, () => {
    run(db, 'UPDATE prospects SET review_status = ?, review_note = ?, reviewed_at = ?, updated_at = ? WHERE id = ?',
      decision, clean, decision === 'pending' ? null : nowIso(), nowIso(), id)
    logActivity(db, `review.${decision}`, decision === 'approved' ? 'Approved after review' : decision === 'rejected' ? `Rejected: ${clean}` : 'Moved back to the review queue',
      { prospectId: id, data: { note: clean } })
    // Withdrawing approval takes the company's open pitches out of the outreach workflow.
    if (decision !== 'approved') {
      run(db, `UPDATE pitches SET status = 'rejected', reject_reason = ?, reviewed_at = ?, updated_at = ? WHERE prospect_id = ? AND status IN ('draft', 'approved')`,
        `Company review changed to ${decision}`, nowIso(), nowIso(), id)
      if (decision === 'pending' && ['draft_ready', 'awaiting_approval'].includes(before.stage)) setStage(db, id, 'qualified', 'Review reopened')
    }
    if (decision === 'approved' && ['discovered', 'researching'].includes(before.stage)) setStage(db, id, 'qualified', 'Approved in review')
    if (decision === 'rejected' && !['won', 'lost', 'not_interested', 'opted_out', 'paused'].includes(before.stage)) setStage(db, id, 'paused', 'Rejected in review')
    return getProspect(db, id)
  })
}

function contactColumns(input: ContactInput, existing?: Contact): Record<string, Param> {
  const out: Record<string, Param> = {}
  const has = (k: keyof ContactInput) => Object.prototype.hasOwnProperty.call(input, k)
  if (has('name')) out.name = text(input.name, 'Name', 200)
  if (has('role')) out.role = text(input.role, 'Role', 200)
  if (has('email')) {
    if (input.email == null || input.email === '') out.email = null
    else {
      const e = normalizeEmail(input.email)
      if (!e) throw invalid(`Not a valid email address: ${input.email}`)
      out.email = e
    }
  }
  if (has('contact_form_url')) {
    out.contact_form_url = input.contact_form_url ? normalizeUrl(input.contact_form_url) : null
    if (input.contact_form_url && !out.contact_form_url) throw invalid('Contact form URL is not a valid URL')
  }
  if (has('source_url')) {
    out.source_url = input.source_url ? normalizeUrl(input.source_url) : null
    if (input.source_url && !out.source_url) throw invalid('Source URL is not a valid URL')
  }
  if (has('jurisdiction')) {
    const j = (input.jurisdiction ?? 'unknown').trim()
    out.jurisdiction = j.toLowerCase() === 'unknown' || !j ? 'unknown' : j.toUpperCase()
    if (out.jurisdiction !== 'unknown' && !/^[A-Z]{2}$/.test(out.jurisdiction)) throw invalid('Jurisdiction must be a 2-letter country code or "unknown"')
  }
  if (has('is_primary')) out.is_primary = input.is_primary ? 1 : 0
  if (has('discovered_by')) {
    if (!['manual', 'research', 'csv'].includes(input.discovered_by as string)) throw invalid('Unknown contact origin')
    out.discovered_by = input.discovered_by!
  }
  if (has('verification_status')) {
    const s = input.verification_status
    if (!['unverified', 'verified', 'failed'].includes(s as string)) throw invalid('Unknown verification status')
    out.verification_status = s!
    if (s === 'verified') {
      // A contact is only "verified" when we can point to where it was published.
      const source = has('source_url') ? out.source_url : existing?.source_url
      if (!source) throw invalid('A contact can only be marked verified when it has a source URL')
      out.verified_at = input.verified_at ?? nowIso()
    } else out.verified_at = null
  }
  return out
}

function emailConflict(db: DB, email: string, excludeContactId = -1) {
  const other = get<{ company_name: string }>(db,
    'SELECT p.company_name FROM contacts c JOIN prospects p ON p.id = c.prospect_id WHERE c.email = ? AND c.id != ?', email, excludeContactId)
  if (other) throw new AppError(409, 'duplicate', `${email} is already a contact for ${other.company_name}`)
}

export function addContact(db: DB, prospectId: number, input: ContactInput): Contact {
  const prospect = getProspect(db, prospectId)
  const cols = contactColumns(input)
  if (!cols.email && !cols.contact_form_url) throw invalid('A contact needs an email address or a contact form URL')
  if (cols.email) emailConflict(db, cols.email as string)
  const now = nowIso()
  cols.prospect_id = prospectId
  cols.created_at = now
  cols.updated_at = now
  const id = tx(db, () => {
    if (cols.is_primary) run(db, 'UPDATE contacts SET is_primary = 0 WHERE prospect_id = ?', prospectId)
    const keys = Object.keys(cols)
    return run(db, `INSERT INTO contacts (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, ...keys.map((k) => cols[k])).lastId
  })
  logActivity(db, 'contact.added', `Added contact ${cols.email ?? cols.contact_form_url} for ${prospect.company_name}`, { prospectId })
  return get<Contact>(db, 'SELECT * FROM contacts WHERE id = ?', id)!
}

export function updateContact(db: DB, contactId: number, input: ContactInput): Contact {
  const existing = get<Contact>(db, 'SELECT * FROM contacts WHERE id = ?', contactId)
  if (!existing) throw notFound('Contact')
  const cols = contactColumns(input, existing)
  // Changing the address or its source invalidates an earlier verification.
  const emailChanged = 'email' in cols && cols.email !== existing.email
  const sourceChanged = 'source_url' in cols && cols.source_url !== existing.source_url
  if ((emailChanged || sourceChanged) && !('verification_status' in cols)) {
    cols.verification_status = 'unverified'
    cols.verified_at = null
  }
  const email = 'email' in cols ? cols.email : existing.email
  const form = 'contact_form_url' in cols ? cols.contact_form_url : existing.contact_form_url
  if (!email && !form) throw invalid('A contact needs an email address or a contact form URL')
  if (emailChanged && cols.email) emailConflict(db, cols.email as string, contactId)
  cols.updated_at = nowIso()
  tx(db, () => {
    if (cols.is_primary) run(db, 'UPDATE contacts SET is_primary = 0 WHERE prospect_id = ?', existing.prospect_id)
    const keys = Object.keys(cols)
    run(db, `UPDATE contacts SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => cols[k]), contactId)
  })
  logActivity(db, 'contact.updated', `Updated contact ${email ?? form}`, { prospectId: existing.prospect_id })
  return get<Contact>(db, 'SELECT * FROM contacts WHERE id = ?', contactId)!
}

export function deleteContact(db: DB, contactId: number) {
  const c = get<Contact>(db, 'SELECT * FROM contacts WHERE id = ?', contactId)
  if (!c) throw notFound('Contact')
  run(db, 'DELETE FROM contacts WHERE id = ?', contactId)
  logActivity(db, 'contact.deleted', `Removed contact ${c.email ?? c.contact_form_url}`, { prospectId: c.prospect_id })
}

export function addNote(db: DB, prospectId: number, body: string) {
  getProspect(db, prospectId)
  const b = text(body, 'Note', 10000)
  if (!b) throw invalid('Note is empty')
  const { lastId } = run(db, 'INSERT INTO notes (prospect_id, body, created_at) VALUES (?, ?, ?)', prospectId, b, nowIso())
  logActivity(db, 'note.added', 'Added a note', { prospectId })
  return { id: lastId, body: b }
}

export function setTags(db: DB, prospectId: number, names: string[]): string[] {
  getProspect(db, prospectId)
  const clean = [...new Map(names.map((n) => n.trim()).filter(Boolean).map((n) => [n.toLowerCase(), n.slice(0, 40)])).values()]
  tx(db, () => {
    run(db, 'DELETE FROM prospect_tags WHERE prospect_id = ?', prospectId)
    for (const name of clean) {
      run(db, 'INSERT OR IGNORE INTO tags (name) VALUES (?)', name)
      const tag = get<{ id: number }>(db, 'SELECT id FROM tags WHERE name = ?', name)!
      run(db, 'INSERT OR IGNORE INTO prospect_tags (prospect_id, tag_id) VALUES (?, ?)', prospectId, tag.id)
    }
    run(db, 'DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM prospect_tags)')
  })
  logActivity(db, 'tags.updated', clean.length ? `Tags: ${clean.join(', ')}` : 'Cleared tags', { prospectId })
  return clean
}

export function addSource(db: DB, prospectId: number, input: { url: string; title?: string | null; kind?: string; notes?: string | null }) {
  getProspect(db, prospectId)
  const url = normalizeUrl(input.url)
  if (!url) throw invalid('Source must be a valid URL')
  const kind = input.kind ?? 'other'
  if (!['website', 'partnership_page', 'sponsorship_evidence', 'contact', 'other'].includes(kind)) throw invalid('Unknown source kind')
  const { lastId } = run(db, 'INSERT INTO research_sources (prospect_id, url, title, kind, retrieved_at, notes) VALUES (?, ?, ?, ?, ?, ?)',
    prospectId, url, text(input.title, 'Title', 300), kind, nowIso(), text(input.notes, 'Notes', 2000))
  logActivity(db, 'source.added', `Added research source ${url}`, { prospectId })
  return { id: lastId, url }
}

export const listTags = (db: DB) => all<{ name: string; count: number }>(db,
  'SELECT t.name, count(pt.prospect_id) AS count FROM tags t LEFT JOIN prospect_tags pt ON pt.tag_id = t.id GROUP BY t.id ORDER BY t.name COLLATE NOCASE')
