// Polite HTTP fetching for research. Rules:
//  - robots.txt is fetched once per site and obeyed for every request, including each redirect hop.
//    If robots.txt cannot be fetched because of a server error or timeout, the site is treated as
//    off-limits (RFC 9309). A missing robots.txt (4xx) allows access.
//  - At most one request per site every `delayMs`.
//  - HTML only, size-capped, with a timeout. No cookies, no logins, no JavaScript execution, and no
//    attempt to get past bot protection: a block is recorded as a block.
import { ALLOW_ALL, DISALLOW_ALL, isAllowed, parseRobots, type RobotsRules } from './robots'

export const USER_AGENT = 'IronmanCarterOutreachResearch/0.2 (independent creator sponsorship research; obeys robots.txt)'
export const AGENT_TOKEN = 'IronmanCarterOutreachResearch'

export type FetchOutcome = 'ok' | 'robots_disallowed' | 'http_error' | 'not_html' | 'too_large' | 'network_error' | 'timeout'

export interface FetchResult {
  url: string
  finalUrl: string
  status: number | null
  outcome: FetchOutcome
  html: string | null
  bytes: number
  fetchedAt: string
  error?: string
}

export interface FetcherOptions {
  fetchImpl?: typeof fetch
  delayMs?: number
  timeoutMs?: number
  maxBytes?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export function createFetcher(opts: FetcherOptions = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch
  const delayMs = opts.delayMs ?? 1500
  const timeoutMs = opts.timeoutMs ?? 15_000
  const maxBytes = opts.maxBytes ?? 4_000_000 // some brand homepages exceed 1.5 MB of HTML
  const sleep = opts.sleep ?? realSleep
  const now = opts.now ?? Date.now
  const lastHit = new Map<string, number>()
  const robotsCache = new Map<string, Promise<RobotsRules>>()

  // Waits until this host may be contacted again, then reserves the slot.
  async function throttle(host: string) {
    const wait = (lastHit.get(host) ?? -Infinity) + delayMs - now()
    lastHit.set(host, Math.max(now(), (lastHit.get(host) ?? -Infinity) + delayMs))
    if (wait > 0) await sleep(wait)
  }

  async function rawGet(url: string, accept: string) {
    const u = new URL(url)
    await throttle(u.host)
    return fetchImpl(url, {
      redirect: 'manual',
      headers: { 'user-agent': USER_AGENT, accept, 'accept-language': 'en-US,en;q=0.8' },
      signal: AbortSignal.timeout(timeoutMs),
    })
  }

  async function readCapped(res: Response): Promise<{ text: string; bytes: number; truncated: boolean }> {
    if (!res.body) return { text: '', bytes: 0, truncated: false }
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maxBytes) {
        await reader.cancel()
        return { text: '', bytes, truncated: true }
      }
      chunks.push(value)
    }
    return { text: Buffer.concat(chunks).toString('utf8'), bytes, truncated: false }
  }

  function robotsFor(origin: string): Promise<RobotsRules> {
    let p = robotsCache.get(origin)
    if (!p) {
      p = (async () => {
        try {
          const res = await rawGet(`${origin}/robots.txt`, 'text/plain,*/*;q=0.5')
          if (res.status >= 200 && res.status < 300) return parseRobots((await readCapped(res)).text, AGENT_TOKEN)
          if (res.status >= 300 && res.status < 500) return ALLOW_ALL
          return DISALLOW_ALL
        } catch {
          return DISALLOW_ALL
        }
      })()
      robotsCache.set(origin, p)
    }
    return p
  }

  async function allowed(url: string) {
    const u = new URL(url)
    return isAllowed(await robotsFor(u.origin), u.pathname + u.search)
  }

  async function get(url: string): Promise<FetchResult> {
    const fetchedAt = new Date(now()).toISOString()
    let current = url
    for (let hop = 0; hop < 6; hop++) {
      let u: URL
      try {
        u = new URL(current)
      } catch {
        return { url, finalUrl: current, status: null, outcome: 'network_error', html: null, bytes: 0, fetchedAt, error: 'Invalid URL' }
      }
      if (u.protocol !== 'https:' && u.protocol !== 'http:') {
        return { url, finalUrl: current, status: null, outcome: 'network_error', html: null, bytes: 0, fetchedAt, error: 'Unsupported scheme' }
      }
      if (!(await allowed(current))) return { url, finalUrl: current, status: null, outcome: 'robots_disallowed', html: null, bytes: 0, fetchedAt }
      let res: Response
      try {
        res = await rawGet(current, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1')
      } catch (err) {
        const e = err as Error
        const timeout = e.name === 'TimeoutError' || e.name === 'AbortError'
        return { url, finalUrl: current, status: null, outcome: timeout ? 'timeout' : 'network_error', html: null, bytes: 0, fetchedAt, error: e.message }
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        await res.body?.cancel()
        current = new URL(res.headers.get('location')!, current).toString()
        continue
      }
      if (res.status < 200 || res.status >= 300) {
        await res.body?.cancel()
        return { url, finalUrl: current, status: res.status, outcome: 'http_error', html: null, bytes: 0, fetchedAt }
      }
      const type = res.headers.get('content-type') ?? ''
      if (type && !/html|xml/i.test(type)) {
        await res.body?.cancel()
        return { url, finalUrl: current, status: res.status, outcome: 'not_html', html: null, bytes: 0, fetchedAt }
      }
      const body = await readCapped(res)
      if (body.truncated) return { url, finalUrl: current, status: res.status, outcome: 'too_large', html: null, bytes: body.bytes, fetchedAt }
      return { url, finalUrl: current, status: res.status, outcome: 'ok', html: body.text, bytes: body.bytes, fetchedAt }
    }
    return { url, finalUrl: current, status: null, outcome: 'network_error', html: null, bytes: 0, fetchedAt, error: 'Too many redirects' }
  }

  return { get, allowed }
}

export type Fetcher = ReturnType<typeof createFetcher>
