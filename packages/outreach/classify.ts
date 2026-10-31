// Classifies brand replies. Conservative: one clear signal → that category; none or conflicting signals →
// "unclear" for you to decide. Local AI (Ollama, only when selected) must quote the reply word for word to
// justify its choice, or its answer is ignored. Nothing here replies to anyone or changes a deal.
import { getSetting, type DB } from '../db'
import { runAI, type RouterDeps } from '../ai/router'

export const CATEGORIES = {
  interested: 'Interested',
  needs_info: 'Needs more information',
  negotiating: 'Negotiating',
  not_interested: 'Not interested',
  out_of_office: 'Out of office',
  wrong_contact: 'Wrong contact',
  referral: 'Referral to another contact',
  unclear: 'Unclear response',
} as const
export type Category = keyof typeof CATEGORIES
export const isCategory = (v: unknown): v is Category => typeof v === 'string' && Object.hasOwn(CATEGORIES, v)

export interface Classification {
  category: Category
  source: 'rules' | 'ollama'
  note: string
  optOut: boolean
}

const RULES: [Exclude<Category, 'unclear'>, RegExp][] = [
  ['out_of_office', /\b(out of (the )?office|on (vacation|holiday|leave|pto)|away (from the office )?until|limited access to (my )?email|auto(matic)?[- ]?reply)\b/i],
  ['wrong_contact', /\b(not the right (person|contact|team)|no longer (with|at|work)|wrong (person|contact|department)|doesn'?t handle|don'?t handle (this|partnerships|sponsorships))\b/i],
  ['referral', /\b(reach out to|contact (my|our) colleague|forward(ed|ing)? (this|your (email|note|message)) to|loop(ing|ed)? in|cc'?(ing|ed)?|please (email|contact) [\w.+-]+@)\b/i],
  ['not_interested', /\b(not interested|not a (good )?fit|no budget|not (currently )?(looking|working with|accepting)|(we('ll)?|i('ll)?) pass\b|not at this time|decline|no thank(s| you))\b/i],
  ['negotiating', /\b(counter|our budget (is|would be)|we can (offer|do) \$|rate (is|would be) too|lower (the )?(rate|price)|usage rights|exclusivity|net ?\d{2}|contract terms)\b/i],
  ['needs_info', /\b(what (are|is) your (rates?|pricing|price)|send (over )?(your |the )?(rates|pricing|media kit|more (info|information|details))|more (info|information|details)|could you (share|send)|do you have (a )?(media kit|rate card)|audience (breakdown|demographics))\b/i],
  ['interested', /\b(interested|love to (chat|work|connect|partner)|sounds (great|good|interesting)|let'?s (chat|talk|set up|schedule|connect)|happy to (chat|connect|discuss)|would like to (move forward|work together|discuss))\b/i],
]

const OPT_OUT = /\b(unsubscribe|remove me|take me off|stop (emailing|contacting|sending)|do not (email|contact)|don'?t (email|contact) (me|us))\b/i

// The new part of a reply, without quoted history or the signature block below it.
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  for (const line of lines) {
    if (/^\s*>/.test(line)) break
    if (/^On .+wrote:\s*$/i.test(line.trim()) || /^-{2,}\s*Original Message\s*-{2,}/i.test(line.trim()) || /^From: .+/.test(line.trim()) && out.length > 0) break
    out.push(line)
  }
  return out.join('\n').trim()
}

export function classifyByRules(text: string, autoSubmitted = false): Classification {
  const optOut = OPT_OUT.test(text)
  if (autoSubmitted) return { category: 'out_of_office', source: 'rules', note: 'Marked by the sender’s mail system as an automatic reply.', optOut }
  const hits = RULES.filter(([, re]) => re.test(text)).map(([c]) => c)
  // "Interested" phrasing inside a decline ("not interested") is not interest.
  const set = new Set(hits)
  if (set.has('not_interested')) set.delete('interested')
  if (set.has('referral') && set.has('wrong_contact')) set.delete('wrong_contact')
  const cats = [...set]
  if (optOut && !cats.length) return { category: 'not_interested', source: 'rules', note: 'Asked not to be contacted again.', optOut }
  if (cats.length === 1) {
    const match = text.match(RULES.find(([c]) => c === cats[0])![1])?.[0]
    return { category: cats[0], source: 'rules', note: `Matched the phrase “${match}”.`, optOut }
  }
  return {
    category: 'unclear', source: 'rules', optOut,
    note: cats.length ? `Mixed signals (${cats.map((c) => CATEGORIES[c]).join(', ')}); please classify it yourself.` : 'No clear signal; please classify it yourself.',
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim()

// Local AI classification (Ollama only). The quote must appear in the reply, so the model cannot invent meaning.
export async function classifyReply(db: DB, text: string, opts: { autoSubmitted?: boolean; ai?: RouterDeps } = {}): Promise<Classification> {
  const rules = classifyByRules(text, opts.autoSubmitted)
  if (opts.autoSubmitted || getSetting<string>(db, 'ai.provider') !== 'ollama' || !text.trim()) return rules
  const prompt = [
    'Classify this reply from a brand to a creator\'s sponsorship pitch into exactly one category:',
    Object.entries(CATEGORIES).map(([k, v]) => `- ${k}: ${v}`).join('\n'),
    'Use "unclear" if the reply does not clearly fit one category. Do not guess.',
    'Answer with JSON only: {"category": "<key>", "quote": "<the exact words from the reply that justify it>"}',
    '',
    'Reply:',
    '"""',
    text.slice(0, 4000),
    '"""',
  ].join('\n')
  try {
    const r = await runAI(db, { purpose: 'classify_reply', prompt, maxOutputTokens: 200, cache: true }, opts.ai)
    const json = JSON.parse(r.text.slice(r.text.indexOf('{'), r.text.lastIndexOf('}') + 1)) as { category?: unknown; quote?: unknown }
    if (!isCategory(json.category)) throw new Error('unknown category')
    if (json.category === 'unclear') return { ...rules, category: 'unclear', source: 'ollama', note: 'Local AI found no clear category; please classify it yourself.' }
    if (typeof json.quote !== 'string' || json.quote.trim().length < 3 || !norm(text).includes(norm(json.quote))) throw new Error('quote not found in the reply')
    return { category: json.category, source: 'ollama', note: `Local AI (${r.model}) cited “${json.quote.trim().slice(0, 200)}”.`, optOut: rules.optOut }
  } catch (err) {
    return { ...rules, note: `${rules.note} (Local AI answer not usable: ${(err as Error).message}.)` }
  }
}
