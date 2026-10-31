import { describe, expect, it } from 'vitest'
import { get } from '../packages/db'
import { parseCsv, toCsv } from '../packages/core/csv'
import { exportCsv, importCsv } from '../packages/crm/csvio'
import { addContact, createProspect, listProspects } from '../packages/crm/prospects'
import { freshDb } from './helpers'

const HEADER = 'company_name,website,category,stage,potential_value_usd,tags,contact_email,contact_source_url,notes'

describe('CSV parsing', () => {
  it('handles quotes, commas and newlines inside fields', () => {
    expect(parseCsv('a,b\r\n"x, y","line1\nline2 ""quoted"""\n')).toEqual([['a', 'b'], ['x, y', 'line1\nline2 "quoted"']])
  })
  it('neutralizes spreadsheet formulas on export', () => {
    expect(toCsv(['h'], [['=HYPERLINK("x")'], ['+1']])).toBe('h\r\n"\'=HYPERLINK(""x"")"\r\n\'+1\r\n')
  })
})

describe('CSV import/export', () => {
  it('dry run validates without writing anything', () => {
    const db = freshDb()
    const r = importCsv(db, `${HEADER}\nRazer,razer.com,gaming-peripherals,qualified,1500,a;b,partners@razer.com,https://razer.com/p,hello\n`, { dryRun: true })
    expect(r.created).toBe(1)
    expect(listProspects(db)).toHaveLength(0)
    expect(get(db, 'SELECT count(*) AS n FROM activities')).toEqual({ n: 0 })
  })

  it('imports rows, skips duplicates and reports errors per row', () => {
    const db = freshDb()
    createProspect(db, { company_name: 'Razer', website: 'razer.com' })
    const csv = [
      HEADER,
      'Razer Inc,https://www.razer.com,,,,,,,',
      'Corsair,corsair.com,PC Hardware,discovered,2000.50,"hw; priority",creators@corsair.com,https://corsair.com/creators,first note',
      'Bad Stage Co,bad.com,,won-ish,,,,,',
      'Sneaky,sneaky.com,,approved_autopilot,,,,,',
    ].join('\n')
    const r = importCsv(db, csv, { dryRun: false })
    expect(r.results.map((x) => x.status)).toEqual(['duplicate', 'created', 'error', 'error'])
    expect(r.results[3].message).toMatch(/cannot approve/)
    const corsair = listProspects(db, { q: 'corsair' })[0]
    expect(corsair.potential_value_cents).toBe(200050)
    expect(corsair.tags).toEqual(['hw', 'priority'])
    expect(corsair.primary_email).toBe('creators@corsair.com')
    expect(get(db, "SELECT verification_status FROM contacts WHERE email = 'creators@corsair.com'")).toEqual({ verification_status: 'unverified' })
  })

  it('round-trips an export into a fresh database', () => {
    const a = freshDb()
    const p = createProspect(a, { company_name: 'Elgato', website: 'elgato.com', category_id: 5, potential_value_cents: 75000 })
    addContact(a, p.id, { email: 'partners@elgato.com', source_url: 'https://elgato.com/partners', is_primary: true })
    const csv = exportCsv(a)
    const b = freshDb()
    const r = importCsv(b, csv, { dryRun: false })
    expect(r.created).toBe(1)
    const [row] = listProspects(b)
    expect(row).toMatchObject({ company_name: 'Elgato', domain: 'elgato.com', category_name: 'Creator Software', potential_value_cents: 75000, primary_email: 'partners@elgato.com' })
  })

  it('requires a company_name column', () => {
    expect(() => importCsv(freshDb(), 'name\nX\n')).toThrow(/company_name/)
  })
})
