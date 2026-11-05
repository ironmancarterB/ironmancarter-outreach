// Numbers for the Overview page. Everything is computed from stored data; nothing is estimated.
import { all, get, getSetting, type DB } from '../db'
import { ACTIVE_DEAL_STAGES, STAGES } from '../core/stages'
import { paidSpendThisMonth } from '../ai/router'
import { getDefaultMediaKit } from '../mediakit/store'
import { contactEligibility, type Contact, type Prospect } from './prospects'
import { limitsStatus } from '../outreach/send'
import { leadMetrics, listLeads } from './leads'

export function overview(db: DB, now = new Date()) {
  const tierSlug = getSetting<string>(db, 'outreach.sendingTier')
  const tier = get<{ slug: string; name: string; daily_limit: number; weekly_limit: number }>(db, 'SELECT * FROM sending_tiers WHERE slug = ?', tierSlug)!
  const autopilot = getSetting<boolean>(db, 'outreach.autopilotEnabled')
  const liveSending = getSetting<boolean>(db, 'outreach.liveSendingEnabled')
  const limits = limitsStatus(db, now)

  const stageCounts = Object.fromEntries(STAGES.map((s) => [s.id, 0])) as Record<string, number>
  for (const r of all<{ stage: string; n: number }>(db, 'SELECT stage, count(*) AS n FROM prospects GROUP BY stage')) stageCounts[r.stage] = r.n

  const prospects = new Map(all<Prospect>(db, 'SELECT * FROM prospects').map((p) => [p.id, p]))
  const contacts = all<Contact>(db, 'SELECT * FROM contacts')
  const eligibleCompanies = new Set<number>()
  const reviewCompanies = new Set<number>()
  let manualQueue = 0
  for (const c of contacts) {
    const p = prospects.get(c.prospect_id)!
    if (!c.email && c.contact_form_url) manualQueue++
    const e = contactEligibility(db, c, p)
    if (e.status === 'eligible') eligibleCompanies.add(p.id)
    else if (e.status === 'needs_review') reviewCompanies.add(p.id)
  }

  const today = now.toISOString().slice(0, 10)
  const money = get<{ won: number | null; collected: number | null; pipeline: number | null; wonCount: number }>(db, `
    SELECT
      sum(CASE WHEN stage = 'won' THEN negotiated_value_cents END) AS won,
      sum(CASE WHEN stage = 'won' AND payment_status = 'paid' THEN negotiated_value_cents END) AS collected,
      sum(CASE WHEN stage IN ('replied', 'negotiating', 'proposal_sent') THEN COALESCE(negotiated_value_cents, potential_value_cents) END) AS pipeline,
      count(CASE WHEN stage = 'won' THEN 1 END) AS wonCount
    FROM prospects`)!

  const leads = listLeads(db)
  return {
    leads: leadMetrics(db, leads),
    outreach: {
      autopilotEnabled: autopilot,
      liveSendingEnabled: liveSending,
      mode: getSetting<string>(db, 'outreach.mode'),
      tier,
      // Counted from the send records (manual sends only; autopilot does not exist).
      sentToday: limits.total.sent,
      sentThisWeek: limits.weekNew.sent,
      remainingToday: liveSending ? Math.min(limits.newEmails.remaining, limits.total.remaining) : 0,
      remainingThisWeek: liveSending ? limits.weekNew.remaining : 0,
    },
    prospects: {
      total: prospects.size,
      byStage: stageCounts,
      verifiedAvailable: eligibleCompanies.size,
      needsReview: reviewCompanies.size,
      manualContactQueue: manualQueue,
      activeNegotiations: ACTIVE_DEAL_STAGES.reduce((n, s) => n + stageCounts[s], 0),
      followUpsScheduled: get<{ n: number }>(db, 'SELECT count(*) AS n FROM prospects WHERE next_follow_up_date >= ?', today)!.n,
      pendingReview: leads.filter((l) => l.actionable && l.review_status === 'pending').length,
      approved: get<{ n: number }>(db, "SELECT count(*) AS n FROM prospects WHERE review_status = 'approved'")!.n,
    },
    repliesNeedingAttention: get<{ n: number }>(db, 'SELECT count(*) AS n FROM email_threads WHERE needs_review = 1')!.n,
    revenue: {
      contractedCents: money.won ?? 0,
      collectedCents: money.collected ?? 0,
      openPipelineCents: money.pipeline ?? 0,
      dealsWon: money.wonCount,
    },
    mediaKit: getDefaultMediaKit(db) ?? null,
    ai: {
      provider: getSetting<string>(db, 'ai.provider'),
      paidEnabled: getSetting<boolean>(db, 'ai.paidEnabled'),
      budgetUsd: getSetting<number>(db, 'ai.monthlyBudgetUsd'),
      paidSpendThisMonthUsd: paidSpendThisMonth(db, now),
    },
    categories: all<{ id: number; name: string; enabled: number; prospects: number }>(db, `
      SELECT c.id, c.name, c.enabled, count(p.id) AS prospects FROM categories c
      LEFT JOIN prospects p ON p.category_id = c.id GROUP BY c.id ORDER BY c.sort_order`),
    recentActivity: all<{ id: number; prospect_id: number | null; type: string; summary: string; created_at: string; company_name: string | null }>(db, `
      SELECT a.id, a.prospect_id, a.type, a.summary, a.created_at, p.company_name FROM activities a
      LEFT JOIN prospects p ON p.id = a.prospect_id ORDER BY a.id DESC LIMIT 15`),
  }
}
