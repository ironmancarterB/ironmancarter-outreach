// Pitch lifecycle: generate → edit / regenerate → approve or reject. Draft mode only: approval marks a
// pitch as ready for the future approval gate (Phase 5); nothing here can send anything.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { all, get, getSetting, logActivity, nowIso, run, tx, type DB } from '../db'
import { AppError, invalid, notFound } from '../core/errors'
import { getProspect, setStage } from '../crm/prospects'
import { mediaKitFilePath, type MediaKit } from '../mediakit/store'
import type { RouterDeps } from '../ai/router'
import { writeWithLocalAI } from './ai'
import type { Claim } from './claims'
import { runChecks, validateClaims } from './checks'
import { gatherFacts, type PitchOptions } from './facts'
import { outreachPriority, PROGRAM_LABELS, type ProgramType } from './programType'
import { writeTemplate } from './template'
import { ensureApplication } from './applications'

export interface PitchRow {
  id: number
  prospect_id: number
  version: number
  channel: 'email' | 'manual_form'
  contact_id: number | null
  recipient_email: string | null
  application_url: string | null
  subject: string | null
  body: string
  status: 'draft' | 'approved' | 'rejected' | 'superseded'
  generator: 'template' | 'ollama'
  ai_model: string | null
  generation_note: string | null
  options: string
  claims: string
  flags: string
  media_kit_id: number | null
  edited: number
  reviewed_at: string | null
  reject_reason: string | null
  created_at: string
  updated_at: string
}

export function cleanOptions(input: Partial<PitchOptions> & Record<string, unknown>): PitchOptions {
  const channel = input.channel === 'manual_form' ? 'manual_form' : input.channel === 'email' || input.channel == null ? 'email' : null
  if (!channel) throw invalid('Channel must be email or manual_form')
  const text = (v: unknown, field: string, max: number) => {
    if (v == null || v === '') return null
    if (typeof v !== 'string') throw invalid(`${field} must be text`)
    if (v.length > max) throw invalid(`${field} is too long`)
    return v.trim() || null
  }
  const num = (v: unknown) => (v == null || v === '' ? null : Number.isInteger(Number(v)) ? Number(v) : (() => { throw invalid('Invalid id') })())
  return {
    channel,
    contact_id: num(input.contact_id),
    package_id: num(input.package_id),
    include_rates: input.include_rates === true,
    custom_rate_text: text(input.custom_rate_text, 'Custom rate', 200),
    custom_deliverables: text(input.custom_deliverables, 'Custom deliverables', 300),
    concept: text(input.concept, 'Campaign concept', 600),
  }
}

export const getPitch = (db: DB, id: number) => {
  const p = get<PitchRow>(db, 'SELECT * FROM pitches WHERE id = ?', id)
  if (!p) throw notFound('Pitch')
  return p
}

export async function generatePitch(db: DB, prospectId: number, rawOptions: Partial<PitchOptions> & Record<string, unknown>, deps: { ai?: RouterDeps; now?: Date } = {}) {
  const options = cleanOptions(rawOptions)
  const prospect = getProspect(db, prospectId)
  if (prospect.review_status !== 'approved') {
    throw new AppError(409, 'review_required', `Approve ${prospect.company_name} in the review queue before drafting a pitch.`)
  }
  const facts = gatherFacts(db, prospectId, options, deps.now)

  // Local AI only when you selected Ollama; the template otherwise, or when the AI draft is unusable.
  let draft = writeTemplate(facts)
  let generator: PitchRow['generator'] = 'template'
  let aiModel: string | null = null
  const provider = getSetting<string>(db, 'ai.provider')
  let note = provider === 'mock' ? 'Written from the template (the offline mock provider is selected, so no AI was used).' : 'Written from the template.'
  if (provider === 'ollama') {
    const attempt = await writeWithLocalAI(db, facts, deps.ai)
    if (attempt.draft) {
      draft = attempt.draft
      generator = 'ollama'
      aiModel = attempt.model
      note = attempt.note
    } else {
      note = `${attempt.note} Used the template instead; no other AI provider was tried.`
    }
  } else if (provider !== 'mock') {
    note = `The ${provider} provider is not used for pitches in this phase. Written from the template.`
  }

  return tx(db, () => {
    const now = nowIso()
    run(db, `UPDATE pitches SET status = 'superseded', updated_at = ? WHERE prospect_id = ? AND channel = ? AND status IN ('draft', 'approved')`, now, prospectId, options.channel)
    const version = (get<{ v: number | null }>(db, 'SELECT max(version) AS v FROM pitches WHERE prospect_id = ?', prospectId)?.v ?? 0) + 1
    const id = run(db, `INSERT INTO pitches (prospect_id, version, channel, contact_id, recipient_email, application_url, subject, body, generator, ai_model, generation_note,
      options, claims, flags, media_kit_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      prospectId, version, options.channel, facts.contact?.id ?? null, facts.contact?.email ?? null, options.channel === 'manual_form' ? facts.application?.url ?? null : null,
      draft.subject, draft.body, generator, aiModel, note, JSON.stringify(options), JSON.stringify(draft.claims), JSON.stringify(facts.flags), facts.mediaKit?.id ?? null, now, now).lastId
    if (options.channel === 'manual_form' && facts.application) ensureApplication(db, prospectId, facts.application)
    if (['qualified', 'discovered', 'researching'].includes(prospect.stage)) setStage(db, prospectId, 'draft_ready', 'Pitch drafted')
    logActivity(db, 'pitch.generated', `Drafted ${options.channel === 'email' ? 'email' : 'manual submission'} pitch v${version} (${generator === 'ollama' ? `local AI ${aiModel}` : 'template'})`,
      { prospectId, data: { pitchId: id, flags: facts.flags.map((x) => x.code) } })
    return getPitch(db, id)
  })
}

export async function regeneratePitch(db: DB, pitchId: number, overrides: Record<string, unknown> = {}, deps: { ai?: RouterDeps; now?: Date } = {}) {
  const p = getPitch(db, pitchId)
  if (p.status === 'superseded') throw new AppError(409, 'superseded', 'A newer version of this pitch exists; regenerate from that one.')
  return generatePitch(db, p.prospect_id, { ...JSON.parse(p.options), ...overrides }, deps)
}

export function updatePitch(db: DB, pitchId: number, input: { subject?: string | null; body?: string }) {
  const p = getPitch(db, pitchId)
  if (p.status !== 'draft' && p.status !== 'approved') throw new AppError(409, 'not_editable', `A ${p.status} pitch cannot be edited. Regenerate to start a new draft.`)
  const subject = input.subject === undefined ? p.subject : (input.subject ?? '').trim().slice(0, 200) || null
  const body = input.body === undefined ? p.body : String(input.body).replace(/\r\n/g, '\n').trim()
  if (!body) throw invalid('The pitch cannot be empty')
  if (body.length > 5000) throw invalid('The pitch is too long')
  if (subject === p.subject && body === p.body) return p
  tx(db, () => {
    run(db, "UPDATE pitches SET subject = ?, body = ?, edited = 1, status = 'draft', reviewed_at = NULL, updated_at = ? WHERE id = ?", subject, body, nowIso(), pitchId)
    if (p.status === 'approved') {
      const stage = getProspect(db, p.prospect_id).stage
      if (stage === 'awaiting_approval') setStage(db, p.prospect_id, 'draft_ready', 'Approved pitch was edited')
    }
    logActivity(db, 'pitch.edited', `Edited pitch v${p.version}${p.status === 'approved' ? ' (approval withdrawn; re-approve after review)' : ''}`, { prospectId: p.prospect_id })
  })
  return getPitch(db, pitchId)
}

export function evaluatePitch(db: DB, p: PitchRow) {
  const options = JSON.parse(p.options) as PitchOptions
  // If the chosen contact was deleted or lost its email since drafting, fall back to the best current one.
  const contactOk = !options.contact_id || get(db, 'SELECT 1 FROM contacts WHERE id = ? AND prospect_id = ? AND email IS NOT NULL', options.contact_id, p.prospect_id)
  const facts = gatherFacts(db, p.prospect_id, contactOk ? options : { ...options, contact_id: null })
  const { checks, wordCount } = runChecks(facts, p.subject, p.body)
  const claims = validateClaims(db, p.prospect_id, JSON.parse(p.claims) as Claim[], p.body)
  for (const c of claims) for (const problem of c.problems) checks.push({ level: 'warning', code: 'evidence_changed', message: `${problem}.` })
  if (facts.prospect.reviewStatus !== 'approved') checks.push({ level: 'blocker', code: 'review', message: 'The company is no longer approved in the review queue.' })
  return { facts, checks, wordCount, claims }
}

export function approvePitch(db: DB, pitchId: number) {
  const p = getPitch(db, pitchId)
  if (p.status !== 'draft') throw new AppError(409, 'not_draft', `Only drafts can be approved (this one is ${p.status}).`)
  const { checks, facts } = evaluatePitch(db, p)
  const blockers = checks.filter((c) => c.level === 'blocker')
  if (blockers.length) throw new AppError(409, 'blocked', `Fix these first: ${blockers.map((b) => b.message).join(' ')}`, blockers)
  return tx(db, () => {
    run(db, "UPDATE pitches SET status = 'approved', reviewed_at = ?, updated_at = ?, recipient_email = ?, contact_id = ? WHERE id = ?",
      nowIso(), nowIso(), facts.contact?.email ?? p.recipient_email, facts.contact?.id ?? p.contact_id, pitchId)
    if (p.channel === 'email') {
      if (getProspect(db, p.prospect_id).stage === 'draft_ready') setStage(db, p.prospect_id, 'awaiting_approval', 'Pitch approved; waiting for the initial sending approval gate (Phase 5)')
    } else {
      run(db, "UPDATE manual_applications SET status = 'ready', updated_at = ? WHERE prospect_id = ? AND status = 'not_started'", nowIso(), p.prospect_id)
    }
    logActivity(db, 'pitch.approved', `Approved ${p.channel === 'email' ? 'email' : 'manual submission'} pitch v${p.version}. Nothing was sent.`, { prospectId: p.prospect_id })
    return getPitch(db, pitchId)
  })
}

export function rejectPitch(db: DB, pitchId: number, reason: string) {
  const p = getPitch(db, pitchId)
  if (p.status !== 'draft' && p.status !== 'approved') throw new AppError(409, 'not_open', `This pitch is already ${p.status}.`)
  const why = String(reason ?? '').trim()
  if (!why) throw invalid('Add a short reason so you remember why')
  return tx(db, () => {
    run(db, "UPDATE pitches SET status = 'rejected', reject_reason = ?, reviewed_at = ?, updated_at = ? WHERE id = ?", why.slice(0, 500), nowIso(), nowIso(), pitchId)
    const live = get(db, "SELECT 1 FROM pitches WHERE prospect_id = ? AND status IN ('draft', 'approved')", p.prospect_id)
    const stage = getProspect(db, p.prospect_id).stage
    if (!live && ['draft_ready', 'awaiting_approval'].includes(stage)) setStage(db, p.prospect_id, 'qualified', 'Pitch rejected')
    logActivity(db, 'pitch.rejected', `Rejected pitch v${p.version}: ${why}`, { prospectId: p.prospect_id })
    return getPitch(db, pitchId)
  })
}

// What the future Gmail integration will attach. Verified against the stored file; not yet tested with Gmail.
export function attachmentReference(db: DB, dataDir: string, mediaKitId: number | null) {
  if (!mediaKitId) return null
  const kit = get<MediaKit>(db, 'SELECT * FROM media_kits WHERE id = ?', mediaKitId)
  if (!kit) return { mediaKitId, missing: true as const }
  const path = mediaKitFilePath(dataDir, kit)
  const exists = existsSync(path)
  const checksumOk = exists && createHash('sha256').update(readFileSync(path)).digest('hex') === kit.sha256
  return {
    mediaKitId: kit.id, version: kit.version, label: kit.label, filename: kit.original_filename, mimeType: 'application/pdf',
    sizeBytes: kit.size_bytes, sha256: kit.sha256, storedFile: `data/media-kit/${kit.stored_filename}`,
    fileExists: exists, checksumOk, isCurrentDefault: !!kit.is_default, gmailAttachmentTested: false,
  }
}

export function pitchView(db: DB, dataDir: string, pitchId: number) {
  const p = getPitch(db, pitchId)
  const { facts, checks, wordCount, claims } = evaluatePitch(db, p)
  return {
    pitch: { ...p, options: JSON.parse(p.options) as PitchOptions, claims: JSON.parse(p.claims) as Claim[], flags: JSON.parse(p.flags) },
    company: { id: facts.prospect.id, name: facts.prospect.name, domain: facts.prospect.domain, category: facts.prospect.categoryName, fitScore: facts.prospect.fitScore, reviewStatus: facts.prospect.reviewStatus },
    program: facts.program,
    recipient: facts.contact ? {
      id: facts.contact.id, email: facts.contact.email, role: facts.contact.role, verification_status: facts.contact.verification_status,
      verified_at: facts.contact.verified_at, source_url: facts.contact.source_url, eligibility: facts.contact.eligibility,
    } : null,
    application: facts.application,
    currentFlags: facts.flags,
    checks,
    wordCount,
    claimValidation: claims,
    attachment: p.channel === 'email' ? attachmentReference(db, dataDir, p.media_kit_id) : null,
    versions: all<{ id: number; version: number; channel: string; status: string; generator: string; created_at: string }>(db,
      'SELECT id, version, channel, status, generator, created_at FROM pitches WHERE prospect_id = ? ORDER BY version DESC', p.prospect_id),
    sendingAvailable: false,
  }
}

// The approval dashboard: what to draft next (best brands first) and every pitch by status.
export function outreachQueue(db: DB) {
  const approved = all<{ id: number; company_name: string; domain: string | null; fit_score: number | null; category_name: string | null; stage: string }>(db, `
    SELECT p.id, p.company_name, p.domain, p.fit_score, c.name AS category_name, p.stage FROM prospects p LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.review_status = 'approved' AND p.stage NOT IN ('won', 'lost', 'not_interested', 'opted_out', 'paused')
      AND NOT EXISTS (SELECT 1 FROM pitches x WHERE x.prospect_id = p.id AND x.status IN ('draft', 'approved'))`)
  const ready = approved.map((p) => {
    const facts = gatherFacts(db, p.id, { channel: 'email' })
    const type = facts.program.type
    const hasEmail = !!facts.contact?.email && facts.contact.verification_status === 'verified'
    return {
      ...p, programType: type, programLabel: facts.program.label, evidenceCount: facts.evidence.length, hasVerifiedEmail: hasEmail,
      suggestedChannel: hasEmail ? 'email' : facts.application ? 'manual_form' : 'email',
      priority: outreachPriority(p.fit_score, type, hasEmail),
    }
  }).sort((a, b) => b.priority - a.priority)
  const pitches = all<PitchRow & { company_name: string; fit_score: number | null }>(db, `
    SELECT x.*, p.company_name, p.fit_score FROM pitches x JOIN prospects p ON p.id = x.prospect_id
    WHERE x.status != 'superseded' ORDER BY x.updated_at DESC`)
  const summarize = (x: (typeof pitches)[number]) => {
    const { checks, wordCount } = evaluatePitch(db, x)
    return {
      id: x.id, prospect_id: x.prospect_id, company_name: x.company_name, fit_score: x.fit_score, version: x.version, channel: x.channel,
      recipient_email: x.recipient_email, application_url: x.application_url, subject: x.subject, status: x.status, generator: x.generator,
      edited: !!x.edited, updated_at: x.updated_at, reject_reason: x.reject_reason, wordCount,
      blockers: checks.filter((c) => c.level === 'blocker').length, warnings: checks.filter((c) => c.level === 'warning').length,
    }
  }
  return {
    ready,
    drafts: pitches.filter((x) => x.status === 'draft').map(summarize),
    approved: pitches.filter((x) => x.status === 'approved').map(summarize),
    rejected: pitches.filter((x) => x.status === 'rejected').map(summarize),
    pendingReview: get<{ n: number }>(db, "SELECT count(*) AS n FROM prospects WHERE review_status = 'pending'")!.n,
  }
}

export function setProgramTypeOverride(db: DB, prospectId: number, value: string | null) {
  const p = getProspect(db, prospectId)
  if (value !== null && !['paid_sponsorship', 'creator_partnerships', 'affiliate_only', 'unknown'].includes(value)) throw invalid('Unknown program type')
  run(db, 'UPDATE prospects SET program_type_override = ?, updated_at = ? WHERE id = ?', value, nowIso(), prospectId)
  logActivity(db, 'program_type.set', value ? `Program type set to "${PROGRAM_LABELS[value as ProgramType]}"` : 'Program type back to automatic', { prospectId: p.id })
}
