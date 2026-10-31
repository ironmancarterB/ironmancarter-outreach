// Classifies what kind of creator program a brand runs, from recorded evidence only.
// "Paid" is claimed only when a source actually mentions payment; otherwise compensation is unknown.
export type ProgramType = 'paid_sponsorship' | 'creator_partnerships' | 'affiliate_only' | 'unknown'

export const PROGRAM_LABELS: Record<ProgramType, string> = {
  paid_sponsorship: 'Paid creator sponsorships',
  creator_partnerships: 'Creator partnerships (pay not stated)',
  affiliate_only: 'Affiliate program only (commission)',
  unknown: 'No creator program found',
}

export interface EvidenceItem {
  signal: string            // SIGNAL_LABELS key, e.g. 'creator_program'
  snippet: string | null
}

const PAID = /\b(paid (partnerships?|sponsorships?|collaborations?|campaigns?)|get paid|we pay|compensat\w+|flat[- ]fee|sponsorship (deals?|opportunit\w+|program))\b/i
const CREATOR = ['creator_program', 'ambassador_program', 'influencer_mentions', 'esports_sponsorship', 'partnership_inquiries']

export function classifyProgram(evidence: EvidenceItem[]): { type: ProgramType; basis: string } {
  const signals = new Set(evidence.map((e) => e.signal))
  const paid = evidence.find((e) => e.snippet && PAID.test(e.snippet))
  if (paid) return { type: 'paid_sponsorship', basis: `A source mentions payment: "${paid.snippet!.slice(0, 140)}"` }
  const creator = CREATOR.filter((s) => signals.has(s))
  if (creator.length) return { type: 'creator_partnerships', basis: `Evidence of ${creator.map((s) => s.replace(/_/g, ' ')).join(', ')}; no source says whether it is paid.` }
  if (signals.has('affiliate_program')) return { type: 'affiliate_only', basis: 'Only an affiliate (commission) program was found. Pitch a paid sponsorship rather than joining the affiliate program.' }
  return { type: 'unknown', basis: 'No creator, sponsorship or affiliate program found in the recorded research.' }
}

// Higher = draft first. Brands with demonstrated creator partnerships and a verified mailbox lead.
export function outreachPriority(fitScore: number | null, type: ProgramType, hasVerifiedEmail: boolean): number {
  const bonus = { paid_sponsorship: 15, creator_partnerships: 10, affiliate_only: -5, unknown: -10 }[type]
  return (fitScore ?? 40) + bonus + (hasVerifiedEmail ? 5 : 0)
}
