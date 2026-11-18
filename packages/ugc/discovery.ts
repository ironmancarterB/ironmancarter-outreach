// Finds new UGC candidate companies beyond the starter list, from Wikidata: a free, public (CC0) database whose
// query service permits automated use. Only real organizations with an official website on record are added, each
// with the Wikidata item it came from. Candidates are only places to look: research still fetches each site and
// records what it finds, and nothing about a company is trusted until then.
import { all, get, getSetting, logActivity, nowIso, run, setSetting, type DB } from '../db'
import { normalizeDomain, normalizeUrl } from '../core/normalize'

const ENDPOINT = 'https://query.wikidata.org/sparql'
// A generic client name, as the service asks; no personal details are sent.
const USER_AGENT = 'OutreachResearchTool/1.0 (local research; low volume)'

// What each UGC category looks for: Wikidata classes (instance of, including subclasses) or industries.
export const DISCOVERY_SOURCES: { category: string; label: string; where: string }[] = [
  { category: 'ugc-ai-tools', label: 'AI companies', where: '?item wdt:P452 wd:Q11660 .' },
  { category: 'ugc-saas', label: 'Software companies', where: '{ ?item wdt:P31/wdt:P279* wd:Q1058914 } UNION { ?item wdt:P452 wd:Q880371 }' },
  { category: 'ugc-gaming', label: 'Game developers and publishers', where: '{ ?item wdt:P31/wdt:P279* wd:Q210167 } UNION { ?item wdt:P31/wdt:P279* wd:Q1137109 }' },
  { category: 'ugc-agencies', label: 'Advertising and marketing agencies', where: '{ ?item wdt:P31/wdt:P279* wd:Q216931 } UNION { ?item wdt:P452 wd:Q37038 }' },
]

// Sites that are not a company's own (social profiles, app stores, link hubs) are never used as its website.
const NOT_A_COMPANY_SITE = /^(facebook|twitter|x|instagram|linkedin|youtube|tiktok|github|apple|google|play\.google|wikipedia|wikidata|medium|steampowered|blogspot|wordpress|tumblr|crunchbase)\.[a-z.]+$/

export interface DiscoveryRow { item: string; name: string; website: string }

export function sparqlFor(where: string, limit: number, offset: number) {
  return `SELECT DISTINCT ?item ?itemLabel ?website WHERE {
  ${where}
  ?item wdt:P856 ?website .
  FILTER NOT EXISTS { ?item wdt:P576 ?dissolved }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} ORDER BY ?item LIMIT ${limit} OFFSET ${offset}`
}

export async function queryWikidata(where: string, limit: number, offset: number, fetchImpl: typeof fetch = fetch): Promise<DiscoveryRow[]> {
  const url = `${ENDPOINT}?query=${encodeURIComponent(sparqlFor(where, limit, offset))}`
  const r = await fetchImpl(url, { headers: { accept: 'application/sparql-results+json', 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(60_000) })
  if (!r.ok) throw new Error(`Wikidata answered HTTP ${r.status}`)
  const j = await r.json() as { results: { bindings: { item: { value: string }; itemLabel?: { value: string }; website: { value: string } }[] } }
  return j.results.bindings.map((b) => ({ item: b.item.value, name: b.itemLabel?.value ?? '', website: b.website.value }))
}

// Adds up to `wanted` new candidates, spread across the categories, continuing where the last run stopped.
// Returns how many were added per category. Already-known domains (pool or CRM, either campaign) are skipped.
export async function discoverCompanies(db: DB, wanted: number, fetchImpl: typeof fetch = fetch) {
  const state = getSetting<{ enabled: boolean; cursors: Record<string, number>; lastRunDay: string | null }>(db, 'ugc.discovery')
  const added: Record<string, number> = {}
  const errors: string[] = []
  if (!state.enabled || wanted <= 0) return { added, errors, total: 0 }
  const perSource = Math.max(10, Math.ceil(wanted / DISCOVERY_SOURCES.length))
  for (const src of DISCOVERY_SOURCES) {
    const cat = get<{ id: number; enabled: number }>(db, 'SELECT id, enabled FROM categories WHERE slug = ?', src.category)
    if (!cat?.enabled) continue
    let offset = state.cursors[src.category] ?? 0
    added[src.category] = 0
    // Read pages of 200 until this category has its share or the source runs out (at most 5 pages a run).
    for (let page = 0; page < 5 && added[src.category] < perSource; page++) {
      let rows: DiscoveryRow[]
      try { rows = await queryWikidata(src.where, 200, offset, fetchImpl) } catch (err) { errors.push(`${src.label}: ${(err as Error).message}`); break }
      if (!rows.length) { offset = 0; break } // end of the list: start over next time (known domains are skipped)
      offset += rows.length
      const last = rows.length < 200
      for (const r of rows) {
        if (added[src.category] >= perSource) break
        const name = r.name.trim()
        if (!name || /^Q\d+$/.test(name)) continue
        const website = normalizeUrl(r.website)
        const domain = normalizeDomain(r.website)
        if (!website || !domain || NOT_A_COMPANY_SITE.test(domain)) continue
        if (get(db, 'SELECT 1 FROM candidate_pool WHERE domain = ?', domain) || get(db, 'SELECT 1 FROM prospects WHERE domain = ?', domain)) continue
        const now = nowIso()
        added[src.category] += run(db, `INSERT OR IGNORE INTO candidate_pool (company_name, website, domain, category_id, origin, added_at, updated_at, source_url)
          VALUES (?, ?, ?, ?, 'discovery', ?, ?, ?)`, name.slice(0, 150), website, domain, cat.id, now, now, r.item).changes
      }
      if (last) break
    }
    state.cursors[src.category] = offset
  }
  setSetting(db, 'ugc.discovery', { ...state, lastRunDay: nowIso().slice(0, 10) })
  const total = Object.values(added).reduce((a, b) => a + b, 0)
  logActivity(db, 'ugc.discovered', `Found ${total} new UGC candidate compan${total === 1 ? 'y' : 'ies'} on Wikidata (${Object.entries(added).map(([k, v]) => `${k.replace('ugc-', '')}: ${v}`).join(', ')})${errors.length ? `; ${errors.join('; ')}` : ''}. Each will be researched before use.`)
  return { added, errors, total }
}

export const availableUgcCandidates = (db: DB) => get<{ n: number }>(db, `SELECT count(*) AS n FROM candidate_pool cp JOIN categories c ON c.id = cp.category_id
  WHERE c.campaign_type = 'ugc' AND c.enabled = 1 AND cp.status = 'available' AND NOT EXISTS (SELECT 1 FROM prospects p WHERE p.domain = cp.domain)`)!.n

export const discoveredSummary = (db: DB) => all<{ origin: string; n: number }>(db, `SELECT cp.origin, count(*) AS n FROM candidate_pool cp JOIN categories c ON c.id = cp.category_id
  WHERE c.campaign_type = 'ugc' GROUP BY cp.origin`)
