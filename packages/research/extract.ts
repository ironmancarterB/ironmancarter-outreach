// Reads the facts research needs out of a fetched HTML page. Regex-based on purpose: we only need
// the title, visible text, links, published email addresses and whether there is a contact form.
import { normalizeDomain } from '../core/normalize'

export interface PageLink {
  url: string
  text: string
}

export interface ExtractedPage {
  title: string | null
  description: string | null
  text: string
  mainText: string          // text without navigation, header, footer and sidebars (used for evidence)
  links: PageLink[]
  emails: string[]
  hasContactForm: boolean
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', trade: '™', reg: '®', copy: '©', middot: '·', bull: '•',
}

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

const clean = (s: string) => decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}/gi
const ASSET_SUFFIX = /\.(png|jpe?g|gif|webp|svg|avif|css|js|ico|mp4|woff2?)$/i

export function extractPage(html: string, baseUrl: string): ExtractedPage {
  const noComments = html.replace(/<!--[\s\S]*?-->/g, ' ')
  const title = noComments.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
  const description = noComments.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1]
    ?? noComments.match(/<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i)?.[1]
  const visible = noComments.replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ')

  const links: PageLink[] = []
  const emails = new Set<string>()
  for (const m of visible.matchAll(/<a\b[^>]*?href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = decodeEntities(m[2].trim())
    if (/^mailto:/i.test(href)) {
      const addr = decodeURIComponent(href.slice(7).split('?')[0]).trim().toLowerCase()
      if (addr.match(EMAIL_RE)?.[0] === addr) emails.add(addr)
      continue
    }
    if (/^(javascript|tel|sms|data):/i.test(href) || href.startsWith('#')) continue
    try {
      const url = new URL(href, baseUrl)
      if (url.protocol !== 'https:' && url.protocol !== 'http:') continue
      url.hash = ''
      links.push({ url: url.toString(), text: clean(m[3]).slice(0, 120) })
    } catch { /* ignore malformed links */ }
  }
  const text = clean(visible)
  const mainText = clean(visible.replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, ' '))
  for (const m of text.matchAll(EMAIL_RE)) {
    const e = m[0].toLowerCase().replace(/\.+$/, '')
    if (!ASSET_SUFFIX.test(e)) emails.add(e)
  }

  const forms = visible.match(/<form\b[\s\S]*?<\/form>/gi) ?? []
  // A message box, or several visible fields. A lone email box is a newsletter sign-up, not a contact form.
  const hasContactForm = forms.some((f) => {
    if (/<textarea/i.test(f)) return true
    const fields = (f.match(/<(input|select)\b[^>]*>/gi) ?? []).filter((i) => !/type=["']?(hidden|submit|button|checkbox|radio|image)/i.test(i))
    return fields.length >= 3 && /type=["']email["']|name=["'][^"']*email/i.test(f)
  })

  return {
    title: title ? clean(title).slice(0, 200) || null : null,
    description: description ? decodeEntities(description).trim().slice(0, 400) || null : null,
    text,
    mainText,
    links,
    emails: [...emails],
    hasContactForm,
  }
}

// ---------- Email classification ----------

export type EmailClass =
  | { kind: 'role'; rank: number; label: string }
  | { kind: 'excluded'; reason: string }
  | { kind: 'personal' }
  | { kind: 'off_domain' }

// Mailboxes a business publishes for inbound inquiries, best first.
const ROLE_RANKS: [RegExp, number, string][] = [
  [/^(partnerships?|partners?|sponsorships?|sponsors?|brandpartnerships?|collabs?|collaborations?)$/, 1, 'Partnerships'],
  [/^(influencers?|creators?|creatorpartnerships|affiliates?|affiliate-?program|ambassadors?|talent|streamers?|esports|gaming)$/, 2, 'Creator / affiliate program'],
  [/^(marketing|brand|brands|pr|press|media|social|community|advertising|ads|events)$/, 3, 'Marketing / press'],
  [/^(business|bd|bizdev|sales|hello|contact|info|team|inquiries|enquiries|general)$/, 4, 'General business'],
]

// Mailboxes that exist for something else and must not receive sponsorship pitches.
const EXCLUDED = /^(support|help|helpdesk|service|customerservice|care|noreply|no-reply|donotreply|privacy|legal|dpo|gdpr|compliance|security|abuse|careers|jobs|hr|recruiting|billing|accounts|orders|returns|warranty|rma|webmaster|admin|postmaster|investors?|ir)$/

// Classifies an address found on a company's site. Personal addresses (people's names) are never kept.
export function classifyEmail(email: string, companyDomain: string): EmailClass {
  const [local, host] = email.toLowerCase().split('@')
  const hostDomain = normalizeDomain(host)
  if (!hostDomain || hostDomain !== companyDomain) return { kind: 'off_domain' }
  const key = local.replace(/[._+-]?(us|usa|na|global|team|hq)$/, '').replace(/[0-9]+$/, '')
  if (EXCLUDED.test(key) || EXCLUDED.test(local)) return { kind: 'excluded', reason: `${local}@ is for ${local.replace(/[-_.]/g, ' ')}, not partnerships` }
  for (const [re, rank, label] of ROLE_RANKS) if (re.test(key) || re.test(local)) return { kind: 'role', rank, label }
  return { kind: 'personal' }
}
