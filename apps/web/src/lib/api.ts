import { useCallback, useEffect, useState } from 'react'

export class ApiError extends Error {
  status: number
  code: string
  details?: unknown
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

// Every write carries this header; the server rejects writes without it (see apps/server/src/app.ts).
const CLIENT_HEADER = { 'x-outreach-client': 'dashboard' }

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData
  const res = await fetch(path, {
    method,
    headers: { ...CLIENT_HEADER, ...(body !== undefined && !isForm ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) {
    const e = data?.error ?? {}
    throw new ApiError(res.status, e.code ?? 'error', e.message ?? `Request failed (${res.status})`, e.details)
  }
  return data as T
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
}

export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!path) return
    let cancelled = false
    setLoading(true)
    api.get<T>(path)
      .then((d) => { if (!cancelled) { setData(d); setError(null) } })
      .catch((e: Error) => { if (!cancelled) setError(e) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [path, tick])
  const reload = useCallback(() => setTick((t) => t + 1), [])
  return { data, error, loading, reload, setData }
}

// Calls fn every `ms` while `active` is true (used to follow a running research batch).
export function usePoll(fn: () => void, ms: number, active: boolean) {
  useEffect(() => {
    if (!active) return
    const t = setInterval(fn, ms)
    return () => clearInterval(t)
  }, [fn, ms, active])
}
