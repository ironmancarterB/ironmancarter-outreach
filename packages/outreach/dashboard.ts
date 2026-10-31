// Outreach dashboard data. Every number is counted from stored records; nothing is estimated.
import { all, get, getSetting, logActivity, nowIso, run, type DB } from '../db'
import { AppError, invalid, notFound } from '../core/errors'
import { contactEligibility, getProspect, type Contact } from '../crm/prospects'
import { isDomainSuppressed, isEmailSuppressed } from '../crm/suppressions'
import { evaluatePitch, type PitchRow } from '../pitch/service'
import { composeBody, contentHash, type DraftRow } from '../gmail/drafts'
import { gmailDraftLink, gmailThreadLink } from '../gmail/google'
import { addBusinessDays, calendar } from './businessDays'
import { CATEGORIES, isCategory } from './classify'
import { listFollowUps, reconcileFollowUps } from './followups'
import { limitsStatus, stopState } from './send'

const n = (db: DB, sql: string, ...p: (string | number)[]) => get<{ n: number }>(db, sql, ...p)!.n

// Latest classified reply per company.
const LATEST_REPLY = `SELECT t.prospect_id, m.classification FROM email_messages m JOIN email_threads t ON t.id = m.thread_id
  WHERE m.direction = 'inbound' AND m.kind = 'reply' AND m.id = (SELECT m2.id FROM email_messages m2 JOIN email_threads t2 ON t2.id = m2.thread_id
    WHERE t2.prospect_id = t.prospect_id AND m2.direction = 'inbound' AND m2.kind = 'reply' ORDER BY COALESCE(m2.message_at, m2.created_at) DESC LIMIT 1)`

export function outreachOverview(db: DB, now = new Date()) {
  reconcileFollowUps(db)
  const iso = now.toISOString()
  return {
    approvedProspects: n(db, "SELECT count(*) AS n FROM prospects WHERE review_status = 'approved'"),
    draftsAwaitingApproval: n(db, "SELECT count(*) AS n FROM pitches WHERE status = 'draft'"),
    readyToSend: sendingQueue(db).filter((q) => q.readyForReview).length,
    emailsSent: n(db, "SELECT count(*) AS n FROM send_attempts WHERE status = 'sent'"),
    uncertainSends: n(db, "SELECT count(*) AS n FROM send_attempts WHERE status = 'uncertain'"),
    repliesReceived: n(db, "SELECT count(*) AS n FROM email_messages WHERE direction = 'inbound' AND kind = 'reply'"),
    needsReview: n(db, "SELECT count(*) AS n FROM email_threads WHERE needs_review = 1"),
    followUpsDue: n(db, "SELECT count(*) AS n FROM follow_ups WHERE status IN ('scheduled', 'approved') AND due_at <= ?", iso),
    interestedBrands: n(db, `SELECT count(*) AS n FROM (${LATEST_REPLY}) WHERE classification = 'interested'`),
    activeNegotiations: n(db, "SELECT count(*) AS n FROM prospects WHERE stage IN ('negotiating', 'proposal_sent')"),
    liveSendingEnabled: getSetting<boolean>(db, 'outreach.liveSendingEnabled'),
    emergencyStop: stopState(db),
    limits: limitsStatus(db, now),
    lastSync: get(db, 'SELECT * FROM gmail_sync_runs ORDER BY id DESC LIMIT 1') ?? null,
  }
}

// Approved email pitches that have not been sent, with everything you need to judge them at a glance.
export function sendingQueue(db: DB) {
  const pitches = all<PitchRow & { company_name: string }>(db, `SELECT x.*, p.company_name FROM pitches x JOIN prospects p ON p.id = x.prospect_id
    WHERE x.channel = 'email' AND x.status = 'approved'
      AND NOT EXISTS (SELECT 1 FROM send_attempts s WHERE s.prospect_id = x.prospect_id AND s.kind = 'initial' AND s.status IN ('sending', 'sent', 'uncertain'))
    ORDER BY x.updated_at DESC`)
  const account = get<{ email: string }>(db, "SELECT email FROM mail_accounts WHERE provider = 'gmail' AND status = 'connected'")
  const cal = calendar(db)
  const fu = getSetting<{ firstAfterBusinessDays: number; secondAfterBusinessDays: number; max: number }>(db, 'outreach.followUps')
  return pitches.map((x) => {
    const prospect = getProspect(db, x.prospect_id)
    const contact = x.contact_id ? get<Contact>(db, 'SELECT * FROM contacts WHERE id = ?', x.contact_id) : undefined
    const elig = contact ? contactEligibility(db, contact, prospect) : null
    const blockers = evaluatePitch(db, x).checks.filter((c) => c.level === 'blocker')
    const draft = get<DraftRow>(db, "SELECT * FROM gmail_drafts WHERE prospect_id = ? AND kind = 'pitch' AND status IN ('creating', 'created', 'uncertain')", x.prospect_id)
    const body = composeBody(db, 'pitch', x.body)
    const upToDate = !!draft && draft.content_sha256 === contentHash(x.recipient_email ?? '', x.subject ?? '', body, draft.attachment_sha256)
    const suppressed = !!x.recipient_email && (isEmailSuppressed(db, x.recipient_email) || isDomainSuppressed(db, x.recipient_email))
    const checks = [
      { label: 'Pitch checks', ok: !blockers.length, detail: blockers.length ? `${blockers.length} to fix` : 'Pass' },
      { label: 'Contact eligible', ok: elig?.status === 'eligible', detail: elig ? `${elig.status.replace('_', ' ')}${elig.status !== 'eligible' ? `: ${elig.reasons.join('; ')}` : ''}` : 'No contact' },
      { label: 'Not suppressed', ok: !suppressed, detail: suppressed ? 'On the do-not-contact list' : 'OK' },
      { label: 'Gmail draft', ok: !!draft && draft.status === 'created' && upToDate && !draft.edited_in_gmail && !!draft.attachment_verified_at,
        detail: !draft ? 'Not created' : draft.status !== 'created' ? draft.status : !upToDate ? 'Out of date' : draft.edited_in_gmail ? 'Changed in Gmail' : draft.attachment_verified_at ? 'Verified (media kit matches)' : 'Not verified' },
      { label: 'Postal address', ok: !!getSetting<string>(db, 'business.postalAddress').trim(), detail: getSetting<string>(db, 'business.postalAddress').trim() ? 'Set' : 'Missing' },
    ]
    const ifSentNow = [fu.firstAfterBusinessDays, fu.secondAfterBusinessDays].slice(0, fu.max).map((d) => addBusinessDays(new Date(), d, cal).toISOString())
    return {
      pitchId: x.id, prospectId: x.prospect_id, company: x.company_name, contact: x.recipient_email, subject: x.subject,
      preview: x.body.replace(/\s+/g, ' ').slice(0, 220), approvedAt: x.reviewed_at, stage: prospect.stage,
      mediaKit: draft?.attachment_verified_at ? 'verified' : draft ? 'attached, not verified' : 'no Gmail draft yet',
      draftOpenUrl: draft?.status === 'created' && draft.gmail_message_id && account ? gmailDraftLink(account.email, draft.gmail_message_id) : null,
      checks, readyForReview: checks.every((c) => c.ok), followUpsIfSentNow: ifSentNow,
    }
  })
}

export function conversations(db: DB) {
  const account = get<{ email: string }>(db, "SELECT email FROM mail_accounts WHERE provider = 'gmail' AND status != 'disconnected'")
  return all<{ id: number; prospect_id: number | null; company_name: string | null; gmail_thread_id: string; subject: string | null; status: string; needs_review: number;
    review_reason: string | null; last_message_at: string | null; last_inbound_at: string | null; origin: string; messages: number; inbound: number }>(db, `
    SELECT t.id, t.prospect_id, p.company_name, t.gmail_thread_id, t.subject, t.status, t.needs_review, t.review_reason, t.last_message_at, t.last_inbound_at, t.origin,
      (SELECT count(*) FROM email_messages m WHERE m.thread_id = t.id AND m.kind != 'draft') AS messages,
      (SELECT count(*) FROM email_messages m WHERE m.thread_id = t.id AND m.direction = 'inbound') AS inbound
    FROM email_threads t LEFT JOIN prospects p ON p.id = t.prospect_id
    WHERE t.status != 'draft' OR t.origin = 'reply_search' ORDER BY COALESCE(t.last_message_at, t.updated_at) DESC`).map((t) => {
    const latest = get<{ classification: string | null; classification_source: string | null; kind: string }>(db,
      "SELECT classification, classification_source, kind FROM email_messages WHERE thread_id = ? AND direction = 'inbound' ORDER BY COALESCE(message_at, created_at) DESC LIMIT 1", t.id)
    return { ...t, latest: latest ?? null, openUrl: account ? gmailThreadLink(account.email, t.gmail_thread_id) : null }
  })
}

export function conversationMessages(db: DB, where: { threadId?: number; prospectId?: number }) {
  const rows = all<Record<string, unknown>>(db, `SELECT m.id, m.thread_id, m.direction, m.kind, m.from_email, m.to_email, m.subject, m.snippet, m.body_text, m.classification,
      m.classification_source, m.classification_note, m.opt_out, m.needs_review, m.review_reason, m.message_at, m.created_at, m.send_attempt_id, c.email AS contact_email
    FROM email_messages m JOIN email_threads t ON t.id = m.thread_id LEFT JOIN contacts c ON c.id = m.contact_id
    WHERE m.kind != 'draft' AND ${where.threadId ? 't.id = ?' : 't.prospect_id = ?'} ORDER BY COALESCE(m.message_at, m.created_at)`, where.threadId ?? where.prospectId ?? 0)
  return rows
}

export function classifyMessage(db: DB, id: number, input: { classification?: unknown; note?: unknown }) {
  const m = get<{ id: number; thread_id: number; direction: string; classification: string | null }>(db, 'SELECT id, thread_id, direction, classification FROM email_messages WHERE id = ?', id)
  if (!m) throw notFound('Message')
  if (m.direction !== 'inbound') throw new AppError(409, 'outbound', 'Only replies are classified.')
  if (!isCategory(input.classification)) throw invalid(`Choose one of: ${Object.values(CATEGORIES).join(', ')}`)
  const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim().slice(0, 500) : 'Set by you'
  run(db, "UPDATE email_messages SET classification = ?, classification_source = 'manual', classification_note = ?, classified_at = ?, needs_review = 0 WHERE id = ?", input.classification, note, nowIso(), id)
  const t = get<{ prospect_id: number | null }>(db, 'SELECT prospect_id FROM email_threads WHERE id = ?', m.thread_id)
  logActivity(db, 'reply.classified', `Reply classified by you: ${CATEGORIES[input.classification]}${m.classification && m.classification !== input.classification ? ` (was ${m.classification.replace('_', ' ')})` : ''}`, { prospectId: t?.prospect_id ?? null })
  return get(db, 'SELECT * FROM email_messages WHERE id = ?', id)
}

// You confirmed a flagged conversation belongs to this company (or fixed it yourself).
export function markThreadReviewed(db: DB, id: number) {
  const t = get<{ id: number; prospect_id: number | null }>(db, 'SELECT id, prospect_id FROM email_threads WHERE id = ?', id)
  if (!t) throw notFound('Conversation')
  run(db, 'UPDATE email_threads SET needs_review = 0, updated_at = ? WHERE id = ?', nowIso(), id)
  run(db, "UPDATE email_messages SET needs_review = 0 WHERE thread_id = ? AND (classification IS NULL OR classification != 'unclear')", id)
  logActivity(db, 'reply.reviewed', 'You reviewed a flagged conversation', { prospectId: t.prospect_id })
  return get(db, 'SELECT * FROM email_threads WHERE id = ?', id)
}

export function sentList(db: DB) {
  return all(db, `SELECT s.id, s.kind, s.origin, s.status, s.recipient, s.subject, s.sent_at, s.confirmed_at, s.error, s.reconcile_note, s.prospect_id, s.attachment_sha256,
      p.company_name FROM send_attempts s LEFT JOIN prospects p ON p.id = s.prospect_id ORDER BY s.id DESC LIMIT 500`)
}

const OUTREACH_TYPES = "(a.type LIKE 'send.%' OR a.type LIKE 'reply.%' OR a.type LIKE 'followup.%' OR a.type LIKE 'outreach.%' OR a.type LIKE 'gmail.%' OR a.type LIKE 'pitch.%' OR a.type = 'stage.changed' OR a.type = 'suppression.added')"

export function outreachActivity(db: DB, prospectId?: number) {
  return all(db, `SELECT a.id, a.prospect_id, a.type, a.summary, a.created_at, p.company_name FROM activities a LEFT JOIN prospects p ON p.id = a.prospect_id
    WHERE ${OUTREACH_TYPES}${prospectId ? ' AND a.prospect_id = ?' : ''} ORDER BY a.id DESC LIMIT 500`, ...(prospectId ? [prospectId] : []))
}

export { listFollowUps }
