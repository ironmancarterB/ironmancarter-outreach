import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { get, run, setSetting, type DB } from '../packages/db'
import { addContact, createProspect, getProspect, reviewProspect } from '../packages/crm/prospects'
import { importMediaKit } from '../packages/mediakit/store'
import { classifyProgram, outreachPriority } from '../packages/pitch/programType'
import { gatherFacts } from '../packages/pitch/facts'
import { runChecks, bodyWords } from '../packages/pitch/checks'
import { firstSentence } from '../packages/pitch/template'
import { approvePitch, attachmentReference, evaluatePitch, generatePitch, outreachQueue, regeneratePitch, rejectPitch, updatePitch } from '../packages/pitch/service'
import { markSubmitted, updateApplication } from '../packages/pitch/applications'
import { updatePackage } from '../packages/pitch/packages'
import { ensureMailDomains } from '../packages/research/mailDomain'
import type { AIProvider } from '../packages/ai/types'
import { fakePdf, freshDb, tempDir } from './helpers'

let cleanup: (() => void) | undefined
afterEach(() => cleanup?.())

// Imports a stand-in media kit as the default (pitches reference the default kit).
function withKit(db: DB) {
  const t = tempDir()
  cleanup = t.cleanup
  return { dir: t.dir, kit: importMediaKit(db, t.dir, { buffer: fakePdf('kit'), originalFilename: 'Content Media Kit Final.pdf' }).kit }
}

type Opts = { evidence?: { title: string; snippet: string; url?: string }[]; email?: string | null; category?: number; name?: string; domain?: string; approve?: boolean }

// A researched, approved company with recorded evidence and a verified partnerships mailbox.
function brand(db: DB, o: Opts = {}) {
  const name = o.name ?? 'Brand A'
  const domain = o.domain ?? 'brand-a.test'
  const p = createProspect(db, { company_name: name, website: `https://${domain}`, category_id: o.category ?? 1, products: 'Lightweight gaming mice', campaign_concept: 'A clutch-play Short featuring the mouse.' })
  const add = (url: string, title: string | null, kind: string, snippet: string | null) =>
    run(db, 'INSERT INTO research_sources (prospect_id, url, title, kind, retrieved_at, snippet) VALUES (?, ?, ?, ?, ?, ?)', p.id, url, title, kind, '2026-10-30T12:00:00.000Z', snippet)
  add(`https://${domain}/`, 'Brand A', 'website', 'Lightweight gaming mice')
  for (const e of o.evidence ?? [{ title: 'Creator program', snippet: 'Join the Brand A Creator Program and partner with us.', url: `https://${domain}/creators` }]) {
    add(e.url ?? `https://${domain}/creators`, e.title, 'sponsorship_evidence', e.snippet)
  }
  if (o.email !== null) {
    addContact(db, p.id, { email: o.email ?? `partnerships@${domain}`, source_url: `https://${domain}/creators`, verification_status: 'verified', jurisdiction: 'US', is_primary: true, discovered_by: 'research' })
  }
  if (o.approve !== false) reviewProspect(db, p.id, 'approved')
  return p
}

describe('program classification', () => {
  it('only calls a program paid when a source says so', () => {
    expect(classifyProgram([{ signal: 'creator_program', snippet: 'Get paid to create content with us.' }]).type).toBe('paid_sponsorship')
    expect(classifyProgram([{ signal: 'creator_program', snippet: 'Join our creator program.' }]).type).toBe('creator_partnerships')
    expect(classifyProgram([{ signal: 'affiliate_program', snippet: 'Earn 10% commission.' }]).type).toBe('affiliate_only')
    expect(classifyProgram([]).type).toBe('unknown')
  })
  it('ranks demonstrated creator partnerships and verified email first', () => {
    expect(outreachPriority(70, 'creator_partnerships', true)).toBeGreaterThan(outreachPriority(80, 'affiliate_only', false))
  })
})

describe('pitch generation', () => {
  it('refuses unreviewed companies', async () => {
    const db = freshDb()
    const p = brand(db, { approve: false })
    await expect(generatePitch(db, p.id, { channel: 'email' })).rejects.toThrow(/Approve Brand A/)
  })

  it('writes a personalized 100–150 word pitch from verified facts only', async () => {
    const db = freshDb()
    withKit(db)
    const p = brand(db)
    const pitch = await generatePitch(db, p.id, { channel: 'email' })
    const body = pitch.body
    expect(pitch).toMatchObject({ status: 'draft', generator: 'template', channel: 'email', recipient_email: 'partnerships@brand-a.test' })
    expect(body).toMatch(/^Hi Brand A partnerships team,/)
    expect(body).toContain('I saw Brand A runs a creator program')
    expect(body).toContain('7.9M Instagram views and 4.2M YouTube views')
    expect(body).toContain('Between Aug 1 and Oct 29, 2026')
    expect(body.endsWith('\n\nBest,\nCarter')).toBe(true)
    expect(body).not.toMatch(/\nIronmanCarter\n|ironmancarterbusiness@gmail\.com/)
    expect(body).toContain('media kit')
    expect(body).toMatch(/recurring monthly partnership/)
    expect(body).not.toMatch(/\$/)
    expect(bodyWords(body)).toBeGreaterThanOrEqual(100)
    expect(bodyWords(body)).toBeLessThanOrEqual(150)
    expect(pitch.subject).toBe('Brand A x IronmanCarter: sponsored League of Legends content')

    const claims = JSON.parse(pitch.claims)
    const brandClaim = claims.find((c: { kind: string }) => c.kind === 'brand')
    expect(brandClaim.sources[0]).toMatchObject({ type: 'research', url: 'https://brand-a.test/creators', snippet: expect.stringContaining('Creator Program') })
    expect(claims.find((c: { kind: string }) => c.kind === 'metric').sources.map((s: { label: string }) => s.label)).toEqual(['Views', 'Views', 'Audience ages 18–34'])

    const { checks } = evaluatePitch(db, pitch)
    expect(checks.filter((c) => c.level === 'blocker')).toEqual([])
    expect(getProspect(db, p.id).stage).toBe('draft_ready')
  })

  it('pitches a paid sponsorship to affiliate-only brands instead of joining the affiliate program', async () => {
    const db = freshDb()
    const p = brand(db, { evidence: [{ title: 'Affiliate program', snippet: 'Join our affiliate program and earn commission.' }] })
    const pitch = await generatePitch(db, p.id, { channel: 'email' })
    expect(pitch.subject).toBe('Paid sponsorship idea for Brand A from IronmanCarter')
    expect(pitch.body).toContain("I know Brand A has an affiliate program, but I'm reaching out about a paid sponsorship instead")
    expect(JSON.parse(pitch.flags).map((f: { code: string }) => f.code)).toContain('affiliate_only')
  })

  it('flags a missing media kit instead of claiming an attachment', async () => {
    const db = freshDb()
    const p = brand(db)
    const pitch = await generatePitch(db, p.id, { channel: 'email' })
    expect(pitch.body).not.toContain('attached')
    expect(JSON.parse(pitch.flags).find((f: { code: string }) => f.code === 'no_media_kit').level).toBe('missing')
  })

  it('flags missing evidence instead of inventing it', async () => {
    const db = freshDb()
    const p = brand(db, { evidence: [] })
    const pitch = await generatePitch(db, p.id, { channel: 'email' })
    expect(pitch.body).not.toMatch(/I saw|runs a creator program|affiliate/)
    expect(JSON.parse(pitch.claims).some((c: { kind: string }) => c.kind === 'brand')).toBe(false)
    expect(JSON.parse(pitch.flags).find((f: { code: string }) => f.code === 'no_evidence').level).toBe('missing')
  })

  it('never offers rates unless you choose to, and uses your wording exactly', async () => {
    const db = freshDb()
    const p = brand(db)
    const plain = await generatePitch(db, p.id, { channel: 'email', package_id: 1 })
    expect(plain.body).toContain('single sponsored short')
    expect(plain.body).not.toContain('$')
    const priced = await regeneratePitch(db, plain.id, { include_rates: true })
    expect(priced.body).toContain('usually $500–$750')
    expect(evaluatePitch(db, priced).checks.filter((c) => c.level === 'blocker')).toEqual([])
    const monthly = await regeneratePitch(db, priced.id, { package_id: 3, include_rates: true })
    expect(monthly.body).toMatch(/monthly partnership \(recurring short-form integrations each month, usually \$2,000–\$3,000 a month\) rather than a one-off/)
    const custom = await regeneratePitch(db, monthly.id, { package_id: null, include_rates: false, custom_rate_text: '$1,200 for two Shorts' })
    expect(custom.body).toContain('$1,200 for two Shorts')
    expect(JSON.parse(custom.flags).map((f: { code: string }) => f.code)).toContain('rates_included')
  })

  it('uses your custom collaboration idea, without breaking on abbreviations', async () => {
    const db = freshDb()
    const p = brand(db)
    const pitch = await generatePitch(db, p.id, { channel: 'email', concept: 'A three-part ranked climb series (e.g. Iron to Bronze) using the mouse. Extra detail.' })
    expect(pitch.body).toContain("Here's what I have in mind: a three-part ranked climb series (e.g. Iron to Bronze) using the mouse.")
    expect(firstSentence('One idea (i.e. this one). Another.')).toBe('One idea (i.e. this one)')
  })

  it('keeps one live pitch per channel and versions regenerations', async () => {
    const db = freshDb()
    const p = brand(db)
    const a = await generatePitch(db, p.id, { channel: 'email' })
    const b = await regeneratePitch(db, a.id)
    expect(b.version).toBe(2)
    expect(get(db, 'SELECT status FROM pitches WHERE id = ?', a.id)).toEqual({ status: 'superseded' })
    await expect(regeneratePitch(db, a.id)).rejects.toThrow(/newer version/)
  })
})

describe('quality checks', () => {
  async function draft(db: DB, category = 1) {
    const p = brand(db, { category, name: `Brand ${category}`, domain: `brand-${category}.test` })
    return generatePitch(db, p.id, { channel: 'email' })
  }
  const blockersAfterEdit = async (db: DB, id: number, body: string, subject?: string) => {
    const p = updatePitch(db, id, { body, ...(subject !== undefined ? { subject } : {}) })
    return evaluatePitch(db, p).checks.filter((c) => c.level === 'blocker').map((c) => c.code)
  }

  it('blocks invented numbers, promises, fake history, budgets, prices, other emails and placeholders', async () => {
    const db = freshDb()
    const pitch = await draft(db)
    const sig = '\n\nBest,\nCarter'
    const base = pitch.body.split('\n\nBest,')[0]
    expect(await blockersAfterEdit(db, pitch.id, `${base} I average 50M views a month.${sig}`)).toContain('unsupported_number')
    expect(await blockersAfterEdit(db, pitch.id, `${base} I guarantee strong sales.${sig}`)).toContain('guarantee')
    expect(await blockersAfterEdit(db, pitch.id, `${base} Great chatting with you last week.${sig}`)).toContain('relationship')
    expect(await blockersAfterEdit(db, pitch.id, `${base} This fits your marketing budget.${sig}`)).toContain('budget')
    expect(await blockersAfterEdit(db, pitch.id, `${base} It costs $500.${sig}`)).toContain('price')
    expect(await blockersAfterEdit(db, pitch.id, `${base} Ask jane@agency.test.${sig}`)).toContain('other_email')
    expect(await blockersAfterEdit(db, pitch.id, `${base} [insert stat here]${sig}`)).toContain('placeholder')
    // Saving without a sign-off adds your signature once instead of failing.
    expect(await blockersAfterEdit(db, pitch.id, base)).not.toContain('signature')
    expect(get<{ body: string }>(db, 'SELECT body FROM pitches WHERE id = ?', pitch.id)!.body.endsWith(`${base.trim()}\n\nBest,\nCarter`)).toBe(true)
    expect(await blockersAfterEdit(db, pitch.id, `${base}${sig}`, 'Re: our chat')).toContain('subject')
  })

  it('applies category guardrails for VPN and energy drink brands', async () => {
    const db = freshDb()
    const vpn = await draft(db, 8)
    const sig = '\n\nBest,\nCarter'
    expect(await blockersAfterEdit(db, vpn.id, `${vpn.body.split('\n\nBest,')[0]} It keeps you completely anonymous online.${sig}`)).toContain('category_claim')
    const drink = await draft(db, 7)
    const drinkBase = drink.body.split('\n\nBest,')[0]
    expect(await blockersAfterEdit(db, drink.id, `${drinkBase} Perfect for teens grinding ranked.${sig}`)).toContain('category_claim')
    expect(await blockersAfterEdit(db, drink.id, `${drinkBase} It improves focus in games.${sig}`)).toContain('category_claim')
  })

  it('warns about generic mass-email phrasing', async () => {
    const db = freshDb()
    const p = brand(db)
    const f = gatherFacts(db, p.id, { channel: 'email' })
    const { checks } = runChecks(f, 'Hi', `I hope this email finds you well. Let's create synergy for Brand A.\n\nBest,\nCarter`)
    expect(checks.find((c) => c.code === 'generic')?.message).toMatch(/hope this email finds you well.*synergy/)
  })
})

describe('evidence validation', () => {
  it('notices removed sources and changed analytics after drafting', async () => {
    const db = freshDb()
    const p = brand(db)
    const pitch = await generatePitch(db, p.id, { channel: 'email' })
    run(db, "DELETE FROM research_sources WHERE kind = 'sponsorship_evidence'")
    run(db, "UPDATE creator_metrics SET value = 8100000 WHERE platform = 'instagram' AND metric_key = 'views_90d'")
    const { checks, claims } = evaluatePitch(db, pitch)
    expect(claims.find((c) => c.kind === 'brand')!.problems[0]).toMatch(/has been removed/)
    expect(claims.find((c) => c.kind === 'metric')!.problems[0]).toMatch(/changed from 7,933,413 to 8,100,000/)
    // The old figure in the text is no longer backed by your analytics.
    expect(checks.find((c) => c.code === 'unsupported_number')?.message).toContain('7.9')
  })
})

describe('approval workflow', () => {
  it('approves only clean drafts and never sends anything', async () => {
    const db = freshDb()
    const p = brand(db)
    const pitch = await generatePitch(db, p.id, { channel: 'email' })
    updatePitch(db, pitch.id, { body: `${pitch.body.split('\n\nBest,')[0]} I guarantee 1M views.\n\nBest,\nCarter` })
    expect(() => approvePitch(db, pitch.id)).toThrow(/Fix these first/)
    updatePitch(db, pitch.id, { body: pitch.body })
    const approved = approvePitch(db, pitch.id)
    expect(approved.status).toBe('approved')
    expect(getProspect(db, p.id).stage).toBe('awaiting_approval')
    expect(get<{ summary: string }>(db, "SELECT summary FROM activities WHERE type = 'pitch.approved'")!.summary).toMatch(/Nothing was sent/)
  })

  it('withdraws approval when an approved pitch is edited', async () => {
    const db = freshDb()
    const p = brand(db)
    const pitch = await generatePitch(db, p.id, { channel: 'email' })
    approvePitch(db, pitch.id)
    const edited = updatePitch(db, pitch.id, { subject: 'Brand A x IronmanCarter: a League Shorts idea' })
    expect(edited).toMatchObject({ status: 'draft', edited: 1 })
    expect(getProspect(db, p.id).stage).toBe('draft_ready')
  })

  it('requires a reason to reject and returns the company to Qualified', async () => {
    const db = freshDb()
    const p = brand(db)
    const pitch = await generatePitch(db, p.id, { channel: 'email' })
    expect(() => rejectPitch(db, pitch.id, ' ')).toThrow(/reason/)
    expect(rejectPitch(db, pitch.id, 'Tone is off').status).toBe('rejected')
    expect(getProspect(db, p.id).stage).toBe('qualified')
  })

  it('pulls pitches out of the workflow if the company is un-approved', async () => {
    const db = freshDb()
    const p = brand(db)
    const pitch = await generatePitch(db, p.id, { channel: 'email' })
    reviewProspect(db, p.id, 'pending')
    expect(get(db, 'SELECT status, reject_reason FROM pitches WHERE id = ?', pitch.id)).toEqual({ status: 'rejected', reject_reason: 'Company review changed to pending' })
  })

  it('refuses to draft an email with no qualifying recipient', async () => {
    const db = freshDb()
    const p = brand(db, { email: null })
    await expect(generatePitch(db, p.id, { channel: 'email' })).rejects.toThrow(/no qualifying public email/)
  })

  it('lists approved companies to draft, best first', async () => {
    const db = freshDb()
    brand(db, { name: 'Affiliate Co', domain: 'aff.test', evidence: [{ title: 'Affiliate program', snippet: 'Affiliate program.' }] })
    brand(db, { name: 'Creator Co', domain: 'creator.test' })
    const unreviewed = brand(db, { name: 'Unreviewed', domain: 'unrev.test', approve: false })
    await ensureMailDomains(db, unreviewed.id)
    const q = outreachQueue(db)
    expect(q.ready.map((r) => r.company_name)).toEqual(['Creator Co', 'Affiliate Co'])
    expect(q.pendingReview).toBe(1)
  })
})

describe('manual submissions', () => {
  it('uses the verified creator portal, tracks status, and records your own submission', async () => {
    const db = freshDb()
    const p = brand(db, { email: null })
    const pitch = await generatePitch(db, p.id, { channel: 'manual_form' })
    expect(pitch.application_url).toBe('https://brand-a.test/creators')
    expect(pitch.body).not.toContain("I've attached")
    expect(get(db, 'SELECT url_origin, status FROM manual_applications WHERE prospect_id = ?', p.id)).toEqual({ url_origin: 'research', status: 'not_started' })
    expect(() => markSubmitted(db, p.id)).toThrow(/Approve the manual submission/)
    approvePitch(db, pitch.id)
    const app = markSubmitted(db, p.id, null, new Date('2026-11-02T12:00:00Z'))!
    expect(app).toMatchObject({ status: 'submitted', follow_up_date: '2026-11-09' })
    expect(getProspect(db, p.id)).toMatchObject({ stage: 'contacted', next_follow_up_date: '2026-11-09' })
  })

  it('only accepts application pages on the brand\'s own site', async () => {
    const db = freshDb()
    const p = brand(db, { email: null })
    expect(() => updateApplication(db, p.id, { application_url: 'https://forms.example.com/brand-a' })).toThrow(/own site/)
    expect(updateApplication(db, p.id, { application_url: 'https://brand-a.test/creators' })!.url_origin).toBe('research')
    expect(updateApplication(db, p.id, { application_url: 'https://brand-a.test/apply' })!.url_origin).toBe('manual')
  })
})

describe('local AI (Ollama) drafting', () => {
  const GOOD = `Subject: Brand A x IronmanCarter

Hi Brand A team,

I'm IronmanCarter, a comedic League of Legends creator [F1]. Between Aug 1 and Oct 29, 2026, my Instagram videos got about 7.9M views [F2] and my YouTube videos about 4.2M views [F3]. About 85% of my Instagram audience is 18–34 [F4]. I saw your Creator Program invites creators to partner with you [F5]. My idea is a clutch-play Short featuring the mouse [F6], and I'd love for it to become a recurring monthly partnership if the first one works [F7]. My media kit is attached [F8]. It would be a natural fit for my channel, and I would bring real energy to it. Would you be open to a quick chat about a paid partnership?

Best,
IronmanCarter
ironmancarterbusiness@gmail.com`
  const local = (text: string | Error): AIProvider => ({
    id: 'ollama', billing: 'free_local', model: () => 'gemma4:12b',
    generate: async () => { if (text instanceof Error) throw text; return { text, model: 'gemma4:12b', inputTokens: 100, outputTokens: 200 } },
  })
  const paid = vi.fn()
  const deps = (p: AIProvider) => ({ ai: { providers: { ollama: p, anthropic: { id: 'anthropic' as const, billing: 'paid_api' as const, model: () => 'x', generate: paid } } } })

  it('uses a cited local-AI draft and maps every cited sentence to its evidence', async () => {
    const db = freshDb()
    withKit(db)
    setSetting(db, 'ai.provider', 'ollama')
    const p = brand(db)
    const pitch = await generatePitch(db, p.id, { channel: 'email' }, deps(local(GOOD)))
    expect(pitch).toMatchObject({ generator: 'ollama', ai_model: 'gemma4:12b' })
    expect(pitch.body).not.toMatch(/\[F\d+\]/)
    const brandClaim = JSON.parse(pitch.claims).find((c: { kind: string }) => c.kind === 'brand')
    expect(brandClaim.sources[0].url).toBe('https://brand-a.test/creators')
  })

  it.each([
    ['invented citations', GOOD.replace('[F5]', '[F42]'), /do not exist/],
    ['an invented statistic', GOOD.replace('About 85%', 'About 97%'), /failed checks/],
    ['the wrong format', 'Here is a pitch for you!', /format/],
    ['an unavailable model', new Error('connection refused'), /unavailable/],
  ])('falls back to the template on %s, never to another provider', async (_label, output, note) => {
    const db = freshDb()
    withKit(db)
    setSetting(db, 'ai.provider', 'ollama')
    const p = brand(db)
    const pitch = await generatePitch(db, p.id, { channel: 'email' }, deps(local(output)))
    expect(pitch.generator).toBe('template')
    expect(pitch.generation_note).toMatch(note)
    expect(pitch.generation_note).toMatch(/no other AI provider was tried/)
    expect(paid).not.toHaveBeenCalled()
  })
})

describe('media kit attachment reference', () => {
  it('points at the default kit version, verifies the stored file, and is not marked Gmail-tested', async () => {
    const db = freshDb()
    const { dir, kit } = withKit(db)
    const p = brand(db)
    const pitch = await generatePitch(db, p.id, { channel: 'email' })
    expect(pitch.media_kit_id).toBe(kit.id)
    expect(attachmentReference(db, dir, pitch.media_kit_id)).toMatchObject({
      version: 1, filename: 'Content Media Kit Final.pdf', mimeType: 'application/pdf', fileExists: true, checksumOk: true, isCurrentDefault: true, gmailAttachmentVerified: false,
    })
  })
})

describe('packages', () => {
  it('validates price ranges', () => {
    const db = freshDb()
    expect(() => updatePackage(db, 1, { price_min_cents: 90000, price_max_cents: 10000 })).toThrow(/at least the minimum/)
    expect(updatePackage(db, 1, { price_min_cents: 60000, price_max_cents: 80000 })).toMatchObject({ price_min_cents: 60000, price_max_cents: 80000 })
  })
})

describe('sending is confined to one confirmed path', () => {
  it('has one send call (drafts.send), reachable only through the manual confirmation module', () => {
    const root = join(import.meta.dirname, '..')
    const files: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (/\.(ts|tsx)$/.test(name)) files.push(path)
      }
    }
    walk(join(root, 'apps'))
    walk(join(root, 'packages'))
    const rel = (f: string) => f.slice(root.length)
    const containing = (re: RegExp) => files.filter((f) => re.test(readFileSync(f, 'utf8'))).map(rel).sort()
    // No other mail-sending mechanism anywhere.
    expect(containing(/nodemailer|smtp|sendMail\(|users\.messages\.send/i)).toEqual([])
    // The Gmail API is only called from the Gmail client.
    expect(containing(/gmail\.googleapis/)).toEqual(['/packages/gmail/google.ts'])
    const google = readFileSync(join(root, 'packages/gmail/google.ts'), 'utf8')
    expect(google).not.toMatch(/\$\{GMAIL_API\}\/messages\/send/)
    expect([...google.matchAll(/\$\{GMAIL_API\}\/drafts\/send/g)]).toHaveLength(2) // the guard and sendDraft
    const paths = new Set([...google.matchAll(/\$\{GMAIL_(?:API|UPLOAD)\}\/([a-z]+)/g)].map((m) => m[1]))
    expect([...paths].sort()).toEqual(['drafts', 'messages', 'profile', 'threads'])
    // Only the manual-send module can authorize and call a send.
    expect(containing(/SEND_AUTHORITY/)).toEqual(['/packages/gmail/google.ts', '/packages/outreach/send.ts'])
    expect(containing(/\.sendDraft\(/)).toEqual(['/packages/outreach/send.ts'])
    // No scheduler, timer or bulk loop sends anything.
    const send = readFileSync(join(root, 'packages/outreach/send.ts'), 'utf8')
    expect(send).not.toMatch(/setInterval|setTimeout|cron/i)
    expect(containing(/confirmSend\(/)).toEqual(['/apps/server/src/outreachRoutes.ts', '/packages/outreach/send.ts'])
  })
})
