// Evidence-based fit scoring. Every point traces back to something research recorded, and the
// explanation lists those facts. Categories set a baseline for audience and product fit; published
// creator programs and verified contacts move the score.
import type { FitBreakdown } from '../core/scoring'
import { scoreFit } from '../core/scoring'
import type { Signal } from './evidence'

// Baselines reflect IronmanCarter's audience: 18–34, mostly male, gaming and League of Legends.
const CATEGORY_BASE: Record<string, { audience: number; product: number; integration: number; recurringBase: number }> = {
  'gaming-peripherals': { audience: 20, product: 14, integration: 5, recurringBase: 6 },
  'pc-hardware': { audience: 18, product: 12, integration: 4, recurringBase: 4 },
  'gaming-software': { audience: 21, product: 14, integration: 5, recurringBase: 8 },
  'ai-tools': { audience: 13, product: 10, integration: 4, recurringBase: 8 },
  'creator-software': { audience: 15, product: 12, integration: 4, recurringBase: 8 },
  'productivity-tech': { audience: 10, product: 8, integration: 3, recurringBase: 6 },
  'energy-drinks': { audience: 15, product: 9, integration: 3, recurringBase: 6 },
  'vpn-privacy': { audience: 13, product: 9, integration: 3, recurringBase: 8 },
}

export interface ScoreInput {
  categorySlug: string
  categoryName: string
  signals: Set<Signal>
  bestEmailRank: number | null      // 1 = partnerships mailbox … 4 = general inbox
  hasContactForm: boolean
}

export interface ScoreResult {
  breakdown: FitBreakdown
  score: number
  explanation: string
}

const clamp = (v: number, max: number) => Math.max(0, Math.min(max, Math.round(v)))

export function scoreResearch(input: ScoreInput): ScoreResult {
  const base = CATEGORY_BASE[input.categorySlug] ?? { audience: 10, product: 8, integration: 3, recurringBase: 4 }
  const s = input.signals
  const why: string[] = []

  let audience = base.audience
  if (s.has('gaming_audience')) audience += 2
  if (s.has('streaming_audience')) audience += 2
  if (s.has('league_of_legends')) audience += 3
  const mentions = [s.has('gaming_audience') && 'gaming', s.has('streaming_audience') && 'streaming/creators', s.has('league_of_legends') && 'League of Legends'].filter(Boolean)
  why.push(`${input.categoryName} baseline for a gaming audience${mentions.length ? `; site mentions ${mentions.join(', ')}` : ''}.`)

  let evidence = 0
  const programs: string[] = []
  if (s.has('creator_program')) { evidence += 15; programs.push('creator program') }
  if (s.has('affiliate_program')) { evidence += 8; programs.push('affiliate program') }
  if (s.has('ambassador_program')) { evidence += 8; programs.push('ambassador program') }
  if (s.has('influencer_mentions')) { evidence += 6; programs.push('influencer partnerships') }
  if (s.has('esports_sponsorship')) { evidence += 5; programs.push('esports/team sponsorships') }
  if (s.has('partnership_inquiries')) { evidence += 3; programs.push('invites partnership inquiries') }
  why.push(programs.length ? `Published evidence: ${programs.join(', ')}.` : 'No published evidence of creator sponsorships found on the pages visited.')

  let recurring = base.recurringBase
  if (s.has('creator_program') || s.has('ambassador_program')) recurring += 8
  if (s.has('affiliate_program')) recurring += 4
  if (s.has('esports_sponsorship')) recurring += 2

  const product = base.product + (s.has('league_of_legends') ? 1 : 0)

  let contact = 0
  if (input.bestEmailRank != null) {
    contact = [10, 10, 8, 7, 5][input.bestEmailRank] ?? 5
    why.push(`Verified business email published on the company's own site${input.bestEmailRank <= 2 ? ' (partnership/creator mailbox)' : ''}.`)
  } else if (input.hasContactForm) {
    contact = 4
    why.push('Contact form only (manual contact queue).')
  } else {
    why.push('No published business contact found.')
  }

  const breakdown: FitBreakdown = {
    audience: clamp(audience, 25),
    evidence: clamp(evidence, 25),
    recurring: clamp(recurring, 20),
    product: clamp(product, 15),
    contact: clamp(contact, 10),
    integration: clamp(base.integration, 5),
  }
  return { breakdown, score: scoreFit(breakdown), explanation: why.join(' ') }
}

// Template concepts used when no local AI is selected. Deliberately generic; edit per brand.
export const CONCEPT_TEMPLATES: Record<string, string> = {
  'gaming-peripherals': 'Gear-in-action League of Legends short: a clutch play or challenge with the product visible and naturally called out, with a recurring monthly series option.',
  'pc-hardware': 'Setup/upgrade short built around a League of Legends session (performance before/after or build reveal), with a longer stream integration.',
  'gaming-software': 'Show the tool improving a real League of Legends game in a short (draft, build or replay insight), plus a stream segment using it live.',
  'ai-tools': 'Creative AI experiment short: use the tool to make something tied to a League of Legends moment and show the process honestly.',
  'creator-software': 'Behind-the-scenes short showing how the product fits the editing or streaming workflow, linked to a recurring tips series.',
  'productivity-tech': 'Day-in-the-life creator short showing where the product genuinely fits, kept light and comedic.',
  'energy-drinks': 'Late-night ranked session short with the product on desk, aimed at an adult audience and with no health or performance claims.',
  'vpn-privacy': 'Short on a real use case (e.g. safer public Wi-Fi while travelling to events), avoiding any anonymity or security guarantees.',
}
