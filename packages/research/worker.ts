// Durable research queue. State lives in SQLite, so a crash or restart resumes where it stopped:
// candidates left "researching" go back to "pending" (up to MAX_ATTEMPTS), and finished work is never redone.
import { all, get, getSetting, logActivity, nowIso, run, setSetting, tx, type DB } from '../db'
import type { RouterDeps } from '../ai/router'
import { createFetcher, type Fetcher } from './fetcher'
import { researchCandidate, type Candidate, type ResearchResult } from './pipeline'
import { processContactRun, recoverContactRuns } from './contacts'
import { MAX_RESEARCH_MULTIPLIER, topUpBatch } from './batches'
import { checkDueMailDomains, ensureMailDomains, type MailLookup } from './mailDomain'
import { contactQualification, departmentOf } from '../crm/leads'
import type { Contact } from '../crm/prospects'
import { scoreFit, type FitBreakdown } from '../core/scoring'

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

// Atomically claims the next pending candidate of the oldest active batch. Brands already being researched count
// toward the target, so parallel lanes never overshoot it.
export function claimNext(db: DB): Candidate | null {
  return tx(db, () => {
    const c = get<Candidate>(db, `SELECT rc.id, rc.batch_id, rc.pool_id, rc.company_name, rc.website, rc.domain, rc.category_id
      FROM research_candidates rc JOIN research_batches b ON b.id = rc.batch_id
      WHERE rc.status = 'pending' AND b.status IN ('queued', 'running')
        AND (SELECT count(*) FROM research_candidates x WHERE x.batch_id = b.id AND (x.qualified = 1 OR x.status = 'researching')) < b.requested_size
      ORDER BY b.id, rc.id LIMIT 1`)
    if (!c) return null
    const now = nowIso()
    run(db, "UPDATE research_candidates SET status = 'researching', attempts = attempts + 1, started_at = ? WHERE id = ? AND status = 'pending'", now, c.id)
    run(db, "UPDATE research_batches SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ? AND status = 'queued'", now, c.batch_id)
    return c
  })
}

function completeIfDone(db: DB, batchId: number) {
  const b = get<{ requested_size: number; status: string }>(db, 'SELECT requested_size, status FROM research_batches WHERE id = ?', batchId)!
  const count = (where: string) => get<{ n: number }>(db, `SELECT count(*) AS n FROM research_candidates WHERE batch_id = ? AND ${where}`, batchId)!.n
  const now = nowIso()
  // Target reached: stop early, and put the brands not needed back in the pool.
  if (b.status === 'running' && count('qualified = 1') >= b.requested_size) {
    run(db, `UPDATE candidate_pool SET status = 'available', updated_at = ? WHERE id IN (SELECT pool_id FROM research_candidates WHERE batch_id = ? AND status = 'pending')`, now, batchId)
    run(db, "UPDATE research_candidates SET status = 'cancelled', message = 'Not needed: the batch reached its target', finished_at = ? WHERE batch_id = ? AND status = 'pending'", now, batchId)
  }
  if (count("status IN ('pending', 'researching')")) return
  if (b.status === 'running' && topUpBatch(db, batchId) > 0) return
  const changed = run(db, "UPDATE research_batches SET status = 'completed', finished_at = ? WHERE id = ? AND status = 'running'", now, batchId).changes
  if (changed) {
    const s = get<{ done: number; dup: number; other: number; qualified: number }>(db, `SELECT
      count(CASE WHEN status = 'done' THEN 1 END) AS done, count(CASE WHEN status = 'duplicate' THEN 1 END) AS dup,
      count(CASE WHEN status IN ('unreachable', 'blocked', 'failed') THEN 1 END) AS other, count(CASE WHEN qualified = 1 THEN 1 END) AS qualified FROM research_candidates WHERE batch_id = ?`, batchId)!
    if (s.qualified < b.requested_size) {
      run(db, 'UPDATE research_batches SET shortfall_note = ? WHERE id = ?', `Found ${s.qualified} of ${b.requested_size} brands with qualifying emails after researching ${s.done + s.dup + s.other}. Stopped at the candidate pool, category quotas or the limit of ${MAX_RESEARCH_MULTIPLIER}× the target. Remaining slots were left empty rather than filled with unverified contacts; add candidates to research more.`, batchId)
    }
    logActivity(db, 'research.batch_completed', `Research batch #${batchId} finished: ${s.qualified} with qualifying emails, ${s.done - s.qualified} without, ${s.dup} duplicates, ${s.other} unreachable/blocked`)
  }
}

export function finishCandidate(db: DB, cand: Candidate, result: ResearchResult) {
  tx(db, () => {
    const now = nowIso()
    run(db, 'UPDATE research_candidates SET status = ?, message = ?, prospect_id = ?, finished_at = ?, qualified = ?, exclusion_reason = ? WHERE id = ?',
      result.status, result.message.slice(0, 1000), result.prospectId ?? null, now, result.qualified ? 1 : 0, result.exclusionReason ?? null, cand.id)
    run(db, "UPDATE candidate_pool SET status = 'researched', updated_at = ? WHERE id = ?", now, cand.pool_id)
    completeIfDone(db, cand.batch_id)
  })
}

// Does this company have an email that qualifies, and if not, why? Runs the deeper contact research first when
// the homepage pass found nothing, so a batch knows the answer before it moves on.
export async function qualifyResearched(db: DB, prospectId: number, deps: { fetcher: Fetcher; mailLookup?: MailLookup }) {
  const check = async () => {
    await ensureMailDomains(db, prospectId, deps.mailLookup)
    const domain = get<{ domain: string | null }>(db, 'SELECT domain FROM prospects WHERE id = ?', prospectId)!.domain
    const rows = all<Contact>(db, 'SELECT * FROM contacts WHERE prospect_id = ? AND email IS NOT NULL', prospectId)
      .map((c) => ({ c, q: contactQualification(db, c, domain) }))
      .sort((a, b) => departmentOf(a.c).rank - departmentOf(b.c).rank)
    return { best: rows.find((r) => r.q.qualifies)?.c ?? null, first: rows[0] ?? null }
  }
  let r = await check()
  if (!r.best && await processContactRun(db, deps, prospectId)) r = await check()
  return {
    qualified: !!r.best,
    email: r.best?.email ?? null,
    exclusionReason: r.best ? null : r.first?.q.reasons[0] ?? (get(db, 'SELECT 1 FROM contacts WHERE prospect_id = ? AND contact_form_url IS NOT NULL', prospectId) ? 'Contact form or portal only' : 'No email discovered'),
  }
}

export async function processOne(db: DB, deps: { fetcher: Fetcher; ai?: RouterDeps; mailLookup?: MailLookup }): Promise<boolean> {
  const cand = claimNext(db)
  if (!cand) return false
  let result: ResearchResult
  try {
    result = await researchCandidate(db, cand, deps)
    if (result.status === 'done' && result.prospectId) {
      const pid = result.prospectId
      const q = await qualifyResearched(db, pid, deps)
      result = { ...result, qualified: q.qualified, exclusionReason: q.exclusionReason, message: q.qualified ? `${result.message}. Qualifying email: ${q.email}` : `${result.message}. Excluded: ${q.exclusionReason}` }
      // UGC leads also need a minimum lead score: the daily target is never met with weak leads.
      const ugc = applyUgcMinimum(db, pid, q.qualified)
      if (ugc) result = { ...result, qualified: false, exclusionReason: ugc, message: `${result.message}. Not counted: ${ugc}` }
    }
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
      const worked = (await processOne(db, { fetcher, ai: opts.ai })) || (await processContactRun(db, { fetcher })) || (await checkDueMailDomains(db)) > 0
      if (!worked) await new Promise((r) => setTimeout(r, idle))
    }
  }
  const lanes = Math.min(5, Math.max(1, getSetting<number>(db, 'research.concurrency')))
  log(`Research worker running with ${lanes} lane(s)`)
  await Promise.all(Array.from({ length: lanes }, lane))
}

// For a UGC lead with a qualifying email: credit the contact found by the deeper contact research (the first score
// was computed before it ran), then apply the minimum lead score. Returns why the lead does not count, or null.
export function applyUgcMinimum(db: DB, prospectId: number, qualified: boolean): string | null {
  const p = get<{ campaign_type: string; fit_score: number | null; fit_breakdown: string | null; fit_explanation: string | null }>(db,
    'SELECT campaign_type, fit_score, fit_breakdown, fit_explanation FROM prospects WHERE id = ?', prospectId)
  if (!p || p.campaign_type !== 'ugc' || !qualified) return null
  const breakdown = JSON.parse(p.fit_breakdown ?? '{}') as FitBreakdown
  if (!breakdown.contact) {
    breakdown.contact = 8
    const score = scoreFit(breakdown)
    run(db, 'UPDATE prospects SET fit_breakdown = ?, fit_score = ?, fit_explanation = ?, updated_at = ? WHERE id = ?', JSON.stringify(breakdown), score,
      `${(p.fit_explanation ?? '').replace(/ No published business email found yet\.| Contact form only\./, '')} Business email found by contact research.`.trim(), nowIso(), prospectId)
    p.fit_score = score
  }
  const min = getSetting<{ minScore: number }>(db, 'ugc.research').minScore
  return (p.fit_score ?? 0) < min ? `UGC lead score ${p.fit_score ?? 0} is below your minimum of ${min}` : null
}
