// Automatic CRM stage changes from outreach events. Forward-only, only from the listed stages, and always
// logged with the reason, so a stage you set by hand (Negotiating, Paused, Won …) is never overwritten.
import { get, logActivity, nowIso, run, type DB } from '../db'
import { stageLabel, type StageId } from '../core/stages'
import { setStage } from '../crm/prospects'

export const AUTO_STAGE_RULES = {
  contacted: { from: ['qualified', 'draft_ready', 'awaiting_approval'] as StageId[], why: 'First outreach email sent' },
  replied: { from: ['contacted'] as StageId[], why: 'The brand replied in the Gmail conversation' },
} as const

export function autoAdvance(db: DB, prospectId: number | null, to: keyof typeof AUTO_STAGE_RULES): boolean {
  if (!prospectId) return false
  const p = get<{ stage: StageId; company_name: string }>(db, 'SELECT stage, company_name FROM prospects WHERE id = ?', prospectId)
  const rule = AUTO_STAGE_RULES[to]
  if (!p || !rule.from.includes(p.stage)) return false
  setStage(db, prospectId, to, `Automatic: ${rule.why}`)
  logActivity(db, 'outreach.stage_auto', `${stageLabel(p.stage)} → ${stageLabel(to)} automatically: ${rule.why}`, { prospectId })
  return true
}

export function touchContactDates(db: DB, prospectId: number | null, kind: 'outbound' | 'inbound', at = nowIso()) {
  if (!prospectId) return
  if (kind === 'outbound') {
    run(db, 'UPDATE prospects SET first_contacted_at = COALESCE(first_contacted_at, ?), last_contacted_at = CASE WHEN last_contacted_at IS NULL OR last_contacted_at < ? THEN ? ELSE last_contacted_at END WHERE id = ?',
      at, at, at, prospectId)
  } else {
    run(db, 'UPDATE prospects SET last_reply_at = CASE WHEN last_reply_at IS NULL OR last_reply_at < ? THEN ? ELSE last_reply_at END WHERE id = ?', at, at, prospectId)
  }
}
