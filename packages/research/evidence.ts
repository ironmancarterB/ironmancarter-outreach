// Detects published signals of creator partnerships and audience relevance in page text.
// Each finding keeps the URL and the exact sentence it came from, so it can be checked by hand.

export type Signal =
  | 'creator_program'
  | 'affiliate_program'
  | 'ambassador_program'
  | 'influencer_mentions'
  | 'partnership_inquiries'
  | 'esports_sponsorship'
  | 'gaming_audience'
  | 'streaming_audience'
  | 'league_of_legends'

export const SIGNAL_LABELS: Record<Signal, string> = {
  creator_program: 'Creator program',
  affiliate_program: 'Affiliate program',
  ambassador_program: 'Ambassador program',
  influencer_mentions: 'Mentions influencer partnerships',
  partnership_inquiries: 'Invites partnership inquiries',
  esports_sponsorship: 'Esports / team sponsorship',
  gaming_audience: 'Gaming audience',
  streaming_audience: 'Streaming / creator audience',
  league_of_legends: 'League of Legends',
}

const PATTERNS: [Signal, RegExp][] = [
  ['creator_program', /\b(creator (program|partner(ship)? program|fund|network|collective|hub)|content creator program|creators? (program|portal)|for creators|partner program for creators)\b/i],
  ['affiliate_program', /\b(affiliate (program|partners?|network|marketing)|become an affiliate|join (our|the) affiliate)\b/i],
  ['ambassador_program', /\b(ambassador program|brand ambassadors?|become an ambassador|ambassador team)\b/i],
  ['influencer_mentions', /\b(influencer (marketing|partnerships?|program|collaborations?|campaigns?)|work with influencers|influencers? (and|&) creators)\b/i],
  ['partnership_inquiries', /\b(partner with us|partnership (inquiries|enquiries|requests|opportunities)|sponsorship (inquiries|enquiries|requests|opportunities)|become a partner|collaborate with us)\b/i],
  ['esports_sponsorship', /\b(esports? (team|partner|sponsor\w*)|official (partner|sponsor) of|proud (partner|sponsor) of|sponsored (team|athletes?|players?))\b/i],
  ['gaming_audience', /\b(gaming|gamers?|esports?|fps|mmo|competitive play)\b/i],
  ['streaming_audience', /\b(streamers?|streaming|twitch|youtubers?|content creators?|live ?stream)\b/i],
  ['league_of_legends', /\b(league of legends|lol esports|riot games)\b/i],
]

export interface Finding {
  signal: Signal
  url: string
  snippet: string
}

// The sentence containing the match, trimmed to whole words and at most ~120 characters either side.
function sentenceAround(text: string, index: number, length: number) {
  const dot = text.lastIndexOf('. ', index)
  const sentenceStart = dot === -1 ? 0 : dot + 2
  let start = Math.max(sentenceStart, index - 120)
  const next = text.indexOf('. ', index + length)
  let end = Math.min(next === -1 ? text.length : next + 1, index + length + 120)
  // Snap cut points to word boundaries.
  if (start > sentenceStart) {
    const sp = text.indexOf(' ', start)
    if (sp !== -1 && sp < index) start = sp + 1
  }
  if (end < text.length && !/[.!?]/.test(text[end - 1])) {
    const sp = text.lastIndexOf(' ', end)
    if (sp > index + length) end = sp
  }
  const s = text.slice(start, end).trim()
  return `${start > sentenceStart ? '…' : ''}${s}${/[.!?]$/.test(s) || end >= text.length ? '' : '…'}`
}

export function detectSignals(text: string, url: string): Finding[] {
  const out: Finding[] = []
  for (const [signal, re] of PATTERNS) {
    const m = re.exec(text)
    if (m) out.push({ signal, url, snippet: sentenceAround(text, m.index, m[0].length) })
  }
  return out
}

// A dedicated program page on the brand's own site is evidence in itself.
const PAGE_SIGNALS: [RegExp, Signal][] = [
  [/creator|content-?creator/i, 'creator_program'],
  [/affiliate/i, 'affiliate_program'],
  [/ambassador/i, 'ambassador_program'],
  [/influencer/i, 'influencer_mentions'],
]

export function pageSignals(url: string, title: string | null): Finding[] {
  const path = new URL(url).pathname
  return PAGE_SIGNALS.filter(([re]) => re.test(path)).map(([, signal]) => ({ signal, url, snippet: `Dedicated page on the brand's site: "${title ?? path}"` }))
}

// Program pages first, then other subpages, then the homepage: evidence is credited to the most specific page.
export const evidencePriority = (url: string, homeUrl: string) =>
  url === homeUrl ? 2 : /creator|affiliate|ambassador|influencer|partner|sponsor/i.test(new URL(url).pathname) ? 0 : 1

// ---------- Choosing which pages to visit ----------

const PAGE_HINTS: [RegExp, number][] = [
  [/(creator|influencer|affiliate|sponsor)/i, 10],
  [/(ambassador|partner|collab)/i, 8],
  [/contact/i, 7],
  [/(press|media|business|marketing)/i, 6],
  [/about/i, 3],
]

// Common paths for partnership and contact pages, tried only when robots.txt allows.
export const COMMON_PATHS = ['/partners', '/affiliates', '/creators', '/influencers', '/ambassadors', '/sponsorship', '/contact', '/contact-us', '/pages/contact', '/press']

const SKIP = /\.(pdf|zip|png|jpe?g|gif|webp|svg|mp4|mov)$|\/(cart|checkout|account|login|signin|sign-in|register|search|cdn-cgi)\b/i

// Ranks same-site links by how likely they lead to partnership or contact information.
export function rankLinks(links: { url: string; text: string }[], sameSite: (url: string) => boolean): string[] {
  const scored = new Map<string, number>()
  for (const l of links) {
    if (!sameSite(l.url) || SKIP.test(new URL(l.url).pathname)) continue
    const hay = `${new URL(l.url).pathname} ${l.text}`
    let score = 0
    for (const [re, pts] of PAGE_HINTS) if (re.test(hay)) score = Math.max(score, pts)
    if (!score) continue
    const key = l.url.replace(/\/$/, '')
    scored.set(key, Math.max(scored.get(key) ?? 0, score))
  }
  // When the keyword is in the directory rather than the page name (/ambassadors/<name>, /collabs/<name>),
  // visit only one page from that directory so the page budget covers more ground.
  const seenDirs = new Set<string>()
  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)
    .filter(([u]) => {
      const parts = new URL(u).pathname.replace(/\/$/, '').split('/')
      const leaf = parts.pop() ?? ''
      if (PAGE_HINTS.some(([re]) => re.test(leaf))) return true
      const dir = parts.join('/')
      if (seenDirs.has(dir)) return false
      seenDirs.add(dir)
      return true
    })
    .map(([u]) => u)
}
