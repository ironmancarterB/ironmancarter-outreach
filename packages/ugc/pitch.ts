// UGC pitch writer. Leads with what you make (short-form, on-camera demos, editing), never with follower
// counts, and builds every company-specific sentence from research: the site's own product description,
// signals found on its pages and the researched video concepts. Nothing about past clients or product use.
import type { Claim, ClaimSource } from '../pitch/claims'
import type { Facts } from '../pitch/facts'
import { applySignature } from '../pitch/signature'
import type { Draft } from '../pitch/template'
import type { Concept } from './research'
import { renderTemplate, type EmailTemplate } from './templates'

export const TEMPLATE_FOR_CATEGORY: Record<string, string> = {
  'ugc-ai-tools': 'ugc_ai_software',
  'ugc-saas': 'ugc_saas_demo',
  'ugc-productivity': 'ugc_saas_demo',
  'ugc-gaming': 'ugc_gaming',
  'ugc-agencies': 'ugc_agency',
}

export const templateSlugFor = (categorySlug: string | null) => (categorySlug && TEMPLATE_FOR_CATEGORY[categorySlug]) || 'ugc_initial'

export interface UgcFacts {
  concepts: Concept[]
  signals: { id: number; label: string; url: string; snippet: string | null; retrieved_at: string }[]
  portfolio: { url: string | null; usable: boolean; link: string | null; reason: string | null }
  site: { id: number; url: string; snippet: string | null; retrieved_at: string } | null
}

const research = (s: UgcFacts['signals'][number]): ClaimSource => ({ type: 'research', id: s.id, url: s.url, label: s.label, snippet: s.snippet, retrieved_at: s.retrieved_at })
const has = (u: UgcFacts, label: string) => u.signals.find((s) => s.label.includes(label))

export function brandLine(f: Facts, u: UgcFacts): Claim | null {
  const name = f.prospect.name
  const sources: ClaimSource[] = []
  const parts: string[] = []
  const site = u.site
  if (f.prospect.categorySlug === 'ugc-agencies') {
    const agency = has(u, 'Agency offering') ?? has(u, 'Recruits creators')
    if (agency) {
      parts.push('Your site says you run creator and influencer work for brands, so I wanted to introduce myself.')
      sources.push(research(agency))
    }
  } else if (f.prospect.products && site) {
    parts.push(`Your site describes ${name} as "${f.prospect.products.replace(/[.…]+$/, '')}", and that is the kind of product people get faster when they see it in action.`)
    sources.push({ type: 'research', id: site.id, url: site.url, label: 'Official website', snippet: site.snippet, retrieved_at: site.retrieved_at })
  }
  const tiktok = has(u, 'On TikTok')
  if (tiktok && f.prospect.categorySlug !== 'ugc-agencies') {
    parts.push("You're already on TikTok, so these would sit naturally alongside what you post.")
    sources.push(research(tiktok))
  }
  return parts.length ? { sentence: parts.join(' '), kind: 'brand', sources } : null
}

export function writeUgcPitch(f: Facts, u: UgcFacts, template: EmailTemplate): Draft {
  const claims: Claim[] = []
  const brand = brandLine(f, u)
  if (brand) claims.push(brand)
  const concepts = u.concepts.slice(0, 2)
  for (const c of concepts) claims.push({ sentence: `${c.title}: ${c.outline}`, kind: 'concept', sources: [{ type: 'concept', note: c.basis }] })
  const portfolioLine = u.portfolio.link ? `You can see examples of my work here: ${u.portfolio.link}` : ''
  if (portfolioLine) claims.push({ sentence: portfolioLine, kind: 'creator', sources: [{ type: 'creator', note: 'Your UGC portfolio page, checked live before use' }] })
  const vars = {
    greeting: `Hi ${f.prospect.name} team,`,
    company: f.prospect.name,
    brand_line: brand?.sentence ?? '',
    concepts: concepts.map((c) => `- ${c.title}: ${c.outline}`).join('\n'),
    concept_short: concepts[0]?.title ?? '',
    portfolio_line: portfolioLine,
  }
  const body = applySignature(renderTemplate(template.body, vars), f.business.signature)
  const subject = renderTemplate(template.subject ?? 'Video ideas for {{company}}', vars)
  return { subject, body, claims }
}
