// Collects the verified facts a pitch may use, and flags what is missing. A pitch can only say
// things that appear here; anything absent is flagged instead of filled in.
import { getSignature } from './signature'
import { all, get, getSetting, type DB } from '../db'
import { contactEligibility, getProspect, type Contact } from '../crm/prospects'
import type { EligibilityResult } from '../core/eligibility'
import { invalid } from '../core/errors'
import { SIGNAL_LABELS } from '../research/evidence'
import { isTemplateConcept } from '../research/score'
import { getDefaultMediaKit, type MediaKit } from '../mediakit/store'
import { classifyProgram, PROGRAM_LABELS, type ProgramType } from './programType'

export interface PitchOptions {
  channel: 'email' | 'manual_form'
  contact_id?: number | null
  package_id?: number | null
  include_rates?: boolean
  custom_rate_text?: string | null
  custom_deliverables?: string | null
  concept?: string | null
}

export interface Package {
  id: number
  slug: string
  name: string
  deliverables: string
  price_min_cents: number | null
  price_max_cents: number | null
  price_unit: 'flat' | 'per_month' | 'custom'
  recurring: number
  active: number
  notes: string | null
}

export interface EvidenceFact {
  id: number
  signal: string
  label: string
  url: string
  snippet: string | null
  retrieved_at: string
}

export interface MetricFact {
  id: number
  platform: string
  metric_key: string
  label: string
  value: number
  unit: string
  period_label: string | null
  period_start: string | null
  period_end: string | null
  as_of: string
  source: string
}

export interface Flag {
  level: 'missing' | 'warning'
  code: string
  message: string
}

export interface Facts {
  prospect: {
    id: number; name: string; domain: string | null; categorySlug: string | null; categoryName: string | null
    fitScore: number | null; products: string | null; productsSourceId: number | null; concept: string | null
    reviewStatus: string; lastResearchedAt: string | null
  }
  program: { type: ProgramType; label: string; basis: string; overridden: boolean }
  evidence: EvidenceFact[]
  contact: (Contact & { eligibility: EligibilityResult }) | null
  application: { url: string; retrievedAt: string | null; origin: 'research' | 'manual' } | null
  metrics: { igViews: MetricFact | null; ytViews: MetricFact | null; igAge: MetricFact | null }
  mediaKit: MediaKit | null
  pkg: Package | null
  options: PitchOptions
  business: { name: string; email: string; signature: string }
  flags: Flag[]
}

const SIGNAL_BY_LABEL = Object.fromEntries(Object.entries(SIGNAL_LABELS).map(([k, v]) => [v, k]))
const EVIDENCE_ORDER = ['creator_program', 'influencer_mentions', 'ambassador_program', 'esports_sponsorship', 'partnership_inquiries', 'affiliate_program']
const AI_SUFFIX = /\s*\(AI draft from [^)]*\)\s*$/

export const stripAiSuffix = (s: string) => s.replace(AI_SUFFIX, '').trim()

const daysSince = (iso: string, now: Date) => (now.getTime() - new Date(iso.length === 7 ? `${iso}-01` : iso).getTime()) / 86_400_000

export function gatherFacts(db: DB, prospectId: number, options: PitchOptions, now = new Date()): Facts {
  const p = getProspect(db, prospectId)
  const flags: Flag[] = []
  const flag = (level: Flag['level'], code: string, message: string) => flags.push({ level, code, message })
  const category = p.category_id ? get<{ slug: string; name: string }>(db, 'SELECT slug, name FROM categories WHERE id = ?', p.category_id) ?? null : null

  // Evidence recorded by research (or added by you as a source).
  const sources = all<{ id: number; url: string; title: string | null; kind: string; retrieved_at: string; snippet: string | null }>(db,
    'SELECT id, url, title, kind, retrieved_at, snippet FROM research_sources WHERE prospect_id = ? ORDER BY id', prospectId)
  const evidence: EvidenceFact[] = sources
    .filter((s) => (s.kind === 'sponsorship_evidence' || s.kind === 'partnership_page') && s.title && SIGNAL_BY_LABEL[s.title])
    .map((s) => ({ id: s.id, signal: SIGNAL_BY_LABEL[s.title!], label: s.title!, url: s.url, snippet: s.snippet, retrieved_at: s.retrieved_at }))
    .sort((a, b) => EVIDENCE_ORDER.indexOf(a.signal) - EVIDENCE_ORDER.indexOf(b.signal))
  const website = sources.find((s) => s.kind === 'website')

  const auto = classifyProgram(evidence)
  const programType = p.program_type_override ?? auto.type
  if (!evidence.length) flag('missing', 'no_evidence', 'No verified evidence of creator partnerships. The pitch can only speak to category fit; consider adding a source or skipping this brand.')
  if (programType === 'affiliate_only') flag('warning', 'affiliate_only', 'Only an affiliate (commission) program was found. The pitch asks about a paid sponsorship instead of joining it.')
  if (!website) flag('missing', 'no_research', 'No research record of the official website. Run research or add a source before relying on brand details.')
  if (!p.products) flag('warning', 'no_products', 'No product description on record, so the pitch does not describe their products.')
  const freshness = getSetting<number>(db, 'outreach.researchFreshnessDays')
  if (p.last_researched_at && daysSince(p.last_researched_at, now) > freshness) flag('warning', 'research_stale', `Research is more than ${freshness} days old. Re-check sources before using this pitch.`)

  // Recipient (email) or application page (manual).
  let contact: Facts['contact'] = null
  const contacts = all<Contact>(db, 'SELECT * FROM contacts WHERE prospect_id = ? ORDER BY is_primary DESC, id', prospectId)
  if (options.channel === 'email') {
    const chosen = options.contact_id ? contacts.find((c) => c.id === options.contact_id) : contacts.find((c) => c.email && c.verification_status === 'verified') ?? contacts.find((c) => c.email)
    if (options.contact_id && !chosen) throw invalid('That contact does not belong to this company')
    if (chosen && !chosen.email) throw invalid('That contact has no email address; use the manual submission channel')
    if (chosen) {
      contact = { ...chosen, eligibility: contactEligibility(db, chosen, p) }
      if (chosen.verification_status !== 'verified') flag('warning', 'contact_unverified', `${chosen.email} has not been verified against a published source.`)
      if (contact.eligibility.status === 'ineligible') flag('missing', 'contact_ineligible', `${chosen.email} cannot be emailed: ${contact.eligibility.reasons[0]}`)
      else if (contact.eligibility.status === 'needs_review') flag('warning', 'contact_review', `Recipient needs your review before any future sending: ${contact.eligibility.reasons.join('; ')}.`)
    } else {
      flag('missing', 'no_email', 'No published business email for this brand. Use the manual submission channel (creator portal or contact form) instead.')
    }
  }
  const app = get<{ application_url: string; url_origin: 'research' | 'manual'; url_retrieved_at: string | null }>(db,
    'SELECT application_url, url_origin, url_retrieved_at FROM manual_applications WHERE prospect_id = ?', prospectId)
  const application = app ? { url: app.application_url, retrievedAt: app.url_retrieved_at, origin: app.url_origin } : suggestApplicationUrl(db, prospectId)
  if (options.channel === 'manual_form' && !application) flag('missing', 'no_application_url', 'No verified creator portal or contact form URL on record.')

  // Creator analytics: only figures marked "may be quoted in pitches".
  const metric = (platform: string, key: string) => get<MetricFact>(db,
    'SELECT id, platform, metric_key, label, value, unit, period_label, period_start, period_end, as_of, source FROM creator_metrics WHERE platform = ? AND metric_key = ? AND pitchable = 1', platform, key) ?? null
  const metrics = { igViews: metric('instagram', 'views_90d'), ytViews: metric('youtube', 'views_90d'), igAge: metric('instagram', 'audience_18_34') }
  if (!metrics.igViews && !metrics.ytViews) flag('missing', 'no_metrics', 'No pitchable 90-day view figures. Mark them "may be quoted" in Settings → Creator analytics.')
  const oldest = [metrics.igViews, metrics.ytViews].filter(Boolean).map((m) => daysSince(m!.as_of, now)).sort((a, b) => b - a)[0]
  if (oldest > 60) flag('warning', 'metrics_stale', `Your analytics are ${Math.round(oldest)} days old. Update them in Settings → Creator analytics.`)

  const mediaKit = getDefaultMediaKit(db) ?? null
  if (!mediaKit) flag('missing', 'no_media_kit', 'No default media kit. Import one on the Media Kit page.')
  if (options.channel === 'manual_form' && mediaKit && !mediaKit.public_url) {
    flag('warning', 'no_public_kit', 'Forms usually cannot take attachments and your media kit has no public link, so the message offers to send it.')
  }

  const pkg = options.package_id ? get<Package>(db, 'SELECT * FROM sponsorship_packages WHERE id = ?', options.package_id) ?? null : null
  if (options.package_id && !pkg) throw invalid('Unknown package')
  if (options.include_rates || options.custom_rate_text) flag('warning', 'rates_included', 'The pitch mentions pricing. Only send it if you are comfortable committing to that range.')

  const concept = options.concept?.trim() || (p.campaign_concept ? stripAiSuffix(p.campaign_concept) : null)
  if (!concept) flag('missing', 'no_concept', 'No campaign concept. Add one in the pitch options.')
  else if (category && isTemplateConcept(concept)) flag('warning', 'concept_template', `The campaign concept is the generic ${category.name} template. Tailor it to ${p.company_name}.`)
  else if (!options.concept && p.campaign_concept && AI_SUFFIX.test(p.campaign_concept)) flag('warning', 'concept_ai', 'The campaign concept was drafted by local AI. Check it is accurate.')

  return {
    prospect: {
      id: p.id, name: p.company_name, domain: p.domain, categorySlug: category?.slug ?? null, categoryName: category?.name ?? null,
      fitScore: p.fit_score, products: p.products, productsSourceId: website?.id ?? null, concept, reviewStatus: p.review_status, lastResearchedAt: p.last_researched_at,
    },
    program: { type: programType, label: PROGRAM_LABELS[programType], basis: p.program_type_override ? 'Set by you.' : auto.basis, overridden: !!p.program_type_override },
    evidence,
    contact,
    application,
    metrics,
    mediaKit,
    pkg,
    options,
    business: { name: getSetting<string>(db, 'business.creatorName'), email: getSetting<string>(db, 'business.email'), signature: getSignature(db) },
    flags,
  }
}

// The best verified page for a manual submission: a contact form research found, else a creator/affiliate program page.
export function suggestApplicationUrl(db: DB, prospectId: number): Facts['application'] {
  const form = get<{ contact_form_url: string; updated_at: string; discovered_by: string }>(db,
    'SELECT contact_form_url, updated_at, discovered_by FROM contacts WHERE prospect_id = ? AND contact_form_url IS NOT NULL ORDER BY is_primary DESC, id LIMIT 1', prospectId)
  const program = get<{ url: string; retrieved_at: string }>(db, `SELECT url, retrieved_at FROM research_sources WHERE prospect_id = ? AND kind = 'sponsorship_evidence'
    AND title IN ('Creator program', 'Ambassador program', 'Affiliate program') ORDER BY CASE title WHEN 'Creator program' THEN 0 WHEN 'Ambassador program' THEN 1 ELSE 2 END LIMIT 1`, prospectId)
  if (program) return { url: program.url, retrievedAt: program.retrieved_at, origin: 'research' }
  if (form) return { url: form.contact_form_url, retrievedAt: form.discovered_by === 'research' ? form.updated_at : null, origin: form.discovered_by === 'research' ? 'research' : 'manual' }
  return null
}
