// UGC-specific research on top of the shared pipeline: signals that a company uses (or would use) creator
// video, a lead score, and one or two video concepts built only from what its own site says.
// Every point and every concept records the fact behind it, so nothing is invented.
import type { FitBreakdown } from '../core/scoring'
import { scoreFit } from '../core/scoring'
import { normalizeDomain } from '../core/normalize'
import { decodeEntities, type ExtractedPage } from '../research/extract'
import type { Finding, Signal } from '../research/evidence'

export type UgcSignal =
  | 'tiktok' | 'youtube' | 'instagram'
  | 'video_marketing' | 'ugc_mentions' | 'mobile_app' | 'free_trial' | 'agency_services' | 'hiring_creators'

export const UGC_SIGNAL_LABELS: Record<UgcSignal, string> = {
  tiktok: 'On TikTok (linked from their site)',
  youtube: 'On YouTube (linked from their site)',
  instagram: 'On Instagram (linked from their site)',
  video_marketing: 'Uses video on their site (demo or product video)',
  ugc_mentions: 'Mentions UGC or creator content',
  mobile_app: 'Has a mobile app (App Store or Google Play link)',
  free_trial: 'Free plan or free trial (easy to demo on camera)',
  agency_services: 'Agency offering creator, influencer or paid-social work',
  hiring_creators: 'Recruits creators',
}

const TEXT_PATTERNS: [UgcSignal, RegExp][] = [
  ['video_marketing', /\b(watch (the|our|a) (video|demo)|video demo|demo video|product tour|see (it|how it works) in action|watch how)\b/i],
  ['ugc_mentions', /\b(ugc|user[- ]generated content|creator content|creator[- ]led|testimonial videos?)\b/i],
  ['free_trial', /\b(free trial|try (it )?(for )?free|start (for )?free|get started (for )?free|free plan|free forever|freemium|download (it )?for free)\b/i],
  ['agency_services', /\b(influencer marketing agency|ugc agency|creator marketing|influencer campaigns?|talent management|paid social|performance creative|creative production|creator partnerships)\b/i],
  ['hiring_creators', /\b(apply (as|to be) a creator|join our creator (network|roster|community)|become a creator|creator application|we('re| are) hiring creators|creators wanted)\b/i],
]

export interface UgcFinding { signal: UgcSignal; url: string; snippet: string }

const sentence = (text: string, i: number, len: number) => {
  const dot = text.lastIndexOf('. ', i)
  const start = dot === -1 ? 0 : dot + 2
  const end = text.indexOf('. ', i + len)
  const s = text.slice(Math.max(start, i - 120), end === -1 ? Math.min(text.length, i + len + 120) : Math.min(end + 1, i + len + 120)).trim()
  return s.length > 240 ? `${s.slice(0, 237)}…` : s
}

// Reads the pages research already fetched; no extra requests.
export function detectUgcSignals(pages: { url: string; page: ExtractedPage }[], siteDomain: string, categorySlug = 'ugc-agencies'): UgcFinding[] {
  const found = new Map<UgcSignal, UgcFinding>()
  const add = (f: UgcFinding) => { if (!found.has(f.signal)) found.set(f.signal, f) }
  for (const { url, page } of pages) {
    for (const l of page.links) {
      // Parse the URL directly: profile paths contain "@", which the domain helper treats as an email address.
      let u: URL
      try { u = new URL(l.url) } catch { continue }
      const host = normalizeDomain(u.hostname)
      if (!host || host === siteDomain) continue
      const path = u.pathname
      // A profile link (not a single shared video or the platform's homepage).
      if (host === 'tiktok.com' && /^\/@[\w.-]+\/?$/.test(path)) add({ signal: 'tiktok', url, snippet: l.url })
      if (host === 'youtube.com' && /^\/(@[\w.-]+|c\/[\w.-]+|channel\/[\w-]+|user\/[\w.-]+)\/?$/.test(path)) add({ signal: 'youtube', url, snippet: l.url })
      if (host === 'instagram.com' && /^\/[\w.]+\/?$/.test(path) && !/^\/(p|reel|explore|accounts)\//.test(path)) add({ signal: 'instagram', url, snippet: l.url })
      if ((host === 'apple.com' && /\/app\//.test(path)) || (host === 'google.com' && /^\/store\/apps/.test(path))) add({ signal: 'mobile_app', url, snippet: l.url })
    }
    const text = page.mainText || page.text
    for (const [signal, re] of TEXT_PATTERNS) {
      const m = re.exec(text)
      if (!m) continue
      // Outside agencies, offering "creator partnerships" means the company works with creators, not that it is an agency.
      const s = signal === 'agency_services' && categorySlug !== 'ugc-agencies'
        ? (/creator partnerships|influencer campaigns?|creator marketing/i.test(m[0]) ? 'hiring_creators' : null)
        : signal
      if (s) add({ signal: s, url, snippet: sentence(text, m.index, m[0].length) })
    }
  }
  return [...found.values()]
}

// Product relevance follows your category priority (AI tools first … agencies last); recurring and fit reflect the
// kind of work each category buys.
export const UGC_CATEGORY_BASE: Record<string, { relevance: number; fit: number; recurring: number; label: string; priority: number }> = {
  'ugc-ai-tools': { relevance: 24, fit: 14, recurring: 12, label: 'AI tool (demos show the product best)', priority: 1 },
  'ugc-saas': { relevance: 22, fit: 12, recurring: 12, label: 'SaaS product (walkthrough videos)', priority: 1 },
  'ugc-consumer-apps': { relevance: 21, fit: 11, recurring: 12, label: 'Consumer app (app-install and social ads)', priority: 2 },
  'ugc-gaming': { relevance: 21, fit: 15, recurring: 12, label: 'Gaming company (your core niche)', priority: 2 },
  'ugc-creator-tools': { relevance: 20, fit: 14, recurring: 12, label: 'Creator tool (you use this kind of tool)', priority: 2 },
  'ugc-tech-products': { relevance: 18, fit: 13, recurring: 8, label: 'Tech product (unboxing and first-use videos)', priority: 3 },
  'ugc-productivity': { relevance: 17, fit: 12, recurring: 11, label: 'Productivity software (workflow videos)', priority: 3 },
  'ugc-agencies': { relevance: 14, fit: 11, recurring: 10, label: 'Agency (hires creators for client work)', priority: 4 },
}
const CATEGORY = UGC_CATEGORY_BASE

export const UGC_FIT_LABELS: Record<string, string> = {
  audience: 'Product relevance',
  evidence: 'Evidence of video advertising',
  recurring: 'Opportunity for recurring work',
  product: 'Fit with your UGC experience',
  contact: 'Contact verification',
  integration: 'Likelihood of hiring external creators',
}

const clamp = (v: number, max: number) => Math.max(0, Math.min(max, Math.round(v)))

export function scoreUgc(input: { categorySlug: string; ugc: Set<UgcSignal>; shared: Set<Signal>; bestEmailRank: number | null; hasContactForm: boolean }) {
  const base = CATEGORY[input.categorySlug] ?? { relevance: 15, fit: 10, recurring: 8, label: 'Other' }
  const u = input.ugc, s = input.shared
  const why: string[] = [`${base.label}.`]

  let relevance = base.relevance + (u.has('free_trial') ? 2 : 0) + (u.has('mobile_app') ? 1 : 0)
  if (u.has('free_trial')) why.push('Free plan or trial, so it can be shown on camera without a sales call.')

  let evidence = 0
  const ev: string[] = []
  if (u.has('tiktok')) { evidence += 6; ev.push('TikTok') }
  if (u.has('youtube')) { evidence += 3; ev.push('YouTube') }
  if (u.has('instagram')) { evidence += 3; ev.push('Instagram') }
  if (u.has('video_marketing')) { evidence += 5; ev.push('product video on their site') }
  if (u.has('ugc_mentions')) { evidence += 8; ev.push('mentions UGC/creator content') }
  if (s.has('influencer_mentions')) { evidence += 4; ev.push('influencer partnerships') }
  if (s.has('creator_program')) { evidence += 4; ev.push('creator program') }
  why.push(ev.length ? `Video and creator evidence: ${ev.join(', ')}.` : 'No evidence of video marketing found on the pages visited.')

  let recurring = base.recurring
  if (s.has('creator_program') || s.has('affiliate_program') || s.has('ambassador_program')) recurring += 4
  if (u.has('ugc_mentions') || u.has('agency_services')) recurring += 4

  const hires = u.has('ugc_mentions') || u.has('hiring_creators') || u.has('agency_services') || s.has('influencer_mentions') || s.has('creator_program')
  const integration = hires ? 5 : s.has('affiliate_program') || s.has('ambassador_program') ? 3 : 1
  if (hires) why.push('Signs they already work with outside creators.')

  let contact = 0
  if (input.bestEmailRank != null) {
    contact = [10, 10, 9, 8, 6][input.bestEmailRank] ?? 6
    why.push('Business email published on their own site.')
  } else if (input.hasContactForm) {
    contact = 3
    why.push('Contact form only.')
  } else why.push('No published business email found yet.')

  const breakdown: FitBreakdown = {
    audience: clamp(relevance, 25),
    evidence: clamp(evidence, 25),
    recurring: clamp(recurring, 20),
    product: clamp(base.fit, 15),
    contact: clamp(contact, 10),
    integration: clamp(integration, 5),
  }
  return { breakdown, score: scoreFit(breakdown), explanation: why.join(' ') }
}

export interface Concept { title: string; outline: string; basis: string }

// A short, clean product description from the site's own words (meta description, else the title).
export function productLine(name: string, page: Pick<ExtractedPage, 'title' | 'description'>): string | null {
  const raw = decodeEntities(page.description || '').replace(/\s+/g, ' ').trim()
  const fromTitle = decodeEntities(page.title || '').split(/\s[|–—-]\s/).map((x) => x.trim()).find((x) => x && x.toLowerCase() !== name.toLowerCase())
  const text = raw.length >= 25 ? raw : fromTitle && fromTitle.length >= 12 ? fromTitle : null
  if (!text) return null
  const first = text.split(/(?<=[.!?])\s+/)[0]
  const s = (first.length >= 25 ? first : text).replace(/["“”]/g, '')
  return s.length > 170 ? `${s.slice(0, 167).replace(/\s+\S*$/, '')}…` : s.replace(/[.!]+$/, '')
}

// One or two concepts per company. The outlines name the company; the basis records the site facts used.
export function ugcConcepts(input: { name: string; categorySlug: string; product: string | null; sourceUrl: string; ugc: Set<UgcSignal> }): Concept[] {
  const n = input.name
  const basis = input.product ? `Their site: "${input.product}" (${input.sourceUrl})` : `Category fit only: no product description found on ${input.sourceUrl}`
  const platforms = input.ugc.has('tiktok') ? 'TikTok, Reels and Shorts' : 'short-form and paid social'
  const byCategory: Record<string, [string, string][]> = {
    'ugc-ai-tools': [
      ['Prompt to result', `A screen-recorded demo that opens on the finished result as the hook, then shows the exact steps in ${n}, with my on-camera reaction and captions, cut for ${platforms}.`],
      ['First-time walkthrough', `An honest "trying ${n} for the first time" video built around a real task from my own gaming and tech content, start to finish.`],
    ],
    'ugc-saas': [
      ['Problem to solution demo', `Opens on a relatable frustration, then a quick screen-recorded walkthrough of how ${n} handles it, ending on the result and a clear call to action.`],
      ['Setup in one take', `A fast "how I set up ${n}" video for new users, recorded at my desk with screen capture, made to work as an onboarding clip or an ad.`],
    ],
    'ugc-consumer-apps': [
      ['Day-in-the-life POV', `A first-person video showing where ${n} fits into a normal day, with the app on screen at the moment it helps, captioned for sound-off viewing.`],
      ['Before and after', `A quick contrast edit: how I handled something before, then with ${n}, cut for ${platforms}.`],
    ],
    'ugc-gaming': [
      ['Gameplay hook', `Opens on a gameplay moment that stops the scroll, then my on-camera reaction and why ${n} is worth a try, cut for ${platforms}.`],
      ["A player's first impressions", `A natural first-session video in a player's voice, highlighting what makes ${n} different, with captions and a clear call to action.`],
    ],
    'ugc-creator-tools': [
      ['Edit with me', `A behind-the-scenes video of my real content workflow with ${n} in it, showing the exact step it saves.`],
      ['Creator tip', `A quick "the tool I use for this" tip video built around one feature of ${n}, made to run as an ad or on your channels.`],
    ],
    'ugc-tech-products': [
      ['Unboxing to first use', `Unboxing ${n} and getting it running on camera, focused on the moment it is set up and working.`],
      ['Desk setup feature', `A gaming and tech desk-setup video where ${n} shows up naturally, with close-up product shots and captions.`],
    ],
    'ugc-productivity': [
      ['Workflow makeover', `A before and after of my own scattered workflow, then the same week organised in ${n}, shown on screen.`],
      ['The first feature to try', `A short tutorial on the one feature a new user should try first in ${n}, made to work as an ad or an onboarding clip.`],
    ],
    'ugc-agencies': [
      ['Software and AI demos', 'On-camera walkthroughs of SaaS and AI products for your clients, scripted around one clear use case.'],
      ['Gaming and tech ads', "Gameplay-led hooks and gear or app videos in a player's voice, delivered edited and captioned."],
    ],
  }
  const picks = byCategory[input.categorySlug] ?? byCategory['ugc-saas']
  const out = picks.map(([title, outline]) => ({ title, outline, basis }))
  // An app with store listings gets an install-focused idea instead of the second generic one.
  if (input.ugc.has('mobile_app') && !['ugc-consumer-apps', 'ugc-agencies'].includes(input.categorySlug)) {
    out[1] = { title: 'App install ad', outline: `A creator-style install ad for the ${n} app: a hook in the first seconds, the app on screen doing one useful thing, and a clear download prompt.`, basis: `${basis}; App Store or Google Play link on their site` }
  }
  return out
}

export const conceptText = (concepts: Concept[]) => concepts.map((c) => `${c.title}: ${c.outline}`).join('\n')

export const ugcFindingsFromShared = (f: Finding[]) => f.filter((x) => ['creator_program', 'affiliate_program', 'ambassador_program', 'influencer_mentions'].includes(x.signal))
