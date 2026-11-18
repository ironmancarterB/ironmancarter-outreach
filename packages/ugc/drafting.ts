// Batch drafting for UGC: each pitch is written for one company from its own research, then (once your
// portfolio link passes its live check) copied into Gmail as a draft for your review. Nothing is sent: every
// UGC email still needs your approval and the separate send confirmation.
import { all, get, getSetting, logActivity, type DB } from '../db'
import { invalid } from '../core/errors'
import { listLeads } from '../crm/leads'
import type { GmailDeps } from '../gmail/account'
import { createPitchDraft } from '../gmail/drafts'
import { generatePitch, evaluatePitch, getPitch, regeneratePitch } from '../pitch/service'
import type { MailLookup } from '../research/mailDomain'
import { portfolioStatus } from './portfolio'

export const DRAFT_BATCH_SIZES = [10, 25, 50] as const
export const MAX_DRAFT_BATCH = 100

export interface DraftBatchResult {
  requested: number
  pitches: { prospectId: number; company: string; pitchId: number; score: number | null }[]
  gmailDrafts: { prospectId: number; company: string; pitchId: number; recipient: string }[]
  skipped: { prospectId: number; company: string; reason: string }[]
  notes: string[]
}

// Qualified UGC leads with no live pitch yet, best score first. Weak leads are never drafted to fill a batch.
export function draftCandidates(db: DB) {
  const min = getSetting<{ minScore: number }>(db, 'ugc.research').minScore
  const live = new Set(all<{ prospect_id: number }>(db, "SELECT prospect_id FROM pitches WHERE status IN ('draft', 'approved')").map((r) => r.prospect_id))
  return listLeads(db)
    .filter((l) => l.campaign_type === 'ugc' && l.actionable && l.review_status !== 'rejected' && !live.has(l.id) && (l.fit_score ?? 0) >= min)
    .sort((a, b) => (b.fit_score ?? 0) - (a.fit_score ?? 0) || a.id - b.id)
}

const gmailConnected = (db: DB) => get<{ status: string }>(db, "SELECT status FROM mail_accounts WHERE provider = 'gmail' AND status != 'disconnected'")?.status === 'connected'

export async function prepareUgcDrafts(db: DB, opts: { count: number; gmail: GmailDeps | null; dataDir: string; mailLookup?: MailLookup }): Promise<DraftBatchResult> {
  if (!Number.isInteger(opts.count) || opts.count < 1 || opts.count > MAX_DRAFT_BATCH) throw invalid(`Draft batch size must be 1 to ${MAX_DRAFT_BATCH}`)
  const result: DraftBatchResult = { requested: opts.count, pitches: [], gmailDrafts: [], skipped: [], notes: [] }
  const queue = draftCandidates(db)
  for (const lead of queue) {
    if (result.pitches.length >= opts.count) break
    try {
      const p = await generatePitch(db, lead.id, { channel: 'email' }, { mailLookup: opts.mailLookup })
      result.pitches.push({ prospectId: lead.id, company: lead.company_name, pitchId: p.id, score: lead.fit_score })
    } catch (err) {
      result.skipped.push({ prospectId: lead.id, company: lead.company_name, reason: (err as Error).message })
    }
  }
  if (result.pitches.length < opts.count) {
    result.notes.push(`${result.pitches.length} of ${opts.count} drafted: that is every qualified UGC lead without a draft (minimum lead score ${getSetting<{ minScore: number }>(db, 'ugc.research').minScore}). Run research to find more; weak or unverified leads are never used to fill the batch.`)
  }
  const gmail = await createUgcGmailDrafts(db, { gmail: opts.gmail, dataDir: opts.dataDir })
  result.gmailDrafts = gmail.created
  result.skipped.push(...gmail.skipped)
  result.notes.push(...gmail.notes)
  logActivity(db, 'ugc.drafts_prepared', `Prepared ${result.pitches.length} UGC pitch draft(s) and ${result.gmailDrafts.length} Gmail draft(s) for your review. Nothing was sent.`)
  return result
}

// Copies UGC pitches that pass every check into Gmail as drafts. A pitch written before the portfolio link was
// verified is rewritten with the link first (unless you edited it, in which case it is left for you).
export async function createUgcGmailDrafts(db: DB, opts: { gmail: GmailDeps | null; dataDir: string; limit?: number }) {
  const created: DraftBatchResult['gmailDrafts'] = []
  const skipped: DraftBatchResult['skipped'] = []
  const notes: string[] = []
  const portfolio = portfolioStatus(db)
  const waiting = all<{ id: number; prospect_id: number; company_name: string; edited: number; body: string }>(db, `SELECT x.id, x.prospect_id, p.company_name, x.edited, x.body
    FROM pitches x JOIN prospects p ON p.id = x.prospect_id
    WHERE p.campaign_type = 'ugc' AND x.channel = 'email' AND x.status IN ('draft', 'approved')
      AND NOT EXISTS (SELECT 1 FROM gmail_drafts g WHERE g.prospect_id = x.prospect_id AND g.kind = 'pitch' AND g.status IN ('creating', 'created', 'uncertain'))
    ORDER BY p.fit_score DESC, x.id`)
  if (!waiting.length) return { created, skipped, notes }
  if (!portfolio.usable) {
    notes.push(`${waiting.length} UGC pitch(es) are ready in the app but were not copied to Gmail: ${portfolio.reason} They will include the link once it passes its live check.`)
    return { created, skipped, notes }
  }
  if (!opts.gmail || !gmailConnected(db)) {
    notes.push(`${waiting.length} UGC pitch(es) are ready in the app but Gmail is not connected, so no Gmail drafts were created.`)
    return { created, skipped, notes }
  }
  for (const w of waiting.slice(0, opts.limit ?? waiting.length)) {
    try {
      let pitchId = w.id
      if (!w.body.includes(portfolio.link!)) {
        if (w.edited) { skipped.push({ prospectId: w.prospect_id, company: w.company_name, reason: 'You edited this pitch before the portfolio link was verified; add the link and it can go to Gmail.' }); continue }
        pitchId = (await regeneratePitch(db, w.id)).id
      }
      const blockers = evaluatePitch(db, getPitch(db, pitchId)).checks.filter((c) => c.level === 'blocker')
      if (blockers.length) { skipped.push({ prospectId: w.prospect_id, company: w.company_name, reason: blockers.map((b) => b.message).join(' ') }); continue }
      const row = await createPitchDraft(db, opts.gmail, opts.dataDir, pitchId)
      created.push({ prospectId: w.prospect_id, company: w.company_name, pitchId, recipient: row.recipient })
    } catch (err) {
      skipped.push({ prospectId: w.prospect_id, company: w.company_name, reason: (err as Error).message })
      // An uncertain Gmail result stops the batch: nothing more is attempted until you check Gmail.
      if (/uncertain|did not confirm/i.test((err as Error).message)) { notes.push('Stopped: Gmail did not confirm a draft. Use "Check Gmail" on that company before preparing more.'); break }
    }
  }
  return { created, skipped, notes }
}
