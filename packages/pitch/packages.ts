// Sponsorship packages you can offer in pitches. Prices are your exploratory ranges; a pitch only
// mentions them when you choose to include rates.
import { all, get, logActivity, nowIso, run, type DB, type Param } from '../db'
import { invalid, notFound } from '../core/errors'
import type { Package } from './facts'

export const listPackages = (db: DB) => all<Package & { sort_order: number; updated_at: string }>(db, 'SELECT * FROM sponsorship_packages ORDER BY sort_order')

export function updatePackage(db: DB, id: number, input: Partial<Pick<Package, 'name' | 'deliverables' | 'price_min_cents' | 'price_max_cents' | 'price_unit' | 'notes'> & { active: boolean; recurring: boolean }>) {
  const before = get<Package>(db, 'SELECT * FROM sponsorship_packages WHERE id = ?', id)
  if (!before) throw notFound('Package')
  const cols: Record<string, Param> = {}
  for (const k of ['name', 'deliverables'] as const) {
    if (input[k] !== undefined) {
      const s = String(input[k] ?? '').trim()
      if (!s) throw invalid(`${k} cannot be empty`)
      cols[k] = s.slice(0, 300)
    }
  }
  for (const k of ['price_min_cents', 'price_max_cents'] as const) {
    if (input[k] !== undefined) {
      const v = input[k]
      if (v !== null && (!Number.isInteger(v) || v < 0)) throw invalid('Prices must be whole cents, 0 or more')
      cols[k] = v
    }
  }
  const min = 'price_min_cents' in cols ? cols.price_min_cents : before.price_min_cents
  const max = 'price_max_cents' in cols ? cols.price_max_cents : before.price_max_cents
  if (min != null && max != null && (max as number) < (min as number)) throw invalid('The maximum price must be at least the minimum')
  if (input.price_unit !== undefined) {
    if (!['flat', 'per_month', 'custom'].includes(input.price_unit)) throw invalid('Unknown price unit')
    cols.price_unit = input.price_unit
  }
  if (input.active !== undefined) cols.active = input.active ? 1 : 0
  if (input.recurring !== undefined) cols.recurring = input.recurring ? 1 : 0
  if (input.notes !== undefined) cols.notes = input.notes?.trim() || null
  if (!Object.keys(cols).length) return before
  cols.updated_at = nowIso()
  const keys = Object.keys(cols)
  run(db, `UPDATE sponsorship_packages SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => cols[k]), id)
  logActivity(db, 'package.updated', `Updated package ${before.name}`, { data: input })
  return get<Package>(db, 'SELECT * FROM sponsorship_packages WHERE id = ?', id)!
}
