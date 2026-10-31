import { describe, expect, it } from 'vitest'
import { evaluateEligibility, type EligibilityInput } from '../packages/core/eligibility'

const now = new Date('2026-10-30T12:00:00Z')
const base = (over: Partial<EligibilityInput> = {}, contact: Partial<EligibilityInput['contact']> = {}): EligibilityInput => ({
  contact: {
    email: 'partnerships@brand.com',
    source_url: 'https://brand.com/partners',
    verification_status: 'verified',
    verified_at: '2026-10-20T00:00:00Z',
    jurisdiction: 'US',
    ...contact,
  },
  prospect: { domain: 'brand.com', stage: 'qualified' },
  suppressedEmail: false,
  suppressedDomain: false,
  freshnessDays: 90,
  autoJurisdictions: ['US'],
  now,
  ...over,
})

describe('contact verification and outreach eligibility', () => {
  it('is eligible only when verified, sourced, fresh, unsuppressed and in an allowed jurisdiction', () => {
    expect(evaluateEligibility(base()).status).toBe('eligible')
  })

  it('requires a source URL', () => {
    const r = evaluateEligibility(base({}, { source_url: null }))
    expect(r.status).toBe('needs_review')
    expect(r.reasons.join()).toMatch(/source/i)
  })

  it('requires verification', () => {
    expect(evaluateEligibility(base({}, { verification_status: 'unverified', verified_at: null })).status).toBe('needs_review')
    expect(evaluateEligibility(base({}, { verification_status: 'failed' })).status).toBe('ineligible')
  })

  it('treats stale verification as needing review (research freshness)', () => {
    const r = evaluateEligibility(base({}, { verified_at: '2026-06-01T00:00:00Z' }))
    expect(r.status).toBe('needs_review')
    expect(r.reasons.join()).toMatch(/older than 90 days/)
  })

  it('sends unknown or non-allowed jurisdictions to manual review', () => {
    expect(evaluateEligibility(base({}, { jurisdiction: 'unknown' })).status).toBe('needs_review')
    expect(evaluateEligibility(base({}, { jurisdiction: 'CA' })).status).toBe('needs_review')
  })

  it('blocks suppressed emails and domains', () => {
    expect(evaluateEligibility(base({ suppressedEmail: true })).status).toBe('ineligible')
    expect(evaluateEligibility(base({ suppressedDomain: true })).status).toBe('ineligible')
  })

  it('blocks companies that replied, opted out, are negotiating or paused', () => {
    for (const stage of ['replied', 'negotiating', 'opted_out', 'not_interested', 'paused', 'won'] as const) {
      expect(evaluateEligibility(base({ prospect: { domain: 'brand.com', stage } })).status).toBe('ineligible')
    }
  })

  it('routes contact-form-only contacts away from email', () => {
    expect(evaluateEligibility(base({}, { email: null })).status).toBe('ineligible')
  })

  it('flags an email on a different domain than the company', () => {
    const r = evaluateEligibility(base({}, { email: 'brand@agency.com' }))
    expect(r.status).toBe('needs_review')
  })
})
