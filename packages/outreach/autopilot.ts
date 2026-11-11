// Autopilot: sends first emails to qualifying brands and their follow-ups without asking each time, within hard
// limits. Every send goes through the same checks as a manual send (packages/outreach/send.ts), including a fresh
// read-back of the Gmail draft, the do-not-contact list and the duplicate-send indexes. Autopilot never replies to
// a brand, negotiates, or agrees to anything: a reply stops the sequence and waits for you.
import { all, get, getSetting, logActivity, nowIso, run, setSetting, tx, type DB } from '../db'
import { AppError } from '../core/errors'
import { listLeads, type Lead } from '../crm/leads'
import { getDefaultMediaKit } from '../mediakit/store'
import { reviewProspect } from '../crm/prospects'
import type { RouterDeps } from '../ai/router'
import { accessToken, hasReadAccess, missingScopes, type GmailDeps } from '../gmail/account'
import { createPitchDraft, updatePitchDraft } from '../gmail/drafts'
import { gatherFacts } from '../pitch/facts'
import { runChecks } from '../pitch/checks'
import { writeTemplate } from '../pitch/template'
import { approvePitch, generatePitch } from '../pitch/service'
import { getSignature } from '../pitch/signature'
import { createBatch } from '../research/batches'
import { calendar, dayKey, isBusinessDay } from './businessDays'
import { approveFollowUp, createFollowUpDraft, followUpChecks, getFollowUp, liveFollowUpDraft, reconcileFollowUps, type FollowUpRow } from './followups'
import { activationChecklist, autopilotSend, limitsStatus, stopState, type Check } from './send'
import { checkThreadBeforeFollowUp, syncConversations } from './sync'

export const AUTOPILOT_MAX_NEW_PER_DAY = 5
export const AUTOPILOT_PHRASE = 'ENABLE AUTOPILOT'
const HOLD_HOURS = 24
const LOCK_MS = 10 * 60_000

export interface AutopilotConfig { dryRun: boolean; newPerDay: number; sendGapMinutes: number; syncEveryMinutes: number; maxErrorsPerDay: number; maxBouncesPerWeek: number }
export const config = (db: DB) => getSetting<AutopilotConfig>(db, 'outreach.autopilot')
export const isEnabled = (db: DB) => getSetting<boolean>(db, 'outreach.autopilotEnabled')
const today = (db: DB, now = new Date()) => dayKey(now, calendar(db).timezone)

type EventKind = 'sent' | 'dry_run' | 'skipped' | 'error' | 'paused' | 'enabled' | 'disabled' | 'research' | 'sync' | 'report'
export function event(db: DB, kind: EventKind, detail: string, o: { prospectId?: number | null; followUpId?: number | null; sendId?: number | null; now?: Date } = {}) {
  run(db, 'INSERT INTO autopilot_events (day_key, kind, prospect_id, follow_up_id, send_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    today(db, o.now), kind, o.prospectId ?? null, o.followUpId ?? null, o.sendId ?? null, detail.slice(0, 2000), (o.now ?? new Date()).toISOString())
}

// ---------- Switching on and off ----------

// What must be true before autopilot may send. Gmail is checked live (read-only) so a revoked token is caught.
export async function readiness(db: DB, deps: GmailDeps): Promise<Check[]> {
  const checks: Check[] = activationChecklist(db).map((c) => ({ ...c }))
  const add = (label: string, ok: boolean, detail: string) => checks.push({ label, ok, detail })
  const live = getSetting<boolean>(db, 'outreach.liveSendingEnabled')
  add('Live sending is switched on', live, live ? 'On' : 'Switch it on first (the manual activation step)')
  let gmailOk = false, detail = 'Not connected'
  try {
    const { account, token } = await accessToken(db, deps)
    await deps.api.listMessages(token, 'in:sent newer_than:1d')
    gmailOk = hasReadAccess(account) && !missingScopes(account).length
    detail = gmailOk ? `${account.email}: token refreshed and Gmail answered just now (read-only check). gmail.compose allows sending its own drafts.` : 'Permissions missing; reconnect Gmail'
  } catch (err) { detail = `Gmail did not answer: ${(err as Error).message}` }
  add('Gmail authorization works right now', gmailOk, detail)
  const kit = getDefaultMediaKit(db)
  add('Media kit attached to first emails', !!kit, kit ? `v${kit.version} · ${kit.original_filename}` : 'Import a default media kit')
  add('Signature', !!getSignature(db).trim(), getSignature(db).replace(/\n/g, ' / '))
  const cfg = config(db)
  add(`New first emails capped at ${AUTOPILOT_MAX_NEW_PER_DAY} a day or fewer`, cfg.newPerDay >= 1 && cfg.newPerDay <= AUTOPILOT_MAX_NEW_PER_DAY, `${cfg.newPerDay} a day, at least ${cfg.sendGapMinutes} minutes apart, business hours only`)
  const uncertain = get<{ n: number }>(db, "SELECT count(*) AS n FROM send_attempts WHERE status = 'uncertain'")!.n
  add('No send with an uncertain result', !uncertain, uncertain ? `${uncertain} to reconcile in Outreach → Sent` : 'None')
  return checks
}

export async function enableAutopilot(db: DB, deps: GmailDeps, phrase: unknown) {
  if (phrase !== AUTOPILOT_PHRASE) throw new AppError(400, 'phrase', `Type ${AUTOPILOT_PHRASE} to confirm.`)
  const failing = (await readiness(db, deps)).filter((c) => !c.ok)
  if (failing.length) throw new AppError(409, 'checklist', `Not ready: ${failing.map((c) => `${c.label} (${c.detail})`).join('; ')}.`, failing)
  setSetting(db, 'outreach.autopilotEnabled', true)
  setSetting(db, 'outreach.autopilotPause', { reason: null, at: null })
  const cfg = config(db)
  event(db, 'enabled', `Autopilot switched on by you${cfg.dryRun ? ' in DRY-RUN mode (nothing is sent)' : ''}: up to ${cfg.newPerDay} new brands a day plus due follow-ups.`)
  logActivity(db, 'autopilot.enabled', `Autopilot switched ON${cfg.dryRun ? ' (dry run: nothing is sent)' : ''}. Up to ${cfg.newPerDay} new first emails a day, follow-ups when due, business hours only.`)
  return status(db)
}

export function disableAutopilot(db: DB, reason = 'Switched off by you') {
  setSetting(db, 'outreach.autopilotEnabled', false)
  event(db, 'disabled', reason)
  logActivity(db, 'autopilot.disabled', `Autopilot switched off: ${reason}`)
  return status(db)
}

// Stops autopilot after something that needs a person: an uncertain send, repeated errors, bounces, lost Gmail access.
export function autoPause(db: DB, reason: string) {
  if (!isEnabled(db)) return
  setSetting(db, 'outreach.autopilotEnabled', false)
  setSetting(db, 'outreach.autopilotPause', { reason, at: nowIso() })
  event(db, 'paused', reason)
  logActivity(db, 'autopilot.paused', `AUTOPILOT PAUSED: ${reason} Nothing more is sent automatically until you switch it back on.`)
}

export function setDryRun(db: DB, dryRun: boolean) {
  setSetting(db, 'outreach.autopilot', { ...config(db), dryRun })
  event(db, dryRun ? 'enabled' : 'enabled', dryRun ? 'Dry-run mode on: autopilot plans but sends nothing.' : 'Dry-run mode off: autopilot sends for real within its limits.')
  logActivity(db, 'autopilot.mode', dryRun ? 'Autopilot dry-run mode on (nothing is sent).' : 'Autopilot dry-run mode OFF: it now sends real emails within its limits.')
  return status(db)
}

// ---------- One run ----------

// A lease in the settings table, so two workers (or a job that fires twice) never act at the same time.
function acquire(db: DB, holder: string, now: number) {
  return tx(db, () => {
    const cur = get<{ value: string }>(db, "SELECT value FROM settings WHERE key = 'autopilot.lock'")
    const lock = cur ? (JSON.parse(cur.value) as { holder: string; until: number }) : null
    if (lock && lock.until > now && lock.holder !== holder) return false
    setSetting(db, 'autopilot.lock', { holder, until: now + LOCK_MS })
    return true
  })
}
const release = (db: DB, holder: string) => run(db, "DELETE FROM settings WHERE key = 'autopilot.lock' AND json_extract(value, '$.holder') = ?", holder)

const held = (db: DB, key: string, now: Date) => !!get(db, 'SELECT 1 FROM autopilot_holds WHERE key = ? AND until > ?', key, now.toISOString())
const hold = (db: DB, key: string, reason: string, now: Date, hours = HOLD_HOURS) => run(db,
  'INSERT INTO autopilot_holds (key, reason, until, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET reason = excluded.reason, until = excluded.until',
  key, reason.slice(0, 1000), new Date(now.getTime() + hours * 3_600_000).toISOString(), now.toISOString())

export function inSendWindow(db: DB, now = new Date()) {
  const h = getSetting<{ timezone: string; start: string; end: string }>(db, 'outreach.businessHours')
  if (!isBusinessDay(today(db, now), calendar(db))) return false
  const local = new Intl.DateTimeFormat('en-GB', { timeZone: h.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now)
  return local >= h.start && local < h.end
}

// Brands autopilot may write to: actionable (qualifying public email, not contacted, not excluded) and needing
// nothing from you (country, freshness). Best partnership fit first.
export function candidates(db: DB, now = new Date()): Lead[] {
  return listLeads(db).filter((l) => l.actionable && !l.needs_before_send.length && l.outreach_status !== 'gmail_draft' && !held(db, `p:${l.id}`, now))
}

const sentToday = (db: DB, now: Date, kind: 'initial' | 'follow_up') => get<{ n: number }>(db,
  "SELECT count(*) AS n FROM send_attempts WHERE initiated_by = 'autopilot' AND kind = ? AND day_key = ? AND status IN ('sending', 'sent', 'uncertain')", kind, today(db, now))!.n

export interface TickResult { ran: boolean; dryRun: boolean; note: string; actions: string[] }

export async function tick(db: DB, deps: GmailDeps, opts: { dataDir: string; ai?: RouterDeps; now?: Date; forceDryRun?: boolean; holder?: string }): Promise<TickResult> {
  const now = opts.now ?? new Date()
  const cfg = config(db)
  const dry = !!opts.forceDryRun || cfg.dryRun
  const result: TickResult = { ran: false, dryRun: dry, note: '', actions: [] }
  if (!isEnabled(db) && !opts.forceDryRun) return { ...result, note: 'Autopilot is off.' }
  const holder = opts.holder ?? `pid${process.pid}`
  if (!acquire(db, holder, now.getTime())) return { ...result, note: 'Another autopilot run is in progress.' }
  try {
    result.ran = true
    ensureReports(db, now)
    if (stopState(db).active) return { ...result, note: 'STOP ALL OUTREACH is active.' }

    // Safety brakes: anything that needs a person stops autopilot.
    if (!dry) {
      const uncertain = get<{ recipient: string }>(db, "SELECT recipient FROM send_attempts WHERE status = 'uncertain' LIMIT 1")
      if (uncertain) { autoPause(db, `A send to ${uncertain.recipient} has an uncertain result. Reconcile it in Outreach → Sent.`); return { ...result, note: 'Paused: uncertain send.' } }
      const errors = get<{ n: number }>(db, "SELECT count(*) AS n FROM autopilot_events WHERE kind = 'error' AND day_key = ?", today(db, now))!.n
      if (errors >= cfg.maxErrorsPerDay) { autoPause(db, `${errors} errors today (limit ${cfg.maxErrorsPerDay}). Check Autopilot → Activity.`); return { ...result, note: 'Paused: errors.' } }
      const bounces = get<{ n: number }>(db, `SELECT count(*) AS n FROM suppressions WHERE source = 'bounce' AND created_at >= ?
        AND value IN (SELECT recipient FROM send_attempts WHERE initiated_by = 'autopilot')`, new Date(now.getTime() - 7 * 86_400_000).toISOString())!.n
      if (bounces >= cfg.maxBouncesPerWeek) { autoPause(db, `${bounces} autopilot emails hard-bounced in 7 days (limit ${cfg.maxBouncesPerWeek}). Check the addresses before resuming.`); return { ...result, note: 'Paused: bounces.' } }
      try {
        const { account } = await accessToken(db, deps)
        if (missingScopes(account).length) { autoPause(db, 'Gmail permissions are missing. Reconnect Gmail in Settings → Gmail.'); return { ...result, note: 'Paused: Gmail permissions.' } }
      } catch (err) {
        event(db, 'error', `Gmail is unavailable: ${(err as Error).message}`, { now })
        return { ...result, note: 'Gmail unavailable.' }
      }
      // Replies, opt-outs and bounces first, so nothing goes to someone who just answered.
      const last = get<{ started_at: string }>(db, "SELECT started_at FROM gmail_sync_runs ORDER BY id DESC LIMIT 1")
      if (!last || now.getTime() - new Date(last.started_at).getTime() > cfg.syncEveryMinutes * 60_000) {
        try {
          const s = await syncConversations(db, deps, { ai: opts.ai })
          if (s.messagesAdded || s.errors.length) event(db, 'sync', `Checked ${s.threadsChecked} conversations: ${s.replies} repl${s.replies === 1 ? 'y' : 'ies'}, ${s.followUpsCancelled} follow-up(s) stopped${s.errors.length ? `, ${s.errors.length} error(s)` : ''}.`, { now })
        } catch (err) {
          event(db, 'error', `Checking Gmail for replies failed: ${(err as Error).message}`, { now })
          return { ...result, note: 'Reply check failed; nothing sent.' }
        }
      }
    }
    if (!inSendWindow(db, now)) {
      if (!opts.forceDryRun) return { ...result, note: 'Outside business hours; nothing is sent.' }
      result.note = 'Outside business hours now; this is what the next run in business hours would do.'
    }
    const lastSend = get<{ t: string }>(db, "SELECT max(created_at) AS t FROM send_attempts WHERE initiated_by = 'autopilot'")?.t
    if (!dry && lastSend && now.getTime() - new Date(lastSend).getTime() < cfg.sendGapMinutes * 60_000) return { ...result, note: `Waiting: at least ${cfg.sendGapMinutes} minutes between emails.` }

    const limits = limitsStatus(db, now)
    if (await followUpStep(db, deps, opts, cfg, dry, now, limits, result)) return result
    await firstEmailStep(db, deps, opts, cfg, dry, now, limits, result)
    if (!dry) researchStep(db, cfg, now, result)
    return result
  } finally {
    release(db, holder)
  }
}

async function followUpStep(db: DB, deps: GmailDeps, opts: { dataDir: string; ai?: RouterDeps }, cfg: AutopilotConfig, dry: boolean, now: Date, limits: ReturnType<typeof limitsStatus>, result: TickResult) {
  if (limits.followUps.remaining <= 0 || limits.total.remaining <= 0) {
    result.note = `Follow-up limit reached today (${limits.followUps.sent} of ${limits.followUps.limit} follow-ups, ${limits.total.sent} of ${limits.total.limit} emails).`
    return false
  }
  reconcileFollowUps(db)
  const due = all<FollowUpRow>(db, "SELECT * FROM follow_ups WHERE status IN ('scheduled', 'approved') AND due_at <= ? ORDER BY due_at, sequence", now.toISOString())
  for (const row of due) {
    const key = `f:${row.id}`
    if (held(db, key, now)) continue
    const earlier = row.sequence === 2 ? get<{ status: string }>(db, 'SELECT status FROM follow_ups WHERE initial_send_id = ? AND sequence = 1', row.initial_send_id) : undefined
    if (earlier && !['sent', 'skipped', 'cancelled'].includes(earlier.status)) continue
    const original = get<{ recipient: string; initiated_by: string }>(db, 'SELECT recipient, initiated_by FROM send_attempts WHERE id = ?', row.initial_send_id)!
    try {
      if (!dry) await checkThreadBeforeFollowUp(db, deps, row.id, { ai: opts.ai })
      reconcileFollowUps(db, row.prospect_id)
      const f = getFollowUp(db, row.id)
      if (f.status !== 'scheduled' && f.status !== 'approved') continue
      const problems = followUpChecks(db, f)
      if (problems.length) { hold(db, key, problems.join(' '), now); event(db, 'skipped', `Follow-up ${f.sequence} to ${original.recipient} not sent: ${problems.join(' ')}`, { prospectId: f.prospect_id, followUpId: f.id, now }); continue }
      if (dry) {
        event(db, 'dry_run', `Would send follow-up ${f.sequence} to ${original.recipient} ("${f.subject}").`, { prospectId: f.prospect_id, followUpId: f.id, now })
        result.actions.push(`follow-up ${f.sequence} → ${original.recipient}`)
        return true
      }
      if (f.status === 'scheduled') approveFollowUp(db, f.id)
      if (!liveFollowUpDraft(db, f.id)) await createFollowUpDraft(db, deps, opts.dataDir, f.id)
      const r = await autopilotSend(db, deps, { kind: 'follow_up', followUpId: f.id })
      if (r.sent) {
        event(db, 'sent', `Sent follow-up ${f.sequence} to ${r.sent.recipient}.`, { prospectId: f.prospect_id, followUpId: f.id, sendId: r.sent.id, now })
        result.actions.push(`follow-up ${f.sequence} → ${r.sent.recipient}`)
        return true
      }
      const why = r.failing.map((c) => `${c.label}: ${c.detail}`).join('; ')
      hold(db, key, why, now)
      event(db, 'skipped', `Follow-up ${f.sequence} to ${original.recipient} not sent: ${why}`, { prospectId: f.prospect_id, followUpId: f.id, now })
    } catch (err) {
      handleError(db, err, `follow-up to ${original.recipient}`, { prospectId: row.prospect_id, followUpId: row.id, now })
      hold(db, key, (err as Error).message, now)
      return true
    }
  }
  return false
}

async function firstEmailStep(db: DB, deps: GmailDeps, opts: { dataDir: string; ai?: RouterDeps }, cfg: AutopilotConfig, dry: boolean, now: Date, limits: ReturnType<typeof limitsStatus>, result: TickResult) {
  const cap = Math.min(cfg.newPerDay, AUTOPILOT_MAX_NEW_PER_DAY)
  const done = dry ? 0 : sentToday(db, now, 'initial')
  const room = Math.min(cap - done, limits.newEmails.remaining, limits.weekNew.remaining, limits.total.remaining)
  if (room <= 0) { result.note = `${result.note ? `${result.note} ` : ''}Daily limit reached (${done} of ${cap} new first emails today).`; return }
  let attempts = 0
  for (const lead of candidates(db, now)) {
    if (attempts++ >= (dry ? room : 3)) break
    const key = `p:${lead.id}`
    try {
      if (dry) {
        const facts = gatherFacts(db, lead.id, { channel: 'email' }, now)
        const draft = writeTemplate(facts)
        const blockers = runChecks(facts, draft.subject, draft.body).checks.filter((c) => c.level === 'blocker')
        event(db, blockers.length ? 'skipped' : 'dry_run', blockers.length
          ? `Would NOT email ${lead.company_name} (${facts.contact?.email}): ${blockers.map((b) => b.message).join(' ')}`
          : `Would email ${lead.company_name} at ${facts.contact?.email} ("${draft.subject}"), ${lead.confidence?.toUpperCase()} confidence, media kit attached.`, { prospectId: lead.id, now })
        if (!blockers.length) result.actions.push(`first email → ${facts.contact?.email} (${lead.company_name})`)
        continue
      }
      if (lead.review_status === 'pending') reviewProspect(db, lead.id, 'approved', 'Approved automatically by autopilot: qualifying public email, eligible recipient.')
      const open = get<{ id: number; status: string }>(db, "SELECT id, status FROM pitches WHERE prospect_id = ? AND channel = 'email' AND status IN ('draft', 'approved') ORDER BY id DESC LIMIT 1", lead.id)
      let pitchId = open?.id
      if (!pitchId) pitchId = (await generatePitch(db, lead.id, { channel: 'email' }, { ai: opts.ai })).id
      if (!open || open.status === 'draft') approvePitch(db, pitchId)
      const draft = get<{ id: number }>(db, "SELECT id FROM gmail_drafts WHERE prospect_id = ? AND kind = 'pitch' AND status IN ('creating', 'created', 'uncertain')", lead.id)
      if (draft) await updatePitchDraft(db, deps, opts.dataDir, pitchId).catch(() => undefined)
      else await createPitchDraft(db, deps, opts.dataDir, pitchId)
      const r = await autopilotSend(db, deps, { kind: 'initial', pitchId })
      if (r.sent) {
        event(db, 'sent', `Sent the first email to ${lead.company_name} at ${r.sent.recipient}.`, { prospectId: lead.id, sendId: r.sent.id, now })
        result.actions.push(`first email → ${r.sent.recipient} (${lead.company_name})`)
        return
      }
      const why = r.failing.map((c) => `${c.label}: ${c.detail}`).join('; ')
      hold(db, key, why, now)
      event(db, 'skipped', `${lead.company_name} not emailed: ${why}`, { prospectId: lead.id, now })
    } catch (err) {
      hold(db, key, (err as Error).message, now)
      if (err instanceof AppError && ['blocked', 'not_qualified', 'review_required'].includes(err.code)) {
        event(db, 'skipped', `${lead.company_name} not emailed: ${err.message}`, { prospectId: lead.id, now })
        continue
      }
      handleError(db, err, `first email to ${lead.company_name}`, { prospectId: lead.id, now })
      return
    }
  }
  if (!result.actions.length) result.note ||= 'No brand is ready for an automatic first email right now.'
}

// Keeps a small supply of qualifying brands: one research batch a day when fewer are ready than the daily cap.
function researchStep(db: DB, cfg: AutopilotConfig, now: Date, result: TickResult) {
  if (candidates(db, now).length >= cfg.newPerDay) return
  if (get(db, "SELECT 1 FROM autopilot_events WHERE kind = 'research' AND day_key = ?", today(db, now))) return
  if (get(db, "SELECT 1 FROM research_batches WHERE status IN ('queued', 'running')")) return
  try {
    const b = createBatch(db, { size: 20 })
    event(db, 'research', `Started research batch #${b.batch.id} to find up to 20 brands with qualifying emails (${b.batch.total} queued).`, { now })
    result.actions.push(`research batch #${b.batch.id}`)
  } catch (err) {
    event(db, 'research', `Could not start research: ${(err as Error).message}`, { now })
  }
}

function handleError(db: DB, err: unknown, what: string, o: { prospectId?: number; followUpId?: number; now: Date }) {
  const e = err as AppError
  event(db, 'error', `${what}: ${e.message}`, o)
  // A send whose result is unknown must be checked by a person before anything else goes out.
  if (e.code === 'send_uncertain') autoPause(db, `Gmail did not confirm the ${what}. It was not retried; reconcile it in Outreach → Sent.`)
}

// ---------- Reports ----------

function periodNumbers(db: DB, from: string, to: string) {
  const n = (sql: string, ...p: (string | number)[]) => get<{ n: number }>(db, sql, ...p)!.n
  return {
    firstEmails: n("SELECT count(*) AS n FROM send_attempts WHERE kind = 'initial' AND status = 'sent' AND sent_at >= ? AND sent_at < ?", from, to),
    followUps: n("SELECT count(*) AS n FROM send_attempts WHERE kind = 'follow_up' AND status = 'sent' AND sent_at >= ? AND sent_at < ?", from, to),
    byAutopilot: n("SELECT count(*) AS n FROM send_attempts WHERE initiated_by = 'autopilot' AND status = 'sent' AND sent_at >= ? AND sent_at < ?", from, to),
    replies: n("SELECT count(*) AS n FROM email_messages WHERE direction = 'inbound' AND kind = 'reply' AND COALESCE(message_at, created_at) >= ? AND COALESCE(message_at, created_at) < ?", from, to),
    positiveReplies: n("SELECT count(*) AS n FROM email_messages WHERE direction = 'inbound' AND kind = 'reply' AND classification IN ('interested', 'needs_info', 'negotiating') AND COALESCE(message_at, created_at) >= ? AND COALESCE(message_at, created_at) < ?", from, to),
    optOuts: n("SELECT count(*) AS n FROM suppressions WHERE source = 'opt_out' AND created_at >= ? AND created_at < ?", from, to),
    bounces: n("SELECT count(*) AS n FROM suppressions WHERE source = 'bounce' AND created_at >= ? AND created_at < ?", from, to),
    errors: n("SELECT count(*) AS n FROM autopilot_events WHERE kind = 'error' AND created_at >= ? AND created_at < ?", from, to),
    dealsWon: n("SELECT count(DISTINCT prospect_id) AS n FROM activities WHERE type = 'stage.changed' AND json_extract(data, '$.to') = 'won' AND created_at >= ? AND created_at < ?", from, to),
  }
}

const describe = (label: string, x: ReturnType<typeof periodNumbers>) =>
  `${label}: ${x.firstEmails} first email${x.firstEmails === 1 ? '' : 's'} and ${x.followUps} follow-up${x.followUps === 1 ? '' : 's'} sent (${x.byAutopilot} by autopilot); ${x.replies} repl${x.replies === 1 ? 'y' : 'ies'}, ${x.positiveReplies} positive; ${x.optOuts} opt-out${x.optOuts === 1 ? '' : 's'}, ${x.bounces} bounce${x.bounces === 1 ? '' : 's'}, ${x.errors} error${x.errors === 1 ? '' : 's'}; ${x.dealsWon} deal${x.dealsWon === 1 ? '' : 's'} won.`

// Day boundaries are approximated in UTC from the business time zone's calendar day keys.
const startOfDay = (db: DB, key: string) => {
  const tz = calendar(db).timezone
  const [y, m, d] = key.split('-').map(Number)
  const guess = Date.UTC(y, m - 1, d)
  const offset = new Date(new Date(guess).toLocaleString('en-US', { timeZone: tz })).getTime() - new Date(new Date(guess).toLocaleString('en-US', { timeZone: 'UTC' })).getTime()
  return new Date(guess - offset).toISOString()
}
const shift = (key: string, days: number) => new Date(Date.parse(`${key}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)

// Writes yesterday's summary and last week's report once each (UNIQUE period); safe to call on every run.
export function ensureReports(db: DB, now = new Date()) {
  const t = today(db, now)
  const firstActivity = get<{ t: string | null }>(db, "SELECT min(created_at) AS t FROM autopilot_events")?.t
  if (!firstActivity) return
  for (let i = 1; i <= 7; i++) {
    const day = shift(t, -i)
    if (startOfDay(db, shift(day, 1)) <= firstActivity) break
    const x = periodNumbers(db, startOfDay(db, day), startOfDay(db, shift(day, 1)))
    run(db, "INSERT OR IGNORE INTO autopilot_reports (kind, period_key, summary, text, created_at) VALUES ('daily', ?, ?, ?, ?)", day, JSON.stringify(x), describe(`Daily summary for ${day}`, x), now.toISOString())
  }
  const weekday = new Date(`${t}T12:00:00Z`).getUTCDay()
  const thisMonday = shift(t, -((weekday + 6) % 7))
  const lastMonday = shift(thisMonday, -7)
  if (startOfDay(db, thisMonday) > firstActivity) {
    const x = periodNumbers(db, startOfDay(db, lastMonday), startOfDay(db, thisMonday))
    const totals = periodNumbers(db, '0000', '9999')
    const revenue = get<{ c: number | null }>(db, "SELECT sum(negotiated_value_cents) AS c FROM prospects WHERE stage = 'won'")!.c ?? 0
    const text = `${describe(`Week of ${lastMonday}`, x)} All time: ${totals.firstEmails + totals.followUps} emails sent, ${totals.replies} replies (${totals.positiveReplies} positive), ${totals.dealsWon} deals won, $${(revenue / 100).toLocaleString('en-US')} contracted.`
    run(db, "INSERT OR IGNORE INTO autopilot_reports (kind, period_key, summary, text, created_at) VALUES ('weekly', ?, ?, ?, ?)", lastMonday, JSON.stringify({ ...x, revenueCents: revenue }), text, now.toISOString())
  }
}

// ---------- Dashboard ----------

export function status(db: DB, now = new Date()) {
  const cfg = config(db)
  const n = (sql: string, ...p: (string | number)[]) => get<{ n: number }>(db, sql, ...p)!.n
  return {
    enabled: isEnabled(db),
    config: cfg,
    maxNewPerDay: AUTOPILOT_MAX_NEW_PER_DAY,
    phrase: AUTOPILOT_PHRASE,
    pause: getSetting<{ reason: string | null; at: string | null }>(db, 'outreach.autopilotPause'),
    emergencyStop: stopState(db),
    inSendWindow: inSendWindow(db, now),
    today: { firstEmails: sentToday(db, now, 'initial'), followUps: sentToday(db, now, 'follow_up'), cap: Math.min(cfg.newPerDay, AUTOPILOT_MAX_NEW_PER_DAY) },
    readyBrands: candidates(db, now).map((l) => ({ id: l.id, company_name: l.company_name, email: l.email, confidence: l.confidence })),
    totals: {
      emailsSent: n("SELECT count(*) AS n FROM send_attempts WHERE status = 'sent'"),
      byAutopilot: n("SELECT count(*) AS n FROM send_attempts WHERE status = 'sent' AND initiated_by = 'autopilot'"),
      replies: n("SELECT count(*) AS n FROM email_messages WHERE direction = 'inbound' AND kind = 'reply'"),
      positiveReplies: n("SELECT count(*) AS n FROM email_messages WHERE direction = 'inbound' AND kind = 'reply' AND classification IN ('interested', 'needs_info', 'negotiating')"),
      followUpsPending: n("SELECT count(*) AS n FROM follow_ups WHERE status IN ('scheduled', 'approved')"),
      dealsWon: n("SELECT count(*) AS n FROM prospects WHERE stage = 'won'"),
      revenueCents: get<{ c: number | null }>(db, "SELECT sum(negotiated_value_cents) AS c FROM prospects WHERE stage = 'won'")!.c ?? 0,
    },
    events: all<{ id: number; kind: string; detail: string; prospect_id: number | null; created_at: string }>(db, 'SELECT id, kind, detail, prospect_id, created_at FROM autopilot_events ORDER BY id DESC LIMIT 60'),
    reports: all<{ kind: string; period_key: string; text: string; created_at: string }>(db, 'SELECT kind, period_key, text, created_at FROM autopilot_reports ORDER BY created_at DESC, id DESC LIMIT 20'),
  }
}

// ---------- The schedule (runs inside the worker process) ----------

export async function runAutopilot(db: DB, deps: GmailDeps, opts: { dataDir: string; signal?: AbortSignal; everyMs?: number; log?: (m: string) => void; ai?: RouterDeps }) {
  const log = opts.log ?? (() => {})
  const holder = `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  log('Autopilot scheduler running (checks every minute; acts only when switched on)')
  while (!opts.signal?.aborted) {
    try {
      const r = await tick(db, deps, { dataDir: opts.dataDir, ai: opts.ai, holder })
      if (r.actions.length) log(`Autopilot${r.dryRun ? ' (dry run)' : ''}: ${r.actions.join(', ')}`)
    } catch (err) {
      try { event(db, 'error', `Autopilot run failed: ${(err as Error).message}`) } catch { /* database unavailable */ }
      log(`Autopilot error: ${(err as Error).message}`)
    }
    await new Promise((r) => setTimeout(r, opts.everyMs ?? 60_000))
  }
}
