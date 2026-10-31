// Deterministic pitch writer: plain, specific, creator-voiced sentences assembled only from verified facts.
// Used when no local AI is selected, and as the fallback when local AI output is poor or unavailable.
import { isTemplateConcept } from '../research/score'
import type { Claim, ClaimSource } from './claims'
import type { EvidenceFact, Facts, MetricFact } from './facts'

export interface Draft {
  subject: string
  body: string
  claims: Claim[]
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const day = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number)
  return { text: `${MONTHS[m - 1]} ${d}`, year: y }
}

export function periodText(m: MetricFact): string {
  if (m.period_start && m.period_end) {
    const a = day(m.period_start), b = day(m.period_end)
    return a.year === b.year ? `${a.text} and ${b.text}, ${b.year}` : `${a.text}, ${a.year} and ${b.text}, ${b.year}`
  }
  return `the last ${m.period_label ?? 'reporting period'}`
}

export const millions = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n))

export const usdRange = (min: number | null, max: number | null) => {
  const f = (c: number) => `$${(c / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
  if (min != null && max != null) return `${f(min)}–${f(max)}`
  if (min != null) return `from ${f(min)}`
  return null
}

const metricSource = (m: MetricFact): ClaimSource => ({
  type: 'metric', id: m.id, label: m.label, platform: m.platform, value: m.value, period: m.period_label, as_of: m.as_of, source: m.source,
})
const researchSource = (e: EvidenceFact): ClaimSource => ({ type: 'research', id: e.id, url: e.url, label: e.label, snippet: e.snippet, retrieved_at: e.retrieved_at })

// Stable per-company choice between phrasings, so pitches do not read identically.
const pick = <T>(variants: T[], seed: number) => variants[Math.abs(seed * 2654435761) % variants.length]

const FIT: Record<string, string> = {
  'gaming-peripherals': 'gear like yours shows up on camera naturally',
  'pc-hardware': 'hardware like yours is part of the setup people already watch',
  'gaming-software': 'a tool like yours fits right into the games I already play on stream',
  'ai-tools': 'AI tools like yours make for genuinely fun creative experiments on the channel',
  'creator-software': 'creator tools like yours are an honest fit for behind-the-scenes content',
  'productivity-tech': 'tech like yours can fit into my day-to-day videos without feeling forced',
  'energy-drinks': 'a drink like yours fits naturally into late-night ranked sessions',
  'vpn-privacy': 'a VPN like yours fits easily into my everyday streaming and travel content',
}

function brandSentence(f: Facts): Claim | null {
  const name = f.prospect.name
  const top = f.evidence[0]
  if (!top) return null
  if (f.program.type === 'affiliate_only') {
    const aff = f.evidence.find((e) => e.signal === 'affiliate_program') ?? top
    return { kind: 'brand', sentence: `I know ${name} has an affiliate program, but I'm reaching out about a paid sponsorship instead, since a dedicated integration suits my short-form videos better.`, sources: [researchSource(aff)] }
  }
  const lines: Record<string, string> = {
    creator_program: `I saw ${name} runs a creator program, so you already work with creators.`,
    influencer_mentions: `I saw ${name} partners with influencers and creators.`,
    ambassador_program: `I saw ${name} works with brand ambassadors.`,
    esports_sponsorship: `I saw ${name} already runs sponsorships.`,
    partnership_inquiries: `Your site invites partnership inquiries, so I wanted to reach out directly.`,
    affiliate_program: `I saw ${name} has an affiliate program.`,
  }
  return { kind: 'brand', sentence: lines[top.signal] ?? `I saw ${name} works with creators.`, sources: [researchSource(top)] }
}

// How each category's default idea reads inside a pitch (the stored concept is a planning note).
const PITCH_IDEAS: Record<string, string> = {
  'gaming-peripherals': 'a Short built around a clutch League play or challenge, with your gear on camera and called out naturally',
  'pc-hardware': 'a setup or upgrade Short tied to a League session, plus a stream segment showing the build',
  'gaming-software': 'a Short showing your tool helping in a real League of Legends game, plus a live segment on stream',
  'ai-tools': 'a creative experiment Short where I use your tool on a League moment and show the process honestly',
  'creator-software': 'a behind-the-scenes Short showing where it fits into making my videos',
  'productivity-tech': 'a light, comedic day-in-the-life Short showing where it genuinely fits',
  'energy-drinks': 'a late-night ranked session Short with the drink on my desk, aimed at my adult audience',
  'vpn-privacy': 'a Short built around a real use case, like gaming on hotel Wi-Fi while travelling to events',
}

// First sentence of your concept, without splitting on abbreviations like "e.g." or "i.e.".
export function firstSentence(text: string): string {
  const protectedText = text.replace(/\b(e\.g|i\.e|etc|vs)\./gi, (m) => m.replace(/\./g, '\u0000'))
  return protectedText.split(/(?<=[.!?])\s+/)[0].replace(/[.!?]+$/, '').replace(/\u0000/g, '.')
}

function conceptSentence(f: Facts): string {
  const concept = f.prospect.concept!
  const isTemplate = isTemplateConcept(concept)
  const idea = isTemplate && f.prospect.categorySlug && PITCH_IDEAS[f.prospect.categorySlug] ? PITCH_IDEAS[f.prospect.categorySlug] : firstSentence(concept)
  const firstWord = idea.split(/\s+/)[0]
  const keepCase = (firstWord.length > 1 && firstWord === firstWord.toUpperCase()) || idea.startsWith(f.prospect.name)
  return `Here's what I have in mind: ${keepCase ? idea : idea[0].toLowerCase() + idea.slice(1)}.`
}

// "influencers@" → "Hi Surfshark influencer team"; general inboxes get "Hi Surfshark team".
const TEAM_BY_MAILBOX: [RegExp, string][] = [
  [/^partner|^sponsor|^collab|^brandpartner/, 'partnerships'], [/^influencer/, 'influencer'], [/^creator/, 'creator'], [/^affiliate/, 'affiliate'],
  [/^ambassador/, 'ambassador'], [/^(press|pr|media)$/, 'press'], [/^(marketing|brand|brands|social|community)$/, 'marketing'], [/^esports|^gaming/, 'esports'],
]
const teamName = (email: string | null | undefined) => {
  const local = email?.split('@')[0].toLowerCase() ?? ''
  return TEAM_BY_MAILBOX.find(([re]) => re.test(local))?.[1] ?? null
}

export function writeTemplate(f: Facts): Draft {
  const name = f.prospect.name
  const seed = f.prospect.id
  const claims: Claim[] = []
  const say = (c: Claim | null) => {
    if (c) claims.push(c)
    return c?.sentence ?? ''
  }

  const team = f.options.channel === 'email' ? teamName(f.contact?.email) : null
  const greeting = `Hi ${name}${team ? ` ${team}` : ''} team,`

  const intro = say({
    kind: 'creator', sources: [{ type: 'creator', note: 'Your content description (media kit and brief)' }],
    sentence: pick([
      "I'm IronmanCarter, a League of Legends creator making comedic gaming Shorts, Reels and TikToks, plus Twitch streams.",
      "I'm IronmanCarter, and I make comedic League of Legends videos for Shorts, Reels and TikTok, plus Twitch streams.",
    ], seed),
  })

  const { igViews: ig, ytViews: yt, igAge } = f.metrics
  let metricLine = ''
  if (ig || yt) {
    const lead = ig ?? yt!
    const views = [ig && `${millions(ig.value)} Instagram views`, yt && `${millions(yt.value)} YouTube views`].filter(Boolean).join(' and ')
    const age = igAge ? `, and about ${Math.round(igAge.value)}% of my Instagram audience is 18–34` : ''
    const samePeriod = !ig || !yt || periodText(ig) === periodText(yt)
    const when = samePeriod ? `Between ${periodText(lead)}` : `Over the last ${lead.period_label}`
    metricLine = say({ kind: 'metric', sources: [ig, yt, igAge].filter(Boolean).map((m) => metricSource(m!)), sentence: `${when}, my videos picked up about ${views}${age}.` })
  }

  const brand = say(brandSentence(f))
  const fit = say({
    kind: 'creator', sources: [{ type: 'creator', note: 'Your content is gaming-focused (media kit)' }],
    sentence: `Since all of my content is gaming, ${FIT[f.prospect.categorySlug ?? ''] ?? 'your products could fit my videos naturally'}.`,
  })

  const concept = f.prospect.concept ? say({ kind: 'concept', sources: [{ type: 'concept', note: 'Campaign concept from your CRM record' }], sentence: conceptSentence(f) }) : ''

  const pkg = f.pkg
  const deliverables = f.options.custom_deliverables?.trim() || pkg?.deliverables || null
  const rate = f.options.custom_rate_text?.trim()
    || (f.options.include_rates && pkg ? (() => {
      const r = usdRange(pkg.price_min_cents, pkg.price_max_cents)
      return r ? `usually ${r}${pkg.price_unit === 'per_month' ? ' a month' : ''}` : null
    })() : null)
  const detail = [deliverables, rate].filter(Boolean).join(', ')
  let offer: string
  if (pkg?.recurring) offer = `I'd love to set this up as a ${pkg.name.toLowerCase()}${detail ? ` (${detail})` : ''} rather than a one-off.`
  else if (pkg) offer = `We could start with a ${pkg.name.toLowerCase()}${detail ? ` (${detail})` : ''} and turn it into a monthly series if it works well for you.`
  else offer = `If it works well, I'd love to make it a recurring monthly partnership${detail ? ` (${detail})` : ''}.`
  offer = say({ kind: 'package', sources: pkg ? [{ type: 'package', id: pkg.id, name: pkg.name }] : [{ type: 'creator', note: 'Your goal of recurring partnerships' }], sentence: offer })

  let kit = ''
  if (f.mediaKit) {
    const sentence = f.options.channel === 'email'
      ? "I've attached my media kit with the full numbers."
      : f.mediaKit.public_url ? `My media kit is here: ${f.mediaKit.public_url}` : "I'm happy to send over my media kit with the full numbers."
    kit = say({ kind: 'media_kit', sources: [{ type: 'media_kit', id: f.mediaKit.id, version: f.mediaKit.version }], sentence })
  }

  const cta = pick(['Would you be open to a quick chat about a paid partnership?', 'Would your team be up for a quick call about a paid sponsorship?'], seed + 1)

  const paragraphs = [
    greeting,
    [intro, metricLine].filter(Boolean).join(' '),
    [brand, fit].filter(Boolean).join(' '),
    [concept, offer].filter(Boolean).join(' '),
    [kit, cta].filter(Boolean).join(' '),
    f.business.signature,
  ].filter(Boolean)

  const subject = f.program.type === 'affiliate_only'
    ? `Paid sponsorship idea for ${name} from IronmanCarter`
    : f.evidence.length
      ? `${name} x IronmanCarter: sponsored League of Legends content`
      : `Creator partnership idea: IronmanCarter x ${name}`

  return { subject, body: paragraphs.join('\n\n'), claims }
}
