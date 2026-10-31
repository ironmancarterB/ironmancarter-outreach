import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../apps/server/src/app'
import { all, get, getSetting, run, setSetting, type DB } from '../packages/db'
import { addContact, createProspect, reviewProspect } from '../packages/crm/prospects'
import { importMediaKit } from '../packages/mediakit/store'
import { approvePitch, generatePitch, regeneratePitch, updatePitch } from '../packages/pitch/service'
import { applySignature, DEFAULT_SIGNATURE, endsWithSignature, stripSignature } from '../packages/pitch/signature'
import { forgetAccessTokens } from '../packages/gmail/account'
import { GoogleApi } from '../packages/gmail/google'
import { parseMessage } from '../packages/gmail/mime'
import { memoryStore } from '../packages/gmail/secrets'
import type { AIProvider } from '../packages/ai/types'
import { fakeGoogle } from './fakeGoogle'
import { fakePdf, freshDb, tempDir } from './helpers'

const SIG = 'Best,\nCarter'
const count = (body: string, sig = SIG) => body.split(sig).length - 1

describe('applySignature', () => {
  it('replaces every old default sign-off with the signature, exactly once', () => {
    for (const old of [
      'Best,\nIronmanCarter\nironmancarterbusiness@gmail.com',
      'Best,\nIronmanCarterTTV',
      'Thanks,\nIronmanCarter Outreach',
      'Cheers,\nIronmanCarter',
      'IronmanCarter\nironmancarterbusiness@gmail.com',
      'Best,\nCarter',
    ]) {
      const out = applySignature(`Hi team,\n\nWould you be open to a quick chat?\n\n${old}`, SIG)
      expect(out).toBe('Hi team,\n\nWould you be open to a quick chat?\n\nBest,\nCarter')
    }
  })
  it('is idempotent and keeps a P.S. below the signature', () => {
    const once = applySignature('Hi team,\n\nHello there.', SIG)
    expect(applySignature(applySignature(once, SIG), SIG)).toBe(once)
    const ps = applySignature('Hi team,\n\nHello there.\n\nBest,\nIronmanCarter\n\nP.S. Loved your last launch!', SIG)
    expect(ps).toBe('Hi team,\n\nHello there.\n\nBest,\nCarter\n\nP.S. Loved your last launch!')
    expect(endsWithSignature(ps, SIG)).toBe(true)
    expect(stripSignature(ps, SIG)).toBe('Hi team,\n\nHello there.')
  })
  it('does not mistake a sentence for a sign-off', () => {
    expect(applySignature('Hi team,\n\nThanks!\nI have one more idea for you.', SIG)).toBe('Hi team,\n\nThanks!\nI have one more idea for you.\n\nBest,\nCarter')
  })
})

let db: DB, app: FastifyInstance, google: ReturnType<typeof fakeGoogle>, dir: string, cleanup: () => void
const H = { host: '127.0.0.1:5181', 'x-outreach-client': 'dashboard' }
const req = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown) => app.inject({ method, url, headers: H, ...(payload !== undefined ? { payload: payload as object } : {}) })

beforeEach(async () => {
  const t = tempDir()
  dir = t.dir
  cleanup = t.cleanup
  db = freshDb()
  importMediaKit(db, dir, { buffer: fakePdf('kit'), originalFilename: 'Content Media Kit Final (corrected email).pdf' })
  setSetting(db, 'business.postalAddress', '123 Example St, Los Angeles, CA 90001')
  google = fakeGoogle()
  forgetAccessTokens()
  app = await buildApp({ db, dataDir: dir, gmail: { api: new GoogleApi(google.fetchImpl), secrets: memoryStore(), redirectUri: 'http://127.0.0.1:5181/api/gmail/oauth/callback' } })
})
afterEach(async () => {
  await app.close()
  cleanup()
})

async function connect() {
  await req('PUT', '/api/gmail/client', { client_id: '1234567890-abc.apps.googleusercontent.com', client_secret: 'GOCSPX-test-secret-value' })
  const { url } = (await req('POST', '/api/gmail/connect', {})).json()
  await app.inject({ url: `/api/gmail/oauth/callback?state=${new URL(url).searchParams.get('state')}&code=x`, headers: { host: '127.0.0.1:5181' } })
}

function brand(name = 'Brand A', domain = 'brand-a.test') {
  const p = createProspect(db, { company_name: name, website: `https://${domain}`, category_id: 1, products: 'Gaming mice' })
  run(db, 'INSERT INTO research_sources (prospect_id, url, title, kind, retrieved_at, snippet) VALUES (?, ?, ?, ?, ?, ?)',
    p.id, `https://${domain}/creators`, 'Creator program', 'sponsorship_evidence', new Date().toISOString(), `Join the ${name} Creator Program.`)
  addContact(db, p.id, { email: `partnerships@${domain}`, source_url: `https://${domain}/creators`, verification_status: 'verified', jurisdiction: 'US', is_primary: true, discovered_by: 'research' })
  run(db, 'INSERT INTO contacts (prospect_id, contact_form_url, source_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', p.id, `https://${domain}/apply`, `https://${domain}/apply`, 'now', 'now')
  reviewProspect(db, p.id, 'approved')
  return p
}

describe('signature in every outbound workflow', () => {
  it('defaults to "Best,\\nCarter" and is configurable in Settings → Business, with validation', async () => {
    expect(getSetting<string>(db, 'business.signature')).toBe(DEFAULT_SIGNATURE)
    expect((await req('PATCH', '/api/settings', { 'business.signature': 'Thanks,\nCarter\nother@agency.test' })).statusCode).toBe(400)
    expect((await req('PATCH', '/api/settings', { 'business.signature': '' })).statusCode).toBe(400)
    expect((await req('PATCH', '/api/settings', { 'business.signature': 'Cheers,\r\nCarter  ' })).json().values['business.signature']).toBe('Cheers,\nCarter')
    expect(getSetting<string>(db, 'business.email')).toBe('ironmancarterbusiness@gmail.com')
  })

  it('template pitches (email and manual) end with the signature once', async () => {
    const p = brand()
    const email = await generatePitch(db, p.id, { channel: 'email' })
    const manual = await generatePitch(db, p.id, { channel: 'manual_form' })
    for (const x of [email, manual]) {
      expect(x.body.endsWith('\n\nBest,\nCarter')).toBe(true)
      expect(count(x.body)).toBe(1)
      expect(x.body).not.toMatch(/\nIronmanCarter(TTV| Outreach)?\n|ironmancarterbusiness@gmail\.com$/)
    }
  })

  it('local-AI pitches get the signature in place of whatever sign-off the model wrote', async () => {
    setSetting(db, 'ai.provider', 'ollama')
    const p = brand()
    const text = `Subject: Brand A x IronmanCarter

Hi Brand A team,

I'm IronmanCarter, a comedic League of Legends creator [F1]. Between Aug 1 and Oct 29, 2026, my Instagram videos got about 7.9M views [F2] and my YouTube videos about 4.2M views [F3]. About 85% of my Instagram audience is 18–34 [F4]. I saw your Creator Program invites creators to partner with you [F5]. My media kit is attached [F7]. It would be a natural fit for my channel, and I would bring real energy to the idea with a fun Short that shows the gear in a clutch moment. Would you be open to a quick chat about a paid partnership?

Thanks so much,
IronmanCarterTTV
ironmancarterbusiness@gmail.com`
    const ollama: AIProvider = { id: 'ollama', billing: 'free_local', model: () => 'gemma4:12b', generate: async () => ({ text, model: 'gemma4:12b', inputTokens: 1, outputTokens: 1 }) }
    const pitch = await generatePitch(db, p.id, { channel: 'email' }, { ai: { providers: { ollama } } })
    expect(pitch.generator).toBe('ollama')
    expect(pitch.body.endsWith('a paid partnership?\n\nBest,\nCarter')).toBe(true)
    expect(pitch.body).not.toContain('IronmanCarterTTV')
  })

  it('editing or regenerating never duplicates the signature', async () => {
    const p = brand()
    const pitch = await generatePitch(db, p.id, { channel: 'email' })
    const edited = updatePitch(db, pitch.id, { body: `${pitch.body}\n\nBest,\nCarter\n\nBest,\nIronmanCarter\nironmancarterbusiness@gmail.com` })
    expect(count(edited.body)).toBe(1)
    expect(edited.body.endsWith('\n\nBest,\nCarter')).toBe(true)
    const again = await regeneratePitch(db, edited.id)
    expect(count(again.body)).toBe(1)
  })

  it('Gmail drafts carry the signature above the compliance footer, from your unchanged address', async () => {
    await connect()
    const p = brand()
    const pitch = approvePitch(db, (await generatePitch(db, p.id, { channel: 'email' })).id)
    const d = (await req('POST', `/api/pitches/${pitch.id}/gmail-draft`, { confirm: true })).json()
    expect(d.gmail.draft.verification.ok).toBe(true)
    const raw = parseMessage(google.draftRaw([...google.state.drafts.keys()][0]))
    const text = raw.parts.find((x) => x.contentType === 'text/plain')!.data.toString('utf8').replace(/\r\n/g, '\n')
    expect(text).toMatch(/\n\nBest,\nCarter\n\n--\n123 Example St, Los Angeles, CA 90001\nPrefer not to hear from me\?/)
    expect(count(text)).toBe(1)
    expect(raw.headers.from).toBe('"IronmanCarter" <ironmancarterbusiness@gmail.com>')
  })

  it('follow-ups end with the signature, and edits keep exactly one', async () => {
    await connect()
    await req('POST', '/api/outreach/live-sending', { enable: true, phrase: 'ENABLE MANUAL SENDING' })
    const p = brand()
    const pitch = approvePitch(db, (await generatePitch(db, p.id, { channel: 'email' })).id)
    await req('POST', `/api/pitches/${pitch.id}/gmail-draft`, { confirm: true })
    const prep = (await req('POST', '/api/outreach/send/prepare', { pitchId: pitch.id })).json()
    expect((await req('POST', '/api/outreach/send/confirm', { token: prep.token, recipient: prep.preview.to, subject: prep.preview.subject, contentSha256: prep.contentSha256 })).json().status).toBe('sent')
    const fus = all<{ id: number; body: string }>(db, 'SELECT id, body FROM follow_ups ORDER BY sequence')
    expect(fus).toHaveLength(2)
    for (const f of fus) { expect(f.body.endsWith('\n\nBest,\nCarter')).toBe(true); expect(count(f.body)).toBe(1) }
    const e = (await req('PATCH', `/api/outreach/follow-ups/${fus[0].id}`, { body: `${fus[0].body}\n\nThanks,\nIronmanCarter` })).json()
    expect(count(e.body)).toBe(1)
    expect(e.body.endsWith('Best,\nCarter')).toBe(true)
  })

  it('a new signature updates unsent drafts and their Gmail copies in place, never sent emails or history', async () => {
    await connect()
    await req('POST', '/api/outreach/live-sending', { enable: true, phrase: 'ENABLE MANUAL SENDING' })
    // Brand A: sent already (history must not change). Brand B: approved with a Gmail draft. Brand C: unapproved draft.
    const a = brand('Brand A', 'brand-a.test'), b = brand('Brand B', 'brand-b.test'), c = brand('Brand C', 'brand-c.test')
    const pa = approvePitch(db, (await generatePitch(db, a.id, { channel: 'email' })).id)
    await req('POST', `/api/pitches/${pa.id}/gmail-draft`, { confirm: true })
    const prep = (await req('POST', '/api/outreach/send/prepare', { pitchId: pa.id })).json()
    await req('POST', '/api/outreach/send/confirm', { token: prep.token, recipient: prep.preview.to, subject: prep.preview.subject, contentSha256: prep.contentSha256 })
    const sentRawBefore = google.sentMessages()[0].raw.toString('latin1')
    const historyBefore = JSON.stringify(all(db, "SELECT * FROM email_messages WHERE kind != 'draft' ORDER BY id"))
    const sentPitchBody = get<{ body: string }>(db, 'SELECT body FROM pitches WHERE id = ?', pa.id)!.body
    const pb = approvePitch(db, (await generatePitch(db, b.id, { channel: 'email' })).id)
    await req('POST', `/api/pitches/${pb.id}/gmail-draft`, { confirm: true })
    const draftId = get<{ gmail_draft_id: string }>(db, 'SELECT gmail_draft_id FROM gmail_drafts WHERE pitch_id = ?', pb.id)!.gmail_draft_id
    const pc = await generatePitch(db, c.id, { channel: 'email' })
    const sendsBefore = google.sentRequests().length

    const r = (await req('PATCH', '/api/settings', { 'business.signature': 'Thanks,\nCarter' })).json()
    expect(r.signatureRefresh).toMatchObject({ gmailDraftsUpdated: 1, skipped: [] })
    expect(r.signatureRefresh.pitches).toBeGreaterThanOrEqual(2) // Brand B and Brand C (+ follow-ups for Brand A)

    const NEW = 'Thanks,\nCarter'
    for (const id of [pb.id, pc.id]) {
      const body = get<{ body: string }>(db, 'SELECT body FROM pitches WHERE id = ?', id)!.body
      expect(body.endsWith(`\n\n${NEW}`)).toBe(true)
      expect(body).not.toContain('Best,\nCarter')
    }
    expect(get(db, 'SELECT status FROM pitches WHERE id = ?', pb.id)).toEqual({ status: 'approved' })
    // Same Gmail draft, new content, still verified; nothing sent.
    expect([...google.state.drafts.keys()]).toEqual([draftId])
    expect(parseMessage(google.draftRaw(draftId)).parts.find((x) => x.contentType === 'text/plain')!.data.toString('utf8')).toContain('Thanks,\r\nCarter\r\n\r\n--')
    expect((await req('GET', `/api/pitches/${pb.id}`)).json().gmail.draft).toMatchObject({ outOfDate: false })
    expect(google.sentRequests()).toHaveLength(sendsBefore)
    // Pending follow-ups for Brand A picked up the new signature; the sent email and history did not change.
    for (const f of all<{ body: string }>(db, "SELECT body FROM follow_ups WHERE status = 'scheduled'")) expect(f.body.endsWith(NEW)).toBe(true)
    expect(google.sentMessages()[0].raw.toString('latin1')).toBe(sentRawBefore)
    expect(JSON.stringify(all(db, "SELECT * FROM email_messages WHERE kind != 'draft' ORDER BY id"))).toBe(historyBefore)
    expect(get<{ body: string }>(db, 'SELECT body FROM pitches WHERE id = ?', pa.id)!.body).toBe(sentPitchBody)
    expect(getSetting<boolean>(db, 'outreach.liveSendingEnabled')).toBe(true) // unchanged by the refresh (enabled for this test only)
  })

  it('leaves a Gmail draft you changed in Gmail alone and reports it', async () => {
    await connect()
    const p = brand()
    const pitch = approvePitch(db, (await generatePitch(db, p.id, { channel: 'email' })).id)
    await req('POST', `/api/pitches/${pitch.id}/gmail-draft`, { confirm: true })
    google.editInGmail([...google.state.drafts.keys()][0])
    await req('POST', '/api/gmail/sync', {})
    const r = (await req('PATCH', '/api/settings', { 'business.signature': 'Thanks,\nCarter' })).json()
    expect(r.signatureRefresh.gmailDraftsUpdated).toBe(0)
    expect(r.signatureRefresh.skipped[0]).toMatch(/changed it in Gmail/)
  })
})
