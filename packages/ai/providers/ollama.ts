// Local inference through Ollama (https://ollama.com). Runs on this Mac; free apart from electricity.
import type { AIProvider } from '../types'

export interface OllamaConfig {
  baseUrl: string
  model: string
}

const isLocal = (url: string) => {
  try {
    return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)
  } catch {
    return false
  }
}

export function ollamaProvider(cfg: OllamaConfig, fetchImpl: typeof fetch = fetch): AIProvider {
  return {
    id: 'ollama',
    billing: 'free_local',
    model: () => cfg.model,
    async generate(req, model) {
      // Refuse remote hosts: a remote "Ollama" could be a paid or third-party service.
      if (!isLocal(cfg.baseUrl)) throw new Error('Ollama must run on this computer (localhost)')
      const res = await fetchImpl(`${cfg.baseUrl.replace(/\/$/, '')}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          // Thinking models (e.g. gemma4) otherwise spend the whole token budget on hidden reasoning.
          think: false,
          options: { num_predict: req.maxOutputTokens },
          messages: [...(req.system ? [{ role: 'system', content: req.system }] : []), { role: 'user', content: req.prompt }],
        }),
        signal: AbortSignal.timeout(180_000),
      })
      if (!res.ok) throw new Error(`Ollama returned ${res.status}: ${(await res.text()).slice(0, 200)}`)
      const body = await res.json() as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number }
      return {
        text: body.message?.content ?? '',
        model,
        inputTokens: body.prompt_eval_count ?? 0,
        outputTokens: body.eval_count ?? 0,
      }
    },
  }
}

export async function ollamaStatus(cfg: OllamaConfig, fetchImpl: typeof fetch = fetch) {
  if (!isLocal(cfg.baseUrl)) return { reachable: false, models: [] as string[], error: 'Ollama must run on localhost' }
  try {
    const res = await fetchImpl(`${cfg.baseUrl.replace(/\/$/, '')}/api/tags`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return { reachable: false, models: [], error: `HTTP ${res.status}` }
    const body = await res.json() as { models?: { name: string }[] }
    return { reachable: true, models: (body.models ?? []).map((m) => m.name) }
  } catch (err) {
    return { reachable: false, models: [], error: (err as Error).message }
  }
}
