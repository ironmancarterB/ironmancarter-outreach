import { describe, expect, it } from 'vitest'
import { all, get } from '../packages/db'
import {
  addContact, addNote, createProspect, deleteProspect, findDuplicates, getProspectDetail, listProspects, setStage, setTags,
  updateContact, updateProspect,
} from '../packages/crm/prospects'
import { isEmailSuppressed } from '../packages/crm/suppressions'
import { freshDb } from './helpers'

const brand = (db: ReturnType<typeof freshDb>, name = 'Logitech G', website = 'https://www.logitechg.com') =>
  createProspect(db, { company_name: name, website, category_id: 1 })

describe('brand deduplication', () => {
  it('blocks a second company on the same domain, however the URL is written', () => {
    const db = freshDb()
    brand(db)
    expect(() => brand(db, 'Logi', 'http://logitechg.com/en-us')).toThrow(/same domain/)
    expect(() => brand(db, 'Logi Shop', 'shop.logitechg.com')).toThrow(/same domain/)
  })

  it('blocks reuse of a contact email across companies', () => {
    const db = freshDb()
    const a = brand(db)
    addContact(db, a.id, { email: 'Partners@LogitechG.com' })
    const b = brand(db, 'Other Co', 'other.com')
    expect(() => addContact(db, b.id, { email: 'partners@logitechg.com' })).toThrow(/already a contact for Logitech G/)
    expect(() => createProspect(db, { company_name: 'Third' }, { contactEmails: ['partners@logitechg.com'] })).toThrow(/same email/)
  })

  it('asks for confirmation when only the name is similar', () => {
    const db = freshDb()
    brand(db, 'HyperX', 'hyperx.com')
    expect(() => createProspect(db, { company_name: 'HyperX Gaming LLC' })).toThrow(/similar name/)
    expect(createProspect(db, { company_name: 'HyperX Gaming LLC' }, { allowSimilarName: true }).id).toBeGreaterThan(0)
  })

  it('blocks changing a website to a domain already in the CRM', () => {
    const db = freshDb()
    brand(db)
    const b = brand(db, 'Razer', 'razer.com')
    expect(() => updateProspect(db, b.id, { website: 'logitechg.com' })).toThrow(/same domain/)
  })

  it('reports every kind of match', () => {
    const db = freshDb()
    const a = brand(db)
    addContact(db, a.id, { email: 'partners@logitechg.com' })
    const reasons = findDuplicates(db, { domain: 'logitechg.com', emails: ['partners@logitechg.com'], name: 'Logitech G' }).map((d) => d.reason)
    expect(reasons).toEqual(['domain', 'email'])
  })
})

describe('CRM records', () => {
  it('requires an explanation for every fit score', () => {
    const db = freshDb()
    const p = brand(db)
    expect(() => updateProspect(db, p.id, { fit_breakdown: { audience: 20 } })).toThrow(/explanation/)
    const u = updateProspect(db, p.id, { fit_breakdown: { audience: 20, evidence: 20, recurring: 15, product: 12, contact: 5, integration: 4 }, fit_explanation: 'Sponsors LoL creators' })
    expect(u.fit_score).toBe(76)
  })

  it('logs stage changes in the activity history', () => {
    const db = freshDb()
    const p = brand(db)
    setStage(db, p.id, 'researching', 'started')
    setStage(db, p.id, 'qualified')
    const types = getProspectDetail(db, p.id).activities.map((a) => a.summary)
    expect(types).toContain('Discovered → Researching')
    expect(types).toContain('Researching → Qualified')
  })

  it('does not allow approving for autopilot by hand', () => {
    const db = freshDb()
    const p = brand(db)
    expect(() => setStage(db, p.id, 'approved_autopilot')).toThrow(/Autopilot is not available/)
  })

  it('suppresses every address when a company opts out', () => {
    const db = freshDb()
    const p = brand(db)
    addContact(db, p.id, { email: 'a@logitechg.com' })
    addContact(db, p.id, { email: 'b@logitechg.com' })
    setStage(db, p.id, 'opted_out')
    expect(isEmailSuppressed(db, 'a@logitechg.com')).toBe(true)
    expect(isEmailSuppressed(db, 'B@logitechg.com')).toBe(true)
    expect(all(db, "SELECT * FROM suppressions WHERE source = 'opt_out'")).toHaveLength(2)
  })

  it('only marks a contact verified when it has a source, and resets verification when the email changes', () => {
    const db = freshDb()
    const p = brand(db)
    const c = addContact(db, p.id, { email: 'partners@logitechg.com' })
    expect(() => updateContact(db, c.id, { verification_status: 'verified' })).toThrow(/source URL/)
    updateContact(db, c.id, { source_url: 'https://logitechg.com/partners' })
    const v = updateContact(db, c.id, { verification_status: 'verified' })
    expect(v.verification_status).toBe('verified')
    expect(v.verified_at).toBeTruthy()
    const changed = updateContact(db, c.id, { email: 'creators@logitechg.com' })
    expect(changed.verification_status).toBe('unverified')
    expect(changed.verified_at).toBeNull()
  })

  it('requires an email or a contact form', () => {
    const db = freshDb()
    const p = brand(db)
    expect(() => addContact(db, p.id, { name: 'Someone' })).toThrow(/email address or a contact form/)
    expect(addContact(db, p.id, { contact_form_url: 'logitechg.com/contact' }).contact_form_url).toBe('https://logitechg.com/contact')
  })

  it('searches, filters and sorts', () => {
    const db = freshDb()
    const a = brand(db)
    const b = createProspect(db, { company_name: 'NordVPN', website: 'nordvpn.com', category_id: 8 })
    updateProspect(db, b.id, { fit_breakdown: { audience: 25, evidence: 25, recurring: 20, product: 10 }, fit_explanation: 'x' })
    setTags(db, a.id, ['Peripherals', 'priority'])
    addNote(db, a.id, 'Met at a con')
    expect(listProspects(db, { q: 'nord' }).map((p) => p.company_name)).toEqual(['NordVPN'])
    expect(listProspects(db, { tag: 'PRIORITY' }).map((p) => p.id)).toEqual([a.id])
    expect(listProspects(db, { category_id: 8 }).map((p) => p.id)).toEqual([b.id])
    expect(listProspects(db, { tier: 'A' }).map((p) => p.id)).toEqual([b.id])
    expect(listProspects(db, { sort: 'name', dir: 'asc' }).map((p) => p.company_name)).toEqual(['Logitech G', 'NordVPN'])
    expect(listProspects(db, { sort: 'score' })[0].company_name).toBe('NordVPN')
  })

  it('deletes contacts, notes and tags with the company but keeps the audit record', () => {
    const db = freshDb()
    const p = brand(db)
    addContact(db, p.id, { email: 'x@logitechg.com' })
    setTags(db, p.id, ['t'])
    deleteProspect(db, p.id)
    expect(get(db, 'SELECT count(*) AS n FROM contacts')).toEqual({ n: 0 })
    expect(get(db, 'SELECT count(*) AS n FROM tags')).toEqual({ n: 0 })
    expect(get<{ summary: string }>(db, "SELECT summary FROM activities WHERE type = 'prospect.deleted'")?.summary).toBe('Deleted Logitech G')
  })
})
