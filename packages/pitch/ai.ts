// Optional local-AI pitch writing (Ollama). The model only sees numbered verified facts and must cite
// them as [F1], [F2]… Its draft is used only if every citation is valid and it passes the same checks
// as any pitch; otherwise the template is used and the reason is recorded. Never a paid provider.
import { runAI, type RouterDeps } from '../ai/router'
import type { DB } from '../db'
import type { Claim, ClaimSource } from './claims'
import { runChecks } from './checks'
import { applySignature } from './signature'
import type { Facts } from './facts'
import { millions, periodText, usdRange, type Draft } from './template'

interface NumberedFact {
  text: string
  kind: Claim['kind']
  sources: ClaimSource[]
}

export function numberFacts(f: Facts): NumberedFact[] {
  const out: NumberedFact[] = []
  const add = (text: string, kind: Claim['kind'], sources: ClaimSource[]) => out.push({ text, kind, sources })
  add('Sender: IronmanCarter, a comedic League of Legends and gaming creator on YouTube Shorts, Instagram Reels, TikTok and Twitch. All content is gaming.', 'creator', [{ type: 'creator', note: 'Your content description' }])
  const { igViews: ig, ytViews: yt, igAge } = f.metrics
  for (const m of [ig, yt]) {
    if (m) add(`Between ${periodText(m)}, IronmanCarter's ${m.platform === 'instagram' ? 'Instagram' : 'YouTube'} videos got about ${millions(m.value)} views (write it exactly as "${millions(m.value)}").`, 'metric',
      [{ type: 'metric', id: m.id, label: m.label, platform: m.platform, value: m.value, period: m.period_label, as_of: m.as_of, source: m.source }])
  }
  if (igAge) add(`About ${Math.round(igAge.value)}% of IronmanCarter's Instagram audience is aged 18–34.`, 'metric',
    [{ type: 'metric', id: igAge.id, label: igAge.label, platform: igAge.platform, value: igAge.value, period: igAge.period_label, as_of: igAge.as_of, source: igAge.source }])
  for (const e of f.evidence.slice(0, 3)) {
    add(`${f.prospect.name}'s own website shows: ${e.label}. Exact text: "${e.snippet ?? e.label}"`, 'brand',
      [{ type: 'research', id: e.id, url: e.url, label: e.label, snippet: e.snippet, retrieved_at: e.retrieved_at }])
  }
  if (f.program.type === 'affiliate_only') add(`${f.prospect.name} only has an affiliate (commission) program; ask about a paid sponsorship instead.`, 'brand', [])
  if (f.prospect.concept) add(`Campaign idea to suggest: ${f.prospect.concept}`, 'concept', [{ type: 'concept', note: 'Campaign concept from your CRM record' }])
  const pkg = f.pkg
  const rate = f.options.custom_rate_text?.trim() || (f.options.include_rates && pkg ? usdRange(pkg.price_min_cents, pkg.price_max_cents) : null)
  if (pkg) add(`Offer: ${pkg.name} (${f.options.custom_deliverables?.trim() || pkg.deliverables})${rate ? `, rate ${rate}${pkg.price_unit === 'per_month' ? ' per month' : ''}` : ', do not mention any price'}.`, 'package', [{ type: 'package', id: pkg.id, name: pkg.name }])
  else add(`Goal: a recurring monthly partnership if a first video works well.${rate ? ` Rate: ${rate}.` : ' Do not mention any price.'}`, 'package', [])
  if (f.mediaKit) {
    add(f.options.channel === 'email' ? 'The media kit PDF is attached to the email.' : f.mediaKit.public_url ? `Media kit link: ${f.mediaKit.public_url}` : 'Offer to send the media kit.', 'media_kit',
      [{ type: 'media_kit', id: f.mediaKit.id, version: f.mediaKit.version }])
  }
  return out
}

const SYSTEM = `You write short sponsorship pitches for IronmanCarter, a gaming creator, in his own voice: friendly, direct, specific, like a real person, not a sales template.
Rules:
- Use ONLY the numbered facts. Never invent products, programs, past relationships, budgets, statistics or results.
- After each sentence that uses a fact, add its marker, e.g. [F2]. Sentences without facts get no marker.
- 100 to 140 words before the sign-off. No promises about views, sales or conversions. No prices unless a fact gives one.
- Do not use: "I hope this email finds you well", "I came across", "synergy", "leverage", "game-changer".
- Ask about a paid partnership, mention interest in a recurring arrangement, end with a simple question.
- Output exactly:
Subject: <accurate subject line>

<email body starting with a greeting>

<sign-off>`

export interface AiAttempt {
  draft: Draft | null
  model: string | null
  note: string
}

export async function writeWithLocalAI(db: DB, f: Facts, deps?: RouterDeps): Promise<AiAttempt> {
  const facts = numberFacts(f)
  const prompt = [
    `Brand: ${f.prospect.name}${f.prospect.categoryName ? ` (${f.prospect.categoryName})` : ''}`,
    `Channel: ${f.options.channel === 'email' ? 'email' : 'message pasted into a website contact form'}`,
    `Business email for the sign-off: ${f.business.email}`,
    'Facts:',
    ...facts.map((x, i) => `[F${i + 1}] ${x.text}`),
  ].join('\n')
  let text: string
  let model: string
  try {
    const r = await runAI(db, { purpose: 'pitch_draft', tier: 'routine', system: SYSTEM, prompt, maxOutputTokens: 500, cache: false }, deps)
    text = r.text
    model = r.model
  } catch (err) {
    return { draft: null, model: null, note: `Local AI unavailable (${(err as Error).message.slice(0, 140)}).` }
  }

  const m = text.match(/^\s*Subject:\s*(.+)\n([\s\S]+)$/i)
  if (!m) return { draft: null, model, note: 'Local AI did not follow the required format.' }
  const subject = m[1].trim().replace(/\s*\[F\d+\]/g, '')
  const raw = m[2].trim()

  // Map cited sentences to their facts, then remove the markers.
  const claims: Claim[] = []
  const bad: string[] = []
  for (const sentence of raw.split(/(?<=[.!?](?:\s*\[F\d+\])*)\s+|\n+/)) {
    const refs = [...sentence.matchAll(/\[F(\d+)\]/g)].map((x) => Number(x[1]))
    if (!refs.length) continue
    const clean = sentence.replace(/\s*\[F\d+\]/g, '').trim()
    const used = refs.map((n) => facts[n - 1])
    if (used.some((x) => !x)) { bad.push(...refs.filter((n) => !facts[n - 1]).map((n) => `F${n}`)); continue }
    claims.push({ sentence: clean, kind: used[0].kind, sources: used.flatMap((x) => x.sources) })
  }
  if (bad.length) return { draft: null, model, note: `Local AI cited facts that do not exist (${bad.join(', ')}).` }
  let body = raw.replace(/\s*\[F\d+\]/g, '').replace(/[ \t]+\n/g, '\n').trim()
  // Whatever sign-off the model wrote is replaced by your configured signature (never two).
  body = applySignature(body, f.business.signature)

  const { checks, wordCount } = runChecks(f, subject, body)
  const blockers = checks.filter((c) => c.level === 'blocker')
  if (blockers.length) return { draft: null, model, note: `Local AI draft failed checks (${blockers.map((b) => b.message).join(' ')}).` }
  if (wordCount < 80 || wordCount > 175) return { draft: null, model, note: `Local AI draft was ${wordCount} words.` }
  if (!claims.some((c) => c.kind === 'metric') || (f.evidence.length && !claims.some((c) => c.kind === 'brand'))) {
    return { draft: null, model, note: 'Local AI draft did not use your verified metrics and the brand evidence.' }
  }
  return { draft: { subject, body, claims }, model, note: `Written by local AI (${model}); every cited sentence maps to a verified fact.` }
}
