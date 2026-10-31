// A tiny fake internet for research tests. No real network access ever happens in tests.
export interface FakeRoute {
  status?: number
  body?: string
  type?: string
  location?: string
}

export function fakeWeb(routes: Record<string, FakeRoute | string>) {
  const calls: string[] = []
  const table = new Map(Object.entries(routes).map(([u, r]) => [new URL(u).toString(), typeof r === 'string' ? { body: r } : r]))
  const fetchImpl = (async (input: string | URL) => {
    const url = new URL(String(input)).toString()
    calls.push(url)
    const r = table.get(url)
    if (!r) return new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } })
    const headers: Record<string, string> = { 'content-type': r.type ?? (url.endsWith('/robots.txt') ? 'text/plain' : 'text/html; charset=utf-8') }
    if (r.location) headers.location = r.location
    return new Response(r.body ?? '', { status: r.status ?? 200, headers })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

export const html = (title: string, body: string, description = '') =>
  `<!doctype html><html><head><title>${title}</title><meta name="description" content="${description}"></head><body>${body}</body></html>`
