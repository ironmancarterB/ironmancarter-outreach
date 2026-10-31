// Paid Anthropic API provider: optional and disabled by default.
//
// Phase 1 deliberately ships without the Anthropic SDK and without any network call here. Claude Code's
// subscription usage (your Claude Pro plan) is unrelated to this provider: the API is billed separately,
// per token, to an API key. When paid AI is approved later, this file gains the real SDK call, still
// behind the router's budget guard.
import type { AIProvider } from '../types'

export interface AnthropicConfig {
  routineModel: string
  premiumModel: string
}

export function anthropicProvider(cfg: AnthropicConfig): AIProvider {
  return {
    id: 'anthropic',
    billing: 'paid_api',
    model: (tier) => (tier === 'premium' ? cfg.premiumModel : cfg.routineModel),
    async generate() {
      throw new Error('The paid Anthropic API integration is not installed. It will be added only after you approve paid AI.')
    },
  }
}
