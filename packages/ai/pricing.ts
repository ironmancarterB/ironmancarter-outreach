// Paid-API price table, in USD per million tokens. These figures are NOT trusted for spending decisions:
// `verifiedAt` stays null until IronmanCarter confirms current prices on anthropic.com/pricing, and the
// router refuses every paid call while any price it would need is unverified.
export interface ModelPrice {
  inputPerMTok: number
  outputPerMTok: number
  verifiedAt: string | null
  note: string
}

export const ANTHROPIC_PRICES: Record<string, ModelPrice> = {
  'claude-haiku-5-5': { inputPerMTok: 0.1, outputPerMTok: 0.5, verifiedAt: null, note: 'Unverified reference figure (Claude API skill, cached 2026-10-06)' },
  'claude-sonnet-5-5': { inputPerMTok: 2, outputPerMTok: 10, verifiedAt: null, note: 'Unverified reference figure (Claude API skill, cached 2026-10-06)' },
  'claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20, verifiedAt: null, note: 'Unverified reference figure (Claude API skill, cached 2026-10-06)' },
}

export function costUsd(price: ModelPrice, inputTokens: number, outputTokens: number): number {
  return (inputTokens * price.inputPerMTok + outputTokens * price.outputPerMTok) / 1_000_000
}
