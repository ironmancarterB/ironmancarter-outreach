// UGC deals: deliverables, price, usage rights and payment for each project. Everything is entered by you;
// the app never agrees to a price, usage term or contract. Revenue counts only booked projects with an agreed
// price, and "collected" only payments you recorded.
import { all, get, getSetting, logActivity, nowIso, run, tx, type DB, type Param } from '../db'
import { AppError, invalid, notFound } from '../core/errors'
import { getProspect, setStage } from '../crm/prospects'
import { stageLabel, type StageId } from '../core/stages'
import { renderTemplate, getTemplate } from './templates'
import { applySignature, getSignature } from '../pitch/signature'

export const DEAL_STATUSES = ['interested', 'negotiating', 'contract_pending', 'booked', 'delivered', 'declined'] as const
export type DealStatus = (typeof DEAL_STATUSES)[number]
export const USAGE_RIGHTS = ['organic', 'paid_ads', 'paid_ads_whitelisting', 'perpetual', 'custom'] as const
export const RAW_FOOTAGE = ['not_included', 'included', 'extra_fee'] as const
export const CONTRACT_STATUSES = ['none', 'drafted', 'sent', 'signed', 'cancelled'] as const
export const PAYMENT_STATUSES = ['none', 'invoiced', 'partial', 'paid', 'refunded'] as const

export interface UgcDeal {
  id: number
  prospect_id: number
  contact_id: number | null
  title: string
  status: DealStatus
  deliverables: string | null
  video_count: number | null
  quoted_cents: number | null
  negotiated_cents: number | null
  usage_rights: (typeof USAGE_RIGHTS)[number]
  usage_fee_cents: number | null
  paid_ads_duration: string | null
  raw_footage: (typeof RAW_FOOTAGE)[number]
  exclusivity: string | null
  revisions: number | null
  deadline: string | null
  contract_status: (typeof CONTRACT_STATUSES)[number]
  payment_status: (typeof PAYMENT_STATUSES)[number]
  amount_paid_cents: number
  recurring: number
  meeting_at: string | null
  booked_at: string | null
  paid_at: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

export const BOOKED: DealStatus[] = ['booked', 'delivered']

// What a deal is worth once booked: the agreed production price plus any separately agreed usage fee.
export const dealValue = (d: Pick<UgcDeal, 'negotiated_cents' | 'usage_fee_cents'>) => (d.negotiated_cents ?? 0) + (d.usage_fee_cents ?? 0)

// Problems that block saving. Warnings are returned for display.
export function dealProblems(d: Partial<UgcDeal>): { errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  if (d.status && BOOKED.includes(d.status) && d.negotiated_cents == null) errors.push('A booked project needs the agreed price (negotiated price), so revenue is never estimated.')
  if (d.usage_rights === 'perpetual' && d.usage_fee_cents == null) errors.push('Perpetual usage must have its own license fee. It is never included in a production price.')
  if ((d.usage_rights === 'paid_ads' || d.usage_rights === 'paid_ads_whitelisting') && !d.paid_ads_duration?.trim()) errors.push('Paid ad usage needs a duration (for example "30 days").')
  if (d.payment_status === 'paid' && !d.amount_paid_cents) errors.push('Record the amount paid before marking it paid.')
  if (d.status && BOOKED.includes(d.status) && d.contract_status !== 'signed') warnings.push('Booked without a signed agreement.')
  if ((d.usage_rights === 'paid_ads' || d.usage_rights === 'paid_ads_whitelisting') && d.usage_fee_cents == null) warnings.push('Paid ad usage is usually priced separately from production.')
  if (d.raw_footage === 'included') warnings.push('Raw footage is included at no extra fee.')
  if (d.exclusivity?.trim() && !/no(ne)?|not exclusive/i.test(d.exclusivity)) warnings.push('Exclusivity limits other work; make sure it is priced in.')
  return { errors, warnings }
}

const money = (v: unknown, field: string) => {
  if (v == null || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0 || n > 10_000_000) throw invalid(`${field} must be a dollar amount`)
  return Math.round(n * 100)
}
const text = (v: unknown, max = 500) => (v == null ? null : String(v).trim().slice(0, max) || null)
const oneOf = <T extends string>(v: unknown, list: readonly T[], field: string): T => {
  if (!list.includes(v as T)) throw invalid(`${field} must be one of ${list.join(', ')}`)
  return v as T
}
const DATE = /^\d{4}-\d{2}-\d{2}$/

// Input uses dollars (quoted_usd, negotiated_usd, usage_fee_usd, amount_paid_usd); storage uses cents.
function clean(input: Record<string, unknown>): Record<string, Param> {
  const out: Record<string, Param> = {}
  const has = (k: string) => Object.prototype.hasOwnProperty.call(input, k)
  if (has('title')) { const t = text(input.title, 120); if (!t) throw invalid('Give the deal a short title'); out.title = t }
  if (has('status')) out.status = oneOf(input.status, DEAL_STATUSES, 'Status')
  if (has('deliverables')) out.deliverables = text(input.deliverables, 1000)
  if (has('video_count')) {
    const n = input.video_count == null || input.video_count === '' ? null : Number(input.video_count)
    if (n != null && (!Number.isInteger(n) || n < 0 || n > 500)) throw invalid('Number of videos must be a whole number')
    out.video_count = n
  }
  if (has('quoted_usd')) out.quoted_cents = money(input.quoted_usd, 'Quoted price')
  if (has('negotiated_usd')) out.negotiated_cents = money(input.negotiated_usd, 'Negotiated price')
  if (has('usage_fee_usd')) out.usage_fee_cents = money(input.usage_fee_usd, 'Usage fee')
  if (has('amount_paid_usd')) out.amount_paid_cents = money(input.amount_paid_usd, 'Amount paid') ?? 0
  if (has('usage_rights')) out.usage_rights = oneOf(input.usage_rights, USAGE_RIGHTS, 'Usage rights')
  if (has('paid_ads_duration')) out.paid_ads_duration = text(input.paid_ads_duration, 80)
  if (has('raw_footage')) out.raw_footage = oneOf(input.raw_footage, RAW_FOOTAGE, 'Raw footage')
  if (has('exclusivity')) out.exclusivity = text(input.exclusivity, 200)
  if (has('revisions')) {
    const n = input.revisions == null || input.revisions === '' ? null : Number(input.revisions)
    if (n != null && (!Number.isInteger(n) || n < 0 || n > 20)) throw invalid('Revisions must be 0 to 20')
    out.revisions = n
  }
  for (const k of ['deadline', 'meeting_at'] as const) {
    if (has(k)) {
      const v = text(input[k], 10)
      if (v && !DATE.test(v)) throw invalid(`${k === 'deadline' ? 'Deadline' : 'Meeting date'} must be YYYY-MM-DD`)
      out[k] = v
    }
  }
  if (has('contract_status')) out.contract_status = oneOf(input.contract_status, CONTRACT_STATUSES, 'Contract status')
  if (has('payment_status')) out.payment_status = oneOf(input.payment_status, PAYMENT_STATUSES, 'Payment status')
  if (has('recurring')) out.recurring = input.recurring ? 1 : 0
  if (has('notes')) out.notes = text(input.notes, 2000)
  return out
}

export const getDeal = (db: DB, id: number) => {
  const d = get<UgcDeal>(db, 'SELECT * FROM ugc_deals WHERE id = ?', id)
  if (!d) throw notFound('Deal')
  return d
}

export function listDeals(db: DB, prospectId?: number) {
  return all<UgcDeal & { company_name: string }>(db, `SELECT d.*, p.company_name FROM ugc_deals d JOIN prospects p ON p.id = d.prospect_id
    ${prospectId ? 'WHERE d.prospect_id = ?' : ''} ORDER BY d.updated_at DESC`, ...(prospectId ? [prospectId] : []))
    .map((d) => ({ ...d, value_cents: BOOKED.includes(d.status) ? dealValue(d) : null, ...dealProblems(d) }))
}

// The company's CRM stage follows its most advanced deal, which also stops any pending follow-ups.
const STAGE_FOR: Record<DealStatus, StageId> = {
  interested: 'replied', negotiating: 'negotiating', contract_pending: 'proposal_sent', booked: 'won', delivered: 'won', declined: 'not_interested',
}
const RANK: DealStatus[] = ['declined', 'interested', 'negotiating', 'contract_pending', 'booked', 'delivered']

function syncStage(db: DB, prospectId: number) {
  const deals = all<{ status: DealStatus }>(db, 'SELECT status FROM ugc_deals WHERE prospect_id = ?', prospectId)
  if (!deals.length) return
  const top = deals.map((d) => d.status).sort((a, b) => RANK.indexOf(b) - RANK.indexOf(a))[0]
  const stage = STAGE_FOR[top]
  const p = getProspect(db, prospectId)
  if (p.stage === stage || p.stage === 'opted_out') return
  try { setStage(db, prospectId, stage, `UGC deal ${top.replace('_', ' ')}`) } catch (err) {
    logActivity(db, 'ugc.stage_not_synced', `Could not move to "${stageLabel(stage)}": ${(err as Error).message}`, { prospectId })
  }
}

export function createDeal(db: DB, prospectId: number, input: Record<string, unknown>) {
  const p = getProspect(db, prospectId)
  if (p.campaign_type !== 'ugc') throw new AppError(409, 'not_ugc', `${p.company_name} is a sponsorship company. UGC deals are tracked on UGC companies only.`)
  const cols = clean({ title: input.title ?? `${p.company_name} UGC project`, ...input })
  const merged = { status: 'interested', usage_rights: 'organic', raw_footage: 'not_included', contract_status: 'none', payment_status: 'none', amount_paid_cents: 0, ...cols } as Partial<UgcDeal>
  const { errors } = dealProblems(merged)
  if (errors.length) throw new AppError(400, 'invalid_deal', errors.join(' '))
  const contact = get<{ id: number }>(db, 'SELECT id FROM contacts WHERE prospect_id = ? AND email IS NOT NULL ORDER BY is_primary DESC, id LIMIT 1', prospectId)
  const now = nowIso()
  cols.prospect_id = prospectId
  cols.contact_id = contact?.id ?? null
  cols.created_at = now
  cols.updated_at = now
  if (merged.status && BOOKED.includes(merged.status)) cols.booked_at = now
  if (merged.payment_status === 'paid') cols.paid_at = now
  const keys = Object.keys(cols)
  const id = tx(db, () => {
    const id = run(db, `INSERT INTO ugc_deals (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, ...keys.map((k) => cols[k])).lastId
    logActivity(db, 'ugc.deal_created', `Added UGC deal "${cols.title}" (${String(merged.status).replace('_', ' ')})`, { prospectId })
    syncStage(db, prospectId)
    return id
  })
  return getDeal(db, id)
}

export function updateDeal(db: DB, id: number, input: Record<string, unknown>) {
  const before = getDeal(db, id)
  const cols = clean(input)
  const after = { ...before, ...cols } as UgcDeal
  const { errors } = dealProblems(after)
  if (errors.length) throw new AppError(400, 'invalid_deal', errors.join(' '))
  const now = nowIso()
  if (BOOKED.includes(after.status) && !before.booked_at) cols.booked_at = now
  if (!BOOKED.includes(after.status) && before.booked_at && after.status !== 'delivered') cols.booked_at = null
  if (after.payment_status === 'paid' && !before.paid_at) cols.paid_at = now
  if (after.payment_status !== 'paid' && after.payment_status !== 'partial') cols.paid_at = null
  if (after.payment_status === 'partial' && !before.paid_at && after.amount_paid_cents) cols.paid_at = now
  if (!Object.keys(cols).length) return before
  cols.updated_at = now
  const keys = Object.keys(cols)
  tx(db, () => {
    run(db, `UPDATE ugc_deals SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => cols[k]), id)
    logActivity(db, 'ugc.deal_updated', `Updated UGC deal "${after.title}": ${keys.filter((k) => k !== 'updated_at').join(', ')}`, { prospectId: before.prospect_id })
    syncStage(db, before.prospect_id)
  })
  return getDeal(db, id)
}

export function deleteDeal(db: DB, id: number) {
  const d = getDeal(db, id)
  run(db, 'DELETE FROM ugc_deals WHERE id = ?', id)
  logActivity(db, 'ugc.deal_deleted', `Deleted UGC deal "${d.title}"`, { prospectId: d.prospect_id })
}

const usd = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`

// A reply, pricing proposal or retainer proposal written from your templates for you to copy into Gmail.
// Prices come from your pricing guidelines (UGC → Pricing); nothing is sent or agreed.
export function renderDealTemplate(db: DB, dealId: number, slug: string) {
  const d = getDeal(db, dealId)
  const t = getTemplate(db, slug)
  if (!['reply', 'proposal'].includes(t.kind)) throw invalid('Choose a reply or proposal template')
  const p = getProspect(db, d.prospect_id)
  const pricing = getSetting<{ oneVideoUsd: number; threeVideosUsd: number; fiveVideosUsd: number; monthlyFourFromUsd: number }>(db, 'ugc.pricing')
  const contact = d.contact_id ? get<{ name: string | null }>(db, 'SELECT name FROM contacts WHERE id = ?', d.contact_id) : undefined
  const body = renderTemplate(t.body, {
    contact_name: contact?.name?.split(' ')[0] || 'there',
    company: p.company_name,
    deliverables: d.deliverables ?? (d.video_count ? `${d.video_count} edited UGC video${d.video_count === 1 ? '' : 's'}.` : 'a short set of edited UGC videos.'),
    price_1: usd(pricing.oneVideoUsd), price_3: usd(pricing.threeVideosUsd), price_5: usd(pricing.fiveVideosUsd), price_monthly: usd(pricing.monthlyFourFromUsd),
    revisions: String(d.revisions ?? 1),
  })
  return { slug, name: t.name, body: applySignature(body, getSignature(db)), note: 'Copy this into your reply in Gmail and adjust it. Prices are your starting guidelines; nothing was quoted or sent.' }
}
