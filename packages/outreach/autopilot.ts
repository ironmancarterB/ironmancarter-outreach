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
import { approvePitch, generatePitch, regeneratePitch } from '../pitch/service'
import { createDeal } from '../ugc/deals'
import { gateStatus, runLaunchGate } from '../ugc/gate'
import { availableCandidates, discoverCompanies } from '../ugc/discovery'
import { getSignature } from '../pitch/signature'
import { createBatch } from '../research/batches'
import { calendar, dayKey, isBusinessDay } from './businessDays'
import { approveFollowUp, createFollowUpDraft, followUpChecks, getFollowUp, liveFollowUpDraft, reconcileFollowUps, type FollowUpRow } from './followups'
import { activationChecklist, autopilotSend, campaignBudget, limitsStatus, stopState, type Check } from './send'
import { checkThreadBeforeFollowUp, syncConversations } from './sync'

export const AUTOPILOT_MAX_NEW_PER_DAY = 5
export const AUTOPILOT_PHRASE = 'ENABLE AUTOPILOT'
// UGC autopilot: its own switch, limits and pause, sharing the account-wide limits, safety brakes, lock and worker.
export const UGC_AUTOPILOT_PHRASE = 'ENABLE UGC AUTOPILOT'
export const UGC_AUTOPILOT_HARD_MAX = 10
export type Campaign = 'sponsorship' | 'ugc'
const HOLD_HOURS = 24
const LOCK_MS = 10 * 60_000

export interface AutopilotConfig { dryRun: boolean; newPerDay: number; sendGapMinutes: number; syncEveryMinutes: number; maxErrorsPerDay: number; maxBouncesPerWeek: number }
export const config = (db: DB) => getSetting<AutopilotConfig>(db, 'outreach.autopilot')
export const isEnabled = (db: DB) => getSetting<boolean>(db, 'outreach.autopilotEnabled')
export interface UgcAutopilotConfig { newPerDay: number; rampMax: number; maxBouncesPerWeek: number }
export const ugcConfig = (db: DB) => getSetting<UgcAutopilotConfig>(db, 'ugc.autopilot')
export const ugcEnabled = (db: DB) => getSetting<boolean>(db, 'ugc.autopilotEnabled')
export const campaignEnabled = (db: DB, c: Campaign) => (c === 'ugc' ? ugcEnabled(db) : isEnabled(db))
export const campaignPaused = (db: DB) => getSetting<{ sponsorship: boolean; ugc: boolean }>(db, 'outreach.campaignPause')

// Your pause switch per campaign: the campaign stays switched on (its checklist still holds) but sends nothing.
export function setCampaignPaused(db: DB, campaign: Campaign, pausedNow: boolean) {
  setSetting(db, 'outreach.campaignPause', { ...campaignPaused(db), [campaign]: pausedNow })
  event(db, pausedNow ? 'paused' : 'enabled', `${campaign === 'ugc' ? 'UGC' : 'Sponsorship'} sending ${pausedNow ? 'paused' : 'resumed'} by you.`, { campaign })
  logActivity(db, 'autopilot.campaign_pause', `${campaign === 'ugc' ? 'UGC' : 'Sponsorship'} automatic sending ${pausedNow ? 'paused' : 'resumed'}.`)
  return campaignPaused(db)
}

const backoffUntil = (db: DB) => get<{ value: string }>(db, "SELECT value FROM settings WHERE key = 'autopilot.backoffUntil'") ? (JSON.parse(get<{ value: string }>(db, "SELECT value FROM settings WHERE key = 'autopilot.backoffUntil'")!.value) as number | null) : null
const setBackoff = (db: DB, until: number | null) => setSetting(db, 'autopilot.backoffUntil', until)
const today = (db: DB, now = new Date()) => dayKey(now, calendar(db).timezone)

type EventKind = 'sent' | 'dry_run' | 'skipped' | 'error' | 'paused' | 'enabled' | 'disabled' | 'research' | 'sync' | 'report'
export function event(db: DB, kind: EventKind, detail: string, o: { prospectId?: number | null; followUpId?: number | null; sendId?: number | null; now?: Date; campaign?: Campaign } = {}) {
  run(db, 'INSERT INTO autopilot_events (day_key, kind, prospect_id, follow_up_id, send_id, detail, created_at, campaign) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    today(db, o.now), kind, o.prospectId ?? null, o.followUpId ?? null, o.sendId ?? null, detail.slice(0, 2000), (o.now ?? new Date()).toISOString(), o.campaign ?? 'sponsorship')
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
export function autoPause(db: DB, reason: string, campaign: Campaign | 'both' = 'sponsorship') {
  if (campaign === 'both') { autoPause(db, reason, 'sponsorship'); autoPause(db, reason, 'ugc'); return }
  if (!campaignEnabled(db, campaign)) return
  const ugc = campaign === 'ugc'
  setSetting(db, ugc ? 'ugc.autopilotEnabled' : 'outreach.autopilotEnabled', false)
  setSetting(db, ugc ? 'ugc.autopilotPause' : 'outreach.autopilotPause', { reason, at: nowIso() })
  event(db, 'paused', reason, { campaign })
  logActivity(db, ugc ? 'ugc.autopilot_paused' : 'autopilot.paused', `${ugc ? 'UGC ' : ''}AUTOPILOT PAUSED: ${reason} Nothing more is sent automatically${ugc ? ' for UGC' : ''} until you switch it back on.`)
}

export function setDryRun(db: DB, dryRun: boolean) {
  setSetting(db, 'outreach.autopilot', { ...config(db), dryRun })
  event(db, dryRun ? 'enabled' : 'enabled', dryRun ? 'Dry-run mode on: autopilot plans but sends nothing.' : 'Dry-run mode off: autopilot sends for real within its limits.')
  logActivity(db, 'autopilot.mode', dryRun ? 'Autopilot dry-run mode on (nothing is sent).' : 'Autopilot dry-run mode OFF: it now sends real emails within its limits.')
  return status(db)
}

// ---------- UGC autopilot switch ----------

export async function ugcReadiness(db: DB, deps: GmailDeps, fetchImpl: typeof fetch = fetch): Promise<Check[]> {
  const checks = (await readiness(db, deps)).filter((c) => !/^Media kit|^New first emails capped/.test(c.label))
  const add = (label: string, ok: boolean, detail: string) => checks.push({ label, ok, detail })
  const gate = await runLaunchGate(db, fetchImpl)
  for (const g of gate.checks) add(`Launch gate: ${g.label}`, g.ok, g.detail)
  const cfg = ugcConfig(db)
  add(`UGC first emails start at ${cfg.newPerDay} a day (max ${Math.min(cfg.rampMax, UGC_AUTOPILOT_HARD_MAX)})`, cfg.newPerDay >= 1 && cfg.newPerDay <= cfg.rampMax && cfg.rampMax <= UGC_AUTOPILOT_HARD_MAX, 'Always inside the shared account limits, which are never changed automatically')
  const tmpl = get<{ n: number }>(db, "SELECT count(*) AS n FROM email_templates WHERE campaign_type = 'ugc' AND kind = 'initial'")!.n
  add('UGC templates', tmpl > 0, `${tmpl} first-email template(s)`)
  add('STOP ALL OUTREACH is off', !stopState(db).active, stopState(db).active ? 'Resume outreach first' : 'Off')
  return checks
}

export async function enableUgcAutopilot(db: DB, deps: GmailDeps, phrase: unknown, fetchImpl: typeof fetch = fetch) {
  if (phrase !== UGC_AUTOPILOT_PHRASE) throw new AppError(400, 'phrase', `Type ${UGC_AUTOPILOT_PHRASE} to confirm.`)
  const failing = (await ugcReadiness(db, deps, fetchImpl)).filter((c) => !c.ok)
  if (failing.length) throw new AppError(409, 'checklist', `Not ready: ${failing.map((c) => `${c.label} (${c.detail})`).join('; ')}.`, failing)
  setSetting(db, 'ugc.autopilotEnabled', true)
  setSetting(db, 'ugc.autopilotPause', { reason: null, at: null })
  const cap = ugcCap(db)
  event(db, 'enabled', `UGC autopilot switched on: up to ${cap} UGC first emails a day plus due UGC follow-ups, inside the shared account limits.`, { campaign: 'ugc' })
  logActivity(db, 'ugc.autopilot_enabled', `UGC autopilot switched ON: up to ${cap} first emails a day (growing only after clean weeks), follow-ups when due, business hours only.`)
  return ugcStatus(db)
}

export function disableUgcAutopilot(db: DB, reason = 'Switched off by you') {
  setSetting(db, 'ugc.autopilotEnabled', false)
  event(db, 'disabled', reason, { campaign: 'ugc' })
  logActivity(db, 'ugc.autopilot_disabled', `UGC autopilot switched off: ${reason}`)
  return ugcStatus(db)
}

export function ugcStatus(db: DB, now = new Date()) {
  const n = (sql: string, ...p: (string | number)[]) => get<{ n: number }>(db, sql, ...p)!.n
  const ready = ugcCandidates(db, now)
  const waiting = listLeads(db).filter((l) => l.campaign_type === 'ugc' && l.actionable && l.needs_before_send.length)
  const limits = limitsStatus(db, now)
  return {
    enabled: ugcEnabled(db),
    config: ugcConfig(db),
    cap: ugcCap(db, now),
    hardMax: UGC_AUTOPILOT_HARD_MAX,
    phrase: UGC_AUTOPILOT_PHRASE,
    pause: getSetting<{ reason: string | null; at: string | null }>(db, 'ugc.autopilotPause'),
    gate: gateStatus(db, now),
    permission: getSetting<{ confirmed: boolean; note: string | null; at: string | null }>(db, 'ugc.videosPermission'),
    emergencyStop: stopState(db),
    sponsorshipEnabled: isEnabled(db),
    inSendWindow: inSendWindow(db, now),
    limits,
    today: { firstEmails: sentToday(db, now, 'initial', 'ugc'), followUps: sentToday(db, now, 'follow_up', 'ugc') },
    queue: ready.map((l) => ({ id: l.id, company_name: l.company_name, email: l.email, fit_score: l.fit_score })),
    waiting: waiting.map((l) => ({ id: l.id, company_name: l.company_name, email: l.email, contact_id: l.contact_id, fit_score: l.fit_score, needs: l.needs_before_send })),
    totals: {
      sent: n("SELECT count(*) AS n FROM send_attempts s JOIN prospects p ON p.id = s.prospect_id WHERE s.kind = 'initial' AND s.status = 'sent' AND p.campaign_type = 'ugc'"),
      followUpsSent: n("SELECT count(*) AS n FROM send_attempts s JOIN prospects p ON p.id = s.prospect_id WHERE s.kind = 'follow_up' AND s.status = 'sent' AND p.campaign_type = 'ugc'"),
      errors7d: n("SELECT count(*) AS n FROM autopilot_events WHERE campaign = 'ugc' AND kind = 'error' AND created_at >= ?", new Date(now.getTime() - 7 * 86_400_000).toISOString()),
      bounces7d: ugcBounces(db, now),
      followUpsPending: n("SELECT count(*) AS n FROM follow_ups f JOIN prospects p ON p.id = f.prospect_id WHERE f.status IN ('scheduled', 'approved') AND p.campaign_type = 'ugc'"),
    },
    events: all<{ id: number; kind: string; detail: string; prospect_id: number | null; created_at: string }>(db, "SELECT id, kind, detail, prospect_id, created_at FROM autopilot_events WHERE campaign = 'ugc' ORDER BY id DESC LIMIT 60"),
  }
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
  // Sponsorship only: UGC emails are never sent without your approval of each one.
  return listLeads(db).filter((l) => l.campaign_type === 'sponsorship' && l.actionable && !l.needs_before_send.length && l.outreach_status !== 'gmail_draft' && !held(db, `p:${l.id}`, now))
}

const sentToday = (db: DB, now: Date, kind: 'initial' | 'follow_up', campaign: Campaign = 'sponsorship') => get<{ n: number }>(db,
  `SELECT count(*) AS n FROM send_attempts s JOIN prospects p ON p.id = s.prospect_id WHERE s.initiated_by = 'autopilot' AND s.kind = ? AND s.day_key = ?
    AND s.status IN ('sending', 'sent', 'uncertain') AND p.campaign_type = ?`, kind, today(db, now), campaign)!.n

// UGC companies autopilot may write to: a qualifying public email, a recipient that needs nothing from you (country
// confirmed, research fresh), a lead score at or above your minimum, not rejected and not on hold. Best score first.
export function ugcCandidates(db: DB, now = new Date()): Lead[] {
  const min = getSetting<{ minScore: number }>(db, 'ugc.research').minScore
  return listLeads(db).filter((l) => l.campaign_type === 'ugc' && l.actionable && !l.needs_before_send.length && l.review_status !== 'rejected'
    && (l.fit_score ?? 0) >= min && !held(db, `p:${l.id}`, now)).sort((a, b) => (b.fit_score ?? 0) - (a.fit_score ?? 0))
}

// Today's UGC cap: starts at newPerDay and moves one step a week: up after a clean week with real volume, down after
// any bounce. Never above rampMax or the hard maximum, and always inside the shared account limits.
export function ugcCap(db: DB, now = new Date()) {
  const cfg = ugcConfig(db)
  const ramp = getSetting<{ cap: number | null; reviewedAt: string | null }>(db, 'ugc.autopilotRamp')
  const max = Math.min(cfg.rampMax, UGC_AUTOPILOT_HARD_MAX)
  // The starting limit you set is the floor; the ramp only adds to it.
  let cap = Math.min(Math.max(ramp.cap ?? cfg.newPerDay, cfg.newPerDay, 1), max)
  if (!ramp.reviewedAt) {
    setSetting(db, 'ugc.autopilotRamp', { cap, reviewedAt: now.toISOString() })
  } else if (now.getTime() - new Date(ramp.reviewedAt).getTime() >= 7 * 86_400_000) {
    const since = new Date(now.getTime() - 7 * 86_400_000).toISOString()
    const sends = get<{ n: number }>(db, `SELECT count(*) AS n FROM send_attempts s JOIN prospects p ON p.id = s.prospect_id
      WHERE s.initiated_by = 'autopilot' AND s.kind = 'initial' AND s.status = 'sent' AND p.campaign_type = 'ugc' AND s.sent_at >= ?`, since)!.n
    const bounces = ugcBounces(db, now)
    const before = cap
    if (bounces > 0) cap = Math.max(1, cap - 1)
    else if (sends >= cap * 3) cap = Math.min(cap + 1, max)
    setSetting(db, 'ugc.autopilotRamp', { cap, reviewedAt: now.toISOString() })
    if (cap !== before) event(db, 'report', `UGC daily limit ${cap > before ? 'raised' : 'lowered'} from ${before} to ${cap} (${sends} sent and ${bounces} bounce(s) in the last 7 days).`, { campaign: 'ugc', now })
  }
  return cap
}

const ugcBounces = (db: DB, now: Date) => get<{ n: number }>(db, `SELECT count(*) AS n FROM suppressions WHERE source = 'bounce' AND created_at >= ?
  AND value IN (SELECT s.recipient FROM send_attempts s JOIN prospects p ON p.id = s.prospect_id WHERE s.initiated_by = 'autopilot' AND p.campaign_type = 'ugc')`,
  new Date(now.getTime() - 7 * 86_400_000).toISOString())!.n

export interface TickResult { ran: boolean; dryRun: boolean; note: string; actions: string[] }

export async function tick(db: DB, deps: GmailDeps, opts: { dataDir: string; ai?: RouterDeps; now?: Date; forceDryRun?: boolean; holder?: string; campaigns?: Campaign[]; fetchImpl?: typeof fetch }): Promise<TickResult> {
  const now = opts.now ?? new Date()
  const cfg = config(db)
  const dry = !!opts.forceDryRun || cfg.dryRun
  const result: TickResult = { ran: false, dryRun: dry, note: '', actions: [] }
  // Each campaign runs only while its own switch is on; a forced dry run plans the campaigns asked for.
  const paused = campaignPaused(db)
  const sponsorshipOn = opts.forceDryRun ? (opts.campaigns ?? ['sponsorship']).includes('sponsorship') : isEnabled(db) && !paused.sponsorship
  const ugcOn = opts.forceDryRun ? (opts.campaigns ?? []).includes('ugc') : ugcEnabled(db) && !paused.ugc
  if (!sponsorshipOn && !ugcOn) return { ...result, note: isEnabled(db) || ugcEnabled(db) ? 'Both campaigns are paused.' : 'Autopilot is off.' }
  // Recoverable trouble (Gmail briefly unreachable, too many errors today) waits instead of switching autopilot off.
  const wait = backoffUntil(db)
  if (!opts.forceDryRun && wait && wait > now.getTime()) return { ...result, note: `Waiting until ${new Date(wait).toISOString().slice(11, 16)} UTC after a recoverable problem.` }
  const holder = opts.holder ?? `pid${process.pid}`
  if (!acquire(db, holder, now.getTime())) return { ...result, note: 'Another autopilot run is in progress.' }
  try {
    result.ran = true
    ensureReports(db, now)
    if (stopState(db).active) return { ...result, note: 'STOP ALL OUTREACH is active.' }

    // Safety brakes: anything that needs a person stops autopilot.
    if (!dry) {
      const uncertain = get<{ recipient: string }>(db, "SELECT recipient FROM send_attempts WHERE status = 'uncertain' LIMIT 1")
      // Account-wide brakes (one Gmail account): they pause both campaigns.
      if (uncertain) { autoPause(db, `A send to ${uncertain.recipient} has an uncertain result. Reconcile it in Outreach → Sent.`, 'both'); return { ...result, note: 'Paused: uncertain send.' } }
      const errors = get<{ n: number }>(db, "SELECT count(*) AS n FROM autopilot_events WHERE kind = 'error' AND day_key = ?", today(db, now))!.n
      if (errors >= cfg.maxErrorsPerDay) {
        // Stops for the rest of the day and resumes on its own the next business day.
        const tomorrow = new Date(now.getTime() + 86_400_000)
        if (!get(db, "SELECT 1 FROM autopilot_events WHERE kind = 'paused' AND day_key = ? AND detail LIKE 'Errors:%'", today(db, now))) {
          event(db, 'paused', `Errors: ${errors} today (limit ${cfg.maxErrorsPerDay}). Both campaigns stop for today and resume tomorrow. Check Autopilot → Activity.`, { now })
          logActivity(db, 'autopilot.cooldown', `Autopilot stopped for today after ${errors} errors; it resumes tomorrow. Nothing was switched off.`)
        }
        setBackoff(db, Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate(), 8))
        return { ...result, note: 'Stopped for today: errors.' }
      }
      // Bounce brakes are per campaign.
      const bounces = get<{ n: number }>(db, `SELECT count(*) AS n FROM suppressions WHERE source = 'bounce' AND created_at >= ?
        AND value IN (SELECT s.recipient FROM send_attempts s LEFT JOIN prospects p ON p.id = s.prospect_id WHERE s.initiated_by = 'autopilot' AND COALESCE(p.campaign_type, 'sponsorship') = 'sponsorship')`, new Date(now.getTime() - 7 * 86_400_000).toISOString())!.n
      if (sponsorshipOn && bounces >= cfg.maxBouncesPerWeek) { autoPause(db, `${bounces} autopilot emails hard-bounced in 7 days (limit ${cfg.maxBouncesPerWeek}). Check the addresses before resuming.`); return { ...result, note: 'Paused: bounces.' } }
      if (ugcOn) {
        const ub = ugcBounces(db, now)
        if (ub >= ugcConfig(db).maxBouncesPerWeek) autoPause(db, `${ub} UGC autopilot emails hard-bounced in 7 days (limit ${ugcConfig(db).maxBouncesPerWeek}). Check the addresses before resuming.`, 'ugc')
      }
      try {
        const { account } = await accessToken(db, deps)
        if (missingScopes(account).length) { autoPause(db, 'Gmail permissions are missing. Reconnect Gmail in Settings → Gmail.', 'both'); return { ...result, note: 'Paused: Gmail permissions.' } }
      } catch (err) {
        // Authorization problems need you (reconnect); a network or Google outage is retried in 5 minutes.
        if (err instanceof AppError && ['not_connected', 'needs_reconnect', 'wrong_account'].includes(err.code)) {
          autoPause(db, `Gmail authorization failed: ${err.message}`, 'both')
          return { ...result, note: 'Paused: Gmail authorization.' }
        }
        setBackoff(db, now.getTime() + 5 * 60_000)
        event(db, 'skipped', `Gmail is temporarily unavailable (${(err as Error).message}); trying again in 5 minutes.`, { now })
        return { ...result, note: 'Gmail unavailable; retrying in 5 minutes.' }
      }
      if (wait) setBackoff(db, null)
      // Replies, opt-outs and bounces first, so nothing goes to someone who just answered.
      const last = get<{ started_at: string }>(db, "SELECT started_at FROM gmail_sync_runs ORDER BY id DESC LIMIT 1")
      if (!last || now.getTime() - new Date(last.started_at).getTime() > cfg.syncEveryMinutes * 60_000) {
        try {
          const s = await syncConversations(db, deps, { ai: opts.ai })
          if (s.messagesAdded || s.errors.length) event(db, 'sync', `Checked ${s.threadsChecked} conversations: ${s.replies} repl${s.replies === 1 ? 'y' : 'ies'}, ${s.followUpsCancelled} follow-up(s) stopped${s.errors.length ? `, ${s.errors.length} error(s)` : ''}.`, { now })
          interestedUgcStep(db, now)
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
    const campaigns: Campaign[] = [...(sponsorshipOn ? ['sponsorship' as const] : []), ...(ugcOn ? ['ugc' as const] : [])]
    if (await followUpStep(db, deps, opts, cfg, dry, now, limits, result, campaigns)) return result
    if (sponsorshipOn) {
      // One email per run: if sponsorship sent one, UGC waits for the next run (the send gap applies to both).
      const sentBefore = dry ? 0 : sentToday(db, now, 'initial', 'sponsorship')
      await firstEmailStep(db, deps, opts, cfg, dry, now, limits, result)
      if (!dry) await researchStep(db, cfg, now, result, opts.fetchImpl)
      if (!dry && sentToday(db, now, 'initial', 'sponsorship') > sentBefore) return result
    }
    if (ugcOn) await ugcFirstEmailStep(db, deps, opts, dry, now, limitsStatus(db, now), result)
    return result
  } finally {
    release(db, holder)
  }
}

async function followUpStep(db: DB, deps: GmailDeps, opts: { dataDir: string; ai?: RouterDeps }, cfg: AutopilotConfig, dry: boolean, now: Date, limits: ReturnType<typeof limitsStatus>, result: TickResult, campaigns: Campaign[] = ['sponsorship']) {
  if (limits.followUps.remaining <= 0 || limits.total.remaining <= 0) {
    result.note = `Follow-up limit reached today (${limits.followUps.sent} of ${limits.followUps.limit} follow-ups, ${limits.total.sent} of ${limits.total.limit} emails).`
    return false
  }
  reconcileFollowUps(db)
  // Only follow-ups of campaigns whose autopilot is on; the others wait for you.
  const due = all<FollowUpRow & { campaign_type: Campaign }>(db, `SELECT f.*, p.campaign_type FROM follow_ups f JOIN prospects p ON p.id = f.prospect_id
    WHERE f.status IN ('scheduled', 'approved') AND f.due_at <= ? AND p.campaign_type IN (${campaigns.map(() => '?').join(', ') || "''"}) ORDER BY f.due_at, f.sequence`, now.toISOString(), ...campaigns)
  for (const row of due) {
    const campaign = row.campaign_type
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
        event(db, 'dry_run', `Would send follow-up ${f.sequence} to ${original.recipient} ("${f.subject}").`, { prospectId: f.prospect_id, followUpId: f.id, now, campaign })
        result.actions.push(`follow-up ${f.sequence} → ${original.recipient}`)
        return true
      }
      if (f.status === 'scheduled') approveFollowUp(db, f.id)
      if (!liveFollowUpDraft(db, f.id)) await createFollowUpDraft(db, deps, opts.dataDir, f.id)
      const r = await autopilotSend(db, deps, { kind: 'follow_up', followUpId: f.id })
      if (r.sent) {
        event(db, 'sent', `Sent ${campaign === 'ugc' ? 'UGC ' : ''}follow-up ${f.sequence} to ${r.sent.recipient}.`, { prospectId: f.prospect_id, followUpId: f.id, sendId: r.sent.id, now, campaign })
        result.actions.push(`follow-up ${f.sequence} → ${r.sent.recipient}`)
        return true
      }
      const why = r.failing.map((c) => `${c.label}: ${c.detail}`).join('; ')
      hold(db, key, why, now)
      event(db, 'skipped', `Follow-up ${f.sequence} to ${original.recipient} not sent: ${why}`, { prospectId: f.prospect_id, followUpId: f.id, now, campaign })
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
  const budget = campaignBudget(db, now).campaigns.sponsorship
  const room = Math.min(cap - done, budget.remaining, limits.newEmails.remaining, limits.weekNew.remaining, limits.total.remaining)
  if (room <= 0) { result.note = `${result.note ? `${result.note} ` : ''}Sponsorship daily limit reached (${budget.sent} of ${budget.allocated} sponsorship slots, ${limits.newEmails.sent} of ${limits.newEmails.limit} new emails today).`; return }
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

// UGC first emails: same send path and checks as every other email (fresh Gmail read-back, do-not-contact list,
// one first email per company and per address, shared account limits). The launch gate must be passing.
async function ugcFirstEmailStep(db: DB, deps: GmailDeps, opts: { dataDir: string; ai?: RouterDeps }, dry: boolean, now: Date, limits: ReturnType<typeof limitsStatus>, result: TickResult) {
  const say = (n: string) => { result.note = `${result.note ? `${result.note} ` : ''}${n}` }
  const gate = gateStatus(db, now)
  if (!gate.passing) { say(gate.fresh ? 'UGC: the launch gate is failing, so no UGC email is sent.' : 'UGC: the launch gate needs checking again.'); return }
  const cap = ugcCap(db, now)
  const done = dry ? 0 : sentToday(db, now, 'initial', 'ugc')
  const budget = campaignBudget(db, now).campaigns.ugc
  const room = Math.min(cap - done, budget.remaining, limits.newEmails.remaining, limits.weekNew.remaining, limits.total.remaining)
  if (room <= 0) { say(`UGC daily limit reached (${budget.sent} of ${budget.allocated} UGC slots, ${done} of ${cap} by autopilot; shared limits: ${limits.newEmails.sent} of ${limits.newEmails.limit} new today, ${limits.weekNew.sent} of ${limits.weekNew.limit} this week).`); return }
  const portfolio = gate.checks.length ? getSetting<string>(db, 'ugc.portfolioUrl') : ''
  let attempts = 0
  for (const lead of ugcCandidates(db, now)) {
    if (attempts++ >= (dry ? room : 3)) break
    const key = `p:${lead.id}`
    try {
      let open = get<{ id: number; status: string; body: string; edited: number }>(db, "SELECT id, status, body, edited FROM pitches WHERE prospect_id = ? AND channel = 'email' AND status IN ('draft', 'approved') ORDER BY id DESC LIMIT 1", lead.id)
      if (dry) {
        event(db, 'dry_run', `Would email ${lead.company_name} at ${lead.email} (UGC pitch${open ? ` v${open.id}` : ' to be written'}, portfolio ${portfolio}).`, { prospectId: lead.id, now, campaign: 'ugc' })
        result.actions.push(`UGC first email → ${lead.email} (${lead.company_name})`)
        continue
      }
      // A pitch written before the portfolio link was verified is rewritten (never one you edited yourself).
      if (open && !open.edited && portfolio && !open.body.includes(portfolio)) open = { ...open, id: (await regeneratePitch(db, open.id)).id, status: 'draft' }
      const pitchId = open?.id ?? (await generatePitch(db, lead.id, { channel: 'email' })).id
      if (!open || open.status === 'draft') approvePitch(db, pitchId)
      const draft = get<{ id: number; edited_in_gmail: number }>(db, "SELECT id, edited_in_gmail FROM gmail_drafts WHERE prospect_id = ? AND kind = 'pitch' AND status IN ('creating', 'created', 'uncertain')", lead.id)
      if (draft?.edited_in_gmail) {
        hold(db, key, 'You edited this Gmail draft; autopilot leaves it for you to send or update.', now, 24 * 30)
        event(db, 'skipped', `${lead.company_name}: you edited the Gmail draft, so autopilot leaves it to you.`, { prospectId: lead.id, now, campaign: 'ugc' })
        continue
      }
      if (draft) await updatePitchDraft(db, deps, opts.dataDir, pitchId)
      else await createPitchDraft(db, deps, opts.dataDir, pitchId)
      const r = await autopilotSend(db, deps, { kind: 'initial', pitchId })
      if (r.sent) {
        event(db, 'sent', `Sent the UGC first email to ${lead.company_name} at ${r.sent.recipient}.`, { prospectId: lead.id, sendId: r.sent.id, now, campaign: 'ugc' })
        result.actions.push(`UGC first email → ${r.sent.recipient} (${lead.company_name})`)
        return
      }
      const why = r.failing.map((c) => `${c.label}: ${c.detail}`).join('; ')
      hold(db, key, why, now)
      event(db, 'skipped', `${lead.company_name} not emailed: ${why}`, { prospectId: lead.id, now, campaign: 'ugc' })
    } catch (err) {
      hold(db, key, (err as Error).message, now)
      if (err instanceof AppError && ['blocked', 'not_qualified', 'review_required', 'edited_in_gmail', 'duplicate', 'gone'].includes(err.code)) {
        event(db, 'skipped', `${lead.company_name} not emailed: ${err.message}`, { prospectId: lead.id, now, campaign: 'ugc' })
        continue
      }
      handleError(db, err, `UGC first email to ${lead.company_name}`, { prospectId: lead.id, now, campaign: 'ugc' })
      return
    }
  }
  if (!result.actions.length) say(ugcCandidates(db, now).length ? 'UGC: no email went out this run.' : 'UGC: no company is ready for an automatic email (see UGC → Autopilot for why).')
}

// A positive reply to a UGC email: follow-ups are already stopped by the reply check; this opens an "Interested" deal
// (no price, no terms) and tells you on the dashboard. Nothing is answered or agreed automatically.
export function interestedUgcStep(db: DB, now = new Date()) {
  const rows = all<{ prospect_id: number; company_name: string; from_email: string; message_id: number }>(db, `SELECT t.prospect_id, p.company_name, m.from_email, m.id AS message_id
    FROM email_messages m JOIN email_threads t ON t.id = m.thread_id JOIN prospects p ON p.id = t.prospect_id
    WHERE m.direction = 'inbound' AND m.kind = 'reply' AND m.classification IN ('interested', 'needs_info', 'negotiating') AND p.campaign_type = 'ugc'
      AND NOT EXISTS (SELECT 1 FROM ugc_deals d WHERE d.prospect_id = t.prospect_id)
    GROUP BY t.prospect_id`)
  for (const r of rows) {
    try {
      createDeal(db, r.prospect_id, { title: 'Interested (replied to outreach)', status: 'interested', notes: `Opened automatically from the reply by ${r.from_email}. No price, terms or usage rights have been discussed or agreed.` })
      event(db, 'sync', `INTERESTED: ${r.company_name} replied positively (${r.from_email}). Follow-ups stopped; it is waiting for you in UGC → Pipeline.`, { prospectId: r.prospect_id, now, campaign: 'ugc' })
      logActivity(db, 'ugc.interested', `${r.company_name} replied with interest. Follow-ups stopped; reply to them yourself.`, { prospectId: r.prospect_id })
    } catch (err) {
      event(db, 'error', `Could not open a deal for ${r.company_name}: ${(err as Error).message}`, { prospectId: r.prospect_id, now, campaign: 'ugc' })
    }
  }
  return rows.length
}

// Keeps a small supply of qualifying brands: one research batch a day when fewer are ready than the daily cap.
async function researchStep(db: DB, cfg: AutopilotConfig, now: Date, result: TickResult, fetchImpl?: typeof fetch) {
  if (candidates(db, now).length >= cfg.newPerDay) return
  if (get(db, "SELECT 1 FROM autopilot_events WHERE kind = 'research' AND day_key = ? AND campaign = 'sponsorship'", today(db, now))) return
  if (get(db, "SELECT 1 FROM research_batches WHERE status IN ('queued', 'running')")) return
  // The starter list runs out: find more sponsorship brands from public discovery first (worker only).
  if (fetchImpl && availableCandidates(db, 'sponsorship') < 80) {
    const d = await discoverCompanies(db, 80, fetchImpl, 'sponsorship').catch((e: Error) => ({ total: 0, errors: [e.message] }))
    if (d.total) event(db, 'research', `Found ${d.total} new sponsorship candidates on Wikidata.`, { now })
  }
  try {
    const b = createBatch(db, { size: 20 })
    event(db, 'research', `Started research batch #${b.batch.id} to find up to 20 brands with qualifying emails (${b.batch.total} queued).`, { now })
    result.actions.push(`research batch #${b.batch.id}`)
  } catch (err) {
    event(db, 'research', `Could not start research: ${(err as Error).message}`, { now })
  }
}

function handleError(db: DB, err: unknown, what: string, o: { prospectId?: number; followUpId?: number; now: Date; campaign?: Campaign }) {
  const e = err as AppError
  event(db, 'error', `${what}: ${e.message}`, o)
  // A send whose result is unknown must be checked by a person before anything else goes out (both campaigns stop).
  if (e.code === 'send_uncertain') autoPause(db, `Gmail did not confirm the ${what}. It was not retried; reconcile it in Outreach → Sent.`, 'both')
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

// ---------- Dual-campaign dashboard ----------

export function dualStatus(db: DB, now = new Date()) {
  const budget = campaignBudget(db, now)
  const paused = campaignPaused(db)
  const n = (sql: string, ...p: (string | number)[]) => get<{ n: number }>(db, sql, ...p)!.n
  const leads = listLeads(db)
  const blocked = (c: Campaign) => {
    const reasons = new Map<string, number>()
    // Companies with a found email that cannot be emailed right now (no-email and already-contacted companies are not counted).
    const skip = ['no_email', 'form_only', 'social_only', 'already_contacted']
    for (const l of leads.filter((x) => x.campaign_type === c && !x.previously_contacted && (x.needs_before_send.length || (x.exclusion && !skip.includes(x.exclusion.code))))) {
      const why = l.needs_before_send.length ? l.needs_before_send : l.exclusion ? [l.exclusion.label] : []
      for (const w of why) reasons.set(w, (reasons.get(w) ?? 0) + 1)
    }
    return [...reasons.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count)
  }
  const per = (c: Campaign) => ({
    enabled: campaignEnabled(db, c),
    paused: paused[c],
    autoPause: getSetting<{ reason: string | null; at: string | null }>(db, c === 'ugc' ? 'ugc.autopilotPause' : 'outreach.autopilotPause'),
    today: budget.campaigns[c],
    followUpsToday: n(`SELECT count(*) AS n FROM send_attempts s JOIN prospects p ON p.id = s.prospect_id WHERE s.kind = 'follow_up' AND s.day_key = ? AND s.status IN ('sending', 'sent', 'uncertain') AND p.campaign_type = ?`, budget.day, c),
    weekSent: n(`SELECT count(*) AS n FROM send_attempts s JOIN prospects p ON p.id = s.prospect_id WHERE s.kind = 'initial' AND s.day_key >= ? AND s.status IN ('sending', 'sent', 'uncertain') AND p.campaign_type = ?`, dayKey(new Date(now.getTime() - 6 * 86_400_000), calendar(db).timezone), c),
    ready: (c === 'ugc' ? ugcCandidates(db, now) : candidates(db, now)).length,
    blocked: blocked(c),
    replies: n(`SELECT count(DISTINCT t.prospect_id) AS n FROM email_messages m JOIN email_threads t ON t.id = m.thread_id JOIN prospects p ON p.id = t.prospect_id WHERE m.direction = 'inbound' AND m.kind = 'reply' AND p.campaign_type = ?`, c),
    interested: n(`SELECT count(DISTINCT t.prospect_id) AS n FROM email_messages m JOIN email_threads t ON t.id = m.thread_id JOIN prospects p ON p.id = t.prospect_id WHERE m.direction = 'inbound' AND m.kind = 'reply' AND m.classification IN ('interested', 'needs_info', 'negotiating') AND p.campaign_type = ?`, c),
  })
  return {
    day: budget.day, tier: budget.tier, allocation: budget.allocation,
    combined: budget.combined, week: budget.week, followUps: budget.limits.followUps, total: budget.limits.total,
    inSendWindow: inSendWindow(db, now), emergencyStop: stopState(db),
    sponsorship: per('sponsorship'), ugc: per('ugc'),
  }
}

// ---------- The schedule (runs inside the worker process) ----------

export async function runAutopilot(db: DB, deps: GmailDeps, opts: { dataDir: string; signal?: AbortSignal; everyMs?: number; log?: (m: string) => void; ai?: RouterDeps }) {
  const log = opts.log ?? (() => {})
  const holder = `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  log('Autopilot scheduler running (checks every minute; acts only when switched on)')
  while (!opts.signal?.aborted) {
    try {
      const r = await tick(db, deps, { dataDir: opts.dataDir, ai: opts.ai, holder, fetchImpl: fetch })
      if (r.actions.length) log(`Autopilot${r.dryRun ? ' (dry run)' : ''}: ${r.actions.join(', ')}`)
    } catch (err) {
      try { event(db, 'error', `Autopilot run failed: ${(err as Error).message}`) } catch { /* database unavailable */ }
      log(`Autopilot error: ${(err as Error).message}`)
    }
    await new Promise((r) => setTimeout(r, opts.everyMs ?? 60_000))
  }
}
