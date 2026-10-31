// Quality and safety checks run on every pitch (generated or edited). Blockers prevent approval;
// warnings are shown for your judgment.
import { get, type DB } from '../db'
import { normalizeDomain } from '../core/normalize'
import type { Claim } from './claims'
import type { Facts } from './facts'
import { millions } from './template'
import { endsWithSignature, stripSignature } from './signature'

export interface Check {
  level: 'blocker' | 'warning'
  code: string
  message: string
}

export const bodyWords = (body: string) => {
  const main = stripSignature(body)
  return main.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w)).length
}

const URL_RE = /https?:\/\/[^\s)]+/gi
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi
const NUMBER_RE = /\d+(?:[.,]\d+)*/g

const normNum = (s: string) => s.replace(/,/g, '').replace(/\.0+$/, '')

// Every number the pitch is allowed to contain: your recorded metrics (in the forms they are written),
// dates of their reporting periods, package prices when you chose to include them, and numbers that
// appear in the brand's own recorded evidence.
export function allowedNumbers(f: Facts): Set<string> {
  const out = new Set<string>(['18', '34'])
  const add = (s: string | null | undefined) => { for (const n of (s ?? '').match(NUMBER_RE) ?? []) out.add(normNum(n)) }
  for (const m of [f.metrics.igViews, f.metrics.ytViews, f.metrics.igAge]) {
    if (!m) continue
    add(String(m.value)); add(millions(m.value)); add(String(Math.round(m.value))); add(m.period_label); add(m.period_start); add(m.period_end); add(m.as_of)
    for (const d of [m.period_start, m.period_end]) if (d) { const [y, , dd] = d.split('-'); out.add(y); out.add(String(Number(dd))) }
  }
  if (f.options.include_rates && f.pkg) {
    for (const c of [f.pkg.price_min_cents, f.pkg.price_max_cents]) if (c != null) { out.add(String(c / 100)); out.add(normNum((c / 100).toLocaleString('en-US'))) }
  }
  add(f.options.custom_rate_text); add(f.options.custom_deliverables); add(f.pkg?.deliverables); add(f.prospect.concept)
  for (const e of f.evidence) add(e.snippet)
  add(f.prospect.products); add(f.prospect.name) // brand names can contain digits (8BitDo, 1Password)
  return out
}

const GENERIC = [
  'i hope this email finds you well', 'i hope this finds you well', 'i came across your brand', 'synergy', 'leverage', 'game-changer', 'game changer',
  'dear sir', 'to whom it may concern', 'i am writing to', 'take your brand to the next level', 'win-win', 'esteemed', 'cutting-edge', 'reach out to you today',
]

export function runChecks(f: Facts, subject: string | null, body: string): { checks: Check[]; wordCount: number } {
  const checks: Check[] = []
  const block = (code: string, message: string) => checks.push({ level: 'blocker', code, message })
  const warn = (code: string, message: string) => checks.push({ level: 'warning', code, message })
  const lower = body.toLowerCase()
  const words = bodyWords(body)

  if (words < 60 || words > 220) block('word_count', `${words} words. Keep it near 100–150.`)
  else if (words < 100 || words > 150) warn('word_count', `${words} words (target 100–150).`)

  if (!endsWithSignature(body, f.business.signature)) block('signature', `End with your signature ("${f.business.signature.replace(/\n/g, ' / ')}"; set it in Settings → Business).`)
  else if (stripSignature(body, f.business.signature) !== stripSignature(stripSignature(body, f.business.signature))) warn('signature_twice', 'There seems to be a second sign-off above your signature.')
  const otherEmails = (body.match(EMAIL_RE) ?? []).filter((e) => e.toLowerCase() !== f.business.email.toLowerCase())
  if (otherEmails.length) block('other_email', `Contains an email address that is not yours: ${[...new Set(otherEmails)].join(', ')}`)

  const allowedHosts = new Set([f.prospect.domain, f.mediaKit?.public_url ? normalizeDomain(f.mediaKit.public_url) : null].filter(Boolean))
  const badUrls = (body.match(URL_RE) ?? []).filter((u) => !allowedHosts.has(normalizeDomain(u)))
  if (badUrls.length) block('unknown_url', `Links to a site that is neither the brand's nor your media kit: ${badUrls.join(', ')}`)

  const scrubbed = body.replace(URL_RE, ' ').replace(EMAIL_RE, ' ')
  const allowed = allowedNumbers(f)
  const unsupported = [...new Set((scrubbed.match(NUMBER_RE) ?? []).map(normNum))].filter((n) => !allowed.has(n))
  if (unsupported.length) block('unsupported_number', `Numbers not backed by your analytics or the brand's recorded evidence: ${unsupported.join(', ')}`)

  if (/\$\s?\d/.test(body) && !(f.options.include_rates || f.options.custom_rate_text)) block('price', 'Mentions a price, but you did not choose to include rates.')
  if (/\bguarantee[ds]?\b|\bpromise (you )?(\d|results|views|sales)|\bwill (get|generate|drive|deliver|bring) (you )?(\d|thousands|millions|sales|conversions|results)/i.test(body)) {
    block('guarantee', 'Promises results (views, sales or conversions). Remove it; results cannot be guaranteed.')
  }
  if (/\b(conversions?|roi|go viral|viral hit|sales lift|boost (your )?sales)\b/i.test(body)) warn('performance', 'Talks about conversions/ROI/virality. Make sure nothing reads as a promise.')
  if (/\b(as (we|i) (discussed|mentioned)|following up on our|great (chatting|talking|speaking)|our (last|previous) (call|chat|conversation|campaign)|worked together (before|previously)|loved working with you|thanks again for)\b/i.test(body)) {
    block('relationship', 'Implies a previous relationship with this brand, which is not on record.')
  }
  if (/\b(your|the) (marketing |campaign |creator )?budget\b/i.test(body)) block('budget', "Refers to the brand's budget, which is not known.")
  if (/\[[^\]]*\]|\{[^}]*\}|\bINSERT\b|\bYOUR NAME\b|<[a-z][^>]*>/i.test(body)) block('placeholder', 'Contains an unfilled placeholder or markup.')

  const generic = GENERIC.filter((g) => lower.includes(g))
  if (generic.length) warn('generic', `Generic mass-email phrasing: "${generic.join('", "')}"`)
  if (!lower.includes(f.prospect.name.toLowerCase())) warn('brand_name', `Doesn't mention ${f.prospect.name} by name.`)

  if (f.prospect.categorySlug === 'vpn-privacy' && /\b(anonymous|anonymity|untraceable|unhackable|100% (private|secure|safe)|completely (private|secure|safe)|total privacy|guaranteed privacy)\b/i.test(body)) {
    block('category_claim', 'VPN guardrail: no claims about anonymity, total privacy or guaranteed security.')
  }
  if (f.prospect.categorySlug === 'vpn-privacy' && /\b(safer|safe from|protects? (you|your)|keeps? (you|your \w+) (safe|secure|private)|secures? your)\b/i.test(body)) {
    warn('category_claim', 'VPN guardrail: this reads as a security or safety claim. Keep it to how you would use the product.')
  }
  if (f.prospect.categorySlug === 'energy-drinks') {
    if (/\b(kids?|children|teens?|teenagers?|minors?|high school)\b/i.test(body)) block('category_claim', 'Energy drink guardrail: never position stimulant drinks toward minors.')
    if (/\b(boosts? (your )?(focus|energy|performance|reaction)|improves? (focus|reaction|performance|aim)|healthy|health benefits|better gameplay)\b/i.test(body)) {
      block('category_claim', 'Energy drink guardrail: no health or performance claims.')
    }
  }

  if (f.options.channel === 'email') {
    if (!subject?.trim()) block('subject', 'An email needs a subject line.')
    else if (/^\s*(re|fwd?):/i.test(subject)) block('subject', 'The subject must not pretend to be a reply or forward.')
    else if (subject.length > 90) warn('subject', 'The subject line is long.')
    if (!lower.includes('media kit')) warn('media_kit', 'Does not mention the attached media kit.')
    if (!f.contact?.email) block('recipient', 'No verified business email to address this to. Use the manual submission channel.')
    else if (f.contact.eligibility.status === 'ineligible') block('recipient', `${f.contact.email} cannot be emailed: ${f.contact.eligibility.reasons[0]}`)
    else if (f.contact.eligibility.status === 'needs_review') warn('recipient', `Recipient needs your review before any future sending: ${f.contact.eligibility.reasons.join('; ')}`)
  } else if (!f.application) {
    block('application_url', 'No verified creator portal or contact form URL to submit this through.')
  }
  if (!f.mediaKit) warn('media_kit', 'No default media kit to reference.')

  return { checks, wordCount: words }
}

export interface ClaimValidation {
  sentence: string
  kind: Claim['kind']
  inBody: boolean
  problems: string[]
}

// Confirms the evidence behind each claim still exists and still says the same thing.
export function validateClaims(db: DB, prospectId: number, claims: Claim[], body: string): ClaimValidation[] {
  return claims.map((c) => {
    const problems: string[] = []
    for (const s of c.sources) {
      if (s.type === 'research') {
        const row = get<{ url: string }>(db, 'SELECT url FROM research_sources WHERE id = ? AND prospect_id = ?', s.id, prospectId)
        if (!row) problems.push(`Source ${s.url} has been removed from the company's research`)
        else if (row.url !== s.url) problems.push('Source record changed')
      } else if (s.type === 'metric') {
        const row = get<{ value: number; pitchable: number }>(db, 'SELECT value, pitchable FROM creator_metrics WHERE id = ?', s.id)
        if (!row) problems.push(`${s.label} no longer exists`)
        else {
          if (row.value !== s.value) problems.push(`${s.platform} ${s.label} changed from ${s.value.toLocaleString('en-US')} to ${row.value.toLocaleString('en-US')} since drafting`)
          if (!row.pitchable) problems.push(`${s.platform} ${s.label} is no longer marked "may be quoted"`)
        }
      } else if (s.type === 'package') {
        const row = get<{ active: number }>(db, 'SELECT active FROM sponsorship_packages WHERE id = ?', s.id)
        if (!row?.active) problems.push(`Package ${s.name} is no longer active`)
      } else if (s.type === 'media_kit') {
        const row = get<{ is_default: number; version: number }>(db, 'SELECT is_default, version FROM media_kits WHERE id = ?', s.id)
        if (!row) problems.push('Media kit version no longer exists')
        else if (!row.is_default) problems.push(`Refers to media kit v${row.version}, which is no longer the default`)
      }
    }
    return { sentence: c.sentence, kind: c.kind, inBody: body.includes(c.sentence), problems }
  })
}
