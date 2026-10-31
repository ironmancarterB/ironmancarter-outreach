// Approved pitches → Gmail drafts. Drafts only: nothing here sends, and approving a pitch is not permission to send.
//
// Duplicate safety:
// - a row is written (status 'creating') before the request goes out; unique indexes allow one live Gmail
//   draft per pitch and per company;
// - if Google's answer is lost (timeout, network, server error) the row becomes 'uncertain' and is never
//   retried automatically. "Check Gmail" looks for the draft by the unique reference in its MIME boundary (Gmail
//   replaces any Message-ID the app sets, but keeps the boundary); only you can mark it as not created;
// - updates replace the content of the same Gmail draft id, so they cannot create a second draft.
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { all, get, getSetting, logActivity, nowIso, run, tx, type DB } from '../db'
import { AppError, notFound } from '../core/errors'
import { isDomainSuppressed, isEmailSuppressed } from '../crm/suppressions'
import { getDefaultMediaKit, mediaKitFilePath, type MediaKit } from '../mediakit/store'
import { evaluatePitch, getPitch } from '../pitch/service'
import { accessToken, opFail, opFinish, opStart, type GmailDeps } from './account'
import { gmailDraftLink, GoogleError, type GmailDraft } from './google'
import { boundaryFor, boundaryOf, buildMessage, parseMessage, sha256 } from './mime'

export interface DraftRow {
  id: number
  kind: 'pitch' | 'test'
  pitch_id: number | null
  prospect_id: number | null
  account_id: number
  status: 'creating' | 'created' | 'uncertain' | 'failed' | 'gone' | 'unlinked'
  local_ref: string
  rfc822_message_id: string
  gmail_draft_id: string | null
  gmail_message_id: string | null
  gmail_thread_id: string | null
  recipient: string
  subject: string | null
  content_sha256: string
  media_kit_id: number | null
  attachment_filename: string | null
  attachment_sha256: string | null
  attachment_check: string | null
  attachment_verified_at: string | null
  edited_in_gmail: number
  last_synced_at: string | null
  sync_note: string | null
  error: string | null
  created_at: string
  updated_at: string
}

const LIVE = "('creating', 'created', 'uncertain')"

export const getDraftRow = (db: DB, id: number) => {
  const r = get<DraftRow>(db, 'SELECT * FROM gmail_drafts WHERE id = ?', id)
  if (!r) throw notFound('Gmail draft record')
  return r
}

const liveForCompany = (db: DB, prospectId: number) =>
  get<DraftRow>(db, `SELECT * FROM gmail_drafts WHERE prospect_id = ? AND kind = 'pitch' AND status IN ${LIVE}`, prospectId)

// After a crash or restart: a request that was in flight may or may not have reached Google.
export function recoverInterrupted(db: DB) {
  const stuck = all<DraftRow>(db, "SELECT * FROM gmail_drafts WHERE status = 'creating'")
  tx(db, () => {
    for (const r of stuck) {
      run(db, "UPDATE gmail_drafts SET status = 'uncertain', sync_note = ?, updated_at = ? WHERE id = ?",
        'The app stopped while this draft was being created, so it may or may not exist in Gmail. It was not retried.', nowIso(), r.id)
      logActivity(db, 'gmail.draft_uncertain', `Gmail draft for ${r.recipient} has an uncertain status after a restart. It was not retried.`, { prospectId: r.prospect_id })
    }
    run(db, "UPDATE gmail_operations SET status = 'uncertain', detail = COALESCE(detail || ' · ', '') || 'interrupted by a restart', finished_at = ? WHERE status = 'started'", nowIso())
  })
  return stuck.length
}

// ---------- Attachment ----------

interface LoadedKit { kit: MediaKit; data: Buffer; sha: string }

function loadDefaultKit(db: DB, dataDir: string, expectedKitId: number | null): LoadedKit {
  const kit = getDefaultMediaKit(db)
  if (!kit) throw new AppError(409, 'no_media_kit', 'There is no default media kit to attach.')
  if (expectedKitId != null && kit.id !== expectedKitId) {
    throw new AppError(409, 'media_kit_changed', `This pitch was written for media kit #${expectedKitId}, but the default is now v${kit.version}. Regenerate the pitch first.`)
  }
  const path = mediaKitFilePath(dataDir, kit)
  if (!existsSync(path)) throw new AppError(409, 'media_kit_missing', `The media kit file ${kit.stored_filename} is missing.`)
  const data = readFileSync(path)
  const sha = sha256(data)
  if (sha !== kit.sha256) throw new AppError(409, 'media_kit_checksum', `The stored media kit v${kit.version} does not match its recorded checksum. It will not be attached.`)
  return { kit, data, sha }
}

const contentHash = (to: string, subject: string, body: string, kitSha: string) => sha256(JSON.stringify([to.toLowerCase(), subject, body, kitSha]))

function buildRaw(db: DB, account: { email: string }, m: { to: string; subject: string; body: string; ref: string }, kit: LoadedKit) {
  return buildMessage({
    from: { name: getSetting<string>(db, 'business.creatorName'), email: account.email },
    to: m.to, subject: m.subject, body: m.body, boundary: boundaryFor(m.ref),
    attachment: { filename: kit.kit.original_filename, mimeType: 'application/pdf', data: kit.data },
  })
}

// ---------- Verification: read the draft back from Gmail and compare byte for byte ----------

export interface VerifyResult {
  ok: boolean
  checkedAt: string
  checks: { label: string; ok: boolean; detail: string }[]
}

export async function verifyDraft(db: DB, deps: GmailDeps, rowId: number, expectedBody?: string): Promise<VerifyResult | null> {
  const row = getDraftRow(db, rowId)
  if (!row.gmail_draft_id) return null
  const { account, token } = await accessToken(db, deps)
  const op = opStart(db, 'get_draft', account.id, row.id, 'read back for verification')
  let draft: GmailDraft
  try {
    draft = await deps.api.getDraft(token, row.gmail_draft_id, 'raw')
    opFinish(db, op, 'ok')
  } catch (err) {
    opFail(db, op, err)
    if (err instanceof GoogleError && err.status === 404) markGone(db, row)
    run(db, 'UPDATE gmail_drafts SET sync_note = ?, updated_at = ? WHERE id = ?', `Could not read the draft back: ${(err as Error).message}`, nowIso(), row.id)
    return null
  }
  const parsed = parseMessage(Buffer.from(draft.message.raw ?? '', 'base64url'))
  const kit = row.media_kit_id ? get<MediaKit>(db, 'SELECT * FROM media_kits WHERE id = ?', row.media_kit_id) : undefined
  const pdfs = parsed.parts.filter((p) => p.filename || p.contentType === 'application/pdf')
  const pdf = pdfs[0]
  const text = parsed.parts.find((p) => p.contentType === 'text/plain' && !p.filename)
  const norm = (s: string) => s.replace(/\r\n/g, '\n').trim()
  const checks: VerifyResult['checks'] = [
    { label: 'Recipient', ok: (parsed.headers.to ?? '').toLowerCase().includes(row.recipient.toLowerCase()), detail: parsed.headers.to ?? 'missing' },
    { label: 'Subject', ok: (parsed.headers.subject ?? '') === (row.subject ?? ''), detail: parsed.headers.subject ?? 'missing' },
    { label: 'Sender', ok: (parsed.headers.from ?? '').toLowerCase().includes(account.email), detail: parsed.headers.from ?? 'missing' },
    { label: 'Exactly one attachment', ok: pdfs.length === 1, detail: `${pdfs.length} found` },
  ]
  if (expectedBody !== undefined) checks.push({ label: 'Body matches what the app wrote', ok: !!text && norm(text.data.toString('utf8')) === norm(expectedBody), detail: text ? `${text.data.length} bytes` : 'no text part' })
  if (pdf) {
    const got = sha256(pdf.data)
    checks.push(
      { label: 'Attachment is a PDF', ok: pdf.contentType === 'application/pdf' && pdf.data.subarray(0, 5).toString('latin1') === '%PDF-', detail: pdf.contentType },
      { label: 'Attachment file name', ok: pdf.filename === row.attachment_filename, detail: pdf.filename ?? 'none' },
      { label: 'Attachment size', ok: !!kit && pdf.data.length === kit.size_bytes, detail: `${pdf.data.length.toLocaleString('en-US')} bytes` },
      { label: `Attachment identical to media kit v${kit?.version ?? '?'} (SHA-256)`, ok: !!kit && got === kit.sha256 && got === row.attachment_sha256, detail: got },
    )
  }
  const result: VerifyResult = { ok: checks.every((c) => c.ok), checkedAt: nowIso(), checks }
  // Gmail assigns its own Message-ID; keep it for matching replies later (In-Reply-To / References).
  const gmailMessageIdHeader = parsed.headers['message-id'] ?? row.rfc822_message_id
  run(db, 'UPDATE gmail_drafts SET attachment_check = ?, attachment_verified_at = ?, gmail_message_id = ?, rfc822_message_id = ?, last_synced_at = ?, updated_at = ? WHERE id = ?',
    JSON.stringify(result), result.ok ? result.checkedAt : null, draft.message.id, gmailMessageIdHeader, nowIso(), nowIso(), row.id)
  run(db, "UPDATE email_messages SET rfc822_message_id = ? WHERE draft_row_id = ? AND kind = 'draft'", gmailMessageIdHeader, row.id)
  logActivity(db, result.ok ? 'gmail.draft_verified' : 'gmail.draft_verify_failed',
    result.ok ? `Verified the Gmail draft to ${row.recipient}: recipient, subject and media kit v${kit?.version} attachment match byte for byte`
      : `Gmail draft to ${row.recipient} failed verification: ${checks.filter((c) => !c.ok).map((c) => c.label).join(', ')}`, { prospectId: row.prospect_id })
  return result
}

// ---------- Create ----------

interface CreateInput {
  kind: DraftRow['kind']
  pitchId: number | null
  prospectId: number | null
  to: string
  subject: string
  body: string
  kitId: number | null
}

async function createDraft(db: DB, deps: GmailDeps, dataDir: string, input: CreateInput) {
  const { account, token } = await accessToken(db, deps)
  const kit = loadDefaultKit(db, dataDir, input.kitId)
  const ref = randomUUID()
  const raw = buildRaw(db, account, { to: input.to, subject: input.subject, body: input.body, ref }, kit)
  if (raw.length > 30 * 1024 * 1024) throw new AppError(409, 'too_large', 'The message with its attachment is larger than Gmail accepts.')

  const { rowId, op } = tx(db, () => {
    if (input.pitchId && get(db, `SELECT 1 FROM gmail_drafts WHERE pitch_id = ? AND status IN ${LIVE}`, input.pitchId)) {
      throw new AppError(409, 'duplicate', 'A Gmail draft already exists for this pitch.')
    }
    if (input.prospectId && liveForCompany(db, input.prospectId)) throw new AppError(409, 'duplicate', 'This company already has a Gmail draft. Update it instead of creating another.')
    if (input.kind === 'test' && get(db, `SELECT 1 FROM gmail_drafts WHERE kind = 'test' AND status IN ${LIVE}`)) {
      throw new AppError(409, 'duplicate', 'A test draft already exists. Delete it in Gmail, then press "Sync with Gmail" before making another.')
    }
    const now = nowIso()
    const rowId = run(db, `INSERT INTO gmail_drafts (kind, pitch_id, prospect_id, account_id, status, local_ref, rfc822_message_id, recipient, subject, content_sha256,
      media_kit_id, attachment_filename, attachment_sha256, created_at, updated_at) VALUES (?, ?, ?, ?, 'creating', ?, '', ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.kind, input.pitchId, input.prospectId, account.id, ref, input.to, input.subject, contentHash(input.to, input.subject, input.body, kit.sha),
      kit.kit.id, kit.kit.original_filename, kit.sha, now, now).lastId
    return { rowId, op: opStart(db, 'create_draft', account.id, rowId, `${raw.length.toLocaleString('en-US')} bytes to ${input.to}`) }
  })

  let draft: GmailDraft
  try {
    draft = await deps.api.createDraft(token, raw)
  } catch (err) {
    opFail(db, op, err)
    const unknown = !(err instanceof GoogleError) || err.outcome === 'unknown'
    run(db, 'UPDATE gmail_drafts SET status = ?, error = ?, sync_note = ?, updated_at = ? WHERE id = ?',
      unknown ? 'uncertain' : 'failed', (err as Error).message,
      unknown ? 'Google did not confirm whether the draft was created. It was not retried.' : 'Google refused the request; no draft was created.',
      nowIso(), rowId)
    logActivity(db, unknown ? 'gmail.draft_uncertain' : 'gmail.draft_failed',
      `${unknown ? 'Uncertain' : 'Failed'} Gmail draft to ${input.to}: ${(err as Error).message}${unknown ? ' (not retried)' : ''}`, { prospectId: input.prospectId })
    throw new AppError(unknown ? 504 : 502, unknown ? 'uncertain' : 'google',
      unknown ? `Google did not confirm the draft (${(err as Error).message}). It was not retried. Use "Check Gmail" before doing anything else.`
        : `Gmail refused the draft: ${(err as Error).message}`)
  }

  tx(db, () => {
    run(db, "UPDATE gmail_drafts SET status = 'created', gmail_draft_id = ?, gmail_message_id = ?, gmail_thread_id = ?, error = NULL, sync_note = NULL, last_synced_at = ?, updated_at = ? WHERE id = ?",
      draft.id, draft.message.id, draft.message.threadId, nowIso(), nowIso(), rowId)
    opFinish(db, op, 'ok', `draft ${draft.id}, message ${draft.message.id}`)
    recordThread(db, getDraftRow(db, rowId))
    logActivity(db, 'gmail.draft_created', `Created a Gmail draft to ${input.to} with media kit v${kit.kit.version} attached. Nothing was sent.`, { prospectId: input.prospectId, data: { draftId: draft.id } })
  })
  await verifyDraft(db, deps, rowId, input.body).catch(() => null)
  return getDraftRow(db, rowId)
}

// Conversation tracking groundwork: the thread and draft message, for reply and follow-up tracking later.
function recordThread(db: DB, row: DraftRow) {
  if (!row.gmail_thread_id || !row.gmail_message_id) return
  const now = nowIso()
  run(db, `INSERT INTO email_threads (account_id, prospect_id, gmail_thread_id, subject, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'draft', ?, ?)
    ON CONFLICT(account_id, gmail_thread_id) DO UPDATE SET subject = excluded.subject, updated_at = excluded.updated_at`,
    row.account_id, row.prospect_id, row.gmail_thread_id, row.subject, now, now)
  const thread = get<{ id: number }>(db, 'SELECT id FROM email_threads WHERE account_id = ? AND gmail_thread_id = ?', row.account_id, row.gmail_thread_id)!
  const existing = get<{ id: number }>(db, "SELECT id FROM email_messages WHERE draft_row_id = ? AND kind = 'draft'", row.id)
  if (existing) {
    run(db, 'UPDATE email_messages SET gmail_message_id = ?, thread_id = ?, subject = ? WHERE id = ?', row.gmail_message_id, thread.id, row.subject, existing.id)
  } else {
    run(db, `INSERT INTO email_messages (thread_id, gmail_message_id, rfc822_message_id, direction, kind, draft_row_id, from_email, to_email, subject, created_at)
      SELECT ?, ?, ?, 'outbound', 'draft', ?, email, ?, ?, ? FROM mail_accounts WHERE id = ?`,
      thread.id, row.gmail_message_id, row.rfc822_message_id, row.id, row.recipient, row.subject, now, row.account_id)
  }
}

// Everything that must be true before an approved pitch may become a Gmail draft.
function pitchPreconditions(db: DB, pitchId: number) {
  const p = getPitch(db, pitchId)
  if (p.channel !== 'email') throw new AppError(409, 'not_email', 'Manual submissions are made on the brand\'s site, not by email.')
  if (p.status !== 'approved') throw new AppError(409, 'not_approved', 'Only approved pitches can become Gmail drafts. Approve it first.')
  const { checks } = evaluatePitch(db, p)
  const blockers = checks.filter((c) => c.level === 'blocker')
  if (blockers.length) throw new AppError(409, 'blocked', `Fix these first: ${blockers.map((b) => b.message).join(' ')}`, blockers)
  if (!p.recipient_email || !p.subject) throw new AppError(409, 'incomplete', 'The pitch needs a recipient and a subject.')
  if (isEmailSuppressed(db, p.recipient_email) || isDomainSuppressed(db, p.recipient_email)) throw new AppError(409, 'suppressed', `${p.recipient_email} is on the do-not-contact list.`)
  return p
}

export async function createPitchDraft(db: DB, deps: GmailDeps, dataDir: string, pitchId: number) {
  const p = pitchPreconditions(db, pitchId)
  const existing = liveForCompany(db, p.prospect_id)
  if (existing) {
    throw new AppError(409, 'duplicate', existing.status === 'uncertain'
      ? 'An earlier attempt for this company has an uncertain result. Use "Check Gmail" first.'
      : 'This company already has a Gmail draft. Use "Update Gmail draft" instead.')
  }
  return createDraft(db, deps, dataDir, { kind: 'pitch', pitchId: p.id, prospectId: p.prospect_id, to: p.recipient_email!, subject: p.subject!, body: p.body, kitId: p.media_kit_id })
}

// A draft addressed to your own Gmail account, to test the connection and attachment without touching any prospect.
export async function createTestDraft(db: DB, deps: GmailDeps, dataDir: string) {
  const { account } = await accessToken(db, deps)
  const kit = getDefaultMediaKit(db)
  const body = [
    'This is a test draft created by your IronmanCarter outreach app.',
    '',
    'It checks that the app can create Gmail drafts and attach your media kit. It is addressed to you, not to any brand.',
    'The app cannot send it. You can delete this draft at any time.',
    '',
    `Attached: ${kit?.original_filename ?? 'media kit'} (v${kit?.version ?? '?'}).`,
  ].join('\n')
  return createDraft(db, deps, dataDir, { kind: 'test', pitchId: null, prospectId: null, to: account.email, subject: 'TEST - IronmanCarter Sponsorship Outreach', body, kitId: null })
}

// ---------- Update (same Gmail draft id) ----------

export async function updatePitchDraft(db: DB, deps: GmailDeps, dataDir: string, pitchId: number, opts: { overwriteGmailEdits?: boolean } = {}) {
  const p = pitchPreconditions(db, pitchId)
  const row = liveForCompany(db, p.prospect_id)
  if (!row) throw new AppError(409, 'no_draft', 'There is no Gmail draft for this company yet.')
  if (row.status !== 'created' || !row.gmail_draft_id) throw new AppError(409, 'uncertain', 'The earlier Gmail draft has an uncertain status. Use "Check Gmail" first.')
  if (row.edited_in_gmail && !opts.overwriteGmailEdits) {
    throw new AppError(409, 'edited_in_gmail', 'This draft was changed in Gmail. Updating it replaces those changes with the approved pitch.')
  }
  const { account, token } = await accessToken(db, deps)
  const kit = loadDefaultKit(db, dataDir, p.media_kit_id)
  const raw = buildRaw(db, account, { to: p.recipient_email!, subject: p.subject!, body: p.body, ref: row.local_ref }, kit)
  const op = opStart(db, 'update_draft', account.id, row.id, `pitch v${p.version}`)
  let draft: GmailDraft
  try {
    draft = await deps.api.updateDraft(token, row.gmail_draft_id, raw)
  } catch (err) {
    opFail(db, op, err)
    if (err instanceof GoogleError && err.status === 404) {
      markGone(db, row)
      throw new AppError(409, 'gone', 'That draft is no longer in Gmail (sent or deleted there). You can create a new one.')
    }
    run(db, 'UPDATE gmail_drafts SET sync_note = ?, updated_at = ? WHERE id = ?', `The last update may not have been applied (${(err as Error).message}). Press "Sync with Gmail" to check.`, nowIso(), row.id)
    throw new AppError(502, 'google', `Gmail did not confirm the update: ${(err as Error).message}. It was not retried.`)
  }
  tx(db, () => {
    run(db, `UPDATE gmail_drafts SET pitch_id = ?, recipient = ?, subject = ?, content_sha256 = ?, media_kit_id = ?, attachment_filename = ?, attachment_sha256 = ?,
      gmail_message_id = ?, gmail_thread_id = ?, edited_in_gmail = 0, attachment_check = NULL, attachment_verified_at = NULL, sync_note = NULL, last_synced_at = ?, updated_at = ? WHERE id = ?`,
      p.id, p.recipient_email, p.subject, contentHash(p.recipient_email!, p.subject!, p.body, kit.sha), kit.kit.id, kit.kit.original_filename, kit.sha,
      draft.message.id, draft.message.threadId, nowIso(), nowIso(), row.id)
    opFinish(db, op, 'ok', `message ${draft.message.id}`)
    recordThread(db, getDraftRow(db, row.id))
    logActivity(db, 'gmail.draft_updated', `Updated the Gmail draft to ${p.recipient_email} with pitch v${p.version}. Nothing was sent.`, { prospectId: p.prospect_id })
  })
  await verifyDraft(db, deps, row.id, p.body).catch(() => null)
  return getDraftRow(db, row.id)
}

// ---------- Sync and reconciliation ----------

function markGone(db: DB, row: DraftRow) {
  run(db, "UPDATE gmail_drafts SET status = 'gone', sync_note = ?, last_synced_at = ?, updated_at = ? WHERE id = ?",
    'No longer in Gmail drafts: it was sent or deleted from Gmail. (Sent Mail is checked from Phase 5, which needs read access.)', nowIso(), nowIso(), row.id)
  logActivity(db, 'gmail.draft_gone', `The Gmail draft to ${row.recipient} is no longer in Gmail drafts (sent or deleted in Gmail)`, { prospectId: row.prospect_id })
}

// Checks every linked draft still exists and whether it was changed in Gmail. Read-only at Google.
export async function syncDrafts(db: DB, deps: GmailDeps) {
  const rows = all<DraftRow>(db, "SELECT * FROM gmail_drafts WHERE status = 'created' AND gmail_draft_id IS NOT NULL")
  if (!rows.length) return { checked: 0, gone: 0, edited: 0, errors: 0 }
  const { account, token } = await accessToken(db, deps)
  let gone = 0, edited = 0, errors = 0
  for (const row of rows) {
    const op = opStart(db, 'get_draft', account.id, row.id, 'sync')
    try {
      const d = await deps.api.getDraft(token, row.gmail_draft_id!, 'minimal')
      opFinish(db, op, 'ok')
      const changed = d.message.id !== row.gmail_message_id
      if (changed) {
        edited++
        logActivity(db, 'gmail.draft_edited', `The Gmail draft to ${row.recipient} was changed in Gmail`, { prospectId: row.prospect_id })
      }
      run(db, `UPDATE gmail_drafts SET gmail_message_id = ?, gmail_thread_id = ?, edited_in_gmail = CASE WHEN ? THEN 1 ELSE edited_in_gmail END,
        sync_note = CASE WHEN ? THEN 'Changed in Gmail since the app created it. The app’s attachment check refers to the earlier version.' ELSE sync_note END,
        last_synced_at = ?, updated_at = ? WHERE id = ?`, d.message.id, d.message.threadId, changed ? 1 : 0, changed ? 1 : 0, nowIso(), nowIso(), row.id)
      if (changed) recordThread(db, getDraftRow(db, row.id))
    } catch (err) {
      opFail(db, op, err)
      if (err instanceof GoogleError && err.status === 404) {
        gone++
        markGone(db, row)
      } else {
        errors++
        run(db, 'UPDATE gmail_drafts SET sync_note = ?, updated_at = ? WHERE id = ?', `Last sync failed: ${(err as Error).message}`, nowIso(), row.id)
      }
    }
  }
  logActivity(db, 'gmail.synced', `Synced ${rows.length} Gmail draft${rows.length === 1 ? '' : 's'}: ${gone} gone, ${edited} changed in Gmail, ${errors} errors`)
  return { checked: rows.length, gone, edited, errors }
}

// For an 'uncertain' draft: search Gmail drafts to the same recipient for our Message-ID. Read-only at Google.
export async function checkUncertain(db: DB, deps: GmailDeps, rowId: number) {
  const row = getDraftRow(db, rowId)
  if (row.status !== 'uncertain') throw new AppError(409, 'not_uncertain', 'Only drafts with an uncertain status need checking.')
  const { account, token } = await accessToken(db, deps)
  const op = opStart(db, 'list_drafts', account.id, row.id, `reconcile: to:${row.recipient}`)
  const candidates: { draftId: string; messageId: string; threadId: string; subject: string | null; boundary: string | null }[] = []
  try {
    const list = await deps.api.listDrafts(token, `to:${row.recipient}`)
    for (const d of list.drafts ?? []) {
      const full = await deps.api.getDraft(token, d.id, 'metadata')
      const h = (n: string) => full.message.payload?.headers?.find((x) => x.name.toLowerCase() === n)?.value ?? null
      candidates.push({ draftId: d.id, messageId: full.message.id, threadId: full.message.threadId, subject: h('subject'), boundary: boundaryOf(h('content-type')) })
    }
    opFinish(db, op, 'ok', `${candidates.length} draft(s) to ${row.recipient}`)
  } catch (err) {
    opFail(db, op, err)
    throw new AppError(502, 'google', `Could not check Gmail: ${(err as Error).message}`)
  }
  const match = candidates.find((c) => c.boundary === boundaryFor(row.local_ref))
  if (match) {
    tx(db, () => {
      run(db, "UPDATE gmail_drafts SET status = 'created', gmail_draft_id = ?, gmail_message_id = ?, gmail_thread_id = ?, sync_note = ?, last_synced_at = ?, updated_at = ? WHERE id = ?",
        match.draftId, match.messageId, match.threadId, 'Found in Gmail after an uncertain result.', nowIso(), nowIso(), row.id)
      recordThread(db, getDraftRow(db, row.id))
      logActivity(db, 'gmail.draft_reconciled', `Found the uncertain Gmail draft to ${row.recipient} in Gmail and linked it`, { prospectId: row.prospect_id })
    })
    await verifyDraft(db, deps, row.id).catch(() => null)
    return { found: true as const, row: getDraftRow(db, row.id), similar: [] }
  }
  run(db, 'UPDATE gmail_drafts SET sync_note = ?, last_synced_at = ?, updated_at = ? WHERE id = ?',
    `Checked ${nowIso().slice(0, 16).replace('T', ' ')} UTC: not found in Gmail drafts.${candidates.length ? ` ${candidates.length} other draft(s) to this address exist; look in Gmail.` : ''}`, nowIso(), nowIso(), row.id)
  return { found: false as const, row: getDraftRow(db, row.id), similar: candidates.filter((c) => c.subject === row.subject).map((c) => ({ draftId: c.draftId, subject: c.subject })) }
}

// Your decision after "Check Gmail" found nothing: record that no draft was created, which allows a new attempt.
export function markNotCreated(db: DB, rowId: number) {
  const row = getDraftRow(db, rowId)
  if (row.status !== 'uncertain') throw new AppError(409, 'not_uncertain', 'Only uncertain drafts can be marked as not created.')
  if (!row.last_synced_at || !/not found/.test(row.sync_note ?? '')) throw new AppError(409, 'check_first', 'Press "Check Gmail" first so the app can look for it.')
  run(db, "UPDATE gmail_drafts SET status = 'failed', sync_note = ?, updated_at = ? WHERE id = ?", 'You confirmed this draft was not created in Gmail.', nowIso(), row.id)
  logActivity(db, 'gmail.draft_marked_not_created', `You confirmed the uncertain Gmail draft to ${row.recipient} was not created`, { prospectId: row.prospect_id })
  return getDraftRow(db, row.id)
}

// Stop tracking a draft (the Gmail copy is left exactly as it is; delete it in Gmail yourself if you want).
export function unlinkDraft(db: DB, rowId: number) {
  const row = getDraftRow(db, rowId)
  if (row.status !== 'created') throw new AppError(409, 'not_linked', 'Only a linked draft can be unlinked.')
  run(db, "UPDATE gmail_drafts SET status = 'unlinked', sync_note = ?, updated_at = ? WHERE id = ?", 'Unlinked by you. The Gmail copy was not changed.', nowIso(), row.id)
  logActivity(db, 'gmail.draft_unlinked', `Unlinked the Gmail draft to ${row.recipient}; the copy in Gmail was left untouched`, { prospectId: row.prospect_id })
  return getDraftRow(db, row.id)
}

// ---------- Views ----------

export function draftView(db: DB, row: DraftRow, accountEmail: string | null, currentHash?: string | null) {
  return {
    id: row.id, kind: row.kind, status: row.status, pitchId: row.pitch_id, recipient: row.recipient, subject: row.subject,
    gmailDraftId: row.gmail_draft_id, threadId: row.gmail_thread_id,
    openUrl: row.status === 'created' && row.gmail_message_id && accountEmail ? gmailDraftLink(accountEmail, row.gmail_message_id) : null,
    attachment: { filename: row.attachment_filename, sha256: row.attachment_sha256, mediaKitId: row.media_kit_id },
    verification: row.attachment_check ? (JSON.parse(row.attachment_check) as VerifyResult) : null,
    editedInGmail: !!row.edited_in_gmail,
    outOfDate: currentHash != null && row.status === 'created' && currentHash !== row.content_sha256,
    lastSyncedAt: row.last_synced_at, note: row.sync_note, error: row.error, createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

// The Gmail state of one pitch, for the pitch editor and the approval dashboard.
export function gmailForPitch(db: DB, dataDir: string, pitchId: number) {
  const p = getPitch(db, pitchId)
  if (p.channel !== 'email') return null
  const account = get<{ email: string; status: string }>(db, "SELECT email, status FROM mail_accounts WHERE provider = 'gmail' AND status != 'disconnected'")
  const row = liveForCompany(db, p.prospect_id)
    ?? get<DraftRow>(db, "SELECT * FROM gmail_drafts WHERE pitch_id = ? ORDER BY id DESC LIMIT 1", pitchId)
  let currentHash: string | null = null
  const kit = getDefaultMediaKit(db)
  if (p.recipient_email && p.subject && kit) {
    const path = mediaKitFilePath(dataDir, kit)
    currentHash = existsSync(path) ? contentHash(p.recipient_email, p.subject, p.body, kit.sha256) : null
  }
  return {
    connected: account?.status === 'connected',
    account: account?.email ?? null,
    draft: row ? draftView(db, row, account?.email ?? null, currentHash) : null,
    history: all<{ id: number; status: string; created_at: string }>(db, 'SELECT id, status, created_at FROM gmail_drafts WHERE prospect_id = ? ORDER BY id DESC', p.prospect_id),
  }
}

export function listDraftRows(db: DB) {
  const account = get<{ email: string }>(db, "SELECT email FROM mail_accounts WHERE provider = 'gmail' AND status != 'disconnected'")
  return all<DraftRow & { company_name: string | null }>(db, `SELECT g.*, p.company_name FROM gmail_drafts g LEFT JOIN prospects p ON p.id = g.prospect_id ORDER BY g.id DESC LIMIT 200`)
    .map((r) => ({ ...draftView(db, r, account?.email ?? null), companyName: r.company_name, prospectId: r.prospect_id }))
}

export const listOperations = (db: DB, limit = 100) => all(db, 'SELECT * FROM gmail_operations ORDER BY id DESC LIMIT ?', limit)
