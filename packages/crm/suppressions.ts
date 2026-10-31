import { all, get, nowIso, run, logActivity, type DB } from '../db'
import { AppError, invalid } from '../core/errors'
import { emailDomain, normalizeDomain, normalizeEmail } from '../core/normalize'

export type SuppressionKind = 'email' | 'domain'
export type SuppressionSource = 'manual' | 'opt_out' | 'bounce' | 'import'

export interface Suppression {
  id: number; kind: SuppressionKind; value: string; reason: string; source: SuppressionSource; created_at: string
}

export function addSuppression(db: DB, kind: SuppressionKind, rawValue: string, reason: string, source: SuppressionSource = 'manual') {
  const value = kind === 'email' ? normalizeEmail(rawValue) : normalizeDomain(rawValue)
  if (!value) throw invalid(`Not a valid ${kind}: ${rawValue}`)
  if (!reason.trim()) throw invalid('A reason is required')
  const existing = get<Suppression>(db, 'SELECT * FROM suppressions WHERE kind = ? AND value = ?', kind, value)
  if (existing) return existing
  const { lastId } = run(db, 'INSERT INTO suppressions (kind, value, reason, source, created_at) VALUES (?, ?, ?, ?, ?)',
    kind, value, reason.trim(), source, nowIso())
  logActivity(db, 'suppression.added', `Suppressed ${kind} ${value}`, { data: { reason, source } })
  return get<Suppression>(db, 'SELECT * FROM suppressions WHERE id = ?', lastId)!
}

export const listSuppressions = (db: DB) => all<Suppression>(db, 'SELECT * FROM suppressions ORDER BY created_at DESC')

// Opt-outs and bounces are permanent. Only entries added by hand can be removed.
export function removeSuppression(db: DB, id: number) {
  const row = get<Suppression>(db, 'SELECT * FROM suppressions WHERE id = ?', id)
  if (!row) throw new AppError(404, 'not_found', 'Suppression not found')
  if (row.source !== 'manual') throw new AppError(409, 'protected', `${row.source.replace('_', '-')} suppressions cannot be removed`)
  run(db, 'DELETE FROM suppressions WHERE id = ?', id)
  logActivity(db, 'suppression.removed', `Removed manual suppression for ${row.kind} ${row.value}`)
}

export function isEmailSuppressed(db: DB, email: string | null): boolean {
  const e = normalizeEmail(email)
  if (!e) return false
  return !!get(db, "SELECT 1 FROM suppressions WHERE kind = 'email' AND value = ?", e)
}

export function isDomainSuppressed(db: DB, domainOrEmail: string | null): boolean {
  const d = domainOrEmail?.includes('@') ? emailDomain(domainOrEmail) : normalizeDomain(domainOrEmail)
  if (!d) return false
  return !!get(db, "SELECT 1 FROM suppressions WHERE kind = 'domain' AND value = ?", d)
}
