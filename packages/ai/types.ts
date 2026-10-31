export type ProviderId = 'mock' | 'ollama' | 'anthropic'

// How a call is paid for. Only 'paid_api' ever costs money beyond existing subscriptions.
export type Billing = 'free_mock' | 'free_local' | 'paid_api'

// routine: research, drafting, classification (cheap model). premium: complex tasks only.
export type ModelTier = 'routine' | 'premium'

export interface AIRequest {
  purpose: string              // e.g. 'draft_email', 'classify_reply', 'test'
  system?: string
  prompt: string
  maxOutputTokens: number
  tier?: ModelTier
  cache?: boolean              // default true
}

export interface ProviderResult {
  text: string
  model: string
  inputTokens: number
  outputTokens: number
}

export interface AIProvider {
  id: ProviderId
  billing: Billing
  model(tier: ModelTier): string
  generate(req: AIRequest, model: string): Promise<ProviderResult>
}

export interface AIResult extends ProviderResult {
  provider: ProviderId
  billing: Billing
  costUsd: number
  cached: boolean
}

export class AIBlockedError extends Error {
  code = 'ai_blocked'
}

// Rough token estimate (≈4 characters per token) used for budgeting before a call is made.
export const estimateTokens = (s: string) => Math.ceil(s.length / 4)
