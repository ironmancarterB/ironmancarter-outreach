// Checks that a domain can receive mail, using free public DNS. This proves nothing about an individual mailbox:
// only a reply shows that an address works, so nothing here ever calls an address deliverable.
import { promises as dns } from 'node:dns'
import { all, get, nowIso, run, type DB } from '../db'
import { emailDomain } from '../core/normalize'

export type MailDomainStatus = 'ok' | 'no_mail' | 'invalid' | 'unknown'
export interface MailDomainResult { status: MailDomainStatus; detail: string }
export type MailLookup = (domain: string) => Promise<MailDomainResult>

const RECHECK_DAYS = 30
const RETRY_UNKNOWN_HOURS = 1
const MISSING = new Set(['ENOTFOUND', 'NXDOMAIN'])
const NO_RECORD = new Set(['ENODATA'])

export const dnsLookup: MailLookup = async (domain) => {
  const resolver = new dns.Resolver({ timeout: 5000, tries: 2 })
  try {
    const mx = await resolver.resolveMx(domain)
    // RFC 7505: a single "." record means the domain declares it accepts no mail.
    if (mx.length === 1 && (mx[0].exchange === '' || mx[0].exchange === '.')) return { status: 'no_mail', detail: 'The domain declares that it accepts no email (null MX).' }
    if (mx.length) return { status: 'ok', detail: `Has mail servers (${mx.length} MX record${mx.length === 1 ? '' : 's'}).` }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? ''
    if (MISSING.has(code)) return { status: 'invalid', detail: 'The domain does not exist in DNS.' }
    if (!NO_RECORD.has(code)) return { status: 'unknown', detail: `DNS lookup failed (${code || 'error'}); will try again.` }
  }
  // No MX record: mail falls back to the domain's address record (RFC 5321 §5.1).
  try {
    if ((await resolver.resolve4(domain)).length) return { status: 'ok', detail: 'No MX record, but the domain has an address record that can accept mail.' }
  } catch (err) {
    if (!NO_RECORD.has((err as NodeJS.ErrnoException).code ?? '')) return { status: 'unknown', detail: 'DNS lookup failed; will try again.' }
  }
  return { status: 'no_mail', detail: 'The domain has no mail servers.' }
}

// Tests never touch real DNS.
const defaultLookup: MailLookup = process.env.VITEST ? async () => ({ status: 'ok', detail: 'Stubbed in tests.' }) : dnsLookup

export const mailDomainStatus = (db: DB, domain: string | null) =>
  domain ? get<{ status: MailDomainStatus; detail: string | null; checked_at: string }>(db, 'SELECT status, detail, checked_at FROM mail_domains WHERE domain = ?', domain) ?? null : null

const isDue = (row: { status: string; checked_at: string } | null, now: number) =>
  !row || now - new Date(row.checked_at).getTime() > (row.status === 'unknown' ? RETRY_UNKNOWN_HOURS * 3_600_000 : RECHECK_DAYS * 86_400_000)

export async function checkMailDomain(db: DB, domain: string, lookup: MailLookup = defaultLookup) {
  const r = await lookup(domain)
  const before = mailDomainStatus(db, domain)
  // A passing lookup is not thrown away because DNS hiccuped later.
  if (r.status === 'unknown' && before && before.status !== 'unknown') return before.status
  run(db, `INSERT INTO mail_domains (domain, status, detail, checked_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(domain) DO UPDATE SET status = excluded.status, detail = excluded.detail, checked_at = excluded.checked_at`, domain, r.status, r.detail, nowIso())
  return r.status
}

// Every address domain on one company's record that has not been checked recently.
export async function ensureMailDomains(db: DB, prospectId: number, lookup: MailLookup = defaultLookup) {
  const now = Date.now()
  const domains = new Set(all<{ email: string }>(db, 'SELECT email FROM contacts WHERE prospect_id = ? AND email IS NOT NULL', prospectId).map((c) => emailDomain(c.email)))
  for (const d of domains) if (d && isDue(mailDomainStatus(db, d), now)) await checkMailDomain(db, d, lookup)
}

// For the worker: picks up addresses added by hand, by import or by contact research, and rechecks old results.
export async function checkDueMailDomains(db: DB, opts: { limit?: number; lookup?: MailLookup } = {}): Promise<number> {
  const now = Date.now()
  const due = new Set<string>()
  for (const { email } of all<{ email: string }>(db, 'SELECT DISTINCT email FROM contacts WHERE email IS NOT NULL')) {
    const d = emailDomain(email)
    if (d && isDue(mailDomainStatus(db, d), now)) due.add(d)
    if (due.size >= (opts.limit ?? 20)) break
  }
  for (const d of due) await checkMailDomain(db, d, opts.lookup)
  return due.size
}
