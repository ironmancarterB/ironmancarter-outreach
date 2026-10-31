// CSV import/export for the CRM. Imported contacts always start unverified: a CSV is not a source.
import { all, logActivity, type DB } from '../db'
import { AppError } from '../core/errors'
import { parseCsvObjects, toCsv } from '../core/csv'
import { isStage } from '../core/stages'
import { addContact, createProspect, listProspects, setTags, addNote } from './prospects'

export const CSV_COLUMNS = [
  'company_name', 'website', 'category', 'stage', 'products', 'sponsorship_evidence', 'campaign_concept',
  'potential_value_usd', 'negotiated_value_usd', 'tags', 'contact_name', 'contact_role', 'contact_email',
  'contact_source_url', 'contact_form_url', 'notes',
] as const

export function exportCsv(db: DB): string {
  const rows = listProspects(db, { sort: 'name', dir: 'asc' })
  const contacts = all<{ prospect_id: number; name: string | null; role: string | null; email: string | null; source_url: string | null; contact_form_url: string | null; verification_status: string }>(db,
    'SELECT prospect_id, name, role, email, source_url, contact_form_url, verification_status FROM contacts ORDER BY is_primary DESC, id')
  const primary = new Map<number, (typeof contacts)[number]>()
  for (const c of contacts) if (!primary.has(c.prospect_id)) primary.set(c.prospect_id, c)
  const usd = (c: number | null) => (c == null ? '' : (c / 100).toFixed(2))
  const header = ['id', 'domain', ...CSV_COLUMNS.filter((c) => c !== 'notes'), 'contact_verification', 'fit_score', 'fit_tier', 'fit_explanation', 'payment_status', 'renewal_date', 'created_at', 'updated_at']
  return toCsv(header, rows.map((p) => {
    const c = primary.get(p.id)
    return [
      p.id, p.domain, p.company_name, p.website, p.category_name, p.stage, p.products, p.sponsorship_evidence, p.campaign_concept,
      usd(p.potential_value_cents), usd(p.negotiated_value_cents), p.tags.join('; '), c?.name, c?.role, c?.email, c?.source_url,
      c?.contact_form_url, c?.verification_status, p.fit_score, p.fit_tier, p.fit_explanation, p.payment_status, p.renewal_date,
      p.created_at, p.updated_at,
    ]
  }))
}

export interface ImportRowResult {
  row: number
  company_name: string
  status: 'created' | 'duplicate' | 'possible_duplicate' | 'error'
  message?: string
  prospect_id?: number
}

const dollarsToCents = (s: string, field: string): number | null => {
  if (!s) return null
  const n = Number(s.replace(/[$,\s]/g, ''))
  if (!Number.isFinite(n) || n < 0) throw new AppError(400, 'invalid', `${field} is not a valid amount: ${s}`)
  return Math.round(n * 100)
}

// Imports row by row. With dryRun, every row is validated inside a transaction that is rolled back.
export function importCsv(db: DB, text: string, opts: { dryRun?: boolean } = {}): { results: ImportRowResult[]; created: number } {
  const rows = parseCsvObjects(text)
  if (!rows.length) throw new AppError(400, 'invalid', 'The CSV has no data rows')
  if (!('company_name' in rows[0])) throw new AppError(400, 'invalid', 'The CSV needs a company_name column')
  const categories = all<{ id: number; slug: string; name: string }>(db, 'SELECT id, slug, name FROM categories')
  const findCategory = (v: string) => {
    if (!v) return null
    const k = v.trim().toLowerCase()
    const c = categories.find((c) => c.slug === k || c.name.toLowerCase() === k)
    if (!c) throw new AppError(400, 'invalid', `Unknown category: ${v}`)
    return c.id
  }
  const results: ImportRowResult[] = []
  db.exec('BEGIN IMMEDIATE')
  try {
    rows.forEach((r, i) => {
      const rowNo = i + 2
      const name = r.company_name ?? ''
      db.exec('SAVEPOINT row')
      try {
        const stage = r.stage?.trim() || 'discovered'
        if (!isStage(stage)) throw new AppError(400, 'invalid', `Unknown stage: ${stage}`)
        if (stage === 'approved_autopilot') throw new AppError(400, 'invalid', 'Imports cannot approve companies for autopilot')
        const p = createProspect(db, {
          company_name: name,
          website: r.website || null,
          category_id: findCategory(r.category ?? ''),
          products: r.products || null,
          sponsorship_evidence: r.sponsorship_evidence || null,
          campaign_concept: r.campaign_concept || null,
          potential_value_cents: dollarsToCents(r.potential_value_usd ?? '', 'potential_value_usd'),
          negotiated_value_cents: dollarsToCents(r.negotiated_value_usd ?? '', 'negotiated_value_usd'),
          stage,
          source: 'csv',
        }, { contactEmails: [r.contact_email || null] })
        if (r.contact_email || r.contact_form_url) {
          addContact(db, p.id, {
            name: r.contact_name || null, role: r.contact_role || null, email: r.contact_email || null,
            source_url: r.contact_source_url || null, contact_form_url: r.contact_form_url || null, is_primary: true,
          })
        }
        if (r.tags) setTags(db, p.id, r.tags.split(/[;|]/))
        if (r.notes) addNote(db, p.id, r.notes)
        db.exec('RELEASE row')
        results.push({ row: rowNo, company_name: name, status: 'created', prospect_id: p.id })
      } catch (err) {
        db.exec('ROLLBACK TO row')
        db.exec('RELEASE row')
        const e = err as AppError
        const status = e.code === 'duplicate' || e.code === 'possible_duplicate' ? e.code : 'error'
        results.push({ row: rowNo, company_name: name, status, message: e.message })
      }
    })
    const created = results.filter((r) => r.status === 'created').length
    if (opts.dryRun) db.exec('ROLLBACK')
    else {
      logActivity(db, 'csv.imported', `Imported ${created} of ${results.length} CSV rows`)
      db.exec('COMMIT')
    }
    return { results, created }
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw err
  }
}
