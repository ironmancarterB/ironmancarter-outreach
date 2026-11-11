// Follow-ups: scheduled in business days after the first email, reviewed by you in the queue, and sent only
// through the same manual confirmation as any email. A scheduled follow-up is not permission to send.
import { all, get, getSetting, logActivity, nowIso, run, tx, type DB } from '../db'
import { AppError, invalid, notFound } from '../core/errors'
import { isDomainSuppressed, isEmailSuppressed } from '../crm/suppressions'
import { stageLabel, type StageId } from '../core/stages'
import { accessToken, requireReadAccess, type GmailDeps } from '../gmail/account'
import { composeBody, contentHash, createDraft, getDraftRow, verifyDraft, type DraftRow } from '../gmail/drafts'
import { GoogleError, headerValue } from '../gmail/google'
import { boundaryFor, buildMessage } from '../gmail/mime'
import { addBusinessDays, calendar } from './businessDays'
import { applySignature, endsWithSignature, getSignature } from '../pitch/signature'

export interface FollowUpRow {
  id: number
  prospect_id: number
  contact_id: number | null
  thread_id: number | null
  initial_send_id: number
  sequence: 1 | 2
  due_at: string
  original_due_at: string
  status: 'scheduled' | 'approved' | 'sent' | 'skipped' | 'cancelled'
  subject: string
  body: string
  edited: number
  approved_at: string | null
  cancel_reason: string | null
  sent_send_id: number | null
  created_at: string
  updated_at: string
}

export interface SendRow {
  id: number
  kind: 'initial' | 'follow_up'
  origin: 'app' | 'gmail'
  prospect_id: number | null
  contact_id: number | null
  pitch_id: number | null
  follow_up_id: number | null
  draft_row_id: number | null
  account_id: number
  idempotency_key: string
  recipient: string
  subject: string | null
  content_sha256: string
  attachment_sha256: string | null
  status: 'sending' | 'sent' | 'uncertain' | 'not_sent' | 'failed'
  initiated_by: 'you' | 'autopilot'
  gmail_message_id: string | null
  gmail_thread_id: string | null
  rfc822_message_id: string | null
  day_key: string
  error: string | null
  reconcile_note: string | null
  confirmed_at: string
  sent_at: string | null
  created_at: string
  updated_at: string
}

const PENDING = "('scheduled', 'approved')"
// Stages in which follow-ups stop: the brand engaged, the deal closed, or you paused or opted them out.
export const FOLLOW_UP_STOP_STAGES: StageId[] = ['replied', 'negotiating', 'proposal_sent', 'won', 'lost', 'not_interested', 'opted_out', 'paused']

export const getFollowUp = (db: DB, id: number) => {
  const f = get<FollowUpRow>(db, 'SELECT * FROM follow_ups WHERE id = ?', id)
  if (!f) throw notFound('Follow-up')
  return f
}

const originalOf = (db: DB, f: Pick<FollowUpRow, 'initial_send_id'>) => get<SendRow>(db, 'SELECT * FROM send_attempts WHERE id = ?', f.initial_send_id)!

// ---------- Text ----------

const longDate = (iso: string, timezone: string) => new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: timezone })

export function followUpText(db: DB, prospectId: number, sequence: 1 | 2, original: { sentAt: string; subject: string | null; body: string }) {
  const company = get<{ company_name: string }>(db, 'SELECT company_name FROM prospects WHERE id = ?', prospectId)?.company_name ?? 'your team'
  const greeting = original.body.split('\n')[0].match(/^(Hi|Hello|Hey) .{1,80},$/)?.[0] ?? 'Hi there,'
  const when = longDate(original.sentAt, calendar(db).timezone)
  const middle = sequence === 1
    ? [`Just following up on my email from ${when} about a possible sponsored collaboration between ${company} and my gaming channel. I'm happy to adjust the idea or send any details you need, and my media kit is attached to that first email.`,
      'Would a quick call, or a short reply with next steps, work for you?']
    : [`Checking in one last time about my note from ${when}. If a creator partnership isn't a priority for ${company} right now, no problem at all, and I won't follow up again.`,
      'If the timing changes, I would love to work together.']
  const subject = original.subject ? (/^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`) : 'Re: our sponsorship idea'
  return { subject, body: applySignature([greeting, ...middle].join('\n\n'), getSignature(db)) }
}

const sentences = (s: string) => s.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).map((x) => x.trim().toLowerCase()).filter((x) => x.split(' ').length >= 8)

export function followUpChecks(db: DB, f: Pick<FollowUpRow, 'body' | 'initial_send_id'>) {
  const problems: string[] = []
  const body = f.body
  const own = getSetting<string>(db, 'business.email').toLowerCase()
  if (!body.trim()) problems.push('The follow-up is empty.')
  if (body.length > 1500) problems.push('The follow-up is too long (keep it under 1,500 characters).')
  if (/\[[^\]]*\]|\{\{|\bTODO\b|\bXXX\b/.test(body)) problems.push('It still contains a placeholder.')
  const others = (body.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? []).filter((e) => e.toLowerCase() !== own)
  if (others.length) problems.push(`It contains another email address (${others.join(', ')}).`)
  if (/\bguarantee/i.test(body)) problems.push('It promises results ("guarantee").')
  if (/\$\s?\d/.test(body)) problems.push('It mentions a price. Discuss rates in your own replies.')
  if (!endsWithSignature(body, getSignature(db))) problems.push('It must end with your signature (Settings → Business).')
  const original = originalOf(db, f)
  const draft = original?.draft_row_id ? get<{ pitch_id: number | null }>(db, 'SELECT pitch_id FROM gmail_drafts WHERE id = ?', original.draft_row_id) : undefined
  const pitchBody = draft?.pitch_id ? get<{ body: string }>(db, 'SELECT body FROM pitches WHERE id = ?', draft.pitch_id)?.body : undefined
  if (pitchBody) {
    const copied = sentences(body).filter((s) => sentences(pitchBody).includes(s))
    if (copied.length) problems.push(`It repeats the original pitch word for word: "${copied[0]}"`)
  }
  return problems
}

// ---------- Scheduling ----------

export function scheduleFollowUps(db: DB, send: SendRow) {
  if (send.kind !== 'initial' || send.status !== 'sent' || !send.prospect_id) return 0
  const cfg = getSetting<{ firstAfterBusinessDays: number; secondAfterBusinessDays: number; max: number }>(db, 'outreach.followUps')
  const cal = calendar(db)
  const sentAt = send.sent_at ?? nowIso()
  const draft = send.draft_row_id ? get<{ pitch_id: number | null }>(db, 'SELECT pitch_id FROM gmail_drafts WHERE id = ?', send.draft_row_id) : undefined
  const pitchBody = (draft?.pitch_id && get<{ body: string }>(db, 'SELECT body FROM pitches WHERE id = ?', draft.pitch_id)?.body) || ''
  const thread = send.gmail_thread_id ? get<{ id: number }>(db, 'SELECT id FROM email_threads WHERE account_id = ? AND gmail_thread_id = ?', send.account_id, send.gmail_thread_id) : undefined
  let created = 0
  const plan: [1 | 2, number][] = [[1, cfg.firstAfterBusinessDays], [2, cfg.secondAfterBusinessDays]]
  for (const [seq, days] of plan.slice(0, cfg.max)) {
    const due = addBusinessDays(new Date(sentAt), days, cal).toISOString()
    const text = followUpText(db, send.prospect_id, seq, { sentAt, subject: send.subject, body: pitchBody })
    const now = nowIso()
    // UNIQUE (initial_send_id, sequence): scheduling twice never creates a second follow-up.
    created += run(db, `INSERT OR IGNORE INTO follow_ups (prospect_id, contact_id, thread_id, initial_send_id, sequence, due_at, original_due_at, subject, body, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, send.prospect_id, send.contact_id, thread?.id ?? null, send.id, seq, due, due, text.subject, text.body, now, now).changes
  }
  if (created) {
    const first = get<{ due_at: string }>(db, `SELECT due_at FROM follow_ups WHERE initial_send_id = ? ORDER BY sequence LIMIT 1`, send.id)
    // Your own reminder date is kept if you set one.
    if (first) run(db, 'UPDATE prospects SET next_follow_up_date = COALESCE(next_follow_up_date, ?) WHERE id = ?', first.due_at.slice(0, 10), send.prospect_id)
    logActivity(db, 'followup.scheduled', `Scheduled ${created} follow-up${created === 1 ? '' : 's'} for review (${cfg.firstAfterBusinessDays} and ${cfg.secondAfterBusinessDays} business days). ${getSetting<boolean>(db, 'outreach.autopilotEnabled') ? ' Autopilot sends them when due unless the brand replies, opts out or bounces.' : ' None will be sent automatically.'}`, { prospectId: send.prospect_id })
  }
  return created
}

// Why a pending follow-up must stop, or null if it may continue.
export function stopReason(db: DB, f: FollowUpRow): string | null {
  const original = originalOf(db, f)
  if (!original || original.status !== 'sent') return 'The original email was not confirmed as sent.'
  const p = get<{ stage: StageId }>(db, 'SELECT stage FROM prospects WHERE id = ?', f.prospect_id)
  if (!p) return 'The company was deleted.'
  if (FOLLOW_UP_STOP_STAGES.includes(p.stage)) return `The company is in the "${stageLabel(p.stage)}" stage.`
  if (isEmailSuppressed(db, original.recipient) || isDomainSuppressed(db, original.recipient)) return `${original.recipient} is on the do-not-contact list.`
  const domain = get<{ domain: string | null }>(db, 'SELECT domain FROM prospects WHERE id = ?', f.prospect_id)?.domain
  if (domain && isDomainSuppressed(db, domain)) return `${domain} is on the do-not-contact list.`
  const reply = get<{ kind: string }>(db, `SELECT m.kind FROM email_messages m JOIN email_threads t ON t.id = m.thread_id
    WHERE t.prospect_id = ? AND m.direction = 'inbound' AND m.kind IN ('reply', 'bounce') AND COALESCE(m.message_at, m.created_at) >= ? LIMIT 1`, f.prospect_id, original.sent_at ?? original.created_at)
  if (reply) return reply.kind === 'bounce' ? 'The first email bounced.' : 'The brand replied.'
  return null
}

// Cancels every pending follow-up that must stop. Safe to run any time; called after syncs, replies,
// suppressions, stage changes, and before anything is drafted or sent.
export function reconcileFollowUps(db: DB, prospectId?: number) {
  const pending = all<FollowUpRow>(db, `SELECT * FROM follow_ups WHERE status IN ${PENDING}${prospectId ? ' AND prospect_id = ?' : ''}`, ...(prospectId ? [prospectId] : []))
  let cancelled = 0
  for (const f of pending) {
    const why = stopReason(db, f)
    if (!why) continue
    tx(db, () => {
      run(db, "UPDATE follow_ups SET status = 'cancelled', cancel_reason = ?, updated_at = ? WHERE id = ?", `Cancelled automatically: ${why}`, nowIso(), f.id)
      const draft = get<{ id: number }>(db, "SELECT id FROM gmail_drafts WHERE follow_up_id = ? AND status = 'created'", f.id)
      logActivity(db, 'followup.cancelled', `Follow-up ${f.sequence} cancelled: ${why}${draft ? ' Its Gmail draft was left in Gmail; delete it there.' : ''}`, { prospectId: f.prospect_id })
    })
    cancelled++
  }
  return cancelled
}

// ---------- Your actions ----------

function requirePending(f: FollowUpRow) {
  if (f.status !== 'scheduled' && f.status !== 'approved') throw new AppError(409, 'not_pending', `This follow-up is already ${f.status}.`)
}

export function editFollowUp(db: DB, id: number, input: { body?: unknown }) {
  const f = getFollowUp(db, id)
  requirePending(f)
  const text = typeof input.body === 'string' ? input.body.replace(/\r\n/g, '\n').trim() : null
  if (!text) throw invalid('The follow-up cannot be empty')
  const body = applySignature(text, getSignature(db))
  if (body === f.body) return f
  run(db, "UPDATE follow_ups SET body = ?, edited = 1, status = 'scheduled', approved_at = NULL, updated_at = ? WHERE id = ?", body, nowIso(), id)
  logActivity(db, 'followup.edited', `Edited follow-up ${f.sequence}${f.status === 'approved' ? ' (approval withdrawn)' : ''}`, { prospectId: f.prospect_id })
  return getFollowUp(db, id)
}

export function approveFollowUp(db: DB, id: number) {
  reconcileFollowUps(db)
  const f = getFollowUp(db, id)
  if (f.status !== 'scheduled') throw new AppError(409, 'not_scheduled', f.status === 'approved' ? 'Already approved.' : `This follow-up is ${f.status}.`)
  const problems = followUpChecks(db, f)
  if (problems.length) throw new AppError(409, 'blocked', `Fix these first: ${problems.join(' ')}`, problems)
  run(db, "UPDATE follow_ups SET status = 'approved', approved_at = ?, updated_at = ? WHERE id = ?", nowIso(), nowIso(), id)
  logActivity(db, 'followup.approved', `Approved follow-up ${f.sequence}. Approval is not permission to send; you confirm the send separately.`, { prospectId: f.prospect_id })
  return getFollowUp(db, id)
}

export function rescheduleFollowUp(db: DB, id: number, dueAt: unknown) {
  const f = getFollowUp(db, id)
  requirePending(f)
  const d = typeof dueAt === 'string' ? new Date(dueAt) : null
  if (!d || Number.isNaN(d.getTime())) throw invalid('Choose a valid date and time')
  if (d.getTime() < Date.now() - 60_000) throw invalid('The new date is in the past')
  if (d.getTime() > Date.now() + 180 * 86_400_000) throw invalid('Choose a date within six months')
  if (f.sequence === 2) {
    const first = get<{ due_at: string; status: string }>(db, 'SELECT due_at, status FROM follow_ups WHERE initial_send_id = ? AND sequence = 1', f.initial_send_id)
    if (first && ['scheduled', 'approved'].includes(first.status) && d.toISOString() <= first.due_at) throw invalid('The second follow-up must come after the first')
  }
  run(db, 'UPDATE follow_ups SET due_at = ?, updated_at = ? WHERE id = ?', d.toISOString(), nowIso(), id)
  logActivity(db, 'followup.rescheduled', `Rescheduled follow-up ${f.sequence} to ${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`, { prospectId: f.prospect_id })
  return getFollowUp(db, id)
}

export function skipFollowUp(db: DB, id: number) {
  const f = getFollowUp(db, id)
  requirePending(f)
  run(db, "UPDATE follow_ups SET status = 'skipped', updated_at = ? WHERE id = ?", nowIso(), id)
  logActivity(db, 'followup.skipped', `Skipped follow-up ${f.sequence}`, { prospectId: f.prospect_id })
  return getFollowUp(db, id)
}

export function cancelFollowUp(db: DB, id: number, reason: unknown) {
  const f = getFollowUp(db, id)
  requirePending(f)
  const why = typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 300) : 'Cancelled by you'
  run(db, "UPDATE follow_ups SET status = 'cancelled', cancel_reason = ?, updated_at = ? WHERE id = ?", why, nowIso(), id)
  logActivity(db, 'followup.cancelled', `Follow-up ${f.sequence} cancelled by you: ${why}`, { prospectId: f.prospect_id })
  return getFollowUp(db, id)
}

// ---------- Gmail draft for a follow-up (a reply in the original thread) ----------

export const followUpBody = (db: DB, f: FollowUpRow) => composeBody(db, 'follow_up', f.body)

export const liveFollowUpDraft = (db: DB, followUpId: number) =>
  get<DraftRow>(db, "SELECT * FROM gmail_drafts WHERE follow_up_id = ? AND status IN ('creating', 'created', 'uncertain')", followUpId)

// Threading headers: reply to the latest message in the Gmail conversation.
async function threadingHeaders(db: DB, deps: GmailDeps, threadId: string) {
  const { token } = await accessToken(db, deps)
  const thread = await deps.api.getThread(token, threadId, 'metadata')
  const ids = (thread.messages ?? []).filter((m) => !m.labelIds?.includes('DRAFT')).map((m) => headerValue(m, 'Message-Id')).filter((x): x is string => !!x)
  if (!ids.length) throw new AppError(409, 'no_thread', 'Could not find the original message in Gmail to reply to.')
  return { 'In-Reply-To': ids[ids.length - 1], References: ids.join(' ') }
}

export async function createFollowUpDraft(db: DB, deps: GmailDeps, dataDir: string, id: number) {
  const { account } = await accessToken(db, deps)
  requireReadAccess(account)
  reconcileFollowUps(db)
  const f = getFollowUp(db, id)
  if (f.status !== 'approved') throw new AppError(409, 'not_approved', 'Approve the follow-up before creating its Gmail draft.')
  if (liveFollowUpDraft(db, id)) throw new AppError(409, 'duplicate', 'This follow-up already has a Gmail draft.')
  const original = originalOf(db, f)
  if (!original.gmail_thread_id) throw new AppError(409, 'no_thread', 'The original email has no Gmail conversation to reply in.')
  const headers = await threadingHeaders(db, deps, original.gmail_thread_id)
  return createDraft(db, deps, dataDir, {
    kind: 'follow_up', pitchId: null, prospectId: f.prospect_id, followUpId: f.id, to: original.recipient, subject: f.subject,
    body: followUpBody(db, f), kitId: null, attachKit: false, threadId: original.gmail_thread_id, headers,
  })
}

// Replaces the Gmail draft's content after you edited and re-approved the follow-up (same draft id).
export async function updateFollowUpDraft(db: DB, deps: GmailDeps, id: number) {
  const f = getFollowUp(db, id)
  if (f.status !== 'approved') throw new AppError(409, 'not_approved', 'Approve the edited follow-up first.')
  const row = liveFollowUpDraft(db, id)
  if (!row || row.status !== 'created' || !row.gmail_draft_id || !row.gmail_thread_id) throw new AppError(409, 'no_draft', 'There is no linked Gmail draft to update.')
  const { account, token } = await accessToken(db, deps)
  const headers = await threadingHeaders(db, deps, row.gmail_thread_id)
  const body = followUpBody(db, f)
  const raw = buildMessage({ from: { name: getSetting<string>(db, 'business.creatorName'), email: account.email }, to: row.recipient, subject: f.subject, body, boundary: boundaryFor(row.local_ref), headers })
  try {
    const d = await deps.api.updateDraftInThread(token, row.gmail_draft_id, raw, row.gmail_thread_id)
    run(db, 'UPDATE gmail_drafts SET content_sha256 = ?, gmail_message_id = ?, edited_in_gmail = 0, attachment_check = NULL, attachment_verified_at = NULL, updated_at = ? WHERE id = ?',
      contentHash(row.recipient, f.subject, body, null), d.message.id, nowIso(), row.id)
  } catch (err) {
    if (err instanceof GoogleError && err.status === 404) {
      run(db, "UPDATE gmail_drafts SET status = 'gone', sync_note = 'No longer in Gmail drafts.', updated_at = ? WHERE id = ?", nowIso(), row.id)
      throw new AppError(409, 'gone', 'That draft is no longer in Gmail. Create a new one.')
    }
    throw new AppError(502, 'google', `Gmail did not confirm the update: ${(err as Error).message}. It was not retried.`)
  }
  logActivity(db, 'gmail.draft_updated', `Updated the follow-up ${f.sequence} Gmail draft. Nothing was sent.`, { prospectId: f.prospect_id })
  await verifyDraft(db, deps, row.id, body).catch(() => null)
  return getDraftRow(db, row.id)
}

// ---------- Lists ----------

export function listFollowUps(db: DB, now = new Date()) {
  reconcileFollowUps(db)
  const rows = all<FollowUpRow & { company_name: string; recipient: string; original_subject: string | null; original_sent_at: string | null }>(db, `
    SELECT f.*, p.company_name, s.recipient, s.subject AS original_subject, s.sent_at AS original_sent_at
    FROM follow_ups f JOIN prospects p ON p.id = f.prospect_id JOIN send_attempts s ON s.id = f.initial_send_id ORDER BY f.due_at`)
  const iso = now.toISOString()
  return rows.map((f) => {
    const draft = get<DraftRow>(db, 'SELECT * FROM gmail_drafts WHERE follow_up_id = ? ORDER BY id DESC LIMIT 1', f.id)
    const pending = f.status === 'scheduled' || f.status === 'approved'
    return {
      ...f,
      group: !pending ? (f.status === 'sent' ? 'completed' : f.status) : f.due_at <= iso ? 'overdue' : 'upcoming',
      problems: pending ? followUpChecks(db, f) : [],
      draft: draft ? {
        id: draft.id, status: draft.status, verified: !!draft.attachment_verified_at,
        outOfDate: draft.status === 'created' && draft.content_sha256 !== contentHash(draft.recipient, f.subject, followUpBody(db, f), null),
      } : null,
    }
  })
}
