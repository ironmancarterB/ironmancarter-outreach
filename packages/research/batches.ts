// Research batches and the candidate pool. Research capacity is separate from sending capacity:
// a batch only ever reads public websites.
import { all, get, getSetting, logActivity, nowIso, run, tx, type DB } from '../db'
import { AppError, invalid, notFound } from '../core/errors'
import { normalizeDomain, normalizeUrl } from '../core/normalize'

export const BATCH_SIZES = [20, 50, 100, 200, 500] as const
export type BatchSize = (typeof BATCH_SIZES)[number]

const AVAILABLE = `cp.status = 'available' AND NOT EXISTS (SELECT 1 FROM prospects p WHERE p.domain = cp.domain)`

export function poolSummary(db: DB) {
  return all<{ id: number; name: string; enabled: number; priority: number; research_quota: number; available: number; total: number }>(db, `
    SELECT c.id, c.name, c.enabled, c.priority, c.research_quota,
      (SELECT count(*) FROM candidate_pool cp WHERE cp.category_id = c.id AND ${AVAILABLE}) AS available,
      (SELECT count(*) FROM candidate_pool cp WHERE cp.category_id = c.id) AS total
    FROM categories c ORDER BY c.priority, c.sort_order`)
}

export function listPool(db: DB, filters: { category_id?: number; status?: string } = {}) {
  const where: string[] = []
  const params: (string | number)[] = []
  if (filters.category_id) { where.push('cp.category_id = ?'); params.push(filters.category_id) }
  if (filters.status) { where.push('cp.status = ?'); params.push(filters.status) }
  return all<{ id: number; company_name: string; website: string; domain: string; category_id: number; category_name: string; origin: string; status: string; note: string | null; in_crm: number }>(db, `
    SELECT cp.*, c.name AS category_name, EXISTS (SELECT 1 FROM prospects p WHERE p.domain = cp.domain) AS in_crm
    FROM candidate_pool cp JOIN categories c ON c.id = cp.category_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY c.priority, c.sort_order, cp.company_name COLLATE NOCASE`, ...params)
}

export function addPoolCandidate(db: DB, input: { company_name: string; website: string; category_id: number }, origin: 'manual' | 'csv' = 'manual') {
  const name = String(input.company_name ?? '').trim()
  if (!name) throw invalid('Company name is required')
  const website = normalizeUrl(input.website)
  const domain = normalizeDomain(input.website)
  if (!website || !domain) throw invalid(`Not a valid website: ${input.website}`)
  if (!get(db, 'SELECT 1 FROM categories WHERE id = ?', input.category_id)) throw invalid('Unknown category')
  const existing = get<{ company_name: string }>(db, 'SELECT company_name FROM candidate_pool WHERE domain = ?', domain)
  if (existing) throw new AppError(409, 'duplicate', `${domain} is already a candidate (${existing.company_name})`)
  const crm = get<{ company_name: string }>(db, 'SELECT company_name FROM prospects WHERE domain = ?', domain)
  if (crm) throw new AppError(409, 'duplicate', `${domain} is already in the CRM as ${crm.company_name}`)
  const now = nowIso()
  const { lastId } = run(db, `INSERT INTO candidate_pool (company_name, website, domain, category_id, origin, added_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    name, website, domain, input.category_id, origin, now, now)
  logActivity(db, 'pool.added', `Added research candidate ${name} (${domain})`)
  return get(db, 'SELECT * FROM candidate_pool WHERE id = ?', lastId)
}

// Makes a researched or excluded candidate available again (e.g. a site that was down).
export function releasePoolCandidate(db: DB, id: number) {
  const row = get<{ status: string; company_name: string }>(db, 'SELECT status, company_name FROM candidate_pool WHERE id = ?', id)
  if (!row) throw notFound('Candidate')
  if (row.status === 'queued') throw new AppError(409, 'busy', 'This candidate is in a running batch')
  run(db, "UPDATE candidate_pool SET status = 'available', updated_at = ? WHERE id = ?", nowIso(), id)
  logActivity(db, 'pool.released', `${row.company_name} is available for research again`)
}

export function excludePoolCandidate(db: DB, id: number, note: string) {
  const row = get<{ status: string; company_name: string }>(db, 'SELECT status, company_name FROM candidate_pool WHERE id = ?', id)
  if (!row) throw notFound('Candidate')
  if (row.status === 'queued') throw new AppError(409, 'busy', 'This candidate is in a running batch')
  run(db, "UPDATE candidate_pool SET status = 'excluded', note = ?, updated_at = ? WHERE id = ?", note.trim() || null, nowIso(), id)
  logActivity(db, 'pool.excluded', `Excluded ${row.company_name} from research`)
}

// Picks candidates from enabled categories: higher-priority categories first, and categories that share a
// priority take turns, so a batch is a mix rather than one category. Never more than a category's quota.
// Never pads the batch: if there are fewer candidates than requested, the shortfall is recorded.
export function createBatch(db: DB, input: { size: number; categoryIds?: number[] }) {
  if (!BATCH_SIZES.includes(input.size as BatchSize)) throw invalid(`Batch size must be one of ${BATCH_SIZES.join(', ')}`)
  if (get(db, "SELECT 1 FROM research_batches WHERE status IN ('queued', 'running')")) throw new AppError(409, 'busy', 'A research batch is already running. Wait for it or cancel it.')
  const cats = all<{ id: number; name: string; priority: number; research_quota: number }>(db,
    'SELECT id, name, priority, research_quota FROM categories WHERE enabled = 1 ORDER BY priority, sort_order')
    .filter((c) => !input.categoryIds?.length || input.categoryIds.includes(c.id))
  if (!cats.length) throw invalid('No enabled categories selected')

  type Pick = { id: number; company_name: string; website: string; domain: string; category_id: number }
  const queues = new Map(cats.map((c) => [c.id, all<Pick>(db, `SELECT cp.id, cp.company_name, cp.website, cp.domain, cp.category_id FROM candidate_pool cp
    WHERE cp.category_id = ? AND ${AVAILABLE} ORDER BY cp.origin = 'seed', cp.id LIMIT ?`, c.id, c.research_quota)]))
  const picks: Pick[] = []
  for (const priority of [...new Set(cats.map((c) => c.priority))]) {
    const group = cats.filter((c) => c.priority === priority)
    let added = true
    while (added && picks.length < input.size) {
      added = false
      for (const c of group) {
        const next = queues.get(c.id)!.shift()
        if (next && picks.length < input.size) {
          picks.push(next)
          added = true
        }
      }
    }
  }
  const perCategory = cats.map((c) => `${c.name}: ${picks.filter((p) => p.category_id === c.id).length}`)
  if (!picks.length) throw new AppError(409, 'empty', 'No unresearched candidates are available in the selected categories. Add candidates or raise quotas.')
  const shortfall = picks.length < input.size
    ? `Only ${picks.length} of ${input.size} queued (${perCategory.join(', ')}). Limited by available candidates and per-category quotas; add candidates or raise quotas in Settings → Categories.`
    : null

  return tx(db, () => {
    const now = nowIso()
    const batchId = run(db, `INSERT INTO research_batches (requested_size, category_ids, status, shortfall_note, ai_provider, created_at) VALUES (?, ?, 'queued', ?, ?, ?)`,
      input.size, JSON.stringify(cats.map((c) => c.id)), shortfall, getSetting<string>(db, 'ai.provider'), now).lastId
    for (const p of picks) {
      run(db, `INSERT INTO research_candidates (batch_id, pool_id, company_name, website, domain, category_id) VALUES (?, ?, ?, ?, ?, ?)`,
        batchId, p.id, p.company_name, p.website, p.domain, p.category_id)
      run(db, "UPDATE candidate_pool SET status = 'queued', updated_at = ? WHERE id = ?", now, p.id)
    }
    logActivity(db, 'research.batch_created', `Queued research batch #${batchId}: ${picks.length} brands${shortfall ? ` (requested ${input.size})` : ''}`)
    return getBatch(db, batchId)
  })
}

const COUNTS = `
  (SELECT count(*) FROM research_candidates rc WHERE rc.batch_id = b.id) AS total,
  (SELECT count(*) FROM research_candidates rc WHERE rc.batch_id = b.id AND rc.status IN ('pending', 'researching')) AS remaining,
  (SELECT count(*) FROM research_candidates rc WHERE rc.batch_id = b.id AND rc.status = 'done') AS done,
  (SELECT count(*) FROM research_candidates rc WHERE rc.batch_id = b.id AND rc.status = 'duplicate') AS duplicates,
  (SELECT count(*) FROM research_candidates rc WHERE rc.batch_id = b.id AND rc.status IN ('unreachable', 'blocked', 'failed')) AS problems`

export interface BatchRow {
  id: number
  requested_size: number
  category_ids: string
  status: 'queued' | 'running' | 'completed' | 'cancelled' | 'failed'
  shortfall_note: string | null
  ai_provider: string
  created_at: string
  started_at: string | null
  finished_at: string | null
  total: number
  remaining: number
  done: number
  duplicates: number
  problems: number
}

export interface BatchCandidateRow {
  id: number
  batch_id: number
  pool_id: number
  company_name: string
  website: string
  domain: string
  category_id: number
  category_name: string
  status: string
  attempts: number
  prospect_id: number | null
  message: string | null
  fit_score: number | null
  review_status: string | null
}

export const listBatches = (db: DB) => all<BatchRow>(db, `SELECT b.*, ${COUNTS} FROM research_batches b ORDER BY b.id DESC LIMIT 50`)

export function getBatch(db: DB, id: number) {
  const batch = get<BatchRow>(db, `SELECT b.*, ${COUNTS} FROM research_batches b WHERE b.id = ?`, id)
  if (!batch) throw notFound('Batch')
  const candidates = all<BatchCandidateRow>(db, `SELECT rc.*, c.name AS category_name, p.fit_score, p.review_status FROM research_candidates rc
    JOIN categories c ON c.id = rc.category_id LEFT JOIN prospects p ON p.id = rc.prospect_id WHERE rc.batch_id = ? ORDER BY rc.id`, id)
  return { batch, candidates }
}

export function cancelBatch(db: DB, id: number) {
  const b = get<{ status: string }>(db, 'SELECT status FROM research_batches WHERE id = ?', id)
  if (!b) throw notFound('Batch')
  if (!['queued', 'running'].includes(b.status)) throw new AppError(409, 'finished', 'This batch has already finished')
  tx(db, () => {
    const now = nowIso()
    run(db, `UPDATE candidate_pool SET status = 'available', updated_at = ? WHERE id IN
      (SELECT pool_id FROM research_candidates WHERE batch_id = ? AND status = 'pending')`, now, id)
    run(db, "UPDATE research_candidates SET status = 'cancelled', finished_at = ? WHERE batch_id = ? AND status = 'pending'", now, id)
    run(db, "UPDATE research_batches SET status = 'cancelled', finished_at = ? WHERE id = ?", now, id)
    logActivity(db, 'research.batch_cancelled', `Cancelled research batch #${id}`)
  })
  return getBatch(db, id)
}
