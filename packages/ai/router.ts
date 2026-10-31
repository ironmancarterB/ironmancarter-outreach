// The single entry point for AI calls. Rules:
//  - Exactly one provider is used: the one selected in settings. There is NO fallback to another provider,
//    so a failing free/local provider can never cause a paid call.
//  - Paid calls require: paid AI switched on, verified prices, and room in the monthly budget ($0 by default).
//  - Identical requests are served from the cache.
//  - Every attempt, including blocked and failed ones, is written to the ai_usage ledger.
import { createHash } from 'node:crypto'
import { all, get, getSetting, nowIso, run, type DB } from '../db'
import { ANTHROPIC_PRICES, costUsd, type ModelPrice } from './pricing'
import { anthropicProvider, type AnthropicConfig } from './providers/anthropic'
import { mockProvider } from './providers/mock'
import { ollamaProvider, type OllamaConfig } from './providers/ollama'
import { AIBlockedError, estimateTokens, type AIProvider, type AIRequest, type AIResult, type Billing, type ProviderId } from './types'

export interface RouterDeps {
  providers?: Partial<Record<ProviderId, AIProvider>>
  prices?: Record<string, ModelPrice>
  now?: () => Date
}

export const PROVIDER_IDS: ProviderId[] = ['mock', 'ollama', 'anthropic']

export function buildProvider(db: DB, id: ProviderId, deps: RouterDeps = {}): AIProvider {
  const override = deps.providers?.[id]
  if (override) return override
  if (id === 'mock') return mockProvider
  if (id === 'ollama') return ollamaProvider(getSetting<OllamaConfig>(db, 'ai.ollama'))
  return anthropicProvider(getSetting<AnthropicConfig>(db, 'ai.anthropic'))
}

const monthStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString()

export function paidSpendThisMonth(db: DB, now = new Date()): number {
  return get<{ s: number | null }>(db,
    "SELECT sum(est_cost_usd) AS s FROM ai_usage WHERE billing = 'paid_api' AND status = 'ok' AND created_at >= ?", monthStart(now))?.s ?? 0
}

function record(db: DB, r: { provider: string; model: string; purpose: string; billing: Billing; status: string; input?: number; output?: number; cost?: number; detail?: string }) {
  run(db, `INSERT INTO ai_usage (provider, model, purpose, billing, status, input_tokens, output_tokens, est_cost_usd, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    r.provider, r.model, r.purpose, r.billing, r.status, r.input ?? 0, r.output ?? 0, r.cost ?? 0, r.detail ?? null, nowIso())
}

// Returns a reason string when a paid call must not happen, or null when it may proceed.
export function paidCallBlocker(db: DB, model: string, req: AIRequest, deps: RouterDeps = {}): string | null {
  if (!getSetting<boolean>(db, 'ai.paidEnabled')) return 'Paid AI is switched off (Settings → AI & costs)'
  const price = (deps.prices ?? ANTHROPIC_PRICES)[model]
  if (!price) return `No price on file for ${model}`
  if (!price.verifiedAt) return `Price for ${model} has not been verified against current published pricing`
  const budget = getSetting<number>(db, 'ai.monthlyBudgetUsd')
  const spent = paidSpendThisMonth(db, deps.now?.() ?? new Date())
  // 20% headroom: the input token count is only estimated before the call.
  const estimate = costUsd(price, estimateTokens((req.system ?? '') + req.prompt), req.maxOutputTokens) * 1.2
  if (spent + estimate > budget) {
    return `Monthly paid-AI budget would be exceeded ($${spent.toFixed(4)} spent + ~$${estimate.toFixed(4)} > $${budget.toFixed(2)} budget)`
  }
  return null
}

export async function runAI(db: DB, req: AIRequest, deps: RouterDeps = {}): Promise<AIResult> {
  const providerId = getSetting<ProviderId>(db, 'ai.provider')
  const provider = buildProvider(db, providerId, deps)
  const model = provider.model(req.tier ?? 'routine')
  const base = { provider: provider.id, model, purpose: req.purpose, billing: provider.billing }

  if (provider.billing === 'paid_api') {
    const blocker = paidCallBlocker(db, model, req, deps)
    if (blocker) {
      record(db, { ...base, status: 'blocked', detail: blocker })
      throw new AIBlockedError(blocker)
    }
  }

  const useCache = req.cache !== false
  const cacheKey = createHash('sha256').update(JSON.stringify([provider.id, model, req.system ?? '', req.prompt, req.maxOutputTokens])).digest('hex')
  const now = deps.now?.() ?? new Date()
  if (useCache) {
    const hit = get<{ response: string; input_tokens: number; output_tokens: number }>(db,
      'SELECT response, input_tokens, output_tokens FROM ai_cache WHERE cache_key = ? AND expires_at > ?', cacheKey, now.toISOString())
    if (hit) {
      record(db, { ...base, status: 'cached', detail: 'Served from cache; no provider call' })
      return { ...base, text: hit.response, inputTokens: hit.input_tokens, outputTokens: hit.output_tokens, costUsd: 0, cached: true }
    }
  }

  let result
  try {
    result = await provider.generate(req, model)
  } catch (err) {
    record(db, { ...base, status: 'error', detail: (err as Error).message.slice(0, 500) })
    throw err
  }
  const price = (deps.prices ?? ANTHROPIC_PRICES)[model]
  const cost = provider.billing === 'paid_api' && price ? costUsd(price, result.inputTokens, result.outputTokens) : 0
  record(db, { ...base, model: result.model, status: 'ok', input: result.inputTokens, output: result.outputTokens, cost })
  if (useCache) {
    const ttlDays = getSetting<number>(db, 'ai.cacheTtlDays')
    run(db, `INSERT OR REPLACE INTO ai_cache (cache_key, provider, model, response, input_tokens, output_tokens, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, cacheKey, provider.id, result.model, result.text, result.inputTokens, result.outputTokens,
      now.toISOString(), new Date(now.getTime() + ttlDays * 86_400_000).toISOString())
  }
  return { ...base, ...result, costUsd: cost, cached: false }
}

export function usageSummary(db: DB, now = new Date()) {
  const since = monthStart(now)
  const byBilling = all<{ billing: Billing; status: string; calls: number; input: number; output: number; cost: number }>(db, `
    SELECT billing, status, count(*) AS calls, sum(input_tokens) AS input, sum(output_tokens) AS output, sum(est_cost_usd) AS cost
    FROM ai_usage WHERE created_at >= ? GROUP BY billing, status ORDER BY billing, status`, since)
  const budget = getSetting<number>(db, 'ai.monthlyBudgetUsd')
  const spent = paidSpendThisMonth(db, now)
  return {
    monthStart: since,
    budgetUsd: budget,
    paidSpendUsd: spent,
    remainingUsd: Math.max(0, budget - spent),
    byBilling,
    recent: all<{ id: number; provider: string; model: string; purpose: string; billing: Billing; status: string; input_tokens: number; output_tokens: number; est_cost_usd: number; detail: string | null; created_at: string }>(db,
      'SELECT * FROM ai_usage ORDER BY id DESC LIMIT 25'),
  }
}
