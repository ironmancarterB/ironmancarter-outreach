import { describe, expect, it } from 'vitest'
import { addContact, createProspect, getProspectDetail, setStage } from '../packages/crm/prospects'
import { addSuppression, isDomainSuppressed, isEmailSuppressed, listSuppressions, removeSuppression } from '../packages/crm/suppressions'
import { freshDb } from './helpers'

describe('opt-out suppression', () => {
  it('normalizes values and ignores repeats', () => {
    const db = freshDb()
    addSuppression(db, 'email', ' Someone@Brand.com ', 'asked')
    addSuppression(db, 'email', 'someone@brand.com', 'again')
    expect(listSuppressions(db)).toHaveLength(1)
    expect(isEmailSuppressed(db, 'SOMEONE@brand.com')).toBe(true)
    addSuppression(db, 'domain', 'https://www.brand.com/x', 'company-wide')
    expect(isDomainSuppressed(db, 'brand.com')).toBe(true)
    expect(isDomainSuppressed(db, 'anyone@brand.com')).toBe(true)
  })

  it('requires a reason and a valid value', () => {
    const db = freshDb()
    expect(() => addSuppression(db, 'email', 'nope', 'x')).toThrow(/valid email/)
    expect(() => addSuppression(db, 'email', 'a@b.com', '  ')).toThrow(/reason/)
  })

  it('never lets an opt-out be removed; manual entries can be', () => {
    const db = freshDb()
    const optOut = addSuppression(db, 'email', 'a@brand.com', 'replied unsubscribe', 'opt_out')
    const manual = addSuppression(db, 'email', 'b@brand.com', 'my choice')
    expect(() => removeSuppression(db, optOut.id)).toThrow(/cannot be removed/)
    removeSuppression(db, manual.id)
    expect(listSuppressions(db).map((s) => s.value)).toEqual(['a@brand.com'])
  })

  it('makes suppressed contacts ineligible', () => {
    const db = freshDb()
    const p = createProspect(db, { company_name: 'Brand', website: 'brand.com' })
    addContact(db, p.id, { email: 'partners@brand.com', source_url: 'https://brand.com/p', verification_status: 'verified', jurisdiction: 'US' })
    expect(getProspectDetail(db, p.id).contacts[0].eligibility.status).toBe('eligible')
    addSuppression(db, 'domain', 'brand.com', 'no contact')
    expect(getProspectDetail(db, p.id).contacts[0].eligibility.status).toBe('ineligible')
  })

  it('opting out a company blocks its contacts', () => {
    const db = freshDb()
    const p = createProspect(db, { company_name: 'Brand', website: 'brand.com' })
    addContact(db, p.id, { email: 'partners@brand.com', source_url: 'https://brand.com/p', verification_status: 'verified', jurisdiction: 'US' })
    setStage(db, p.id, 'opted_out')
    const [c] = getProspectDetail(db, p.id).contacts
    expect(c.eligibility.status).toBe('ineligible')
    expect(c.eligibility.reasons.join()).toMatch(/suppression list/)
  })
})
