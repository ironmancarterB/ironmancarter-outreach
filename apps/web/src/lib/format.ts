export const usd = (cents: number | null | undefined, opts: { exact?: boolean } = {}) =>
  cents == null ? '—' : (cents / 100).toLocaleString('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: opts.exact ? 2 : 0, minimumFractionDigits: opts.exact ? 2 : 0,
  })

export const usdAmount = (dollars: number, digits = 2) =>
  dollars.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: Math.max(digits, 4) })

export const num = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString('en-US'))

export function compact(n: number) {
  return n.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: n >= 1_000_000 ? 2 : 1 })
}

export function metricValue(value: number, unit: string, approximate: boolean) {
  const v = unit === 'percent' ? `${value}%` : unit === 'average' ? String(value) : value.toLocaleString('en-US')
  return `${approximate ? '≈' : ''}${v}${unit === 'hours' ? ' hrs' : ''}`
}

export function dateTime(iso: string) {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function relative(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export const bytes = (n: number) => (n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)
