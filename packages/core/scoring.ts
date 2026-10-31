// Sponsorship fit score out of 100. A score never authorizes sending on its own.
export const FIT_FACTORS = [
  { key: 'audience', label: 'Audience relevance', max: 25 },
  { key: 'evidence', label: 'Evidence of creator sponsorships', max: 25 },
  { key: 'recurring', label: 'Recurring partnership potential', max: 20 },
  { key: 'product', label: 'Product fit', max: 15 },
  { key: 'contact', label: 'Verified contact availability', max: 10 },
  { key: 'integration', label: 'Authentic content integration potential', max: 5 },
] as const

export type FitFactor = (typeof FIT_FACTORS)[number]['key']
export type FitBreakdown = Partial<Record<FitFactor, number>>

export function scoreFit(breakdown: FitBreakdown): number {
  let total = 0
  for (const f of FIT_FACTORS) {
    const v = breakdown[f.key] ?? 0
    if (!Number.isFinite(v) || v < 0 || v > f.max) throw new RangeError(`${f.label} must be between 0 and ${f.max}`)
    total += v
  }
  return Math.round(total)
}

export type FitTier = 'A' | 'B' | 'C'

export function fitTier(score: number | null | undefined): FitTier | null {
  if (score == null) return null
  if (score >= 80) return 'A'
  if (score >= 60) return 'B'
  return 'C'
}
