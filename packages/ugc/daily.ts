// The daily UGC run (worker, every minute; does real work at most once per business day):
// 1. Re-check the portfolio link (once a day).
// 2. Research new UGC companies until today's target of qualified leads is met (one batch per day).
// 3. When that batch finishes, draft pitches for the new qualified leads and copy them to Gmail for review.
// It only reads public websites and writes drafts. It never sends, never approves and never raises a limit.
import { get, getSetting, logActivity, nowIso, setSetting, type DB } from '../db'
import { AppError } from '../core/errors'
import type { GmailDeps } from '../gmail/account'
import { createBatch } from '../research/batches'
import { calendar, dayKey, isBusinessDay } from '../outreach/businessDays'
import { checkPortfolio } from './portfolio'
import { prepareUgcDrafts } from './drafting'
import { periodStart } from './dashboard'

export interface DailyState { day: string; batchId: number | null; drafted: boolean; note: string; portfolioCheckedDay?: string }

export async function ugcDailyStep(db: DB, opts: { gmail: GmailDeps | null; dataDir: string; now?: Date; fetchImpl?: typeof fetch }) {
  const now = opts.now ?? new Date()
  const cal = calendar(db)
  const day = dayKey(now, cal.timezone)
  const cfg = getSetting<{ dailyTarget: number; autoDaily: boolean; minScore: number; autoDraft: boolean }>(db, 'ugc.research')
  const prev = getSetting<DailyState | null>(db, 'ugc.lastDaily')
  const state: DailyState = prev?.day === day ? { ...prev } : { day, batchId: null, drafted: false, note: '' }
  const save = () => setSetting(db, 'ugc.lastDaily', state)

  // 1. Portfolio link: checked once a day so emails never point at a page that went down.
  if (state.portfolioCheckedDay !== day && getSetting<string>(db, 'ugc.portfolioUrl')) {
    await checkPortfolio(db, opts.fetchImpl ?? fetch, now).catch(() => null)
    state.portfolioCheckedDay = day
    save()
  }
  if (!cfg.autoDaily || !isBusinessDay(day, cal)) return state

  // 2. One research batch per business day, sized to what is still missing from today's target.
  if (!state.batchId) {
    const startOfDay = periodStart('day', now, cal.timezone).toISOString()
    const qualifiedToday = get<{ n: number }>(db, `SELECT count(*) AS n FROM research_candidates rc JOIN research_batches b ON b.id = rc.batch_id
      WHERE b.campaign_type = 'ugc' AND rc.qualified = 1 AND rc.finished_at >= ?`, startOfDay)!.n
    const need = Math.max(0, cfg.dailyTarget - qualifiedToday)
    if (!need) { state.batchId = -1; state.note = `Today's target of ${cfg.dailyTarget} qualified UGC leads is already met.`; save(); return state }
    if (get(db, "SELECT 1 FROM research_batches WHERE status IN ('queued', 'running')")) return state // try again next minute
    try {
      const b = createBatch(db, { size: Math.min(need, 200), campaign: 'ugc', origin: 'daily' })
      state.batchId = b.batch.id
      state.note = `Researching for ${need} qualified UGC lead(s).`
    } catch (err) {
      state.batchId = -1
      state.note = err instanceof AppError && err.code === 'empty'
        ? 'No UGC candidates left to research. Add companies on the UGC page (one at a time or by CSV).'
        : `Could not start today's UGC research: ${(err as Error).message}`
      logActivity(db, 'ugc.daily_skipped', state.note)
    }
    save()
    return state
  }

  // 3. After the batch finishes: draft the new qualified leads.
  if (state.batchId > 0 && !state.drafted) {
    const b = get<{ status: string }>(db, 'SELECT status FROM research_batches WHERE id = ?', state.batchId)
    if (b && ['queued', 'running'].includes(b.status)) return state
    state.drafted = true
    if (cfg.autoDraft) {
      const qualified = get<{ n: number }>(db, 'SELECT count(*) AS n FROM research_candidates WHERE batch_id = ? AND qualified = 1', state.batchId)!.n
      if (qualified) {
        try {
          const r = await prepareUgcDrafts(db, { count: Math.min(qualified, 100), gmail: opts.gmail, dataDir: opts.dataDir })
          state.note = `Research found ${qualified} qualified UGC lead(s); ${r.pitches.length} pitch draft(s) and ${r.gmailDrafts.length} Gmail draft(s) are waiting for your review. ${r.notes.join(' ')}`.trim()
        } catch (err) {
          state.note = `Drafting failed: ${(err as Error).message}`
        }
      } else state.note = 'Research finished with no new qualified UGC leads today.'
    }
    state.note = `${state.note} (${nowIso().slice(11, 16)} UTC)`
    save()
  }
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
