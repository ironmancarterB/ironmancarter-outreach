// Decides whether a contact could ever be emailed automatically. Pure function: the caller supplies
// suppression lookups and settings. Anything uncertain lands in "needs_review", never "eligible".
import { emailDomain } from './normalize'
import { OUTREACH_BLOCKING_STAGES, type StageId } from './stages'

export type EligibilityStatus = 'eligible' | 'needs_review' | 'ineligible'

export interface EligibilityInput {
  contact: {
    email: string | null
    source_url: string | null
    verification_status: 'unverified' | 'verified' | 'failed'
    verified_at: string | null
    jurisdiction: string
  }
  prospect: { domain: string | null; stage: StageId }
  suppressedEmail: boolean
  suppressedDomain: boolean
  freshnessDays: number
  autoJurisdictions: string[]
  now?: Date
}

export interface EligibilityResult {
  status: EligibilityStatus
  reasons: string[]
}

export function evaluateEligibility(input: EligibilityInput): EligibilityResult {
  const { contact, prospect } = input
  const blockers: string[] = []
  const review: string[] = []

  if (!contact.email) blockers.push('No email address (contact form only, so it goes to the manual queue)')
  if (input.suppressedEmail) blockers.push('Email address is on the suppression list')
  if (input.suppressedDomain) blockers.push('Company domain is on the suppression list')
  if (OUTREACH_BLOCKING_STAGES.includes(prospect.stage)) blockers.push(`Company is in the "${prospect.stage.replace(/_/g, ' ')}" stage`)
  if (contact.verification_status === 'failed') blockers.push('Contact verification failed')

  if (!contact.source_url) review.push('No source URL showing where this contact was published')
  if (contact.verification_status === 'unverified') review.push('Contact has not been verified')
  if (contact.verification_status === 'verified') {
    const at = contact.verified_at ? new Date(contact.verified_at) : null
    const ageDays = at ? ((input.now ?? new Date()).getTime() - at.getTime()) / 86_400_000 : Infinity
    if (!(ageDays <= input.freshnessDays)) review.push(`Verification is older than ${input.freshnessDays} days`)
  }
  if (!input.autoJurisdictions.includes(contact.jurisdiction)) {
    review.push(contact.jurisdiction === 'unknown'
      ? 'Recipient jurisdiction is unknown'
      : `Jurisdiction ${contact.jurisdiction} requires manual review`)
  }
  if (contact.email && prospect.domain && emailDomain(contact.email) !== prospect.domain) {
    review.push('Email domain differs from the company domain (agency or third party?)')
  }

  if (blockers.length) return { status: 'ineligible', reasons: [...blockers, ...review] }
  if (review.length) return { status: 'needs_review', reasons: review }
  return { status: 'eligible', reasons: ['Verified, sourced, fresh, not suppressed, auto-eligible jurisdiction'] }
}
