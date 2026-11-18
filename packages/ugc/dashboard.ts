// UGC pipeline and performance, computed from stored facts on every request (never stored, never estimated).
// UGC numbers are kept apart from sponsorship numbers; unconfirmed offers never count as revenue.
import { all, get, getSetting, type DB } from '../db'
import { calendar, dayKey, zonedTime } from '../outreach/businessDays'
import { listLeads } from '../crm/leads'
import { BOOKED, dealValue, type UgcDeal } from './deals'
import { portfolioStatus } from './portfolio'

export const UGC_STAGES = [
  { id: 'prospect_identified', label: 'Prospect identified' },
  { id: 'contact_verified', label: 'Contact verified' },
  { id: 'draft_prepared', label: 'Draft prepared' },
  { id: 'email_sent', label: 'Email sent' },
  { id: 'follow_up_due', label: 'Follow-up due' },
  { id: 'replied', label: 'Replied' },
  { id: 'interested', label: 'Interested' },
  { id: 'negotiating', label: 'Negotiating' },
  { id: 'contract_pending', label: 'Contract pending' },
  { id: 'project_booked', label: 'Project booked' },
  { id: 'content_delivered', label: 'Content delivered' },
  { id: 'payment_received', label: 'Payment received' },
  { id: 'recurring_client', label: 'Recurring client' },
  { id: 'declined', label: 'Declined' },
] as const
export type UgcStageId = (typeof UGC_STAGES)[number]['id']

const SENT = "('sending', 'sent', 'uncertain')"

export interface PipelineRow {
  id: number
  company_name: string
  domain: string | null
  category_name: string | null
  fit_score: number | null
  stage: UgcStageId
  stage_label: string
  email: string | null
  review_status: string
  pitch_id: number | null
  pitch_status: string | null
  gmail_draft: boolean
  sent_at: string | null
  next_follow_up_at: string | null
  booked_cents: number
  collected_cents: number
  exclusion: string | null
}

export function ugcPipeline(db: DB, now = new Date()): PipelineRow[] {
  const leads = new Map(listLeads(db).filter((l) => l.campaign_type === 'ugc').map((l) => [l.id, l]))
  const prospects = all<{ id: number; company_name: string; domain: string | null; fit_score: number | null; stage: string; review_status: string; category_name: string | null }>(db,
    `SELECT p.id, p.company_name, p.domain, p.fit_score, p.stage, p.review_status, c.name AS category_name FROM prospects p
     LEFT JOIN categories c ON c.id = p.category_id WHERE p.campaign_type = 'ugc'`)
  const byP = <T extends { prospect_id: number }>(rows: T[]) => rows.reduce((m, r) => m.set(r.prospect_id, [...(m.get(r.prospect_id) ?? []), r]), new Map<number, T[]>())
  const deals = byP(all<UgcDeal>(db, 'SELECT * FROM ugc_deals'))
  const pitches = new Map(all<{ prospect_id: number; id: number; status: string }>(db, "SELECT prospect_id, id, status FROM pitches WHERE status IN ('draft', 'approved') AND channel = 'email'").map((r) => [r.prospect_id, r]))
  const drafts = new Set(all<{ prospect_id: number }>(db, `SELECT DISTINCT prospect_id FROM gmail_drafts WHERE kind = 'pitch' AND status IN ('creating', 'created', 'uncertain') AND prospect_id IS NOT NULL`).map((r) => r.prospect_id))
  const sends = new Map(all<{ prospect_id: number; sent_at: string | null; created_at: string }>(db, `SELECT prospect_id, sent_at, created_at FROM send_attempts WHERE kind = 'initial' AND status IN ${SENT} AND prospect_id IS NOT NULL`).map((r) => [r.prospect_id, r]))
  const followUps = new Map(all<{ prospect_id: number; due_at: string }>(db, "SELECT prospect_id, min(due_at) AS due_at FROM follow_ups WHERE status IN ('scheduled', 'approved') GROUP BY prospect_id").map((r) => [r.prospect_id, r.due_at]))
  const replies = new Set(all<{ prospect_id: number }>(db, `SELECT DISTINCT t.prospect_id FROM email_messages m JOIN email_threads t ON t.id = m.thread_id
    WHERE m.direction = 'inbound' AND m.kind = 'reply' AND t.prospect_id IS NOT NULL`).map((r) => r.prospect_id))
  const positive = new Set(all<{ prospect_id: number }>(db, `SELECT DISTINCT t.prospect_id FROM email_messages m JOIN email_threads t ON t.id = m.thread_id
    WHERE m.direction = 'inbound' AND m.kind = 'reply' AND m.classification = 'interested' AND t.prospect_id IS NOT NULL`).map((r) => r.prospect_id))

  return prospects.map((p) => {
    const lead = leads.get(p.id)
    const ds = deals.get(p.id) ?? []
    const live = ds.filter((d) => d.status !== 'declined')
    const booked = ds.filter((d) => BOOKED.includes(d.status))
    const has = (s: string) => live.some((d) => d.status === s)
    const send = sends.get(p.id)
    const due = followUps.get(p.id) ?? null
    let stage: UgcStageId
    if (booked.length >= 2 || booked.some((d) => d.recurring)) stage = 'recurring_client'
    else if (booked.some((d) => d.payment_status === 'paid')) stage = 'payment_received'
    else if (has('delivered')) stage = 'content_delivered'
    else if (has('booked')) stage = 'project_booked'
    else if (has('contract_pending')) stage = 'contract_pending'
    else if (has('negotiating')) stage = 'negotiating'
    else if (has('interested')) stage = 'interested'
    else if (ds.length && !live.length) stage = 'declined'
    else if (['not_interested', 'opted_out', 'lost'].includes(p.stage)) stage = 'declined'
    else if (positive.has(p.id)) stage = 'interested'
    else if (replies.has(p.id) || p.stage === 'replied') stage = 'replied'
    else if (send) stage = due && due <= now.toISOString() ? 'follow_up_due' : 'email_sent'
    else if (pitches.has(p.id) || drafts.has(p.id)) stage = 'draft_prepared'
    else if (lead?.has_qualifying_email) stage = 'contact_verified'
    else stage = 'prospect_identified'
    const pitch = pitches.get(p.id)
    return {
      id: p.id, company_name: p.company_name, domain: p.domain, category_name: p.category_name, fit_score: p.fit_score,
      stage, stage_label: UGC_STAGES.find((s) => s.id === stage)!.label,
      email: lead?.email ?? null, review_status: p.review_status,
      pitch_id: pitch?.id ?? null, pitch_status: pitch?.status ?? null, gmail_draft: drafts.has(p.id),
      sent_at: send?.sent_at ?? send?.created_at ?? null, next_follow_up_at: due,
      booked_cents: booked.reduce((n, d) => n + dealValue(d), 0),
      collected_cents: ds.reduce((n, d) => n + d.amount_paid_cents, 0),
      exclusion: lead?.exclusion?.label ?? null,
    }
  }).sort((a, b) => UGC_STAGES.findIndex((s) => s.id === b.stage) - UGC_STAGES.findIndex((s) => s.id === a.stage) || (b.fit_score ?? 0) - (a.fit_score ?? 0))
}

export type Period = 'day' | 'week' | 'month'

// Start of today / this week (Monday) / this month in your business time zone.
export function periodStart(period: Period, now: Date, timezone: string): Date {
  const [y, m, d] = dayKey(now, timezone).split('-').map(Number)
  if (period === 'month') return zonedTime(y, m, 1, 0, 0, timezone)
  if (period === 'week') {
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
    const back = (dow + 6) % 7
    const monday = new Date(Date.UTC(y, m - 1, d - back))
    return zonedTime(monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate(), 0, 0, timezone)
  }
  return zonedTime(y, m, d, 0, 0, timezone)
}

const rate = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null)

export function ugcMetrics(db: DB, period: Period, now = new Date()) {
  const since = periodStart(period, now, calendar(db).timezone).toISOString()
  const n = (sql: string, ...params: (string | number)[]) => get<{ n: number | null }>(db, sql, ...params)!.n ?? 0
  const UGC_P = "SELECT id FROM prospects WHERE campaign_type = 'ugc'"
  const UGC_BATCH = "SELECT id FROM research_batches WHERE campaign_type = 'ugc'"
  const researched = n(`SELECT count(*) AS n FROM research_candidates WHERE batch_id IN (${UGC_BATCH}) AND status IN ('done', 'duplicate', 'unreachable', 'blocked', 'failed') AND finished_at >= ?`, since)
  const qualified = n(`SELECT count(*) AS n FROM research_candidates WHERE batch_id IN (${UGC_BATCH}) AND qualified = 1 AND finished_at >= ?`, since)
  const verifiedContacts = n(`SELECT count(DISTINCT prospect_id) AS n FROM contacts WHERE prospect_id IN (${UGC_P}) AND email IS NOT NULL AND verification_status = 'verified' AND created_at >= ?`, since)
  const pitchesDrafted = n(`SELECT count(DISTINCT prospect_id) AS n FROM pitches WHERE prospect_id IN (${UGC_P}) AND created_at >= ?`, since)
  const gmailDrafts = n(`SELECT count(*) AS n FROM gmail_drafts WHERE kind = 'pitch' AND prospect_id IN (${UGC_P}) AND status NOT IN ('failed') AND created_at >= ?`, since)
  const approved = n(`SELECT count(*) AS n FROM pitches WHERE prospect_id IN (${UGC_P}) AND reviewed_at >= ? AND status IN ('approved', 'superseded') AND reject_reason IS NULL`, since)
  const sent = n(`SELECT count(*) AS n FROM send_attempts WHERE kind = 'initial' AND status = 'sent' AND prospect_id IN (${UGC_P}) AND COALESCE(sent_at, created_at) >= ?`, since)
  const followUpsSent = n(`SELECT count(*) AS n FROM send_attempts WHERE kind = 'follow_up' AND status = 'sent' AND prospect_id IN (${UGC_P}) AND COALESCE(sent_at, created_at) >= ?`, since)
  const failures = n(`SELECT count(*) AS n FROM send_attempts WHERE status IN ('failed', 'uncertain') AND prospect_id IN (${UGC_P}) AND created_at >= ?`, since)
    + n(`SELECT count(*) AS n FROM email_messages m JOIN email_threads t ON t.id = m.thread_id WHERE m.kind = 'bounce' AND t.prospect_id IN (${UGC_P}) AND COALESCE(m.message_at, m.created_at) >= ?`, since)
  const replies = n(`SELECT count(DISTINCT t.prospect_id) AS n FROM email_messages m JOIN email_threads t ON t.id = m.thread_id
    WHERE m.direction = 'inbound' AND m.kind = 'reply' AND t.prospect_id IN (${UGC_P}) AND COALESCE(m.message_at, m.created_at) >= ?`, since)
  const positive = n(`SELECT count(DISTINCT t.prospect_id) AS n FROM email_messages m JOIN email_threads t ON t.id = m.thread_id
    WHERE m.direction = 'inbound' AND m.kind = 'reply' AND m.classification = 'interested' AND t.prospect_id IN (${UGC_P}) AND COALESCE(m.message_at, m.created_at) >= ?`, since)
  const meetings = n('SELECT count(*) AS n FROM ugc_deals WHERE meeting_at >= ?', since.slice(0, 10))
  const closed = n("SELECT count(*) AS n FROM ugc_deals WHERE status IN ('booked', 'delivered') AND booked_at >= ?", since)
  const booked = n("SELECT sum(COALESCE(negotiated_cents, 0) + COALESCE(usage_fee_cents, 0)) AS n FROM ugc_deals WHERE status IN ('booked', 'delivered') AND booked_at >= ?", since)
  const collected = n('SELECT sum(amount_paid_cents) AS n FROM ugc_deals WHERE paid_at >= ?', since)
  return {
    period, since,
    researched, qualified, verifiedContacts, pitchesDrafted, gmailDrafts, approved, sent, followUpsSent, failures, replies, positive, meetings, closed,
    revenueBookedCents: booked, revenueCollectedCents: collected,
    conversion: {
      qualifiedOfResearched: rate(qualified, researched),
      approvedOfDrafted: rate(approved, pitchesDrafted),
      repliesOfSent: rate(replies, sent),
      positiveOfReplies: rate(positive, replies),
      closedOfPositive: rate(closed, positive),
    },
  }
}

// Research and verification costs. Research reads public pages and checks mail domains with free DNS, so its
// cost is $0; AI calls (if you enable a paid provider) are counted from the usage ledger.
export function ugcCosts(db: DB, now = new Date()) {
  const since = periodStart('day', now, calendar(db).timezone).toISOString()
  const fetches = get<{ n: number }>(db, `SELECT count(*) AS n FROM research_fetches f JOIN research_candidates rc ON rc.id = f.candidate_id
    JOIN research_batches b ON b.id = rc.batch_id WHERE b.campaign_type = 'ugc' AND f.fetched_at >= ?`, since)!.n
  const qualified = get<{ n: number }>(db, `SELECT count(*) AS n FROM research_candidates rc JOIN research_batches b ON b.id = rc.batch_id
    WHERE b.campaign_type = 'ugc' AND rc.qualified = 1 AND rc.finished_at >= ?`, since)!.n
  const ai = get<{ usd: number | null; calls: number }>(db, "SELECT sum(est_cost_usd) AS usd, count(*) AS calls FROM ai_usage WHERE created_at >= ? AND status IN ('ok', 'cached')", since)!
  const alertUsd = getSetting<{ dailyAlertUsd: number }>(db, 'ugc.costs').dailyAlertUsd
  const estimatedUsd = Math.round((ai.usd ?? 0) * 100) / 100
  const flags: string[] = []
  if (estimatedUsd > alertUsd) flags.push(`Today's estimated AI cost ($${estimatedUsd.toFixed(2)}) is above your $${alertUsd} alert.`)
  if (qualified && fetches / qualified > 80) flags.push(`Research is reading ${Math.round(fetches / qualified)} pages per qualified lead today; most candidates are not publishing usable emails.`)
  return {
    estimatedUsd, alertUsd, flags,
    lines: [
      { item: 'Website research', detail: `${fetches} page request(s) today`, usd: 0 },
      { item: 'Email domain checks', detail: 'Free public DNS lookups', usd: 0 },
      { item: 'Email verification service', detail: 'None used (only published, sourced addresses)', usd: 0 },
      { item: 'AI', detail: ai.calls ? `${ai.calls} call(s) today (${getSetting<string>(db, 'ai.provider')} provider)` : `None today (${getSetting<string>(db, 'ai.provider')} provider)`, usd: estimatedUsd },
    ],
  }
}

export function ugcOverview(db: DB, now = new Date()) {
  const pipeline = ugcPipeline(db, now)
  const count = (ids: UgcStageId[]) => pipeline.filter((r) => ids.includes(r.stage)).length
  const deals = all<UgcDeal>(db, 'SELECT * FROM ugc_deals')
  const sponsorship = get<{ won: number | null; collected: number | null }>(db, `SELECT
    sum(CASE WHEN stage = 'won' THEN negotiated_value_cents END) AS won,
    sum(CASE WHEN stage = 'won' AND payment_status = 'paid' THEN negotiated_value_cents END) AS collected
    FROM prospects WHERE campaign_type = 'sponsorship'`)!
  const research = getSetting<{ dailyTarget: number; autoDaily: boolean; minScore: number; autoDraft: boolean }>(db, 'ugc.research')
  const pool = get<{ n: number }>(db, `SELECT count(*) AS n FROM candidate_pool cp JOIN categories c ON c.id = cp.category_id
    WHERE c.campaign_type = 'ugc' AND c.enabled = 1 AND cp.status = 'available' AND NOT EXISTS (SELECT 1 FROM prospects p WHERE p.domain = cp.domain)`)!.n
  return {
    totals: {
      prospects: pipeline.length,
      verifiedContacts: pipeline.filter((r) => r.email).length,
      draftsAwaitingApproval: pipeline.filter((r) => r.pitch_status === 'draft').length,
      emailsSent: pipeline.filter((r) => r.sent_at).length,
      replies: count(['replied', 'interested', 'negotiating', 'contract_pending', 'project_booked', 'content_delivered', 'payment_received', 'recurring_client']),
      interested: count(['interested']),
      negotiating: count(['negotiating', 'contract_pending']),
      booked: count(['project_booked', 'content_delivered', 'payment_received', 'recurring_client']),
      recurringClients: count(['recurring_client']),
      revenueBookedCents: deals.filter((d) => BOOKED.includes(d.status)).reduce((n, d) => n + dealValue(d), 0),
      revenueCollectedCents: deals.reduce((n, d) => n + d.amount_paid_cents, 0),
    },
    sponsorship: { revenueBookedCents: sponsorship.won ?? 0, revenueCollectedCents: sponsorship.collected ?? 0 },
    stages: UGC_STAGES.map((s) => ({ ...s, count: count([s.id]) })),
    portfolio: portfolioStatus(db, now),
    research: { ...research, poolAvailable: pool },
    lastDaily: getSetting<unknown>(db, 'ugc.lastDaily') ?? null,
  }
}
