// Creator analytics: figures IronmanCarter supplies, with their reporting periods. Never generated or estimated.
import { all, get, logActivity, nowIso, run, type DB, type Param } from '../db'
import { invalid, notFound } from '../core/errors'

export interface CreatorMetric {
  id: number
  platform: 'instagram' | 'youtube' | 'tiktok' | 'twitch' | 'combined'
  metric_key: string
  label: string
  value: number
  unit: 'count' | 'percent' | 'hours' | 'average'
  approximate: number
  period_label: string | null
  period_start: string | null
  period_end: string | null
  as_of: string
  source: string
  notes: string | null
  pitchable: number
  updated_at: string
}

export const listMetrics = (db: DB) => all<CreatorMetric>(db,
  "SELECT * FROM creator_metrics ORDER BY CASE platform WHEN 'instagram' THEN 1 WHEN 'youtube' THEN 2 WHEN 'tiktok' THEN 3 WHEN 'twitch' THEN 4 ELSE 5 END, id")

const DATEISH = /^\d{4}-\d{2}(-\d{2})?$/

export function updateMetric(db: DB, id: number, input: Partial<Pick<CreatorMetric, 'label' | 'value' | 'period_label' | 'period_start' | 'period_end' | 'as_of' | 'source' | 'notes'> & { approximate: boolean; pitchable: boolean }>) {
  const before = get<CreatorMetric>(db, 'SELECT * FROM creator_metrics WHERE id = ?', id)
  if (!before) throw notFound('Metric')
  const cols: Record<string, Param> = {}
  if (input.value !== undefined) {
    if (typeof input.value !== 'number' || !Number.isFinite(input.value) || input.value < 0) throw invalid('Value must be a number, 0 or more')
    if (before.unit === 'percent' && input.value > 100) throw invalid('A percentage cannot exceed 100')
    cols.value = input.value
  }
  for (const k of ['label', 'source'] as const) {
    if (input[k] !== undefined) {
      const s = String(input[k] ?? '').trim()
      if (!s) throw invalid(`${k} cannot be empty`)
      cols[k] = s.slice(0, 200)
    }
  }
  if (input.as_of !== undefined) {
    if (typeof input.as_of !== 'string' || !DATEISH.test(input.as_of)) throw invalid('"As of" must be YYYY-MM or YYYY-MM-DD')
    cols.as_of = input.as_of
  }
  for (const k of ['period_start', 'period_end'] as const) {
    if (input[k] !== undefined) {
      if (input[k] && !/^\d{4}-\d{2}-\d{2}$/.test(input[k]!)) throw invalid(`${k.replace('_', ' ')} must be YYYY-MM-DD`)
      cols[k] = input[k] || null
    }
  }
  if (input.period_label !== undefined) cols.period_label = input.period_label?.trim() || null
  if (input.notes !== undefined) cols.notes = input.notes?.trim() || null
  if (input.approximate !== undefined) cols.approximate = input.approximate ? 1 : 0
  if (input.pitchable !== undefined) cols.pitchable = input.pitchable ? 1 : 0
  if (!Object.keys(cols).length) return before
  cols.updated_at = nowIso()
  const keys = Object.keys(cols)
  run(db, `UPDATE creator_metrics SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => cols[k]), id)
  logActivity(db, 'metric.updated', `Updated ${before.platform} ${before.label}${before.period_label ? ` (${before.period_label})` : ''}`,
    { data: { before: before.value, after: cols.value ?? before.value } })
  return get<CreatorMetric>(db, 'SELECT * FROM creator_metrics WHERE id = ?', id)!
}
