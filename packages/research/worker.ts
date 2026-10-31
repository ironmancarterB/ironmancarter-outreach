// Durable research queue. State lives in SQLite, so a crash or restart resumes where it stopped:
// candidates left "researching" go back to "pending" (up to MAX_ATTEMPTS), and finished work is never redone.
import { get, getSetting, logActivity, nowIso, run, setSetting, tx, type DB } from '../db'
import type { RouterDeps } from '../ai/router'
import { createFetcher, type Fetcher } from './fetcher'
import { researchCandidate, type Candidate, type ResearchResult } from './pipeline'
import { processContactRun, recoverContactRuns } from './contacts'

export const MAX_ATTEMPTS = 3

export function recoverStale(db: DB): number {
  return tx(db, () => {
    const now = nowIso()
    const failed = run(db, `UPDATE research_candidates SET status = 'failed', message = 'Stopped repeatedly while researching (worker restarted ${MAX_ATTEMPTS} times)', finished_at = ?
      WHERE status = 'researching' AND attempts >= ?`, now, MAX_ATTEMPTS).changes
    const reset = run(db, "UPDATE research_candidates SET status = 'pending' WHERE status = 'researching'").changes
    if (failed) run(db, `UPDATE candidate_pool SET status = 'researched', updated_at = ? WHERE id IN (SELECT pool_id FROM research_candidates WHERE status = 'failed' AND finished_at = ?)`, now, now)
    if (reset || failed) logActivity(db, 'research.recovered', `Worker restart: ${reset} candidate(s) resumed, ${failed} marked failed`)
    for (const b of db.prepare("SELECT id FROM research_batches WHERE status = 'running'").all() as { id: number }[]) completeIfDone(db, b.id)
    return reset + failed
  })
}

// Atomically claims the next pending candidate of the oldest active batch.
export function claimNext(db: DB): Candidate | null {
  return tx(db, () => {
    const c = get<Candidate>(db, `SELECT rc.id, rc.batch_id, rc.pool_id, rc.company_name, rc.website, rc.domain, rc.category_id
      FROM research_candidates rc JOIN research_batches b ON b.id = rc.batch_id
      WHERE rc.status = 'pending' AND b.status IN ('queued', 'running') ORDER BY b.id, rc.id LIMIT 1`)
    if (!c) return null
    const now = nowIso()
    run(db, "UPDATE research_candidates SET status = 'researching', attempts = attempts + 1, started_at = ? WHERE id = ? AND status = 'pending'", now, c.id)
    run(db, "UPDATE research_batches SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ? AND status = 'queued'", now, c.batch_id)
    return c
  })
}

function completeIfDone(db: DB, batchId: number) {
  const left = get<{ n: number }>(db, "SELECT count(*) AS n FROM research_candidates WHERE batch_id = ? AND status IN ('pending', 'researching')", batchId)!.n
  if (left) return
  const changed = run(db, "UPDATE research_batches SET status = 'completed', finished_at = ? WHERE id = ? AND status = 'running'", nowIso(), batchId).changes
  if (changed) {
    const s = get<{ done: number; dup: number; other: number }>(db, `SELECT
      count(CASE WHEN status = 'done' THEN 1 END) AS done, count(CASE WHEN status = 'duplicate' THEN 1 END) AS dup,
      count(CASE WHEN status IN ('unreachable', 'blocked', 'failed') THEN 1 END) AS other FROM research_candidates WHERE batch_id = ?`, batchId)!
    logActivity(db, 'research.batch_completed', `Research batch #${batchId} finished: ${s.done} added for review, ${s.dup} duplicates, ${s.other} unreachable/blocked`)
  }
}

export function finishCandidate(db: DB, cand: Candidate, result: ResearchResult) {
  tx(db, () => {
    const now = nowIso()
    run(db, 'UPDATE research_candidates SET status = ?, message = ?, prospect_id = ?, finished_at = ? WHERE id = ?',
      result.status, result.message.slice(0, 1000), result.prospectId ?? null, now, cand.id)
    run(db, "UPDATE candidate_pool SET status = 'researched', updated_at = ? WHERE id = ?", now, cand.pool_id)
    completeIfDone(db, cand.batch_id)
  })
}

export async function processOne(db: DB, deps: { fetcher: Fetcher; ai?: RouterDeps }): Promise<boolean> {
  const cand = claimNext(db)
  if (!cand) return false
  let result: ResearchResult
  try {
    result = await researchCandidate(db, cand, deps)
  } catch (err) {
    result = { status: 'failed', message: `Unexpected error: ${(err as Error).message}` }
  }
  finishCandidate(db, cand, result)
  return true
}

export const heartbeat = (db: DB) => setSetting(db, 'worker.heartbeatAt', nowIso())

export interface WorkerOptions {
  fetchImpl?: typeof fetch
  ai?: RouterDeps
  idleMs?: number
  signal?: AbortSignal
  log?: (msg: string) => void
}

// Runs until the signal aborts. Concurrency and request delay come from settings.
export async function runWorker(db: DB, opts: WorkerOptions = {}) {
  const log = opts.log ?? (() => {})
  const recovered = recoverStale(db)
  if (recovered) log(`Recovered ${recovered} interrupted candidate(s)`)
  const contactRuns = recoverContactRuns(db)
  if (contactRuns) log(`Re-queued ${contactRuns} interrupted contact research run(s)`)
  const fetcher = createFetcher({ fetchImpl: opts.fetchImpl, delayMs: Math.max(1000, getSetting<number>(db, 'research.requestDelayMs')) })
  const idle = opts.idleMs ?? 3000
  const lane = async () => {
    while (!opts.signal?.aborted) {
      heartbeat(db)
      // New brands first, then "Find more contacts" runs.
      const worked = (await processOne(db, { fetcher, ai: opts.ai })) || (await processContactRun(db, { fetcher }))
      if (!worked) await new Promise((r) => setTimeout(r, idle))
    }
  }
  const lanes = Math.min(5, Math.max(1, getSetting<number>(db, 'research.concurrency')))
  log(`Research worker running with ${lanes} lane(s)`)
  await Promise.all(Array.from({ length: lanes }, lane))
}
