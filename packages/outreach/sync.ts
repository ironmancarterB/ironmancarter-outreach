// Conversation sync (read-only at Google). Privacy: it reads ONLY
//   - Gmail threads that started from an email the app sent (or you sent from an app draft), and
//   - messages FROM the exact addresses you emailed, received after you emailed them.
// Nothing else in your mailbox is listed, read or stored. Gmail message ids are unique in the database, so
// re-running a sync (or one interrupted by a crash) never records a message twice.
import { all, get, logActivity, nowIso, run, type DB } from '../db'
import { addSuppression } from '../crm/suppressions'
import { bouncedRecipient, bounceSeverity } from '../crm/leads'
import { emailDomain, normalizeEmail } from '../core/normalize'
import { accessToken, requireReadAccess, type GmailDeps, type MailAccount } from '../gmail/account'
import { syncDrafts, type DraftRow } from '../gmail/drafts'
import { GoogleError, headerValue, type GmailMessage, type GmailPart } from '../gmail/google'
import { boundaryFor, boundaryOf } from '../gmail/mime'
import type { RouterDeps } from '../ai/router'
import { classifyReply, stripQuoted } from './classify'
import { reconcileFollowUps, type SendRow } from './followups'
import { autoAdvance, touchContactDates } from './pipeline'
import { recordGmailSend, reconcileSend } from './send'

export const addressOf = (header: string | null) => normalizeEmail(header?.match(/<([^>]+)>/)?.[1] ?? header?.trim() ?? null)

function decode(data?: string) {
  return data ? Buffer.from(data, 'base64url').toString('utf8') : ''
}

// The readable text of a message: text/plain preferred, otherwise HTML with tags removed.
export function messageText(payload?: GmailPart): string {
  const plain: string[] = [], html: string[] = []
  const walk = (p?: GmailPart) => {
    if (!p) return
    if (p.filename) return
    if (p.mimeType === 'text/plain' && p.body?.data) plain.push(decode(p.body.data))
    else if (p.mimeType === 'text/html' && p.body?.data) html.push(decode(p.body.data))
    for (const c of p.parts ?? []) walk(c)
  }
  walk(payload)
  if (plain.length) return plain.join('\n')
  return html.join('\n').replace(/<(br|\/p|\/div)[^>]*>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
}

const isAutoSubmitted = (m: GmailMessage) => {
  const auto = headerValue(m, 'Auto-Submitted')
  return (!!auto && auto.toLowerCase() !== 'no') || !!headerValue(m, 'X-Autoreply') || !!headerValue(m, 'X-Autorespond') || /auto_reply/i.test(headerValue(m, 'Precedence') ?? '')
}
const isBounce = (m: GmailMessage, from: string | null) =>
  /^(mailer-daemon|postmaster)@/i.test(from ?? '') || /multipart\/report/i.test(headerValue(m, 'Content-Type') ?? '')

interface ThreadRow { id: number; account_id: number; prospect_id: number | null; contact_id: number | null; gmail_thread_id: string; origin: string }

interface Ctx { db: DB; account: MailAccount; ai?: RouterDeps; added: number; replies: number }

// Records one Gmail message in a tracked conversation. Returns true if it was new.
async function ingest(ctx: Ctx, thread: ThreadRow, m: GmailMessage, reviewReason?: string): Promise<boolean> {
  const { db, account } = ctx
  if (m.labelIds?.includes('DRAFT')) return false
  if (get(db, 'SELECT 1 FROM email_messages WHERE gmail_message_id = ?', m.id)) return false
  const from = addressOf(headerValue(m, 'From'))
  const at = m.internalDate ? new Date(Number(m.internalDate)).toISOString() : nowIso()
  const subject = headerValue(m, 'Subject')
  const rfc = headerValue(m, 'Message-Id')
  const now = nowIso()

  if (from === account.email) {
    // Something you sent from Gmail yourself in this conversation (for example a manual reply).
    const r = run(db, `INSERT OR IGNORE INTO email_messages (thread_id, gmail_message_id, rfc822_message_id, direction, kind, from_email, to_email, subject, snippet, message_at, created_at)
      VALUES (?, ?, ?, 'outbound', 'sent', ?, ?, ?, ?, ?, ?)`, thread.id, m.id, rfc, from, addressOf(headerValue(m, 'To')), subject, m.snippet ?? null, at, now)
    if (!r.changes) return false
    run(db, 'UPDATE email_threads SET last_outbound_at = ?, last_message_at = ?, last_synced_at = ?, updated_at = ? WHERE id = ?', at, at, now, now, thread.id)
    touchContactDates(db, thread.prospect_id, 'outbound', at)
    ctx.added++
    return true
  }

  const bounce = isBounce(m, from)
  const auto = !bounce && isAutoSubmitted(m)
  const kind = bounce ? 'bounce' : auto ? 'auto_reply' : 'reply'
  const text = stripQuoted(messageText(m.payload)).slice(0, 20_000)
  const c = kind === 'bounce' ? null : await classifyReply(db, text, { autoSubmitted: auto, ai: ctx.ai })

  // Which contact wrote it. Anything not clearly from the company is flagged for you.
  const contact = from && thread.prospect_id ? get<{ id: number }>(db, 'SELECT id FROM contacts WHERE prospect_id = ? AND email = ?', thread.prospect_id, from) : undefined
  const domain = thread.prospect_id ? get<{ domain: string | null }>(db, 'SELECT domain FROM prospects WHERE id = ?', thread.prospect_id)?.domain : null
  const reasons: string[] = []
  if (reviewReason) reasons.push(reviewReason)
  if (!bounce && !contact) reasons.push(from && domain && emailDomain(from) === domain ? `From ${from}, who is not in your CRM yet (same company domain).` : `From ${from ?? 'an unknown sender'}, a different domain than the company; confirm who this is.`)
  if (bounce) reasons.push('Delivery failure: the email may not have arrived. Check the address.')
  if (c?.category === 'unclear') reasons.push('Classification unclear.')

  const r = run(db, `INSERT OR IGNORE INTO email_messages (thread_id, gmail_message_id, rfc822_message_id, direction, kind, contact_id, from_email, to_email, subject, snippet, body_text,
    classification, classification_source, classification_note, classified_at, opt_out, needs_review, review_reason, message_at, created_at)
    VALUES (?, ?, ?, 'inbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    thread.id, m.id, rfc, kind, contact?.id ?? null, from, addressOf(headerValue(m, 'To')), subject, m.snippet ?? null, text,
    c?.category ?? null, c?.source ?? null, c?.note ?? null, c ? now : null, c?.optOut ? 1 : 0, reasons.length ? 1 : 0, reasons.join(' ') || null, at, now)
  if (!r.changes) return false
  ctx.added++

  run(db, `UPDATE email_threads SET last_inbound_at = ?, last_message_at = ?, last_synced_at = ?, updated_at = ?,
    status = CASE WHEN ? = 'reply' THEN 'replied' ELSE status END,
    needs_review = CASE WHEN ? THEN 1 ELSE needs_review END, review_reason = COALESCE(?, review_reason) WHERE id = ?`,
    at, at, now, now, kind, reasons.length ? 1 : 0, reasons.length ? reasons.join(' ') : null, thread.id)
  if (kind === 'reply') {
    ctx.replies++
    touchContactDates(db, thread.prospect_id, 'inbound', at)
    autoAdvance(db, thread.prospect_id, 'replied')
  }
  if (bounce) {
    const recipient = bouncedRecipient(db, thread.gmail_thread_id)
    if (recipient && bounceSeverity(text) === 'permanent') {
      addSuppression(db, 'email', recipient, 'Hard bounce: the mail server rejected this address', 'bounce')
      logActivity(db, 'reply.hard_bounce', `${recipient} bounced. Added to the do-not-contact list; it can no longer be drafted or sent to.`, { prospectId: thread.prospect_id })
    }
  }
  if (c?.optOut && from) {
    addSuppression(db, 'email', from, 'Asked not to be contacted (reply in Gmail)', 'opt_out')
    logActivity(db, 'reply.opt_out', `${from} asked not to be contacted. Added to the do-not-contact list; follow-ups stop.`, { prospectId: thread.prospect_id })
  }
  logActivity(db, `reply.${kind}`, kind === 'reply' ? `Reply from ${from}: ${c ? c.category.replace('_', ' ') : ''}${reasons.length ? ' (needs your review)' : ''}`
    : kind === 'auto_reply' ? `Automatic reply from ${from} (out of office); follow-ups continue.` : `Delivery failure for this conversation (${from}).`, { prospectId: thread.prospect_id })
  return true
}

const sentQuery = (s: SendRow) => `from:${s.recipient} after:${Math.floor(new Date(s.sent_at ?? s.created_at).getTime() / 1000)}`

export async function syncConversations(db: DB, deps: GmailDeps, opts: { ai?: RouterDeps } = {}) {
  const { account, token } = await accessToken(db, deps)
  requireReadAccess(account)
  const runId = run(db, "INSERT INTO gmail_sync_runs (status, started_at) VALUES ('started', ?)", nowIso()).lastId
  const ctx: Ctx = { db, account, ai: opts.ai, added: 0, replies: 0 }
  const result = { threadsChecked: 0, messagesAdded: 0, replies: 0, sentFromGmail: 0, reconciled: 0, followUpsCancelled: 0, errors: [] as string[] }
  try {
    // 1. Drafts: still there? changed in Gmail? (Phase 4 sync, read-only)
    await syncDrafts(db, deps)

    // 2. App drafts that left Drafts: did you send them from Gmail, or delete them?
    for (const d of all<DraftRow>(db, "SELECT * FROM gmail_drafts WHERE status = 'gone' AND kind IN ('pitch', 'follow_up') AND gmail_thread_id IS NOT NULL AND (sync_note IS NULL OR sync_note NOT LIKE 'Deleted%')")) {
      try {
        const thread = await deps.api.getThread(token, d.gmail_thread_id!, 'metadata')
        const sent = thread.messages?.find((m) => m.labelIds?.includes('SENT') && boundaryOf(headerValue(m, 'Content-Type')) === boundaryFor(d.local_ref))
        if (sent) {
          if (await recordGmailSend(db, deps, d, sent)) result.sentFromGmail++
        } else {
          run(db, "UPDATE gmail_drafts SET sync_note = 'Deleted in Gmail (not found in Sent Mail).', updated_at = ? WHERE id = ?", nowIso(), d.id)
          logActivity(db, 'gmail.draft_deleted', `The Gmail draft to ${d.recipient} was deleted in Gmail (it is not in Sent Mail).`, { prospectId: d.prospect_id })
        }
      } catch (err) {
        if (err instanceof GoogleError && err.status === 404) {
          run(db, "UPDATE gmail_drafts SET sync_note = 'Deleted in Gmail (not found in Sent Mail).', updated_at = ? WHERE id = ?", nowIso(), d.id)
        } else result.errors.push((err as Error).message)
      }
    }

    // 3. Uncertain sends: read-only reconciliation. Never resends.
    for (const s of all<{ id: number }>(db, "SELECT id FROM send_attempts WHERE status = 'uncertain'")) {
      try {
        const r = await reconcileSend(db, deps, s.id)
        if (r.status !== 'uncertain') result.reconciled++
      } catch (err) {
        result.errors.push((err as Error).message)
      }
    }

    // 4. Every tracked conversation.
    const threads = all<ThreadRow>(db, `SELECT t.id, t.account_id, t.prospect_id, t.contact_id, t.gmail_thread_id, t.origin FROM email_threads t
      WHERE t.account_id = ? AND (t.origin = 'reply_search' OR EXISTS (SELECT 1 FROM send_attempts s WHERE s.gmail_thread_id = t.gmail_thread_id AND s.status = 'sent'))`, account.id)
    for (const t of threads) {
      try {
        const full = await deps.api.getThread(token, t.gmail_thread_id, 'full')
        for (const m of full.messages ?? []) await ingest(ctx, t, m)
        run(db, 'UPDATE email_threads SET last_synced_at = ? WHERE id = ?', nowIso(), t.id)
        result.threadsChecked++
      } catch (err) {
        result.errors.push(`Thread ${t.gmail_thread_id}: ${(err as Error).message}`)
      }
    }

    // 5. Replies that started a new thread: messages from the exact addresses you emailed, after you emailed them.
    const tracked = new Set(threads.map((t) => t.gmail_thread_id))
    for (const s of all<SendRow>(db, "SELECT * FROM send_attempts WHERE kind = 'initial' AND status = 'sent'")) {
      try {
        const list = await deps.api.listMessages(token, sentQuery(s))
        for (const ref of list.messages ?? []) {
          if (tracked.has(ref.threadId) || get(db, 'SELECT 1 FROM email_messages WHERE gmail_message_id = ?', ref.id)) continue
          const m = await deps.api.getMessage(token, ref.id, 'full')
          if (addressOf(headerValue(m, 'From')) !== s.recipient) continue
          const now = nowIso()
          run(db, `INSERT INTO email_threads (account_id, prospect_id, contact_id, gmail_thread_id, subject, status, origin, needs_review, review_reason, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'replied', 'reply_search', 1, ?, ?, ?) ON CONFLICT(account_id, gmail_thread_id) DO NOTHING`,
            account.id, s.prospect_id, s.contact_id, m.threadId, headerValue(m, 'Subject'), 'A message from this contact arrived in a separate Gmail thread; confirm it belongs to this conversation.', now, now)
          const t = get<ThreadRow>(db, 'SELECT id, account_id, prospect_id, contact_id, gmail_thread_id, origin FROM email_threads WHERE account_id = ? AND gmail_thread_id = ?', account.id, m.threadId)!
          tracked.add(m.threadId)
          await ingest(ctx, t, m, 'Arrived outside the original thread.')
        }
      } catch (err) {
        result.errors.push(`Search for ${s.recipient}: ${(err as Error).message}`)
      }
    }

    // 6. Stop follow-ups that must stop (replies, opt-outs, closed deals).
    result.followUpsCancelled = reconcileFollowUps(db)
    result.messagesAdded = ctx.added
    result.replies = ctx.replies
    run(db, "UPDATE gmail_sync_runs SET status = ?, threads_checked = ?, messages_added = ?, detail = ?, finished_at = ? WHERE id = ?",
      result.errors.length ? 'failed' : 'ok', result.threadsChecked, ctx.added, result.errors.join(' | ').slice(0, 2000) || null, nowIso(), runId)
    logActivity(db, 'gmail.conversations_synced', `Synced ${result.threadsChecked} conversation${result.threadsChecked === 1 ? '' : 's'}: ${ctx.added} new message${ctx.added === 1 ? '' : 's'}, ${ctx.replies} repl${ctx.replies === 1 ? 'y' : 'ies'}${result.followUpsCancelled ? `, ${result.followUpsCancelled} follow-up(s) cancelled` : ''}${result.errors.length ? `, ${result.errors.length} error(s)` : ''}`)
    return result
  } catch (err) {
    run(db, "UPDATE gmail_sync_runs SET status = 'failed', detail = ?, finished_at = ? WHERE id = ?", (err as Error).message, nowIso(), runId)
    throw err
  }
}

// Right before a follow-up is prepared or sent: read its conversation now, so a reply that arrived since the
// last sync cancels the follow-up instead of being missed.
export async function checkThreadBeforeFollowUp(db: DB, deps: GmailDeps, followUpId: number, opts: { ai?: RouterDeps } = {}) {
  const row = get<{ prospect_id: number; gmail_thread_id: string | null }>(db,
    'SELECT f.prospect_id, s.gmail_thread_id FROM follow_ups f JOIN send_attempts s ON s.id = f.initial_send_id WHERE f.id = ?', followUpId)
  if (!row?.gmail_thread_id) return
  const { account, token } = await accessToken(db, deps)
  requireReadAccess(account)
  const thread = get<ThreadRow>(db, 'SELECT id, account_id, prospect_id, contact_id, gmail_thread_id, origin FROM email_threads WHERE account_id = ? AND gmail_thread_id = ?', account.id, row.gmail_thread_id)
  if (!thread) return
  const ctx: Ctx = { db, account, ai: opts.ai, added: 0, replies: 0 }
  const full = await deps.api.getThread(token, row.gmail_thread_id, 'full')
  for (const m of full.messages ?? []) await ingest(ctx, thread, m)
  run(db, 'UPDATE email_threads SET last_synced_at = ? WHERE id = ?', nowIso(), thread.id)
  reconcileFollowUps(db, row.prospect_id)
}
