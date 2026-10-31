import Fastify, { type FastifyInstance } from 'fastify'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import { createReadStream, existsSync } from 'node:fs'
import { join } from 'node:path'
import { all, allSettings, get, getSetting, logActivity, run, setSetting, type DB } from '../../../packages/db'
import { AppError, invalid } from '../../../packages/core/errors'
import { ANTHROPIC_PRICES } from '../../../packages/ai/pricing'
import { ollamaStatus, type OllamaConfig } from '../../../packages/ai/providers/ollama'
import { runAI, usageSummary, type RouterDeps } from '../../../packages/ai/router'
import { AIBlockedError } from '../../../packages/ai/types'
import { exportCsv, importCsv } from '../../../packages/crm/csvio'
import { listMetrics, updateMetric } from '../../../packages/crm/metrics'
import { overview } from '../../../packages/crm/overview'
import {
  addContact, addNote, addSource, createProspect, deleteContact, deleteProspect, findDuplicates, getProspectDetail,
  listProspects, listTags, reviewProspect, setStage, setTags, updateContact, updateProspect, type ListFilters,
} from '../../../packages/crm/prospects'
import {
  addPoolCandidate, cancelBatch, createBatch, excludePoolCandidate, getBatch, listBatches, listPool, poolSummary, releasePoolCandidate,
} from '../../../packages/research/batches'
import { createFetcher } from '../../../packages/research/fetcher'
import { getApplication, listApplications, markSubmitted, updateApplication } from '../../../packages/pitch/applications'
import { gatherFacts, suggestApplicationUrl } from '../../../packages/pitch/facts'
import { listPackages, updatePackage } from '../../../packages/pitch/packages'
import {
  approvePitch, generatePitch, outreachQueue, pitchView, regeneratePitch, rejectPitch, setProgramTypeOverride, updatePitch,
} from '../../../packages/pitch/service'
import { reverifyContacts } from '../../../packages/research/pipeline'
import { addSuppression, listSuppressions, removeSuppression } from '../../../packages/crm/suppressions'
import {
  getMediaKit, importMediaKit, listMediaKits, MAX_MEDIA_KIT_BYTES, mediaKitFilePath, setDefaultMediaKit, updateMediaKit,
} from '../../../packages/mediakit/store'
import { activeAccount, connectionStatus, disconnect, finishConnect, removeClient, saveClient, startConnect, type GmailDeps } from '../../../packages/gmail/account'
import {
  checkUncertain, createPitchDraft, createTestDraft, getDraftRow, gmailForPitch, listDraftRows, listOperations, markNotCreated,
  recoverInterrupted, syncDrafts, unlinkDraft, updatePitchDraft, verifyDraft,
} from '../../../packages/gmail/drafts'
import { GoogleApi } from '../../../packages/gmail/google'
import { defaultSecretStore, memoryStore } from '../../../packages/gmail/secrets'
import { config } from './config'
import { LOCKED, VALIDATORS, validateSetting } from './settingsPolicy'

export interface AppOptions {
  db: DB
  dataDir: string
  webDist?: string                // serve the built dashboard (production)
  fetchImpl?: typeof fetch        // injectable for tests
  aiDeps?: RouterDeps             // injectable for tests
  gmail?: Partial<GmailDeps>      // injectable for tests (fake Google API, in-memory secrets)
  dashboardUrl?: string
  logger?: boolean
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

const id = (v: unknown) => {
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0) throw invalid('Invalid id')
  return n
}
type Body = Record<string, unknown>

// Actions that create something in Gmail or stop tracking it need an explicit confirmation from the dashboard.
const confirmed = (body: unknown) => {
  if ((body as Body | undefined)?.confirm !== true) throw invalid('Confirm this action first')
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const callbackPage = (ok: boolean, message: string, dashboardUrl: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Gmail ${ok ? 'connected' : 'not connected'}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px;color:#18181b;background:#fafafa}
@media (prefers-color-scheme:dark){body{color:#f4f4f5;background:#09090b}}a{color:#4f46e5}</style></head>
<body><h1>${ok ? 'Gmail connected' : 'Gmail was not connected'}</h1><p>${esc(message)}</p>
<p><a href="${esc(dashboardUrl)}/#/settings/gmail">Back to the dashboard</a>. You can close this tab.</p></body></html>`

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const { db, dataDir } = opts
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 5 * 1024 * 1024 })
  const gmail: GmailDeps = {
    api: opts.gmail?.api ?? new GoogleApi(),
    // Tests never touch the real Keychain.
    secrets: opts.gmail?.secrets ?? (process.env.VITEST ? memoryStore() : defaultSecretStore(dataDir)),
    redirectUri: opts.gmail?.redirectUri ?? `http://127.0.0.1:${config.port}/api/gmail/oauth/callback`,
  }
  const dashboardUrl = opts.dashboardUrl ?? `http://localhost:${config.production ? config.port : config.webPort}`
  recoverInterrupted(db)
  await app.register(multipart, { limits: { fileSize: MAX_MEDIA_KIT_BYTES + 1, files: 1, fields: 10 } })

  // Local-only guard. Rejects requests addressed to another host name (DNS rebinding) and requires a
  // custom header on every write, which a web page on another site cannot send without a CORS grant
  // (this server never grants one).
  app.addHook('onRequest', async (req, reply) => {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '')
    if (!LOCAL_HOSTS.has(host)) return reply.code(403).send({ error: { code: 'forbidden', message: 'Local access only' } })
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.url.startsWith('/api/') && req.headers['x-outreach-client'] !== 'dashboard') {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'Missing client header' } })
    }
  })

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: { code: err.code, message: err.message, details: err.details } })
    if (err instanceof AIBlockedError) return reply.code(402).send({ error: { code: 'ai_blocked', message: err.message } })
    const e = err as Error & { code?: string; statusCode?: number; errcode?: number }
    if (e.code === 'ERR_SQLITE_ERROR' && /constraint/i.test(e.message)) {
      return reply.code(409).send({ error: { code: 'constraint', message: e.message.replace(/^.*constraint failed: /i, 'Conflicts with existing data: ') } })
    }
    if (e.code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(413).send({ error: { code: 'too_large', message: 'File is too large' } })
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: { code: 'bad_request', message: e.message } })
    app.log.error(err)
    return reply.code(500).send({ error: { code: 'internal', message: 'Something went wrong. Details are in the server log.' } })
  })

  // ---------- System ----------
  app.get('/api/health', async () => ({ ok: true, sendingCodePresent: false }))
  app.get('/api/overview', async () => overview(db))
  app.get('/api/activity', async (req) => {
    const limit = Math.min(500, Math.max(1, Number((req.query as Body).limit ?? 100) || 100))
    return all(db, `SELECT a.id, a.prospect_id, a.type, a.summary, a.created_at, p.company_name FROM activities a
      LEFT JOIN prospects p ON p.id = a.prospect_id ORDER BY a.id DESC LIMIT ?`, limit)
  })

  app.get('/api/settings', async () => ({ values: allSettings(db), locked: LOCKED, editable: Object.keys(VALIDATORS) }))
  app.patch('/api/settings', async (req) => {
    const body = (req.body ?? {}) as Body
    const clean = Object.entries(body).map(([k, v]) => [k, validateSetting(k, v)] as const)
    const account = activeAccount(db)
    for (const [k, v] of clean) {
      if (k === 'gmail.expectedAccount' && account && v !== account.email) {
        throw new AppError(409, 'connected', `Disconnect ${account.email} (Settings → Gmail) before changing the sending account.`)
      }
    }
    for (const [k, v] of clean) setSetting(db, k, v)
    if (clean.length) logActivity(db, 'settings.updated', `Updated settings: ${clean.map(([k]) => k).join(', ')}`)
    return { values: allSettings(db) }
  })

  app.get('/api/categories', async () => all(db, 'SELECT * FROM categories ORDER BY sort_order'))
  app.patch('/api/categories/:id', async (req) => {
    const cid = id((req.params as Body).id)
    const b = (req.body ?? {}) as Body
    const cat = get<{ name: string }>(db, 'SELECT name FROM categories WHERE id = ?', cid)
    if (!cat) throw new AppError(404, 'not_found', 'Category not found')
    if (b.enabled !== undefined) run(db, 'UPDATE categories SET enabled = ? WHERE id = ?', b.enabled ? 1 : 0, cid)
    if (b.priority !== undefined) {
      if (!Number.isInteger(b.priority) || (b.priority as number) < 1 || (b.priority as number) > 5) throw invalid('Priority must be 1 to 5')
      run(db, 'UPDATE categories SET priority = ? WHERE id = ?', b.priority as number, cid)
    }
    if (b.research_quota !== undefined) {
      if (!Number.isInteger(b.research_quota) || (b.research_quota as number) < 0 || (b.research_quota as number) > 500) throw invalid('Quota must be 0 to 500')
      run(db, 'UPDATE categories SET research_quota = ? WHERE id = ?', b.research_quota as number, cid)
    }
    logActivity(db, 'category.updated', `Updated category ${cat.name}`, { data: b })
    return get(db, 'SELECT * FROM categories WHERE id = ?', cid)
  })
  app.get('/api/tiers', async () => ({
    tiers: all(db, 'SELECT * FROM sending_tiers ORDER BY sort_order'),
    active: getSetting<string>(db, 'outreach.sendingTier'),
  }))

  // ---------- CRM ----------
  app.get('/api/prospects', async (req) => {
    const q = req.query as Record<string, string | undefined>
    const filters: ListFilters = {
      q: q.q || undefined,
      stage: q.stage || undefined,
      category_id: q.category_id ? id(q.category_id) : undefined,
      tag: q.tag || undefined,
      tier: (['A', 'B', 'C'] as const).find((t) => t === q.tier),
      review: (['pending', 'approved', 'rejected'] as const).find((r) => r === q.review),
      source: (['manual', 'csv', 'research'] as const).find((s) => s === q.source),
      sort: (['updated', 'created', 'name', 'score', 'value'] as const).find((s) => s === q.sort),
      dir: q.dir === 'asc' ? 'asc' : 'desc',
    }
    return listProspects(db, filters)
  })
  app.post('/api/prospects/check-duplicates', async (req) => {
    const b = (req.body ?? {}) as Body
    return findDuplicates(db, {
      domain: typeof b.website === 'string' ? b.website : null,
      name: typeof b.company_name === 'string' ? b.company_name : null,
      emails: typeof b.email === 'string' ? [b.email] : [],
      excludeId: b.exclude_id ? id(b.exclude_id) : undefined,
    })
  })
  app.post('/api/prospects', async (req, reply) => {
    const { allowSimilarName, contact, tags, ...input } = (req.body ?? {}) as Body
    const c = contact as Body | undefined
    const prospect = createProspect(db, input as never, { allowSimilarName: !!allowSimilarName, contactEmails: [c?.email as string | null] })
    if (c && (c.email || c.contact_form_url)) addContact(db, prospect.id, { ...c, is_primary: true } as never)
    if (Array.isArray(tags)) setTags(db, prospect.id, tags as string[])
    return reply.code(201).send(getProspectDetail(db, prospect.id))
  })
  app.get('/api/prospects/:id', async (req) => getProspectDetail(db, id((req.params as Body).id)))
  app.patch('/api/prospects/:id', async (req) => {
    const pid = id((req.params as Body).id)
    const { stage, ...rest } = (req.body ?? {}) as Body
    if (stage !== undefined) throw invalid('Change the stage with POST /api/prospects/:id/stage')
    updateProspect(db, pid, rest as never)
    return getProspectDetail(db, pid)
  })
  app.delete('/api/prospects/:id', async (req) => {
    deleteProspect(db, id((req.params as Body).id))
    return { ok: true }
  })
  app.post('/api/prospects/:id/stage', async (req) => {
    const pid = id((req.params as Body).id)
    const b = (req.body ?? {}) as Body
    setStage(db, pid, String(b.stage ?? ''), typeof b.note === 'string' ? b.note : undefined)
    return getProspectDetail(db, pid)
  })
  app.post('/api/prospects/:id/contacts', async (req, reply) => {
    const pid = id((req.params as Body).id)
    addContact(db, pid, (req.body ?? {}) as never)
    return reply.code(201).send(getProspectDetail(db, pid))
  })
  app.patch('/api/contacts/:id', async (req) => {
    const c = updateContact(db, id((req.params as Body).id), (req.body ?? {}) as never)
    return getProspectDetail(db, c.prospect_id)
  })
  app.delete('/api/contacts/:id', async (req) => {
    const cid = id((req.params as Body).id)
    const c = get<{ prospect_id: number }>(db, 'SELECT prospect_id FROM contacts WHERE id = ?', cid)
    deleteContact(db, cid)
    return c ? getProspectDetail(db, c.prospect_id) : { ok: true }
  })
  app.post('/api/prospects/:id/notes', async (req) => {
    const pid = id((req.params as Body).id)
    addNote(db, pid, String(((req.body ?? {}) as Body).body ?? ''))
    return getProspectDetail(db, pid)
  })
  app.put('/api/prospects/:id/tags', async (req) => {
    const pid = id((req.params as Body).id)
    const tags = ((req.body ?? {}) as Body).tags
    if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string')) throw invalid('tags must be a list of text')
    setTags(db, pid, tags as string[])
    return getProspectDetail(db, pid)
  })
  app.post('/api/prospects/:id/sources', async (req) => {
    const pid = id((req.params as Body).id)
    addSource(db, pid, (req.body ?? {}) as never)
    return getProspectDetail(db, pid)
  })
  app.get('/api/tags', async () => listTags(db))

  app.post('/api/prospects/:id/review', async (req) => {
    const pid = id((req.params as Body).id)
    const b = (req.body ?? {}) as Body
    reviewProspect(db, pid, b.decision as 'approved', typeof b.note === 'string' ? b.note : null)
    return getProspectDetail(db, pid)
  })
  // Re-checks contacts against the pages they were published on. Reads public pages only.
  const fetcher = createFetcher({ fetchImpl: opts.fetchImpl, delayMs: 1000 })
  app.post('/api/prospects/:id/reverify', async (req) => {
    const pid = id((req.params as Body).id)
    getProspectDetail(db, pid)
    const results = await reverifyContacts(db, pid, fetcher)
    return { results, detail: getProspectDetail(db, pid) }
  })

  // ---------- Pitches (draft mode: there is no send endpoint) ----------
  app.get('/api/outreach/queue', async () => {
    const q = outreachQueue(db)
    return { ...q, approved: q.approved.map((x) => ({ ...x, gmail: x.channel === 'email' ? gmailForPitch(db, dataDir, x.id)?.draft ?? null : null })) }
  })
  app.get('/api/prospects/:id/outreach', async (req) => {
    const pid = id((req.params as Body).id)
    const facts = gatherFacts(db, pid, { channel: 'email' })
    const manual = gatherFacts(db, pid, { channel: 'manual_form' })
    return {
      company: { id: pid, name: facts.prospect.name, reviewStatus: facts.prospect.reviewStatus, concept: facts.prospect.concept },
      program: facts.program,
      emailFlags: facts.flags,
      manualFlags: manual.flags,
      contacts: all(db, 'SELECT id, email, role, verification_status FROM contacts WHERE prospect_id = ? AND email IS NOT NULL ORDER BY is_primary DESC, id', pid),
      suggestedApplication: suggestApplicationUrl(db, pid),
      application: getApplication(db, pid),
      pitches: all(db, 'SELECT id, version, channel, status, generator, created_at FROM pitches WHERE prospect_id = ? ORDER BY version DESC', pid),
      packages: listPackages(db).filter((p) => p.active),
    }
  })
  app.post('/api/prospects/:id/pitches', async (req, reply) => {
    const p = await generatePitch(db, id((req.params as Body).id), (req.body ?? {}) as Body, { ai: opts.aiDeps })
    return reply.code(201).send(pitchView(db, dataDir, p.id))
  })
  app.put('/api/prospects/:id/program-type', async (req) => {
    const v = ((req.body ?? {}) as Body).value
    setProgramTypeOverride(db, id((req.params as Body).id), typeof v === 'string' ? v : null)
    return { ok: true }
  })
  const pitchWithGmail = (pid: number) => ({ ...pitchView(db, dataDir, pid), gmail: gmailForPitch(db, dataDir, pid) })
  app.get('/api/pitches/:id', async (req) => pitchWithGmail(id((req.params as Body).id)))
  app.patch('/api/pitches/:id', async (req) => {
    const b = (req.body ?? {}) as Body
    const p = updatePitch(db, id((req.params as Body).id), { subject: b.subject as string | undefined, body: b.body as string | undefined })
    return pitchView(db, dataDir, p.id)
  })
  app.post('/api/pitches/:id/regenerate', async (req) => {
    const p = await regeneratePitch(db, id((req.params as Body).id), (req.body ?? {}) as Body, { ai: opts.aiDeps })
    return pitchView(db, dataDir, p.id)
  })
  app.post('/api/pitches/:id/approve', async (req) => pitchView(db, dataDir, approvePitch(db, id((req.params as Body).id)).id))
  app.post('/api/pitches/:id/reject', async (req) => pitchView(db, dataDir, rejectPitch(db, id((req.params as Body).id), String(((req.body ?? {}) as Body).reason ?? '')).id))

  app.get('/api/applications', async () => listApplications(db))
  app.put('/api/prospects/:id/application', async (req) => updateApplication(db, id((req.params as Body).id), (req.body ?? {}) as never))
  app.post('/api/prospects/:id/application/submitted', async (req) => {
    const f = ((req.body ?? {}) as Body).follow_up_date
    return markSubmitted(db, id((req.params as Body).id), typeof f === 'string' ? f : null)
  })

  app.get('/api/packages', async () => listPackages(db))
  app.patch('/api/packages/:id', async (req) => updatePackage(db, id((req.params as Body).id), (req.body ?? {}) as never))

  // ---------- Brand discovery ----------
  app.get('/api/research/status', async () => {
    const beat = get<{ value: string }>(db, "SELECT value FROM settings WHERE key = 'worker.heartbeatAt'")
    const at = beat ? (JSON.parse(beat.value) as string) : null
    return {
      workerHeartbeatAt: at,
      workerRunning: !!at && Date.now() - new Date(at).getTime() < 20_000,
      active: get(db, "SELECT id, status FROM research_batches WHERE status IN ('queued', 'running') ORDER BY id LIMIT 1") ?? null,
      pendingReview: get<{ n: number }>(db, "SELECT count(*) AS n FROM prospects WHERE review_status = 'pending'")!.n,
    }
  })
  app.get('/api/research/pool', async (req) => {
    const q = req.query as Record<string, string | undefined>
    if (q.summary === '1') return { summary: poolSummary(db), entries: [] }
    return { summary: poolSummary(db), entries: listPool(db, { category_id: q.category_id ? id(q.category_id) : undefined, status: q.status || undefined }) }
  })
  app.post('/api/research/pool', async (req, reply) => {
    const b = (req.body ?? {}) as Body
    return reply.code(201).send(addPoolCandidate(db, { company_name: String(b.company_name ?? ''), website: String(b.website ?? ''), category_id: Number(b.category_id) }))
  })
  app.post('/api/research/pool/:id/release', async (req) => {
    releasePoolCandidate(db, id((req.params as Body).id))
    return { ok: true }
  })
  app.post('/api/research/pool/:id/exclude', async (req) => {
    excludePoolCandidate(db, id((req.params as Body).id), String(((req.body ?? {}) as Body).note ?? ''))
    return { ok: true }
  })
  app.get('/api/research/batches', async () => listBatches(db))
  app.post('/api/research/batches', async (req, reply) => {
    const b = (req.body ?? {}) as Body
    const categoryIds = Array.isArray(b.category_ids) ? (b.category_ids as unknown[]).map((x) => id(x)) : undefined
    return reply.code(201).send(createBatch(db, { size: Number(b.size), categoryIds }))
  })
  app.get('/api/research/batches/:id', async (req) => getBatch(db, id((req.params as Body).id)))
  app.post('/api/research/batches/:id/cancel', async (req) => cancelBatch(db, id((req.params as Body).id)))

  app.get('/api/export/prospects.csv', async (_req, reply) => {
    const date = new Date().toISOString().slice(0, 10)
    logActivity(db, 'csv.exported', 'Exported the CRM to CSV')
    return reply.header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="ironmancarter-prospects-${date}.csv"`)
      .send(exportCsv(db))
  })
  app.post('/api/import/prospects', async (req) => {
    const b = (req.body ?? {}) as Body
    if (typeof b.csv !== 'string') throw invalid('Send the CSV text as "csv"')
    return importCsv(db, b.csv, { dryRun: b.dryRun !== false })
  })

  app.get('/api/suppressions', async () => listSuppressions(db))
  app.post('/api/suppressions', async (req, reply) => {
    const b = (req.body ?? {}) as Body
    if (b.kind !== 'email' && b.kind !== 'domain') throw invalid('kind must be email or domain')
    return reply.code(201).send(addSuppression(db, b.kind, String(b.value ?? ''), String(b.reason ?? ''), 'manual'))
  })
  app.delete('/api/suppressions/:id', async (req) => {
    removeSuppression(db, id((req.params as Body).id))
    return { ok: true }
  })

  // ---------- Media kit ----------
  app.get('/api/media-kits', async () => listMediaKits(db))
  app.post('/api/media-kits', async (req, reply) => {
    const file = await req.file()
    if (!file) throw invalid('Choose a PDF file to upload')
    const buffer = await file.toBuffer()
    const fields = file.fields as Record<string, { value?: string } | undefined>
    const result = importMediaKit(db, dataDir, {
      buffer,
      originalFilename: file.filename,
      label: fields.label?.value,
      notes: fields.notes?.value || null,
      makeDefault: fields.makeDefault?.value === 'true',
    })
    return reply.code(result.duplicate ? 200 : 201).send(result)
  })
  app.get('/api/media-kits/:id/file', async (req, reply) => {
    const kit = getMediaKit(db, id((req.params as Body).id))
    const path = mediaKitFilePath(dataDir, kit)
    if (!existsSync(path)) throw new AppError(410, 'missing_file', `The stored file ${kit.stored_filename} is missing from the data folder`)
    const download = (req.query as Body).download === '1'
    return reply.header('content-type', 'application/pdf')
      .header('content-disposition', `${download ? 'attachment' : 'inline'}; filename="${kit.original_filename.replace(/["\r\n]/g, '')}"`)
      .header('cache-control', 'no-store')
      .send(createReadStream(path))
  })
  app.post('/api/media-kits/:id/default', async (req) => setDefaultMediaKit(db, id((req.params as Body).id)))
  app.patch('/api/media-kits/:id', async (req) => updateMediaKit(db, id((req.params as Body).id), (req.body ?? {}) as never))

  // ---------- Creator analytics ----------
  app.get('/api/metrics', async () => listMetrics(db))
  app.patch('/api/metrics/:id', async (req) => updateMetric(db, id((req.params as Body).id), (req.body ?? {}) as never))

  // ---------- AI & costs ----------
  app.get('/api/ai/status', async () => {
    const ollama = getSetting<OllamaConfig>(db, 'ai.ollama')
    return {
      provider: getSetting<string>(db, 'ai.provider'),
      paidEnabled: getSetting<boolean>(db, 'ai.paidEnabled'),
      monthlyBudgetUsd: getSetting<number>(db, 'ai.monthlyBudgetUsd'),
      anthropicKeyPresent: !!process.env.ANTHROPIC_API_KEY,
      anthropicIntegrationInstalled: false,
      ollama: { ...ollama, ...(await ollamaStatus(ollama, opts.fetchImpl)) },
      prices: ANTHROPIC_PRICES,
    }
  })
  app.get('/api/ai/usage', async () => usageSummary(db))
  app.post('/api/ai/test', async (req) => {
    const prompt = String(((req.body ?? {}) as Body).prompt ?? '').trim()
    if (!prompt) throw invalid('Enter a prompt')
    if (prompt.length > 4000) throw invalid('Prompt is too long for a test (max 4,000 characters)')
    return runAI(db, { purpose: 'test', prompt, maxOutputTokens: 300 }, opts.aiDeps)
  })

  // ---------- Gmail (drafts only; nothing here sends) ----------
  app.get('/api/gmail/status', async () => ({
    ...(await connectionStatus(db, gmail)),
    drafts: Object.fromEntries(all<{ status: string; n: number }>(db, 'SELECT status, count(*) AS n FROM gmail_drafts GROUP BY status').map((r) => [r.status, r.n])),
    lastSyncAt: get<{ t: string | null }>(db, 'SELECT max(last_synced_at) AS t FROM gmail_drafts')?.t ?? null,
  }))
  app.put('/api/gmail/client', async (req) => {
    await saveClient(db, gmail, (req.body ?? {}) as Body)
    return connectionStatus(db, gmail)
  })
  app.delete('/api/gmail/client', async () => {
    await removeClient(db, gmail)
    return connectionStatus(db, gmail)
  })
  app.post('/api/gmail/connect', async () => startConnect(db, gmail))
  // Google sends the browser here after the consent screen. Protected by the single-use state value and PKCE.
  app.get('/api/gmail/oauth/callback', async (req, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8').header('cache-control', 'no-store')
    try {
      const { email } = await finishConnect(db, gmail, (req.query ?? {}) as Body)
      return callbackPage(true, `Connected ${email}. The app can create and update drafts only; sending stays disabled.`, dashboardUrl)
    } catch (err) {
      reply.code(err instanceof AppError ? err.status : 500)
      return callbackPage(false, err instanceof AppError ? err.message : 'Something went wrong. Details are in the server log.', dashboardUrl)
    }
  })
  app.post('/api/gmail/disconnect', async (req) => {
    confirmed(req.body)
    return disconnect(db, gmail)
  })
  app.post('/api/gmail/test-draft', async (req) => {
    confirmed(req.body)
    const row = await createTestDraft(db, gmail, dataDir)
    return listDraftRows(db).find((r) => r.id === row.id)
  })
  app.get('/api/gmail/drafts', async () => listDraftRows(db))
  app.get('/api/gmail/operations', async () => listOperations(db, 200))
  app.post('/api/gmail/sync', async () => syncDrafts(db, gmail))
  app.post('/api/gmail/drafts/:id/check', async (req) => checkUncertain(db, gmail, id((req.params as Body).id)))
  app.post('/api/gmail/drafts/:id/verify', async (req) => {
    const row = getDraftRow(db, id((req.params as Body).id))
    return (await verifyDraft(db, gmail, row.id)) ?? { ok: false, checks: [], note: getDraftRow(db, row.id).sync_note }
  })
  app.post('/api/gmail/drafts/:id/not-created', async (req) => {
    confirmed(req.body)
    return markNotCreated(db, id((req.params as Body).id))
  })
  app.post('/api/gmail/drafts/:id/unlink', async (req) => {
    confirmed(req.body)
    return unlinkDraft(db, id((req.params as Body).id))
  })
  app.post('/api/pitches/:id/gmail-draft', async (req, reply) => {
    confirmed(req.body)
    const pid = id((req.params as Body).id)
    await createPitchDraft(db, gmail, dataDir, pid)
    return reply.code(201).send(pitchWithGmail(pid))
  })
  app.put('/api/pitches/:id/gmail-draft', async (req) => {
    confirmed(req.body)
    const pid = id((req.params as Body).id)
    await updatePitchDraft(db, gmail, dataDir, pid, { overwriteGmailEdits: ((req.body ?? {}) as Body).overwriteGmailEdits === true })
    return pitchWithGmail(pid)
  })

  // ---------- Dashboard (production build) ----------
  if (opts.webDist && existsSync(opts.webDist)) {
    await app.register(fastifyStatic, { root: opts.webDist, prefix: '/' })
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: { code: 'not_found', message: 'No such endpoint' } })
      return reply.sendFile('index.html')
    })
  }

  return app
}

export const webDistPath = (root: string) => join(root, 'dist')
