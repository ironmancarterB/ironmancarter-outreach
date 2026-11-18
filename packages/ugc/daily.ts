// The daily UGC run (worker, every minute; does real work only on business days):
// 1. Re-run the UGC launch gate once a day (portfolio live, videos playable, permission, contact details). If it fails
//    while UGC autopilot is on, UGC autopilot pauses itself.
// 2. Research until today's target of qualified leads is met: up to MAX_ROUNDS batches a day, topping the candidate
//    pool up from public discovery (Wikidata) when it runs low.
// 3. After each batch, write UGC pitches for the new qualified leads (and Gmail drafts when the portfolio is live).
// It never raises a sending limit; sending is autopilot's job, inside its own and the account's limits.
import { get, getSetting, logActivity, nowIso, setSetting, type DB } from '../db'
import { AppError } from '../core/errors'
import type { GmailDeps } from '../gmail/account'
import { createBatch, MAX_RESEARCH_MULTIPLIER } from '../research/batches'
import { calendar, dayKey, isBusinessDay } from '../outreach/businessDays'
import { autoPause, ugcEnabled } from '../outreach/autopilot'
import { runLaunchGate } from './gate'
import { prepareUgcDrafts } from './drafting'
import { periodStart } from './dashboard'
import { availableUgcCandidates, discoverCompanies } from './discovery'

export const MAX_ROUNDS = 3

export interface DailyState { day: string; batchId: number | null; drafted: boolean; note: string; round?: number; gateCheckedDay?: string; portfolioCheckedDay?: string; discovered?: number }

export async function ugcDailyStep(db: DB, opts: { gmail: GmailDeps | null; dataDir: string; now?: Date; fetchImpl?: typeof fetch }) {
  const now = opts.now ?? new Date()
  const fetchImpl = opts.fetchImpl ?? fetch
  const cal = calendar(db)
  const day = dayKey(now, cal.timezone)
  const cfg = getSetting<{ dailyTarget: number; autoDaily: boolean; minScore: number; autoDraft: boolean }>(db, 'ugc.research')
  const prev = getSetting<DailyState | null>(db, 'ugc.lastDaily')
  const state: DailyState = prev?.day === day ? { round: 0, ...prev } : { day, batchId: null, drafted: false, note: '', round: 0, discovered: 0 }
  const save = () => setSetting(db, 'ugc.lastDaily', state)

  // 1. Launch gate, once a day.
  if (state.gateCheckedDay !== day && getSetting<string>(db, 'ugc.portfolioUrl')) {
    state.gateCheckedDay = day
    save()
    const gate = await runLaunchGate(db, fetchImpl, now).catch(() => null)
    if (gate && !gate.ok && ugcEnabled(db)) autoPause(db, `The UGC launch gate failed: ${gate.checks.filter((c) => !c.ok).map((c) => `${c.label} (${c.detail})`).join('; ')}.`, 'ugc')
  }
  if (!cfg.autoDaily || !isBusinessDay(day, cal)) return state

  // 3. A batch finished: draft its qualified leads (once).
  if (state.batchId && state.batchId > 0) {
    const b = get<{ status: string }>(db, 'SELECT status FROM research_batches WHERE id = ?', state.batchId)
    if (b && ['queued', 'running'].includes(b.status)) return state
    if (!state.drafted) {
      state.drafted = true
      const qualified = get<{ n: number }>(db, 'SELECT count(*) AS n FROM research_candidates WHERE batch_id = ? AND qualified = 1', state.batchId)!.n
      if (cfg.autoDraft && qualified) {
        try {
          const r = await prepareUgcDrafts(db, { count: Math.min(qualified, 100), gmail: opts.gmail, dataDir: opts.dataDir })
          state.note = `Round ${state.round}: ${qualified} qualified UGC lead(s); ${r.pitches.length} pitch(es) written, ${r.gmailDrafts.length} Gmail draft(s). ${r.notes.join(' ')}`.trim()
        } catch (err) { state.note = `Drafting failed: ${(err as Error).message}` }
      } else state.note = `Round ${state.round}: ${qualified} qualified UGC lead(s).`
      state.note = `${state.note} (${nowIso().slice(11, 16)} UTC)`
      save()
    }
  }

  // 2. Next research round, while today's target is not met.
  if ((state.round ?? 0) >= MAX_ROUNDS || state.batchId === -1) return state
  const startOfDay = periodStart('day', now, cal.timezone).toISOString()
  const qualifiedToday = get<{ n: number }>(db, `SELECT count(*) AS n FROM research_candidates rc JOIN research_batches b ON b.id = rc.batch_id
    WHERE b.campaign_type = 'ugc' AND rc.qualified = 1 AND rc.finished_at >= ?`, startOfDay)!.n
  const need = Math.max(0, cfg.dailyTarget - qualifiedToday)
  if (!need) { state.batchId = -1; state.note = `Today's target of ${cfg.dailyTarget} qualified UGC leads is met (${qualifiedToday}).`; save(); return state }
  if (get(db, "SELECT 1 FROM research_batches WHERE status IN ('queued', 'running')")) return state // another batch is running; try next minute
  const size = Math.min(need, 200)
  // About a third of researched companies qualify, so keep several candidates per lead still needed.
  const available = availableUgcCandidates(db)
  if (available < size * MAX_RESEARCH_MULTIPLIER) {
    const r = await discoverCompanies(db, size * MAX_RESEARCH_MULTIPLIER - available, fetchImpl).catch((err: Error) => ({ total: 0, errors: [err.message] }))
    state.discovered = (state.discovered ?? 0) + r.total
  }
  try {
    const b = createBatch(db, { size, campaign: 'ugc', origin: 'daily' })
    state.batchId = b.batch.id
    state.drafted = false
    state.round = (state.round ?? 0) + 1
    state.note = `Round ${state.round}: researching for ${need} more qualified UGC lead(s) (${qualifiedToday} so far today, target ${cfg.dailyTarget}).`
  } catch (err) {
    state.batchId = -1
    state.note = err instanceof AppError && err.code === 'empty'
      ? `No UGC candidates left to research${state.discovered ? '' : ' and discovery found none'}. ${qualifiedToday} of ${cfg.dailyTarget} qualified today.`
      : `Could not start UGC research: ${(err as Error).message}`
    logActivity(db, 'ugc.daily_skipped', state.note)
  }
  save()
  return state
}

// Worker loop: one daily step a minute until stopped. Errors are logged and never stop the worker.
export async function runUgcDaily(db: DB, gmail: GmailDeps | null, opts: { dataDir: string; signal?: AbortSignal; log?: (m: string) => void; intervalMs?: number }) {
  const log = opts.log ?? (() => {})
  let last = ''
  while (!opts.signal?.aborted) {
    try {
      const s = await ugcDailyStep(db, { gmail, dataDir: opts.dataDir })
      if (s.note && s.note !== last) { log(`UGC daily: ${s.note}`); last = s.note }
    } catch (err) {
      log(`UGC daily step failed: ${(err as Error).message}`)
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 60_000))
  }
}
