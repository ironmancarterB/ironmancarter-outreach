// The UGC launch gate: automatic UGC sending is allowed only while all of these hold, checked live:
// the portfolio page is public and finished, it shows real published videos that actually load, you confirmed the
// videos may be shown publicly, and the site's contact details match your business email.
import { getSetting, logActivity, setSetting, type DB } from '../db'
import { checkPortfolio } from './portfolio'

export interface GateCheck { label: string; ok: boolean; detail: string }
export interface GateState { ok: boolean; checks: GateCheck[]; checkedAt: string | null }

// The gate result is trusted for a day; the worker re-runs it every business day.
export const GATE_MAX_AGE_MS = 26 * 3_600_000

interface Manifest { videos?: { title?: string; type?: string; src?: string; poster?: string }[] }

async function videoLoads(url: string, fetchImpl: typeof fetch) {
  try {
    const r = await fetchImpl(url, { headers: { range: 'bytes=0-1023' }, signal: AbortSignal.timeout(20_000) })
    const type = r.headers.get('content-type') ?? ''
    await r.body?.cancel().catch(() => undefined)
    return { ok: (r.status === 206 || r.status === 200) && /^video\//.test(type), detail: `HTTP ${r.status}, ${type || 'no type'}` }
  } catch (err) {
    return { ok: false, detail: (err as Error).message }
  }
}

export async function runLaunchGate(db: DB, fetchImpl: typeof fetch = fetch, now = new Date()): Promise<GateState> {
  const checks: GateCheck[] = []
  const add = (label: string, ok: boolean, detail: string) => checks.push({ label, ok, detail })

  const p = await checkPortfolio(db, fetchImpl, now)
  add('Portfolio page is public and finished', p.usable, p.usable ? `${p.url}: ${p.check.detail}` : p.reason ?? 'Not usable')

  // Published videos: the site's gallery list, and every video file must actually load.
  let videos: NonNullable<Manifest['videos']> = []
  let html = ''
  if (p.url) {
    const origin = new URL(p.url).origin
    try {
      const r = await fetchImpl(`${origin}/data/portfolio.json`, { signal: AbortSignal.timeout(15_000) })
      if (r.ok) videos = ((await r.json()) as Manifest).videos ?? []
    } catch { /* no manifest */ }
    try { html = await (await fetchImpl(p.url, { signal: AbortSignal.timeout(15_000) })).text() } catch { /* checked above */ }
    const files = videos.filter((v) => v.type === 'file' && v.src)
    const embeds = videos.filter((v) => v.type && v.type !== 'file' && v.src)
    const results = await Promise.all(files.map(async (v) => ({ v, r: await videoLoads(new URL(v.src!, origin).toString(), fetchImpl) })))
    const broken = results.filter((x) => !x.r.ok)
    const count = files.length + embeds.length + (videos.length ? 0 : (html.match(/<(video|iframe)\b/gi) ?? []).length)
    add('Portfolio shows real video examples', count > 0, count ? `${count} published video${count === 1 ? '' : 's'}` : 'No videos are published on the portfolio page')
    add('Every portfolio video loads', count > 0 && !broken.length, broken.length ? `Not loading: ${broken.map((x) => `${x.v.title ?? x.v.src} (${x.r.detail})`).join('; ')}` : files.length ? `${files.length} video file(s) answered with video content` : 'Embedded videos only')
  } else {
    add('Portfolio shows real video examples', false, 'No portfolio link set')
  }

  const permission = getSetting<{ confirmed: boolean; note: string | null; at: string | null }>(db, 'ugc.videosPermission')
  add('Videos are cleared for public display', permission.confirmed, permission.confirmed ? permission.note ?? 'Confirmed' : 'Confirm in UGC → Autopilot that every published video is yours or licensed for display')

  const email = getSetting<string>(db, 'business.email').toLowerCase()
  add('Contact details on the site match your business email', !!html && html.toLowerCase().includes(email), html.toLowerCase().includes(email) ? email : `${email} was not found on the portfolio page`)

  const state: GateState = { ok: checks.every((c) => c.ok), checks, checkedAt: now.toISOString() }
  setSetting(db, 'ugc.launchGate', state)
  logActivity(db, 'ugc.launch_gate', state.ok ? 'UGC launch gate passed: portfolio live with playable videos, permission confirmed, contact details correct.' : `UGC launch gate failed: ${checks.filter((c) => !c.ok).map((c) => c.label).join('; ')}.`)
  return state
}

export function gateStatus(db: DB, now = new Date()) {
  const g = getSetting<GateState>(db, 'ugc.launchGate')
  const fresh = !!g.checkedAt && now.getTime() - new Date(g.checkedAt).getTime() < GATE_MAX_AGE_MS
  return { ...g, fresh, passing: g.ok && fresh }
}

export function confirmVideosPermission(db: DB, note: string) {
  const text = note.trim().slice(0, 500)
  if (text.length < 10) throw new Error('Describe why the videos may be shown (for example "All three are my own content").')
  setSetting(db, 'ugc.videosPermission', { confirmed: true, note: text, at: new Date().toISOString() })
  logActivity(db, 'ugc.videos_permission', `Portfolio videos confirmed for public display: ${text}`)
}
