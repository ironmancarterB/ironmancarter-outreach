// Deterministic offline provider for development and tests. Costs nothing and never touches the network.
import { createHash } from 'node:crypto'
import { estimateTokens, type AIProvider, type AIRequest } from '../types'

const CANNED: Record<string, (req: AIRequest) => string> = {
  classify_reply: (req) => {
    const t = req.prompt.toLowerCase()
    if (/unsubscribe|remove me|stop emailing|opt[ -]?out/.test(t)) return 'opt_out'
    if (/out of (the )?office|on vacation|limited access to email/.test(t)) return 'out_of_office'
    if (/rate|pricing|how much|budget/.test(t)) return 'wants_pricing'
    if (/not interested|no thanks|pass on this/.test(t)) return 'not_interested'
    if (/call|meeting|schedule|calendar/.test(t)) return 'wants_meeting'
    if (/media kit/.test(t)) return 'wants_media_kit'
    if (/interested|love to|sounds great/.test(t)) return 'interested'
    return 'unclear'
  },
}

export const mockProvider: AIProvider = {
  id: 'mock',
  billing: 'free_mock',
  model: (tier) => `mock-${tier}`,
  async generate(req, model) {
    const canned = CANNED[req.purpose]
    const digest = createHash('sha256').update(`${req.system ?? ''}\n${req.prompt}`).digest('hex').slice(0, 8)
    const text = canned
      ? canned(req)
      : `[MOCK ${req.purpose} · ${digest}] This is a placeholder response from the offline mock provider. ` +
        'No AI service was contacted and nothing was billed.'
    return { text, model, inputTokens: estimateTokens((req.system ?? '') + req.prompt), outputTokens: estimateTokens(text) }
  },
}
