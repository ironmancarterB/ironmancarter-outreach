import { describe, expect, it, vi } from 'vitest'
import { all, setSetting } from '../packages/db'
import type { ModelPrice } from '../packages/ai/pricing'
import { ollamaProvider } from '../packages/ai/providers/ollama'
import { runAI, usageSummary } from '../packages/ai/router'
import type { AIProvider } from '../packages/ai/types'
import { freshDb } from './helpers'

const req = { purpose: 'test', prompt: 'Say hi', maxOutputTokens: 100 }
const verified: Record<string, ModelPrice> = { 'paid-model': { inputPerMTok: 1, outputPerMTok: 5, verifiedAt: '2026-10-30', note: 'test' } }
const unverified: Record<string, ModelPrice> = { 'paid-model': { ...verified['paid-model'], verifiedAt: null } }

function fakePaid(): AIProvider & { calls: number } {
  const p = {
    id: 'anthropic' as const,
    billing: 'paid_api' as const,
    calls: 0,
    model: () => 'paid-model',
    // Like a real API: output never exceeds maxOutputTokens.
    async generate(r: { prompt: string; maxOutputTokens: number }) {
      p.calls++
      return { text: 'paid answer', model: 'paid-model', inputTokens: Math.ceil(r.prompt.length / 4), outputTokens: r.maxOutputTokens }
    },
  }
  return p
}

const ledger = (db: ReturnType<typeof freshDb>) => all<{ provider: string; billing: string; status: string; est_cost_usd: number }>(db,
  'SELECT provider, billing, status, est_cost_usd FROM ai_usage ORDER BY id')

describe('mock provider', () => {
  it('is the default, costs $0 and is deterministic', async () => {
    const db = freshDb()
    const a = await runAI(db, { ...req, cache: false })
    const b = await runAI(db, { ...req, cache: false })
    expect(a.provider).toBe('mock')
    expect(a.billing).toBe('free_mock')
    expect(a.costUsd).toBe(0)
    expect(a.text).toBe(b.text)
  })

  it('classifies obvious reply types offline', async () => {
    const db = freshDb()
    const r = await runAI(db, { purpose: 'classify_reply', prompt: 'Please remove me from your list', maxOutputTokens: 10 })
    expect(r.text).toBe('opt_out')
  })
})

describe('cache', () => {
  it('serves identical requests from the cache without calling the provider again', async () => {
    const db = freshDb()
    const gen = vi.fn(async () => ({ text: 'x', model: 'm', inputTokens: 1, outputTokens: 1 }))
    const provider: AIProvider = { id: 'mock', billing: 'free_mock', model: () => 'm', generate: gen }
    await runAI(db, req, { providers: { mock: provider } })
    const second = await runAI(db, req, { providers: { mock: provider } })
    expect(gen).toHaveBeenCalledTimes(1)
    expect(second.cached).toBe(true)
    expect(ledger(db).map((r) => r.status)).toEqual(['ok', 'cached'])
  })
})

describe('paid AI guard ($0 by default)', () => {
  it('blocks paid calls while paid AI is off, and logs the attempt', async () => {
    const db = freshDb()
    setSetting(db, 'ai.provider', 'anthropic')
    const paid = fakePaid()
    await expect(runAI(db, req, { providers: { anthropic: paid }, prices: verified })).rejects.toThrow(/switched off/)
    expect(paid.calls).toBe(0)
    expect(ledger(db)).toEqual([{ provider: 'anthropic', billing: 'paid_api', status: 'blocked', est_cost_usd: 0 }])
  })

  it('blocks paid calls when prices are unverified, even if enabled with a budget', async () => {
    const db = freshDb()
    setSetting(db, 'ai.provider', 'anthropic')
    setSetting(db, 'ai.paidEnabled', true)
    setSetting(db, 'ai.monthlyBudgetUsd', 50)
    const paid = fakePaid()
    await expect(runAI(db, req, { providers: { anthropic: paid }, prices: unverified })).rejects.toThrow(/not been verified/)
    expect(paid.calls).toBe(0)
  })

  it('blocks paid calls with a $0 budget', async () => {
    const db = freshDb()
    setSetting(db, 'ai.provider', 'anthropic')
    setSetting(db, 'ai.paidEnabled', true)
    const paid = fakePaid()
    await expect(runAI(db, req, { providers: { anthropic: paid }, prices: verified })).rejects.toThrow(/budget would be exceeded/)
    expect(paid.calls).toBe(0)
  })

  it('tracks cost and stops once the budget is exhausted', async () => {
    const db = freshDb()
    setSetting(db, 'ai.provider', 'anthropic')
    setSetting(db, 'ai.paidEnabled', true)
    setSetting(db, 'ai.monthlyBudgetUsd', 0.001) // each call: 1 input + 100 output tokens ≈ $0.000501
    const paid = fakePaid()
    const deps = { providers: { anthropic: paid }, prices: verified }
    const first = await runAI(db, { ...req, prompt: 'one' }, deps)
    expect(first.costUsd).toBeCloseTo(0.000501, 6)
    await expect(runAI(db, { ...req, prompt: 'two' }, deps)).rejects.toThrow(/budget/)
    expect(paid.calls).toBe(1)
    const summary = usageSummary(db)
    expect(summary.paidSpendUsd).toBeCloseTo(0.000501, 6)
    expect(summary.paidSpendUsd).toBeLessThanOrEqual(0.001)
  })

  it('never falls back to another provider when the selected one fails', async () => {
    const db = freshDb()
    setSetting(db, 'ai.provider', 'ollama')
    const paid = fakePaid()
    const mockGen = vi.fn()
    const broken: AIProvider = { id: 'ollama', billing: 'free_local', model: () => 'local', generate: async () => { throw new Error('Ollama is not running') } }
    await expect(runAI(db, req, { providers: { ollama: broken, anthropic: paid, mock: { id: 'mock', billing: 'free_mock', model: () => 'm', generate: mockGen } } }))
      .rejects.toThrow(/not running/)
    expect(paid.calls).toBe(0)
    expect(mockGen).not.toHaveBeenCalled()
    expect(ledger(db)).toEqual([{ provider: 'ollama', billing: 'free_local', status: 'error', est_cost_usd: 0 }])
  })
})

describe('ollama provider', () => {
  it('calls the local chat API and reads token counts', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: { content: 'hello' }, prompt_eval_count: 12, eval_count: 3 })))
    const p = ollamaProvider({ baseUrl: 'http://127.0.0.1:11434', model: 'gemma4:12b' }, fetchImpl as unknown as typeof fetch)
    const r = await p.generate({ ...req, system: 'sys' }, 'gemma4:12b')
    expect(r).toEqual({ text: 'hello', model: 'gemma4:12b', inputTokens: 12, outputTokens: 3 })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:11434/api/chat')
    expect(JSON.parse(init.body as string).messages[0]).toEqual({ role: 'system', content: 'sys' })
  })

  it('refuses non-local hosts', async () => {
    const fetchImpl = vi.fn()
    const p = ollamaProvider({ baseUrl: 'https://ollama.example.com', model: 'x' }, fetchImpl as unknown as typeof fetch)
    await expect(p.generate(req, 'x')).rejects.toThrow(/localhost/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
