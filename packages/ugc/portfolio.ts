// Your UGC portfolio link. It goes into an email only after a live check confirms the page loads, is a real
// page (not a placeholder, error or "coming soon" page) and is still the URL you saved. Checked again daily.
import { getSetting, logActivity, setSetting, type DB } from '../db'
import { invalid } from '../core/errors'

export interface PortfolioCheck {
  url: string | null
  ok: boolean
  status: number | null
  detail: string | null
  checkedAt: string | null
  finalUrl?: string | null
  title?: string | null
}

// A link older than this is checked again before it can be used.
export const PORTFOLIO_MAX_AGE_MS = 3 * 86_400_000

const UNFINISHED = /\b(coming soon|under construction|page not found|404 not found|lorem ipsum|placeholder|launching soon|site is being built)\b/i

export function normalizePortfolioUrl(input: unknown): string {
  const raw = String(input ?? '').trim()
  if (!raw) return ''
  let u: URL
  try { u = new URL(raw) } catch { throw invalid('Enter the full link, starting with https://') }
  if (u.protocol !== 'https:') throw invalid('The portfolio link must start with https://')
  if (/^(localhost|127\.|10\.|192\.168\.)/.test(u.hostname) || !u.hostname.includes('.')) throw invalid('Use your public website address, not a local one')
  u.hash = ''
  return u.toString()
}

export function setPortfolioUrl(db: DB, input: unknown) {
  const url = normalizePortfolioUrl(input)
  setSetting(db, 'ugc.portfolioUrl', url)
  setSetting(db, 'ugc.portfolioCheck', { url: null, ok: false, status: null, detail: url ? 'Not checked yet' : null, checkedAt: null } satisfies PortfolioCheck)
  logActivity(db, 'ugc.portfolio_set', url ? `UGC portfolio link set to ${url} (not used until it passes the live check)` : 'UGC portfolio link cleared')
  return portfolioStatus(db)
}

export async function checkPortfolio(db: DB, fetchImpl: typeof fetch = fetch, now = new Date()): Promise<ReturnType<typeof portfolioStatus>> {
  const url = getSetting<string>(db, 'ugc.portfolioUrl')
  if (!url) return portfolioStatus(db, now)
  const save = (c: Omit<PortfolioCheck, 'url' | 'checkedAt'>) => {
    setSetting(db, 'ugc.portfolioCheck', { ...c, url, checkedAt: now.toISOString() } satisfies PortfolioCheck)
    logActivity(db, 'ugc.portfolio_checked', `UGC portfolio ${url}: ${c.ok ? 'live' : `not usable (${c.detail})`}`)
  }
  let res: Response
  try {
    res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(15_000), headers: { 'user-agent': 'Mozilla/5.0 (compatible; OutreachLinkCheck/1.0)', accept: 'text/html' } })
  } catch (err) {
    save({ ok: false, status: null, detail: `Could not load the page: ${(err as Error).message}` })
    return portfolioStatus(db, now)
  }
  const finalUrl = res.url || url
  if (!res.ok) { save({ ok: false, status: res.status, detail: `The page returned HTTP ${res.status}`, finalUrl }); return portfolioStatus(db, now) }
  const type = res.headers.get('content-type') ?? ''
  if (!/text\/html/i.test(type)) { save({ ok: false, status: res.status, detail: `Not a web page (${type || 'unknown type'})`, finalUrl }); return portfolioStatus(db, now) }
  if (new URL(finalUrl).hostname !== new URL(url).hostname) {
    save({ ok: false, status: res.status, detail: `It redirects to another site (${new URL(finalUrl).hostname})`, finalUrl })
    return portfolioStatus(db, now)
  }
  const html = (await res.text()).slice(0, 2_000_000)
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, ' ').trim() ?? null
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  const media = (html.match(/<(video|iframe|img)\b/gi) ?? []).length
  const unfinished = UNFINISHED.exec(`${title ?? ''} ${text.slice(0, 4000)}`)
  if (unfinished) save({ ok: false, status: res.status, detail: `The page looks unfinished ("${unfinished[0]}")`, finalUrl, title })
  // A single-page app can render its content with JavaScript, so a short HTML shell is accepted only with a title.
  else if (text.length < 80 && media === 0 && !title) save({ ok: false, status: res.status, detail: 'The page has no visible content yet', finalUrl, title })
  else save({ ok: true, status: res.status, detail: `Live: HTTP ${res.status}${title ? `, "${title}"` : ''}${media ? `, ${media} image/video element(s)` : ''}`, finalUrl, title })
  return portfolioStatus(db, now)
}

// The link pitches may use, or why there is none.
export function portfolioStatus(db: DB, now = new Date()) {
  const url = getSetting<string>(db, 'ugc.portfolioUrl') || null
  const check = getSetting<PortfolioCheck>(db, 'ugc.portfolioCheck')
  const fresh = !!check.checkedAt && now.getTime() - new Date(check.checkedAt).getTime() < PORTFOLIO_MAX_AGE_MS
  const usable = !!url && check.ok && check.url === url && fresh
  const reason = !url ? 'Add your UGC portfolio link on the UGC Clients page.'
    : check.url !== url || !check.checkedAt ? 'Your UGC portfolio link has not been checked yet.'
      : !check.ok ? `Your UGC portfolio link failed its live check: ${check.detail}.`
        : !fresh ? 'Your UGC portfolio link needs checking again (checks expire after 3 days).' : null
  return { url, usable, link: usable ? url : null, check, reason, checkedAt: check.checkedAt }
}
