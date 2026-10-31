// Puts your current signature on every UNSENT draft: pitches (email and manual), pending follow-ups, and their
// Gmail drafts (updated in place, same draft id, never sent). Sent emails and conversation history are not
// touched. A draft you changed in Gmail is left alone and reported, so your Gmail edits are never overwritten.
import { all, logActivity, nowIso, run, type DB } from '../db'
import type { GmailDeps } from '../gmail/account'
import { activeAccount } from '../gmail/account'
import { composeBody, contentHash, updatePitchDraft, type DraftRow } from '../gmail/drafts'
import { applySignature, getSignature } from '../pitch/signature'
import { updateFollowUpDraft } from './followups'

const SENT = "('sending', 'sent', 'uncertain')"

export async function refreshSignatures(db: DB, deps: GmailDeps | null, dataDir: string) {
  const signature = getSignature(db)
  const result = { pitches: 0, followUps: 0, gmailDraftsUpdated: 0, skipped: [] as string[] }

  const pitches = all<{ id: number; prospect_id: number; body: string; version: number }>(db, `SELECT id, prospect_id, body, version FROM pitches p
    WHERE status IN ('draft', 'approved')
      AND NOT EXISTS (SELECT 1 FROM send_attempts s WHERE s.prospect_id = p.prospect_id AND s.kind = 'initial' AND s.status IN ${SENT})`)
  for (const p of pitches) {
    const body = applySignature(p.body, signature)
    if (body === p.body) continue
    // A signature-only change keeps the pitch's approval; it is logged.
    run(db, 'UPDATE pitches SET body = ?, updated_at = ? WHERE id = ?', body, nowIso(), p.id)
    logActivity(db, 'pitch.signature', `Updated the signature on unsent pitch v${p.version}`, { prospectId: p.prospect_id })
    result.pitches++
  }
  for (const f of all<{ id: number; prospect_id: number; body: string; sequence: number }>(db, "SELECT id, prospect_id, body, sequence FROM follow_ups WHERE status IN ('scheduled', 'approved')")) {
    const body = applySignature(f.body, signature)
    if (body === f.body) continue
    run(db, 'UPDATE follow_ups SET body = ?, updated_at = ? WHERE id = ?', body, nowIso(), f.id)
    logActivity(db, 'followup.signature', `Updated the signature on unsent follow-up ${f.sequence}`, { prospectId: f.prospect_id })
    result.followUps++
  }

  // Gmail copies of those drafts: replace their content in place. Nothing is sent.
  const drafts = all<DraftRow & { pitch_status: string | null; follow_status: string | null; pitch_body: string | null; pitch_subject: string | null; pitch_to: string | null; follow_body: string | null; follow_subject: string | null }>(db, `
    SELECT g.*, p.status AS pitch_status, p.body AS pitch_body, p.subject AS pitch_subject, p.recipient_email AS pitch_to,
      f.status AS follow_status, f.body AS follow_body, f.subject AS follow_subject
    FROM gmail_drafts g LEFT JOIN pitches p ON p.id = g.pitch_id LEFT JOIN follow_ups f ON f.id = g.follow_up_id
    WHERE g.status = 'created' AND g.kind IN ('pitch', 'follow_up')`)
    // Only drafts whose Gmail copy differs from the current text need updating.
    .filter((d) => d.kind === 'pitch'
      ? d.pitch_body != null && d.content_sha256 !== contentHash(d.pitch_to ?? d.recipient, d.pitch_subject ?? '', composeBody(db, 'pitch', d.pitch_body), d.attachment_sha256)
      : d.follow_body != null && d.content_sha256 !== contentHash(d.recipient, d.follow_subject ?? '', composeBody(db, 'follow_up', d.follow_body), null))
  if (drafts.length && (!deps || activeAccount(db)?.status !== 'connected')) {
    result.skipped.push(`${drafts.length} Gmail draft(s) not updated: Gmail is not connected. They show as "out of date"; update them after reconnecting.`)
    return result
  }
  for (const d of drafts) {
    const label = `Gmail draft to ${d.recipient}`
    if (d.edited_in_gmail) { result.skipped.push(`${label}: you changed it in Gmail, so it was left as is.`); continue }
    try {
      if (d.kind === 'pitch' && d.pitch_id) {
        if (d.pitch_status !== 'approved') { result.skipped.push(`${label}: its pitch is not approved, so Gmail was not updated.`); continue }
        await updatePitchDraft(db, deps!, dataDir, d.pitch_id)
        result.gmailDraftsUpdated++
      } else if (d.kind === 'follow_up' && d.follow_up_id) {
        if (d.follow_status !== 'approved') { result.skipped.push(`${label}: the follow-up is not approved, so Gmail was not updated.`); continue }
        await updateFollowUpDraft(db, deps!, d.follow_up_id)
        result.gmailDraftsUpdated++
      }
    } catch (err) {
      result.skipped.push(`${label}: ${(err as Error).message}`)
    }
  }
  if (result.pitches || result.followUps || result.gmailDraftsUpdated) {
    logActivity(db, 'outreach.signature_refreshed', `Signature applied to ${result.pitches} pitch(es), ${result.followUps} follow-up(s) and ${result.gmailDraftsUpdated} Gmail draft(s). Nothing was sent.`)
  }
  return result
}
