// Manual sending. The ONLY way the app sends email:
//   1. prepare: every safeguard is checked and the exact message is read back from Gmail and shown to you;
//   2. confirm: you confirm that exact recipient, subject and text within 10 minutes. Everything is checked
//      again, a 'sending' record is written, and that one verified Gmail draft is sent with drafts.send.
// A sent draft no longer exists, so the same draft can never be sent twice. If Google's answer is lost the
// send is UNCERTAIN: it is never retried; reconcile() checks Gmail's Drafts and Sent Mail (read-only), and
// anything still unclear waits for you. Pitch approval, follow-up approval or scheduling never send anything.
import { randomBytes } from 'node:crypto'
import { all, get, getSetting, logActivity, nowIso, run, setSetting, tx, type DB } from '../db'
import { AppError, notFound } from '../core/errors'
import { contactEligibility, getProspect, type Contact } from '../crm/prospects'
import { contactQualification } from '../crm/leads'
import { isDomainSuppressed, isEmailSuppressed } from '../crm/suppressions'
import { evaluatePitch, getPitch } from '../pitch/service'
import { accessToken, activeAccount, hasReadAccess, missingScopes, opFail, opFinish, opStart, type GmailDeps } from '../gmail/account'
import { composeBody, contentHash, getDraftRow, OPT_OUT_LINE, verifyDraft, type DraftRow } from '../gmail/drafts'
import { GoogleError, headerValue, SEND_AUTHORITY, SendAuthorization, type GmailMessage } from '../gmail/google'
import { boundaryFor, boundaryOf } from '../gmail/mime'
import { calendar, dayKey } from './businessDays'
import { followUpBody, getFollowUp, liveFollowUpDraft, reconcileFollowUps, scheduleFollowUps, type SendRow } from './followups'
import { autoAdvance, touchContactDates } from './pipeline'

export type SendTarget = { kind: 'initial'; pitchId: number } | { kind: 'follow_up'; followUpId: number }

export interface Check { label: string; ok: boolean; detail: string }

const TOKEN_TTL_MS = 10 * 60_000
interface Pending {
  target: SendTarget
  draftRowId: number
  gmailDraftId: string
  gmailMessageId: string
  contentSha: string
  recipient: string
  subject: string
  expiresAt: number
}
const tokens = new Map<string, Pending>()

// The follow-up a prepared confirmation is for (so its thread can be re-read just before sending).
export const pendingFollowUp = (token: string) => {
  const t = tokens.get(token)?.target
  return t?.kind === 'follow_up' ? t.followUpId : null
}

export const getSend = (db: DB, id: number) => {
  const s = get<SendRow>(db, 'SELECT * FROM send_attempts WHERE id = ?', id)
  if (!s) throw notFound('Send record')
  return s
}

// ---------- Controls ----------

export interface StopState { active: boolean; at: string | null; reason: string | null }
export const stopState = (db: DB) => getSetting<StopState>(db, 'outreach.emergencyStop')

export function emergencyStop(db: DB, reason: unknown) {
  const why = typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 300) : 'Stopped from the dashboard'
  setSetting(db, 'outreach.emergencyStop', { active: true, at: nowIso(), reason: why })
  tokens.clear()
  logActivity(db, 'outreach.emergency_stop', `STOP ALL OUTREACH: ${why}. No email can be sent until you resume. Drafts and research were not touched.`)
  return stopState(db)
}

export function resumeOutreach(db: DB) {
  if (!stopState(db).active) return stopState(db)
  setSetting(db, 'outreach.emergencyStop', { active: false, at: null, reason: null })
  logActivity(db, 'outreach.resumed', 'Outreach resumed by you. Every send still needs your confirmation.')
  return stopState(db)
}

// What must be true before live sending can be switched on at all.
export function activationChecklist(db: DB): Check[] {
  const account = activeAccount(db)
  const expected = getSetting<string>(db, 'gmail.expectedAccount')
  const business = getSetting<string>(db, 'business.email')
  const address = getSetting<string>(db, 'business.postalAddress').trim()
  return [
    { label: 'Gmail connected as the sending account', ok: account?.status === 'connected' && account.email === expected, detail: account ? `${account.email} (${account.status})` : 'Not connected' },
    { label: 'Gmail permissions for sending and reconciliation', ok: !!account && !missingScopes(account).length, detail: account ? (missingScopes(account).length ? `Missing ${missingScopes(account).map((s) => s.split('/').pop()).join(', ')}; reconnect Gmail` : 'gmail.compose and gmail.readonly granted') : 'Not connected' },
    { label: 'Business sender identity matches', ok: !!account && business === account.email, detail: `Business email ${business}` },
    { label: 'Postal mailing address for the footer (CAN-SPAM)', ok: !!address, detail: address || 'Missing (Settings → Business)' },
    { label: 'Opt-out line in every email', ok: true, detail: OPT_OUT_LINE },
    { label: 'Emergency stop is off', ok: !stopState(db).active, detail: stopState(db).active ? `Stopped: ${stopState(db).reason}` : 'Off' },
  ]
}

export const ACTIVATION_PHRASE = 'ENABLE MANUAL SENDING'

export function setLiveSending(db: DB, enable: boolean, phrase?: unknown) {
  if (!enable) {
    setSetting(db, 'outreach.liveSendingEnabled', false)
    tokens.clear()
    logActivity(db, 'outreach.live_sending_off', 'Live sending switched off by you.')
    return false
  }
  if (phrase !== ACTIVATION_PHRASE) throw new AppError(400, 'phrase', `Type ${ACTIVATION_PHRASE} to confirm.`)
  const failing = activationChecklist(db).filter((c) => !c.ok)
  if (failing.length) throw new AppError(409, 'checklist', `Not ready: ${failing.map((c) => c.label).join('; ')}.`, failing)
  setSetting(db, 'outreach.liveSendingEnabled', true)
  logActivity(db, 'outreach.live_sending_on', 'Live sending switched ON by you (manual mode: every email still needs its own confirmation; no automatic, scheduled or bulk sending).')
  return true
}

// ---------- Daily limits (server-side, from the send records, so they survive restarts) ----------

export function limitsStatus(db: DB, now = new Date()) {
  const cfg = getSetting<{ newPerDay: number; followUpsPerDay: number; totalPerDay: number }>(db, 'outreach.dailyLimits')
  const tier = get<{ name: string; daily_limit: number; weekly_limit: number }>(db, 'SELECT name, daily_limit, weekly_limit FROM sending_tiers WHERE slug = ?', getSetting<string>(db, 'outreach.sendingTier'))!
  const today = dayKey(now, calendar(db).timezone)
  const weekAgo = dayKey(new Date(now.getTime() - 6 * 86_400_000), calendar(db).timezone)
  const count = (kind: string | null, from: string) => get<{ n: number }>(db,
    `SELECT count(*) AS n FROM send_attempts WHERE day_key >= ? AND day_key <= ? AND status IN ('sending', 'sent', 'uncertain')${kind ? ' AND kind = ?' : ''}`, from, today, ...(kind ? [kind] : []))!.n
  const sentNew = count('initial', today), sentFollow = count('follow_up', today), sentTotal = count(null, today), weekNew = count('initial', weekAgo)
  const newLimit = Math.min(cfg.newPerDay, tier.daily_limit)
  return {
    day: today, tier: tier.name,
    newEmails: { sent: sentNew, limit: newLimit, remaining: Math.max(0, newLimit - sentNew) },
    followUps: { sent: sentFollow, limit: cfg.followUpsPerDay, remaining: Math.max(0, cfg.followUpsPerDay - sentFollow) },
    total: { sent: sentTotal, limit: cfg.totalPerDay, remaining: Math.max(0, cfg.totalPerDay - sentTotal) },
    weekNew: { sent: weekNew, limit: tier.weekly_limit, remaining: Math.max(0, tier.weekly_limit - weekNew) },
  }
}

// ---------- Campaign budget ----------

export type CampaignName = 'sponsorship' | 'ugc'
export interface Allocation { sponsorship: number; ugc: number; redistributeUnused: boolean }

// New first emails today per campaign (manual and automatic), against each campaign's reserved slots. The global
// limits (sending tier and daily limits) cap the total whatever the allocation says.
export function campaignBudget(db: DB, now = new Date()) {
  const limits = limitsStatus(db, now)
  const alloc = getSetting<Allocation>(db, 'outreach.allocation')
  const sent = (c: CampaignName) => get<{ n: number }>(db, `SELECT count(*) AS n FROM send_attempts s LEFT JOIN prospects p ON p.id = s.prospect_id
    WHERE s.kind = 'initial' AND s.day_key = ? AND s.status IN ('sending', 'sent', 'uncertain') AND COALESCE(p.campaign_type, 'sponsorship') = ?`, limits.day, c)!.n
  const s = { sponsorship: sent('sponsorship'), ugc: sent('ugc') }
  const globalRoom = Math.min(limits.newEmails.remaining, limits.weekNew.remaining, limits.total.remaining)
  const room = (c: CampaignName) => {
    const other: CampaignName = c === 'ugc' ? 'sponsorship' : 'ugc'
    const own = Math.max(0, alloc[c] - s[c])
    const spare = alloc.redistributeUnused ? Math.max(0, alloc[other] - s[other]) : 0
    return Math.max(0, Math.min(own + spare, globalRoom))
  }
  return {
    day: limits.day, tier: limits.tier, limits, allocation: alloc,
    campaigns: {
      sponsorship: { allocated: alloc.sponsorship, sent: s.sponsorship, remaining: room('sponsorship') },
      ugc: { allocated: alloc.ugc, sent: s.ugc, remaining: room('ugc') },
    },
    combined: { sent: limits.newEmails.sent, limit: limits.newEmails.limit },
    week: limits.weekNew,
  }
}

// Changing the sending tier is your decision; this records it with your reason.
export function setSendingTier(db: DB, slug: unknown, note: unknown) {
  const tier = get<{ slug: string; name: string; daily_limit: number; weekly_limit: number }>(db, 'SELECT slug, name, daily_limit, weekly_limit FROM sending_tiers WHERE slug = ?', String(slug ?? ''))
  if (!tier) throw new AppError(400, 'invalid', 'Unknown sending tier')
  const why = String(note ?? '').trim()
  if (why.length < 10) throw new AppError(400, 'invalid', 'Say why the tier is changing (your approval is recorded).')
  setSetting(db, 'outreach.sendingTier', tier.slug)
  logActivity(db, 'outreach.tier_changed', `Sending tier set to ${tier.name} (${tier.daily_limit} new emails a day, ${tier.weekly_limit} a week): ${why}`)
  return tier
}

// ---------- Checks ----------

interface Evaluation {
  checks: Check[]
  ready: boolean
  draft: DraftRow | null
  preview: { from: string; to: string; subject: string; body: string; attachment: { filename: string; sha256: string } | null } | null
  contentSha: string | null
  prospectId: number | null
  contactId: number | null
}

const add = (checks: Check[], label: string, ok: boolean, detail: string) => checks.push({ label, ok, detail })

async function evaluate(db: DB, deps: GmailDeps, target: SendTarget, now = new Date()): Promise<Evaluation> {
  const checks: Check[] = []
  const live = getSetting<boolean>(db, 'outreach.liveSendingEnabled')
  add(checks, 'Live sending is switched on', live, live ? 'On (manual mode)' : 'Off. Turn it on in Outreach Controls after reviewing; until then this is a preview only.')
  const stop = stopState(db)
  add(checks, 'STOP ALL OUTREACH is off', !stop.active, stop.active ? `Stopped ${stop.at}: ${stop.reason}` : 'Off')
  const account = activeAccount(db)
  const expected = getSetting<string>(db, 'gmail.expectedAccount')
  const business = getSetting<string>(db, 'business.email')
  add(checks, 'Sending account', account?.status === 'connected' && account.email === expected && account.email === business,
    account ? `${account.email}${account.email !== business ? ` (business email is ${business})` : ''}${account.status !== 'connected' ? ` (${account.status})` : ''}` : 'Gmail is not connected')
  add(checks, 'Gmail permissions', !!account && hasReadAccess(account) && !missingScopes(account).length,
    account && !missingScopes(account).length ? 'Drafts/send and read access (needed to check Sent Mail)' : 'Read access missing; reconnect Gmail')

  let prospectId: number | null = null, contactId: number | null = null, recipient: string | null = null, draft: DraftRow | null = null
  let expectedBody = '', subject = ''
  const limits = limitsStatus(db, now)

  if (target.kind === 'initial') {
    const p = getPitch(db, target.pitchId)
    prospectId = p.prospect_id
    const prospect = getProspect(db, p.prospect_id)
    add(checks, 'Brand approved', prospect.review_status === 'approved', prospect.review_status === 'approved' ? `${prospect.company_name} is approved` : `${prospect.company_name} is ${prospect.review_status} in the review queue`)
    const stageOk = ['qualified', 'draft_ready', 'awaiting_approval'].includes(prospect.stage)
    add(checks, 'Company is ready for first contact', stageOk, `Stage: ${prospect.stage.replace(/_/g, ' ')}`)
    const prior = get<{ status: string }>(db, "SELECT status FROM send_attempts WHERE prospect_id = ? AND kind = 'initial' AND status IN ('sending', 'sent', 'uncertain')", p.prospect_id)
    add(checks, 'One outreach sequence per company', !prior, prior ? `A first email is already ${prior.status}` : 'No earlier outreach')
    const emailedBefore = p.recipient_email ? get<{ company_name: string | null }>(db, `SELECT pr.company_name FROM send_attempts s LEFT JOIN prospects pr ON pr.id = s.prospect_id
      WHERE s.recipient = ? AND s.kind = 'initial' AND s.status IN ('sending', 'sent', 'uncertain') LIMIT 1`, p.recipient_email) : undefined
    add(checks, 'Never emailed this person before', !emailedBefore, emailedBefore ? `${p.recipient_email} was already contacted${emailedBefore.company_name ? ` for ${emailedBefore.company_name}` : ''}` : 'First contact with this address')
    const blockers = p.channel === 'email' && p.status === 'approved' ? evaluatePitch(db, p).checks.filter((c) => c.level === 'blocker') : []
    add(checks, 'Pitch approved and passes every check', p.channel === 'email' && p.status === 'approved' && !blockers.length,
      p.status !== 'approved' ? `Pitch is ${p.status}` : blockers.length ? blockers.map((b) => b.message).join(' ') : `Approved pitch v${p.version}`)
    const contact = p.contact_id ? get<Contact>(db, 'SELECT * FROM contacts WHERE id = ?', p.contact_id) : undefined
    contactId = contact?.id ?? null
    recipient = p.recipient_email
    const elig = contact ? contactEligibility(db, contact, prospect) : null
    add(checks, 'Contact verified and eligible', !!contact && contact.email === p.recipient_email && elig?.status === 'eligible',
      !contact ? 'No contact on the pitch' : contact.email !== p.recipient_email ? 'The pitch recipient no longer matches the contact' : `${elig!.status.replace('_', ' ')}: ${elig!.reasons.join('; ')}`)
    const qualified = contact ? contactQualification(db, contact, prospect.domain) : null
    add(checks, 'Public, sourced contact (no known bounce)', !!qualified?.qualifies,
      !qualified ? 'No contact on the pitch' : qualified.qualifies ? `${qualified.confidence.toUpperCase()} confidence: published, with its source on record. This does not guarantee the mailbox accepts mail.` : qualified.reasons.join(' '))
    draft = get<DraftRow>(db, "SELECT * FROM gmail_drafts WHERE prospect_id = ? AND kind = 'pitch' AND status IN ('creating', 'created', 'uncertain')", p.prospect_id) ?? null
    expectedBody = composeBody(db, 'pitch', p.body)
    subject = p.subject ?? ''
    add(checks, 'Daily limit for new emails', limits.newEmails.remaining > 0 && limits.weekNew.remaining > 0,
      `${limits.newEmails.sent} of ${limits.newEmails.limit} today; ${limits.weekNew.sent} of ${limits.weekNew.limit} this week (${limits.tier} tier)`)
    const campaign: CampaignName = prospect.campaign_type === 'ugc' ? 'ugc' : 'sponsorship'
    const b = campaignBudget(db, now).campaigns[campaign]
    add(checks, `${campaign === 'ugc' ? 'UGC' : 'Sponsorship'} share of today's new emails`, b.remaining > 0, `${b.sent} of ${b.allocated} used today`)
  } else {
    reconcileFollowUps(db)
    const f = getFollowUp(db, target.followUpId)
    prospectId = f.prospect_id
    contactId = f.contact_id
    const original = getSend(db, f.initial_send_id)
    recipient = original.recipient
    add(checks, 'Follow-up approved', f.status === 'approved', f.status === 'cancelled' ? f.cancel_reason ?? 'Cancelled' : `Status: ${f.status}`)
    add(checks, 'Follow-up is due', f.due_at <= now.toISOString(), `Due ${f.due_at.slice(0, 16).replace('T', ' ')} UTC`)
    const earlier = f.sequence === 2 ? get<{ status: string }>(db, 'SELECT status FROM follow_ups WHERE initial_send_id = ? AND sequence = 1', f.initial_send_id) : undefined
    add(checks, 'Earlier follow-up handled', !earlier || ['sent', 'skipped'].includes(earlier.status), earlier ? `Follow-up 1 is ${earlier.status}` : 'First follow-up')
    const prior = get<{ status: string }>(db, "SELECT status FROM send_attempts WHERE idempotency_key = ? AND status IN ('sending', 'sent', 'uncertain')", `follow_up:${f.id}`)
    add(checks, 'Not already sent', !prior, prior ? `Already ${prior.status}` : 'Not sent yet')
    const prospect = getProspect(db, f.prospect_id)
    const contact = f.contact_id ? get<Contact>(db, 'SELECT * FROM contacts WHERE id = ?', f.contact_id) : undefined
    const elig = contact ? contactEligibility(db, { ...contact, email: contact.email }, { ...prospect, stage: 'contacted' }) : null
    add(checks, 'Contact still eligible', !!contact && contact.email === original.recipient && elig?.status === 'eligible',
      !contact ? 'Contact was removed' : `${elig!.status.replace('_', ' ')}: ${elig!.reasons.join('; ')}`)
    draft = liveFollowUpDraft(db, f.id) ?? null
    expectedBody = followUpBody(db, f)
    subject = f.subject
    add(checks, 'Daily limit for follow-ups', limits.followUps.remaining > 0, `${limits.followUps.sent} of ${limits.followUps.limit} today`)
  }

  add(checks, 'Daily limit for all sponsorship emails', limits.total.remaining > 0, `${limits.total.sent} of ${limits.total.limit} today`)
  add(checks, 'Recipient not on the do-not-contact list', !!recipient && !isEmailSuppressed(db, recipient) && !isDomainSuppressed(db, recipient), recipient ?? 'No recipient')
  const address = getSetting<string>(db, 'business.postalAddress').trim()
  add(checks, 'Compliance footer (postal address and opt-out)', !!address && expectedBody.includes(address) && expectedBody.includes(OPT_OUT_LINE), address ? 'Included' : 'Add your postal address in Settings → Business')

  // Read the draft back from Gmail now, so what you confirm is exactly what is in Gmail.
  let verified = false
  if (!draft || draft.status !== 'created' || !draft.gmail_draft_id) {
    add(checks, 'Gmail draft verified', false, !draft ? 'Create the Gmail draft first' : draft.status === 'uncertain' ? 'The Gmail draft has an uncertain status; use Check Gmail' : `Gmail draft is ${draft.status}`)
  } else if (draft.content_sha256 !== contentHash(recipient ?? '', subject, expectedBody, draft.attachment_sha256)) {
    add(checks, 'Gmail draft verified', false, 'The Gmail draft is out of date; update it from the approved text first')
  } else if (draft.edited_in_gmail) {
    add(checks, 'Gmail draft verified', false, 'The draft was changed in Gmail; update it from the approved text first')
  } else if (account && account.status === 'connected') {
    const v = await verifyDraft(db, deps, draft.id, expectedBody).catch((e: Error) => ({ ok: false, checks: [{ label: e.message, ok: false, detail: '' }] }))
    draft = getDraftRow(db, draft.id)
    verified = !!v?.ok && draft.status === 'created'
    add(checks, 'Gmail draft verified', verified, verified ? `Read back from Gmail just now: recipient, subject, body${draft.attachment_sha256 ? ' and media kit (SHA-256)' : ''} match` : `Failed: ${v?.checks.filter((c) => !c.ok).map((c) => c.label).join(', ') || 'could not read the draft'}`)
  } else {
    add(checks, 'Gmail draft verified', false, 'Gmail is not connected')
  }

  const kit = draft?.attachment_sha256 ? { filename: draft.attachment_filename ?? 'attachment.pdf', sha256: draft.attachment_sha256 } : null
  return {
    checks, ready: checks.every((c) => c.ok), draft, prospectId, contactId,
    contentSha: draft && verified ? draft.content_sha256 : null,
    preview: recipient ? { from: `${getSetting<string>(db, 'business.creatorName')} <${account?.email ?? business}>`, to: recipient, subject, body: expectedBody, attachment: kit } : null,
  }
}

// ---------- Prepare and confirm ----------

export async function prepareSend(db: DB, deps: GmailDeps, target: SendTarget) {
  const e = await evaluate(db, deps, target)
  let token: string | null = null
  let expiresAt: string | null = null
  if (e.ready && e.draft?.gmail_draft_id && e.draft.gmail_message_id && e.contentSha && e.preview) {
    token = randomBytes(24).toString('base64url')
    const exp = Date.now() + TOKEN_TTL_MS
    for (const [k, v] of tokens) if (v.expiresAt < Date.now()) tokens.delete(k)
    tokens.set(token, { target, draftRowId: e.draft.id, gmailDraftId: e.draft.gmail_draft_id, gmailMessageId: e.draft.gmail_message_id, contentSha: e.contentSha, recipient: e.preview.to, subject: e.preview.subject, expiresAt: exp })
    expiresAt = new Date(exp).toISOString()
  }
  return { ready: e.ready, checks: e.checks, preview: e.preview, contentSha256: e.contentSha, token, expiresAt, limits: limitsStatus(db) }
}

export async function confirmSend(db: DB, deps: GmailDeps, input: { token?: unknown; recipient?: unknown; subject?: unknown; contentSha256?: unknown }) {
  const token = typeof input.token === 'string' ? input.token : ''
  const pending = tokens.get(token)
  tokens.delete(token) // single use, whatever happens next
  if (!pending || pending.expiresAt < Date.now()) throw new AppError(409, 'confirmation_expired', 'This confirmation expired or was already used. Review the email again.')
  if (input.recipient !== pending.recipient || input.subject !== pending.subject || input.contentSha256 !== pending.contentSha) {
    throw new AppError(409, 'confirmation_mismatch', 'What you confirmed does not match the prepared email. Nothing was sent.')
  }
  // Everything again, including a fresh read-back from Gmail, immediately before sending.
  const e = await evaluate(db, deps, pending.target)
  if (!e.ready) throw new AppError(409, 'not_ready', `Not sent: ${e.checks.filter((c) => !c.ok).map((c) => `${c.label} (${c.detail})`).join('; ')}`, e.checks)
  if (e.draft?.id !== pending.draftRowId || e.contentSha !== pending.contentSha || e.draft.gmail_message_id !== pending.gmailMessageId) {
    throw new AppError(409, 'changed', 'The Gmail draft changed since you reviewed it. Nothing was sent; review it again.')
  }
  return deliver(db, deps, e, pending.target, { recipient: pending.recipient, subject: pending.subject, contentSha: pending.contentSha, gmailDraftId: pending.gmailDraftId }, 'you')
}

// Autopilot: the same checks as a manual send, including a fresh read-back of the Gmail draft, and the same
// duplicate protection; only the human confirmation step is replaced by autopilot being switched on.
export async function autopilotSend(db: DB, deps: GmailDeps, target: SendTarget): Promise<{ sent: SendRow | null; failing: Check[] }> {
  // The switch of the campaign this email belongs to must be on (sponsorship and UGC are separate).
  const pid = target.kind === 'initial'
    ? get<{ prospect_id: number }>(db, 'SELECT prospect_id FROM pitches WHERE id = ?', target.pitchId)?.prospect_id
    : get<{ prospect_id: number }>(db, 'SELECT prospect_id FROM follow_ups WHERE id = ?', target.followUpId)?.prospect_id
  const campaign = (pid && get<{ campaign_type: string }>(db, 'SELECT campaign_type FROM prospects WHERE id = ?', pid)?.campaign_type) || 'sponsorship'
  if (!getSetting<boolean>(db, campaign === 'ugc' ? 'ugc.autopilotEnabled' : 'outreach.autopilotEnabled')) throw new AppError(409, 'autopilot_off', `${campaign === 'ugc' ? 'UGC a' : 'A'}utopilot is switched off.`)
  const e = await evaluate(db, deps, target)
  if (!e.ready || !e.draft?.gmail_draft_id || !e.contentSha || !e.preview) return { sent: null, failing: e.checks.filter((c) => !c.ok) }
  const sent = await deliver(db, deps, e, target, { recipient: e.preview.to, subject: e.preview.subject, contentSha: e.contentSha, gmailDraftId: e.draft.gmail_draft_id }, 'autopilot')
  return { sent, failing: [] }
}

async function deliver(db: DB, deps: GmailDeps, e: Evaluation, t: SendTarget, pending: { recipient: string; subject: string; contentSha: string; gmailDraftId: string }, by: 'you' | 'autopilot') {
  if (stopState(db).active) throw new AppError(409, 'stopped', 'STOP ALL OUTREACH is active. Nothing was sent.')
  const { account, token: access } = await accessToken(db, deps)
  const key = t.kind === 'initial' ? `initial:p${e.prospectId}` : `follow_up:${t.followUpId}`
  const draft = e.draft!

  const { sendId, op } = tx(db, () => {
    const now = nowIso()
    // The unique indexes refuse a second live send for this message or a second first email to this company.
    const sendId = run(db, `INSERT INTO send_attempts (kind, prospect_id, contact_id, pitch_id, follow_up_id, draft_row_id, account_id, idempotency_key, recipient, subject,
      content_sha256, attachment_sha256, status, day_key, confirmed_at, created_at, updated_at, initiated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sending', ?, ?, ?, ?, ?)`,
      t.kind, e.prospectId, e.contactId, t.kind === 'initial' ? t.pitchId : null, t.kind === 'follow_up' ? t.followUpId : null, draft.id, account.id, key,
      pending.recipient, pending.subject, pending.contentSha, draft.attachment_sha256, dayKey(new Date(), calendar(db).timezone), now, now, now, by).lastId
    return { sendId, op: opStart(db, 'send_draft', account.id, draft.id, `send ${sendId} to ${pending.recipient}`) }
  })

  let msg: GmailMessage
  try {
    msg = await deps.api.sendDraft(access, new SendAuthorization(SEND_AUTHORITY, pending.gmailDraftId, sendId))
  } catch (err) {
    opFail(db, op, err)
    const g = err instanceof GoogleError ? err : null
    // A definite refusal means nothing was sent. 404 is NOT definite here: the draft may be gone because it was sent.
    const definite = !!g && g.outcome === 'rejected' && g.status !== 404
    run(db, 'UPDATE send_attempts SET status = ?, error = ?, updated_at = ? WHERE id = ?', definite ? 'failed' : 'uncertain', (err as Error).message, nowIso(), sendId)
    logActivity(db, definite ? 'send.failed' : 'send.uncertain',
      definite ? `Gmail refused to send to ${pending.recipient}: ${(err as Error).message}. Nothing was sent.`
        : `SEND STATUS UNCERTAIN for ${pending.recipient}: ${(err as Error).message}. Not retried; check Gmail with "Reconcile".`, { prospectId: e.prospectId })
    throw new AppError(definite ? 502 : 504, definite ? 'send_failed' : 'send_uncertain',
      definite ? `Gmail refused to send it: ${(err as Error).message}. Nothing was sent.`
        : `Gmail did not confirm the send (${(err as Error).message}). It was NOT retried. Use "Reconcile" to check Sent Mail before doing anything else.`)
  }
  opFinish(db, op, 'ok', `message ${msg.id}`)
  run(db, "UPDATE send_attempts SET status = 'sent', gmail_message_id = ?, gmail_thread_id = ?, sent_at = ?, error = NULL, updated_at = ? WHERE id = ?", msg.id, msg.threadId, nowIso(), nowIso(), sendId)
  await afterSent(db, deps, getSend(db, sendId))
  return getSend(db, sendId)
}

// Bookkeeping after a confirmed send. Its failures never change the fact that the email was sent.
async function afterSent(db: DB, deps: GmailDeps, s: SendRow) {
  try {
    tx(db, () => {
      const how = s.origin === 'gmail' ? 'by you from Gmail' : s.initiated_by === 'autopilot' ? 'automatically by autopilot' : 'by the app after your confirmation'
      if (s.draft_row_id) run(db, "UPDATE gmail_drafts SET status = 'sent', sync_note = ?, updated_at = ? WHERE id = ?", `Sent ${how} (send ${s.id}).`, nowIso(), s.draft_row_id)
      const msgRow = s.draft_row_id ? get<{ id: number }>(db, "SELECT id FROM email_messages WHERE draft_row_id = ? AND kind = 'draft'", s.draft_row_id) : undefined
      const kind = s.kind === 'initial' ? 'sent' : 'follow_up'
      if (msgRow && s.gmail_message_id) {
        run(db, 'DELETE FROM email_messages WHERE gmail_message_id = ? AND id != ?', s.gmail_message_id, msgRow.id)
        run(db, 'UPDATE email_messages SET kind = ?, gmail_message_id = ?, send_attempt_id = ?, contact_id = ?, message_at = ? WHERE id = ?', kind, s.gmail_message_id, s.id, s.contact_id, s.sent_at, msgRow.id)
      } else if (msgRow) {
        run(db, 'UPDATE email_messages SET kind = ?, send_attempt_id = ?, contact_id = ?, message_at = ? WHERE id = ?', kind, s.id, s.contact_id, s.sent_at, msgRow.id)
      }
      if (s.gmail_thread_id) {
        run(db, `UPDATE email_threads SET status = CASE WHEN status = 'draft' THEN 'awaiting_reply' ELSE status END, contact_id = COALESCE(contact_id, ?),
          last_outbound_at = ?, last_message_at = ?, updated_at = ? WHERE account_id = ? AND gmail_thread_id = ?`, s.contact_id, s.sent_at, s.sent_at, nowIso(), s.account_id, s.gmail_thread_id)
      }
      touchContactDates(db, s.prospect_id, 'outbound', s.sent_at ?? nowIso())
      if (s.kind === 'initial') {
        autoAdvance(db, s.prospect_id, 'contacted')
        scheduleFollowUps(db, s)
      } else if (s.follow_up_id) {
        run(db, "UPDATE follow_ups SET status = 'sent', sent_send_id = ?, updated_at = ? WHERE id = ?", s.id, nowIso(), s.follow_up_id)
      }
      logActivity(db, 'send.sent', `${s.origin === 'gmail' ? 'You sent' : 'Sent'} the ${s.kind === 'initial' ? 'first email' : 'follow-up'} to ${s.recipient}${s.origin === 'gmail' ? ' from Gmail' : s.initiated_by === 'autopilot' ? ' automatically (autopilot)' : ' after your confirmation'}.`, { prospectId: s.prospect_id, data: { sendId: s.id } })
    })
  } catch (err) {
    logActivity(db, 'send.bookkeeping_error', `Sent to ${s.recipient}, but updating the CRM failed: ${(err as Error).message}`, { prospectId: s.prospect_id })
  }
  // Gmail's own Message-ID, for matching replies (read access).
  if (s.gmail_message_id) {
    try {
      const { token } = await accessToken(db, deps)
      const m = await deps.api.getMessage(token, s.gmail_message_id, 'metadata')
      const id = headerValue(m, 'Message-Id')
      if (id) {
        run(db, 'UPDATE send_attempts SET rfc822_message_id = ? WHERE id = ?', id, s.id)
        run(db, 'UPDATE email_messages SET rfc822_message_id = ? WHERE gmail_message_id = ?', id, s.gmail_message_id)
      }
    } catch { /* reply matching falls back to the thread id */ }
  }
}

// ---------- Uncertain sends ----------

// Read-only check of Gmail for an uncertain send. Never sends anything.
export async function reconcileSend(db: DB, deps: GmailDeps, sendId: number) {
  const s = getSend(db, sendId)
  if (s.status !== 'uncertain') throw new AppError(409, 'not_uncertain', 'Only uncertain sends need reconciling.')
  const draft = s.draft_row_id ? getDraftRow(db, s.draft_row_id) : null
  if (!draft?.gmail_draft_id) throw new AppError(409, 'no_draft', 'No Gmail draft is linked to this send; check Gmail yourself.')
  const { account, token } = await accessToken(db, deps)
  const op = opStart(db, 'reconcile_send', account.id, draft.id, `send ${s.id}`)
  const note = (text: string) => run(db, 'UPDATE send_attempts SET reconcile_note = ?, updated_at = ? WHERE id = ?', `${nowIso().slice(0, 16).replace('T', ' ')} UTC: ${text}`, nowIso(), s.id)
  try {
    // 1. The draft is still in Drafts → Gmail did not send it.
    try {
      await deps.api.getDraft(token, draft.gmail_draft_id, 'minimal')
      run(db, "UPDATE send_attempts SET status = 'not_sent', updated_at = ? WHERE id = ?", nowIso(), s.id)
      note('The draft is still in Gmail Drafts, so it was not sent. You can review and send it again.')
      opFinish(db, op, 'ok', 'draft still exists: not sent')
      logActivity(db, 'send.reconciled', `Uncertain send to ${s.recipient} reconciled: NOT sent (the draft is still in Gmail).`, { prospectId: s.prospect_id })
      return getSend(db, s.id)
    } catch (err) {
      if (!(err instanceof GoogleError && err.status === 404)) throw err
    }
    // 2. The draft is gone → look for our message (by its MIME boundary) in the thread and in Sent Mail.
    const ours = (m: GmailMessage) => m.labelIds?.includes('SENT') && boundaryOf(headerValue(m, 'Content-Type')) === boundaryFor(draft.local_ref)
    let found: GmailMessage | undefined
    if (draft.gmail_thread_id) {
      try {
        found = (await deps.api.getThread(token, draft.gmail_thread_id, 'metadata')).messages?.find(ours)
      } catch (err) {
        if (!(err instanceof GoogleError && err.status === 404)) throw err
      }
    }
    if (!found) {
      const list = await deps.api.listMessages(token, `in:sent to:${s.recipient} newer_than:7d`)
      for (const m of list.messages ?? []) {
        const full = await deps.api.getMessage(token, m.id, 'metadata')
        if (ours(full)) { found = full; break }
      }
    }
    if (found) {
      run(db, "UPDATE send_attempts SET status = 'sent', gmail_message_id = ?, gmail_thread_id = ?, sent_at = COALESCE(sent_at, ?), updated_at = ? WHERE id = ?",
        found.id, found.threadId, found.internalDate ? new Date(Number(found.internalDate)).toISOString() : nowIso(), nowIso(), s.id)
      note('Found in Sent Mail: it was sent once.')
      opFinish(db, op, 'ok', `found sent message ${found.id}`)
      logActivity(db, 'send.reconciled', `Uncertain send to ${s.recipient} reconciled: it WAS sent (found in Sent Mail).`, { prospectId: s.prospect_id })
      await afterSent(db, deps, getSend(db, s.id))
      return getSend(db, s.id)
    }
    note('The draft is gone from Drafts but the message is not in Sent Mail. Check Gmail yourself, then record what you found.')
    opFinish(db, op, 'ok', 'still uncertain')
    return getSend(db, s.id)
  } catch (err) {
    opFail(db, op, err)
    throw new AppError(502, 'google', `Could not check Gmail: ${(err as Error).message}`)
  }
}

// Your decision after investigating in Gmail yourself. Allowed only after a reconcile attempt.
export async function resolveSend(db: DB, deps: GmailDeps, sendId: number, outcome: unknown) {
  const s = getSend(db, sendId)
  if (s.status !== 'uncertain') throw new AppError(409, 'not_uncertain', 'Only uncertain sends can be resolved.')
  if (!s.reconcile_note) throw new AppError(409, 'reconcile_first', 'Press "Reconcile" first so the app can check Gmail.')
  if (outcome !== 'sent' && outcome !== 'not_sent') throw new AppError(400, 'invalid', 'Choose sent or not sent')
  run(db, 'UPDATE send_attempts SET status = ?, sent_at = CASE WHEN ? THEN COALESCE(sent_at, ?) ELSE sent_at END, reconcile_note = reconcile_note || ?, updated_at = ? WHERE id = ?',
    outcome, outcome === 'sent' ? 1 : 0, nowIso(), ` · You confirmed: ${outcome === 'sent' ? 'sent' : 'not sent'}.`, nowIso(), s.id)
  logActivity(db, 'send.resolved', `You recorded the uncertain send to ${s.recipient} as ${outcome === 'sent' ? 'SENT' : 'NOT sent'}.`, { prospectId: s.prospect_id })
  if (outcome === 'sent') {
    const draft = s.draft_row_id ? getDraftRow(db, s.draft_row_id) : null
    if (draft?.gmail_thread_id && !s.gmail_thread_id) run(db, 'UPDATE send_attempts SET gmail_thread_id = ? WHERE id = ?', draft.gmail_thread_id, s.id)
    await afterSent(db, deps, getSend(db, s.id))
  }
  return getSend(db, s.id)
}

// After a crash or restart, a send that was in flight is uncertain. Never retried.
export function recoverInterruptedSends(db: DB) {
  const stuck = all<SendRow>(db, "SELECT * FROM send_attempts WHERE status = 'sending'")
  for (const s of stuck) {
    run(db, "UPDATE send_attempts SET status = 'uncertain', error = 'The app stopped while sending.', updated_at = ? WHERE id = ?", nowIso(), s.id)
    logActivity(db, 'send.uncertain', `SEND STATUS UNCERTAIN for ${s.recipient}: the app stopped mid-send. Not retried; reconcile with Gmail.`, { prospectId: s.prospect_id })
  }
  run(db, "UPDATE gmail_sync_runs SET status = 'interrupted', finished_at = ? WHERE status = 'started'", nowIso())
  return stuck.length
}

// For you sending a pitch draft from Gmail yourself (found by sync): record it like an app send.
export async function recordGmailSend(db: DB, deps: GmailDeps, draft: DraftRow, msg: GmailMessage) {
  const key = draft.kind === 'pitch' ? `initial:p${draft.prospect_id}` : `follow_up:${draft.follow_up_id}`
  if (get(db, "SELECT 1 FROM send_attempts WHERE idempotency_key = ? AND status IN ('sending', 'sent', 'uncertain')", key)) return null
  const at = msg.internalDate ? new Date(Number(msg.internalDate)) : new Date()
  const pitch = draft.pitch_id ? get<{ contact_id: number | null }>(db, 'SELECT contact_id FROM pitches WHERE id = ?', draft.pitch_id) : undefined
  const follow = draft.follow_up_id ? get<{ contact_id: number | null }>(db, 'SELECT contact_id FROM follow_ups WHERE id = ?', draft.follow_up_id) : undefined
  const id = run(db, `INSERT INTO send_attempts (kind, origin, prospect_id, contact_id, pitch_id, follow_up_id, draft_row_id, account_id, idempotency_key, recipient, subject,
    content_sha256, attachment_sha256, status, gmail_message_id, gmail_thread_id, day_key, confirmed_at, sent_at, created_at, updated_at)
    VALUES (?, 'gmail', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?, ?, ?, ?, ?, ?)`,
    draft.kind === 'pitch' ? 'initial' : 'follow_up', draft.prospect_id, pitch?.contact_id ?? follow?.contact_id ?? null, draft.pitch_id, draft.follow_up_id, draft.id, draft.account_id, key,
    draft.recipient, draft.subject, draft.content_sha256, draft.attachment_sha256, msg.id, msg.threadId, dayKey(at, calendar(db).timezone), at.toISOString(), at.toISOString(), nowIso(), nowIso()).lastId
  await afterSent(db, deps, getSend(db, id))
  return getSend(db, id)
}
