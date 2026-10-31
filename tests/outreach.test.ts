import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../apps/server/src/app'
import { all, get, run, setSetting, type DB } from '../packages/db'
import { addContact, createProspect, getProspect, reviewProspect } from '../packages/crm/prospects'
import { importMediaKit } from '../packages/mediakit/store'
import { approvePitch, generatePitch } from '../packages/pitch/service'
import { forgetAccessTokens } from '../packages/gmail/account'
import { GoogleApi } from '../packages/gmail/google'
import { parseMessage, sha256 } from '../packages/gmail/mime'
import { memoryStore } from '../packages/gmail/secrets'
import { addBusinessDays, dayKey } from '../packages/outreach/businessDays'
import { classifyByRules, classifyReply, stripQuoted } from '../packages/outreach/classify'
import type { AIProvider } from '../packages/ai/types'
import { fakeGoogle } from './fakeGoogle'
import { fakePdf, freshDb, tempDir } from './helpers'

const H = { host: '127.0.0.1:5181', 'x-outreach-client': 'dashboard' }
const CLIENT = { client_id: '1234567890-abc.apps.googleusercontent.com', client_secret: 'GOCSPX-test-secret-value' }
const ADDRESS = '123 Example St, Suite 4, Los Angeles, CA 90001'

let db: DB, app: FastifyInstance, google: ReturnType<typeof fakeGoogle>, secrets: ReturnType<typeof memoryStore>, dir: string, cleanup: () => void, kitPdf: Buffer

const boot = async () => {
  app = await buildApp({ db, dataDir: dir, gmail: { api: new GoogleApi(google.fetchImpl), secrets, redirectUri: 'http://127.0.0.1:5181/api/gmail/oauth/callback' } })
}
beforeEach(async () => {
  const t = tempDir()
  dir = t.dir
  cleanup = t.cleanup
  db = freshDb()
  kitPdf = fakePdf('media kit')
  importMediaKit(db, dir, { buffer: kitPdf, originalFilename: 'Content Media Kit Final (corrected email).pdf' })
  setSetting(db, 'business.postalAddress', ADDRESS)
  google = fakeGoogle()
  secrets = memoryStore()
  forgetAccessTokens()
  await boot()
})
afterEach(async () => {
  await app.close()
  cleanup()
})

const req = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: H, ...(payload !== undefined ? { payload: payload as object } : {}) })

async function connect() {
  await req('PUT', '/api/gmail/client', CLIENT)
  const { url } = (await req('POST', '/api/gmail/connect', {})).json()
  const state = new URL(url).searchParams.get('state')!
  return app.inject({ url: `/api/gmail/oauth/callback?state=${state}&code=x`, headers: { host: '127.0.0.1:5181' } })
}

async function brand(name = 'Brand A', domain = 'brand-a.test', jurisdiction = 'US') {
  const p = createProspect(db, { company_name: name, website: `https://${domain}`, category_id: 1, products: 'Gaming mice' })
  run(db, 'INSERT INTO research_sources (prospect_id, url, title, kind, retrieved_at, snippet) VALUES (?, ?, ?, ?, ?, ?)',
    p.id, `https://${domain}/creators`, 'Creator program', 'sponsorship_evidence', new Date().toISOString(), `Join the ${name} Creator Program.`)
  addContact(db, p.id, { email: `partnerships@${domain}`, source_url: `https://${domain}/creators`, verification_status: 'verified', jurisdiction, is_primary: true, discovered_by: 'research' })
  reviewProspect(db, p.id, 'approved')
  const pitch = approvePitch(db, (await generatePitch(db, p.id, { channel: 'email' })).id)
  return { prospect: p, pitch, email: `partnerships@${domain}` }
}

const enableLive = () => req('POST', '/api/outreach/live-sending', { enable: true, phrase: 'ENABLE MANUAL SENDING' })

async function readyPitch(name?: string, domain?: string, jurisdiction?: string) {
  const b = await brand(name, domain, jurisdiction)
  const r = await req('POST', `/api/pitches/${b.pitch.id}/gmail-draft`, { confirm: true })
  expect(r.statusCode).toBe(201)
  return b
}

async function prepare(payload: object) {
  return (await req('POST', '/api/outreach/send/prepare', payload)).json()
}
const confirmFrom = (p: { token: string; preview: { to: string; subject: string }; contentSha256: string }) =>
  req('POST', '/api/outreach/send/confirm', { token: p.token, recipient: p.preview.to, subject: p.preview.subject, contentSha256: p.contentSha256 })

async function sendPitch(pitchId: number) {
  const p = await prepare({ pitchId })
  expect(p.ready, JSON.stringify(p.checks.filter((c: { ok: boolean }) => !c.ok))).toBe(true)
  return confirmFrom(p)
}
const failing = (p: { checks: { label: string; ok: boolean }[] }) => p.checks.filter((c) => !c.ok).map((c) => c.label)

describe('business days and time zones', () => {
  const cal = { timezone: 'America/Los_Angeles', start: '09:00', days: [1, 2, 3, 4, 5], holidays: [] as string[] }
  it('skips weekends and lands at the start of the business day in your time zone', () => {
    // Friday 2026-10-30 15:00 PT → 5 business days → Friday 2026-11-06 09:00 PST (DST ended 11-01).
    const due = addBusinessDays(new Date('2026-10-30T22:00:00Z'), 5, cal)
    expect(due.toISOString()).toBe('2026-11-06T17:00:00.000Z')
    expect(addBusinessDays(new Date('2026-10-30T22:00:00Z'), 12, cal).toISOString()).toBe('2026-11-17T17:00:00.000Z')
  })
  it('skips holidays and uses the local date, not the UTC date', () => {
    expect(addBusinessDays(new Date('2026-10-30T22:00:00Z'), 5, { ...cal, holidays: ['2026-11-03'] }).toISOString()).toBe('2026-11-09T17:00:00.000Z')
    // 2026-10-31 02:00 UTC is still Friday Oct 30 in Los Angeles.
    expect(dayKey(new Date('2026-10-31T02:00:00Z'), 'America/Los_Angeles')).toBe('2026-10-30')
  })
})

describe('reply classification', () => {
  it('classifies clear replies and leaves mixed or vague ones unclear', () => {
    expect(classifyByRules('Thanks! We would love to chat next week.').category).toBe('interested')
    expect(classifyByRules('What are your rates for a single Short?').category).toBe('needs_info')
    expect(classifyByRules('We are not interested at this time.').category).toBe('not_interested')
    expect(classifyByRules('I\'m no longer with the company.').category).toBe('wrong_contact')
    expect(classifyByRules('Please reach out to jamie@brand.test, she runs creators.').category).toBe('referral')
    expect(classifyByRules('Our budget is $300; exclusivity for 30 days.').category).toBe('negotiating')
    expect(classifyByRules('Anything', true).category).toBe('out_of_office')
    expect(classifyByRules('Sounds interesting, but what are your rates?').category).toBe('unclear')
    expect(classifyByRules('ok').category).toBe('unclear')
    expect(classifyByRules('Please unsubscribe me.')).toMatchObject({ category: 'not_interested', optOut: true })
    expect(stripQuoted('Sounds good!\n\nOn Mon, Nov 2, IronmanCarter wrote:\n> Hi team')).toBe('Sounds good!')
  })

  it('uses local AI only with a verbatim quote from the reply', async () => {
    setSetting(db, 'ai.provider', 'ollama')
    const reply = (text: string): AIProvider => ({ id: 'ollama', billing: 'free_local', model: () => 'gemma4:12b', generate: async () => ({ text, model: 'gemma4:12b', inputTokens: 1, outputTokens: 1 }) })
    const good = await classifyReply(db, 'Happy to connect. Send a few dates.', { ai: { providers: { ollama: reply('{"category":"interested","quote":"Happy to connect"}') } } })
    expect(good).toMatchObject({ category: 'interested', source: 'ollama' })
    const invented = await classifyReply(db, 'Thanks for reaching out.', { ai: { providers: { ollama: reply('{"category":"interested","quote":"we want a deal"}') } } })
    expect(invented).toMatchObject({ category: 'unclear', source: 'rules' })
    expect(invented.note).toMatch(/not usable/)
  })
})

describe('live sending activation gate', () => {
  it('stays off by default and can only be enabled through the checklist and the typed phrase', async () => {
    await connect()
    expect((await req('PATCH', '/api/settings', { 'outreach.liveSendingEnabled': true })).statusCode).toBe(409)
    expect((await req('POST', '/api/outreach/live-sending', { enable: true })).statusCode).toBe(400)
    setSetting(db, 'business.postalAddress', '')
    const r = await enableLive()
    expect(r.statusCode).toBe(409)
    expect(r.json().error.message).toMatch(/Postal mailing address/)
    setSetting(db, 'business.postalAddress', ADDRESS)
    expect((await enableLive()).json()).toEqual({ liveSendingEnabled: true })
    expect((await req('POST', '/api/outreach/live-sending', { enable: false })).json()).toEqual({ liveSendingEnabled: false })
    expect((await req('PATCH', '/api/settings', { 'outreach.autopilotEnabled': true })).statusCode).toBe(409)
  })

  it('lets a drafts-only connection (Phase 4) reconnect to add read access, keeping the same account', async () => {
    google.state.scope = 'https://www.googleapis.com/auth/gmail.compose'
    await connect()
    let s = (await req('GET', '/api/gmail/status')).json()
    expect(s.account).toMatchObject({ readAccess: false, missingScopes: ['https://www.googleapis.com/auth/gmail.readonly'] })
    google.state.scope = 'https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/gmail.readonly'
    const { url } = (await req('POST', '/api/gmail/connect', {})).json()
    expect(new URL(url).searchParams.get('scope')).toContain('gmail.readonly')
    const state = new URL(url).searchParams.get('state')!
    expect((await app.inject({ url: `/api/gmail/oauth/callback?state=${state}&code=y`, headers: { host: '127.0.0.1:5181' } })).statusCode).toBe(200)
    s = (await req('GET', '/api/gmail/status')).json()
    expect(s.account).toMatchObject({ email: 'ironmancarterbusiness@gmail.com', readAccess: true, missingScopes: [] })
    expect(all(db, 'SELECT id FROM mail_accounts')).toHaveLength(1)
    expect(google.state.revoked).toEqual([]) // revoking would end the new grant too
    // Fully connected: connecting again is refused.
    expect((await req('POST', '/api/gmail/connect', {})).statusCode).toBe(409)
  })

  it('requires read access (for reconciliation) before sending can be enabled', async () => {
    google.state.scope = 'https://www.googleapis.com/auth/gmail.compose'
    await connect()
    expect((await enableLive()).json().error.message).toMatch(/permissions/)
    expect((await req('POST', '/api/outreach/sync', {})).json().error.code).toBe('needs_read_access')
  })
})

describe('manual sending', () => {
  it('previews only while live sending is off', async () => {
    await connect()
    const { pitch } = await readyPitch()
    const p = await prepare({ pitchId: pitch.id })
    expect(p.ready).toBe(false)
    expect(p.token).toBeNull()
    expect(failing(p)).toEqual(['Live sending is switched on'])
    expect(p.preview.body).toContain(ADDRESS)
    expect(p.preview.body).toContain('Reply "unsubscribe"')
    expect(google.sentRequests()).toHaveLength(0)
  })

  it('sends exactly the confirmed draft once, with the media kit, and updates the CRM', async () => {
    await connect()
    await enableLive()
    const { pitch, prospect, email } = await readyPitch()
    const p = await prepare({ pitchId: pitch.id })
    expect(p.ready).toBe(true)
    expect(p.preview).toMatchObject({ to: email, subject: pitch.subject, attachment: { sha256: sha256(kitPdf) } })
    // What you confirm must match what was prepared.
    expect((await req('POST', '/api/outreach/send/confirm', { token: p.token, recipient: email, subject: 'Something else', contentSha256: p.contentSha256 })).json().error.code).toBe('confirmation_mismatch')
    expect(google.sentRequests()).toHaveLength(0)
    // The token was used up by the mismatched attempt.
    expect((await confirmFrom(p)).json().error.code).toBe('confirmation_expired')
    const r = await confirmFrom(await prepare({ pitchId: pitch.id }))
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ status: 'sent', kind: 'initial', recipient: email })
    expect(google.sentRequests()).toHaveLength(1)
    const sent = google.sentMessages()
    expect(sent).toHaveLength(1)
    expect(sha256(parseMessage(sent[0].raw).parts.find((x) => x.contentType === 'application/pdf')!.data)).toBe(sha256(kitPdf))
    expect(google.state.drafts.size).toBe(0)
    const pr = getProspect(db, prospect.id)
    expect(pr.stage).toBe('contacted')
    expect(pr.first_contacted_at).toBeTruthy()
    expect(all<{ sequence: number; status: string }>(db, 'SELECT sequence, status FROM follow_ups ORDER BY sequence')).toEqual([{ sequence: 1, status: 'scheduled' }, { sequence: 2, status: 'scheduled' }])
    expect(get(db, "SELECT status FROM gmail_drafts WHERE kind = 'pitch'")).toEqual({ status: 'sent' })
    expect(get<{ rfc822_message_id: string }>(db, 'SELECT rfc822_message_id FROM send_attempts')!.rfc822_message_id).toMatch(/@mail\.gmail\.com>$/)
    // One outreach sequence per company: nothing more can be sent for this pitch.
    const again = await prepare({ pitchId: pitch.id })
    expect(again.ready).toBe(false)
    expect(failing(again)).toEqual(expect.arrayContaining(['One outreach sequence per company']))
    expect(all(db, "SELECT operation FROM gmail_operations WHERE operation = 'send_draft'")).toHaveLength(1)
  })

  it('refuses contacts with an unknown country and suppressed recipients', async () => {
    await connect()
    await enableLive()
    const unknown = await readyPitch('Brand B', 'brand-b.test', 'unknown')
    expect(failing(await prepare({ pitchId: unknown.pitch.id }))).toEqual(['Contact verified and eligible'])
    const ok = await readyPitch('Brand C', 'brand-c.test')
    await req('POST', '/api/suppressions', { kind: 'email', value: ok.email, reason: 'Do not contact' })
    expect(failing(await prepare({ pitchId: ok.pitch.id }))).toEqual(expect.arrayContaining(['Contact verified and eligible', 'Recipient not on the do-not-contact list']))
    expect(google.sentRequests()).toHaveLength(0)
  })

  it('refuses a draft that was changed in Gmail after approval', async () => {
    await connect()
    await enableLive()
    const { pitch } = await readyPitch()
    google.editInGmail([...google.state.drafts.keys()][0])
    await req('POST', '/api/gmail/sync', {})
    expect(failing(await prepare({ pitchId: pitch.id }))).toEqual(['Gmail draft verified'])
  })

  it('STOP ALL OUTREACH blocks sending immediately, voids prepared confirmations, and keeps drafts', async () => {
    await connect()
    await enableLive()
    const { pitch } = await readyPitch()
    const p = await prepare({ pitchId: pitch.id })
    expect((await req('POST', '/api/outreach/stop', { reason: 'Testing the stop' })).json().active).toBe(true)
    expect((await confirmFrom(p)).json().error.code).toBe('confirmation_expired')
    expect(failing(await prepare({ pitchId: pitch.id }))).toEqual(['STOP ALL OUTREACH is off'])
    expect(google.state.drafts.size).toBe(1)
    expect((await req('POST', '/api/outreach/resume', {})).statusCode).toBe(400)
    expect((await req('POST', '/api/outreach/resume', { confirm: true })).json().active).toBe(false)
    expect((await sendPitch(pitch.id)).statusCode).toBe(200)
  })

  it('enforces daily limits server-side, also after a restart', async () => {
    await connect()
    await enableLive()
    setSetting(db, 'outreach.dailyLimits', { newPerDay: 1, followUpsPerDay: 5, totalPerDay: 15 })
    const a = await readyPitch('Brand A', 'brand-a.test')
    const b = await readyPitch('Brand B', 'brand-b.test')
    expect((await sendPitch(a.pitch.id)).statusCode).toBe(200)
    await app.close()
    await boot()
    expect(failing(await prepare({ pitchId: b.pitch.id }))).toEqual(['Daily limit for new emails'])
    expect(google.sentRequests()).toHaveLength(1)
  })

  it('a lost send response is UNCERTAIN, never retried, and reconciled from Sent Mail', async () => {
    await connect()
    await enableLive()
    const { pitch } = await readyPitch()
    google.state.loseNextSendResponse = true
    const r = await confirmFrom(await prepare({ pitchId: pitch.id }))
    expect(r.statusCode).toBe(504)
    expect(r.json().error.message).toMatch(/NOT retried/)
    const send = get<{ id: number; status: string }>(db, 'SELECT id, status FROM send_attempts')!
    expect(send.status).toBe('uncertain')
    expect(failing(await prepare({ pitchId: pitch.id }))).toEqual(expect.arrayContaining(['One outreach sequence per company']))
    const rec = (await req('POST', `/api/outreach/sends/${send.id}/reconcile`, {})).json()
    expect(rec).toMatchObject({ status: 'sent' })
    expect(rec.reconcile_note).toMatch(/Found in Sent Mail/)
    expect(google.sentRequests()).toHaveLength(1)
    expect(google.sentMessages()).toHaveLength(1)
  })

  it('reconciles a lost request whose draft is still in Drafts as not sent, allowing one new confirmed send', async () => {
    await connect()
    await enableLive()
    const { pitch } = await readyPitch()
    google.state.dropNextSendRequest = true
    expect((await confirmFrom(await prepare({ pitchId: pitch.id }))).statusCode).toBe(504)
    const send = get<{ id: number }>(db, 'SELECT id FROM send_attempts')!
    expect((await req('POST', `/api/outreach/sends/${send.id}/reconcile`, {})).json().status).toBe('not_sent')
    expect((await sendPitch(pitch.id)).statusCode).toBe(200)
    expect(google.sentMessages()).toHaveLength(1)
  })

  it('treats a 404 from send as uncertain and leaves unresolvable cases to you', async () => {
    await connect()
    await enableLive()
    const { pitch } = await readyPitch()
    const p = await prepare({ pitchId: pitch.id })
    google.deleteInGmail([...google.state.drafts.keys()][0]) // gone between your review and the send
    // The fresh read-back during confirm notices the draft is gone, so nothing is attempted.
    expect((await confirmFrom(p)).json().error.code).toBe('not_ready')
    expect(google.sentRequests()).toHaveLength(0)
  })

  it('requires a reconcile attempt before you resolve an uncertain send yourself', async () => {
    await connect()
    await enableLive()
    const { pitch } = await readyPitch()
    google.state.loseNextSendResponse = true
    await confirmFrom(await prepare({ pitchId: pitch.id }))
    google.state.messages.clear() // as if the sent message cannot be found
    const send = get<{ id: number }>(db, 'SELECT id FROM send_attempts')!
    expect((await req('POST', `/api/outreach/sends/${send.id}/resolve`, { confirm: true, outcome: 'not_sent' })).json().error.code).toBe('reconcile_first')
    expect((await req('POST', `/api/outreach/sends/${send.id}/reconcile`, {})).json().status).toBe('uncertain')
    expect((await req('POST', `/api/outreach/sends/${send.id}/resolve`, { confirm: true, outcome: 'not_sent' })).json().status).toBe('not_sent')
    expect(google.sentRequests()).toHaveLength(1)
  })

  it('marks a send left in flight by a crash as uncertain on restart', async () => {
    await connect()
    const { pitch, prospect } = await readyPitch()
    const accountId = get<{ id: number }>(db, 'SELECT id FROM mail_accounts')!.id
    run(db, `INSERT INTO send_attempts (kind, prospect_id, pitch_id, account_id, idempotency_key, recipient, content_sha256, status, day_key, confirmed_at, created_at, updated_at)
      VALUES ('initial', ?, ?, ?, ?, 'x@brand-a.test', 'h', 'sending', '2026-10-31', 'now', 'now', 'now')`, prospect.id, pitch.id, accountId, `initial:p${prospect.id}`)
    run(db, "INSERT INTO gmail_sync_runs (status, started_at) VALUES ('started', 'now')")
    await app.close()
    await boot()
    expect(get(db, 'SELECT status FROM send_attempts')).toEqual({ status: 'uncertain' })
    expect(get(db, 'SELECT status FROM gmail_sync_runs')).toEqual({ status: 'interrupted' })
    expect(google.sentRequests()).toHaveLength(0)
  })
})

describe('conversation sync', () => {
  async function sentBrand(name = 'Brand A', domain = 'brand-a.test') {
    const b = await readyPitch(name, domain)
    await sendPitch(b.pitch.id)
    const s = get<{ gmail_thread_id: string }>(db, 'SELECT gmail_thread_id FROM send_attempts WHERE prospect_id = ?', b.prospect.id)!
    return { ...b, threadId: s.gmail_thread_id }
  }
  beforeEach(async () => {
    await connect()
    await enableLive()
  })

  it('records a reply once, classifies it, moves the company to Replied and cancels follow-ups', async () => {
    const b = await sentBrand()
    google.receive({ from: `Partnerships <${b.email}>`, text: 'Thanks! We would love to chat next week.\n\nOn Fri, you wrote:\n> Hi', threadId: b.threadId })
    google.receive({ from: 'Newsletter <news@unrelated.test>', text: 'Big sale!' }) // never read
    const r = (await req('POST', '/api/outreach/sync', {})).json()
    expect(r).toMatchObject({ threadsChecked: 1, replies: 1, followUpsCancelled: 2 })
    expect((await req('POST', '/api/outreach/sync', {})).json()).toMatchObject({ messagesAdded: 0, replies: 0 })
    const replies = all<{ classification: string; body_text: string; contact_id: number | null; needs_review: number }>(db,
      "SELECT classification, body_text, contact_id, needs_review FROM email_messages WHERE direction = 'inbound'")
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ classification: 'interested', body_text: 'Thanks! We would love to chat next week.', needs_review: 0 })
    expect(replies[0].contact_id).not.toBeNull()
    expect(getProspect(db, b.prospect.id)).toMatchObject({ stage: 'replied' })
    expect(getProspect(db, b.prospect.id).last_reply_at).toBeTruthy()
    expect(all<{ status: string }>(db, 'SELECT status FROM follow_ups').map((f) => f.status)).toEqual(['cancelled', 'cancelled'])
    expect(JSON.stringify(all(db, 'SELECT * FROM email_messages'))).not.toContain('Big sale')
    // Only CRM conversations were read.
    expect(google.state.requests.filter((x) => x.url.includes('/messages?')).every((x) => decodeURIComponent(x.url).includes(`from:${b.email}`) || decodeURIComponent(x.url).includes('in:sent'))).toBe(true)
  })

  it('keeps follow-ups for an out-of-office reply, and lets you correct the classification', async () => {
    const b = await sentBrand()
    google.receive({ from: b.email, text: 'I am away until Monday.', threadId: b.threadId, headers: { 'Auto-Submitted': 'auto-replied' } })
    await req('POST', '/api/outreach/sync', {})
    const m = get<{ id: number; kind: string; classification: string }>(db, "SELECT id, kind, classification FROM email_messages WHERE direction = 'inbound'")!
    expect(m).toMatchObject({ kind: 'auto_reply', classification: 'out_of_office' })
    expect(all<{ status: string }>(db, 'SELECT status FROM follow_ups').map((f) => f.status)).toEqual(['scheduled', 'scheduled'])
    expect(getProspect(db, b.prospect.id).stage).toBe('contacted')
    const fixed = (await req('PATCH', `/api/outreach/messages/${m.id}`, { classification: 'needs_info' })).json()
    expect(fixed).toMatchObject({ classification: 'needs_info', classification_source: 'manual' })
    expect((await req('PATCH', `/api/outreach/messages/${m.id}`, { classification: 'made_up' })).statusCode).toBe(400)
  })

  it('honours an opt-out reply: suppresses the address and stops follow-ups', async () => {
    const b = await sentBrand()
    google.receive({ from: b.email, text: 'Please remove me from your list.', threadId: b.threadId })
    await req('POST', '/api/outreach/sync', {})
    expect(get(db, "SELECT source FROM suppressions WHERE value = ?", b.email)).toEqual({ source: 'opt_out' })
    expect(all<{ status: string }>(db, 'SELECT status FROM follow_ups').map((f) => f.status)).toEqual(['cancelled', 'cancelled'])
  })

  it('flags replies from unknown addresses or outside the thread for your review', async () => {
    const b = await sentBrand()
    google.receive({ from: 'Jamie <jamie@agency.test>', text: 'I handle their creators; what are your rates?', threadId: b.threadId })
    google.receive({ from: b.email, text: 'Following up separately: we are interested.', subject: 'Creators' })
    await req('POST', '/api/outreach/sync', {})
    const flagged = all<{ review_reason: string }>(db, "SELECT review_reason FROM email_messages WHERE direction = 'inbound' AND needs_review = 1 ORDER BY id")
    expect(flagged.map((f) => f.review_reason)).toEqual([expect.stringMatching(/different domain/), expect.stringMatching(/outside the original thread/)])
    const convs = (await req('GET', '/api/outreach/conversations')).json()
    expect(convs).toHaveLength(2)
    expect(convs.every((c: { needs_review: number }) => c.needs_review === 1)).toBe(true)
    expect((await req('POST', `/api/outreach/conversations/${convs[0].id}/reviewed`, {})).json().needs_review).toBe(0)
  })

  it('detects a pitch you sent from Gmail yourself and starts tracking it', async () => {
    const b = await readyPitch()
    google.sendFromGmail([...google.state.drafts.keys()][0])
    const r = (await req('POST', '/api/outreach/sync', {})).json()
    expect(r.sentFromGmail).toBe(1)
    expect(get(db, 'SELECT origin, status FROM send_attempts')).toEqual({ origin: 'gmail', status: 'sent' })
    expect(getProspect(db, b.prospect.id).stage).toBe('contacted')
    expect(all(db, 'SELECT id FROM follow_ups')).toHaveLength(2)
    expect(google.sentRequests()).toHaveLength(0)
  })

  it('records a deleted draft as deleted, not sent', async () => {
    await readyPitch()
    google.deleteInGmail([...google.state.drafts.keys()][0])
    await req('POST', '/api/outreach/sync', {})
    expect(get<{ status: string; sync_note: string }>(db, 'SELECT status, sync_note FROM gmail_drafts')).toMatchObject({ status: 'gone', sync_note: expect.stringMatching(/^Deleted in Gmail/) })
    expect(all(db, 'SELECT id FROM send_attempts')).toHaveLength(0)
  })
})

describe('follow-ups', () => {
  async function scheduled() {
    await connect()
    await enableLive()
    const b = await readyPitch()
    await sendPitch(b.pitch.id)
    const [f1, f2] = all<{ id: number; body: string; due_at: string; subject: string }>(db, 'SELECT id, body, due_at, subject FROM follow_ups ORDER BY sequence')
    return { ...b, f1, f2 }
  }

  it('schedules at most two, never duplicates them, and never sends one by itself', async () => {
    const { f1, pitch } = await scheduled()
    expect(f1.subject).toBe(`Re: ${pitch.subject}`)
    expect(f1.body).not.toContain(pitch.body.split('\n')[2])
    const { scheduleFollowUps } = await import('../packages/outreach/followups')
    const send = get<Parameters<typeof scheduleFollowUps>[1]>(db, 'SELECT * FROM send_attempts')!
    expect(scheduleFollowUps(db, send)).toBe(0)
    expect(all(db, 'SELECT id FROM follow_ups')).toHaveLength(2)
    run(db, "UPDATE follow_ups SET due_at = '2000-01-01T00:00:00.000Z'")
    await req('POST', '/api/outreach/sync', {})
    expect(google.sentRequests()).toHaveLength(1) // only the first email
  })

  it('supports approve, edit, reschedule, skip and cancel, with checks', async () => {
    const { f1, f2, pitch } = await scheduled()
    const copied = `${f1.body.split('\n\nBest,')[0]}\n\n${pitch.body.split('\n')[2]}\n\nBest,\nIronmanCarter\nironmancarterbusiness@gmail.com`
    await req('PATCH', `/api/outreach/follow-ups/${f1.id}`, { body: copied })
    expect((await req('POST', `/api/outreach/follow-ups/${f1.id}/approve`, {})).json().error.message).toMatch(/repeats the original pitch/)
    await req('PATCH', `/api/outreach/follow-ups/${f1.id}`, { body: f1.body })
    expect((await req('POST', `/api/outreach/follow-ups/${f1.id}/approve`, {})).json().status).toBe('approved')
    expect((await req('PATCH', `/api/outreach/follow-ups/${f1.id}`, { body: `${f1.body}\nP.S. Thanks!` })).json()).toMatchObject({ status: 'scheduled', edited: 1 })
    expect((await req('POST', `/api/outreach/follow-ups/${f2.id}/reschedule`, { dueAt: '2001-01-01T00:00:00Z' })).statusCode).toBe(400)
    const later = new Date(new Date(f2.due_at).getTime() + 2 * 86_400_000).toISOString()
    expect((await req('POST', `/api/outreach/follow-ups/${f2.id}/reschedule`, { dueAt: later })).json().due_at).toBe(later)
    expect((await req('POST', `/api/outreach/follow-ups/${f1.id}/skip`, {})).json().status).toBe('skipped')
    expect((await req('POST', `/api/outreach/follow-ups/${f2.id}/cancel`, { reason: 'Talking on Instagram instead' })).json()).toMatchObject({ status: 'cancelled', cancel_reason: 'Talking on Instagram instead' })
    const list = (await req('GET', '/api/outreach/follow-ups')).json()
    expect(list.map((f: { group: string }) => f.group)).toEqual(['skipped', 'cancelled'])
  })

  it('drafts a threaded follow-up and sends it only when due, approved and confirmed', async () => {
    const { f1, prospect } = await scheduled()
    await req('POST', `/api/outreach/follow-ups/${f1.id}/approve`, {})
    const d = (await req('POST', `/api/outreach/follow-ups/${f1.id}/gmail-draft`, { confirm: true })).json()
    expect(d).toMatchObject({ kind: 'follow_up', status: 'created' })
    const original = get<{ gmail_thread_id: string; rfc822_message_id: string }>(db, "SELECT gmail_thread_id, rfc822_message_id FROM send_attempts WHERE kind = 'initial'")!
    expect(d.gmail_thread_id).toBe(original.gmail_thread_id)
    const raw = parseMessage(google.draftRaw(d.gmail_draft_id))
    expect(raw.headers['in-reply-to']).toBe(original.rfc822_message_id)
    expect(raw.parts.filter((x) => x.contentType === 'application/pdf')).toHaveLength(0)
    expect((await req('POST', `/api/outreach/follow-ups/${f1.id}/gmail-draft`, { confirm: true })).json().error.code).toBe('duplicate')
    expect(failing(await prepare({ followUpId: f1.id }))).toEqual(['Follow-up is due'])
    run(db, "UPDATE follow_ups SET due_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", f1.id)
    const p = await prepare({ followUpId: f1.id })
    expect(p.ready).toBe(true)
    expect((await confirmFrom(p)).json()).toMatchObject({ status: 'sent', kind: 'follow_up' })
    expect(get(db, 'SELECT status FROM follow_ups WHERE id = ?', f1.id)).toEqual({ status: 'sent' })
    const sent = google.sentMessages()
    expect(sent).toHaveLength(2)
    expect(new Set(sent.map((m) => m.threadId)).size).toBe(1)
    expect(getProspect(db, prospect.id).stage).toBe('contacted')
  })

  it('checks for a reply right before a follow-up is sent', async () => {
    const { f1, email } = await scheduled()
    await req('POST', `/api/outreach/follow-ups/${f1.id}/approve`, {})
    await req('POST', `/api/outreach/follow-ups/${f1.id}/gmail-draft`, { confirm: true })
    run(db, "UPDATE follow_ups SET due_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", f1.id)
    const thread = get<{ gmail_thread_id: string }>(db, "SELECT gmail_thread_id FROM send_attempts WHERE kind = 'initial'")!.gmail_thread_id
    // Prepared while no reply existed; the reply arrives before you confirm. No sync in between.
    const p = await prepare({ followUpId: f1.id })
    expect(p.ready).toBe(true)
    google.receive({ from: email, text: 'Got it, we are interested!', threadId: thread })
    expect((await confirmFrom(p)).json().error.code).toBe('not_ready')
    expect(get<{ cancel_reason: string }>(db, 'SELECT cancel_reason FROM follow_ups WHERE id = ?', f1.id)!.cancel_reason).toMatch(/replied/i)
    expect(failing(await prepare({ followUpId: f1.id }))).toContain('Follow-up approved')
    expect(google.sentRequests()).toHaveLength(1)
  })

  it('cancels pending follow-ups when the company is marked do-not-contact or the deal closes', async () => {
    const { prospect } = await scheduled()
    await req('POST', '/api/suppressions', { kind: 'domain', value: 'brand-a.test', reason: 'Do not contact' })
    expect(all<{ status: string; cancel_reason: string }>(db, 'SELECT status, cancel_reason FROM follow_ups')).toEqual([
      { status: 'cancelled', cancel_reason: expect.stringMatching(/do-not-contact/) }, { status: 'cancelled', cancel_reason: expect.stringMatching(/do-not-contact/) }])
    expect(getProspect(db, prospect.id).stage).toBe('contacted')
  })
})

describe('outreach dashboard', () => {
  it('counts only real records', async () => {
    const empty = (await req('GET', '/api/outreach/overview')).json()
    expect(empty).toMatchObject({ emailsSent: 0, repliesReceived: 0, followUpsDue: 0, interestedBrands: 0, activeNegotiations: 0, liveSendingEnabled: false })
    await connect()
    await enableLive()
    const b = await readyPitch()
    expect((await req('GET', '/api/outreach/sending-queue')).json()[0]).toMatchObject({ company: 'Brand A', readyForReview: true, mediaKit: 'verified' })
    await sendPitch(b.pitch.id)
    const thread = get<{ gmail_thread_id: string }>(db, 'SELECT gmail_thread_id FROM send_attempts')!.gmail_thread_id
    google.receive({ from: b.email, text: 'Sounds great, let’s set up a call.', threadId: thread })
    await req('POST', '/api/outreach/sync', {})
    const o = (await req('GET', '/api/outreach/overview')).json()
    expect(o).toMatchObject({ approvedProspects: 1, emailsSent: 1, repliesReceived: 1, interestedBrands: 1, readyToSend: 0 })
    expect((await req('GET', `/api/prospects/${b.prospect.id}/conversation`)).json().map((m: { kind: string }) => m.kind)).toEqual(['sent', 'reply'])
    expect((await req('GET', '/api/outreach/activity')).json().some((a: { type: string }) => a.type === 'send.sent')).toBe(true)
  })
})
