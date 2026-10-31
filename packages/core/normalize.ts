// Normalization used for duplicate detection and suppression matching.

// Hosts where the first label is not the company (e.g. shop.example.co.uk → example.co.uk).
const TWO_PART_SUFFIXES = new Set(['co.uk', 'com.au', 'co.jp', 'co.nz', 'com.br', 'co.kr', 'com.cn', 'com.mx', 'co.in'])

// "https://www.Logitech.com/en-us/" → "logitech.com". Returns null when no plausible domain is found.
export function normalizeDomain(input: string | null | undefined): string | null {
  if (!input) return null
  let s = input.trim().toLowerCase()
  if (!s) return null
  if (s.includes('@')) s = s.split('@').pop()!
  if (!/^[a-z]+:\/\//.test(s)) s = `https://${s}`
  let host: string
  try {
    host = new URL(s).hostname
  } catch {
    return null
  }
  host = host.replace(/\.$/, '')
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return null
  const labels = host.split('.')
  const lastTwo = labels.slice(-2).join('.')
  const keep = TWO_PART_SUFFIXES.has(lastTwo) ? 3 : 2
  return labels.slice(-keep).join('.')
}

const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/

export function normalizeEmail(input: string | null | undefined): string | null {
  if (!input) return null
  const s = input.trim().toLowerCase().replace(/^mailto:/, '')
  return EMAIL_RE.test(s) ? s : null
}

export const emailDomain = (email: string) => normalizeDomain(email.split('@')[1])

const COMPANY_SUFFIXES = /\b(inc|llc|ltd|limited|corp|corporation|co|company|gmbh|ag|sa|plc|technologies|technology|tech|gaming|official)\b/g

// "Logitech G, Inc." and "logitech g" share the key "logitechg".
export function nameKey(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(COMPANY_SUFFIXES, ' ')
    .replace(/[^a-z0-9]/g, '')
}

export function normalizeUrl(input: string | null | undefined): string | null {
  if (!input) return null
  const s = input.trim()
  if (!s) return null
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    return u.toString()
  } catch {
    return null
  }
}
