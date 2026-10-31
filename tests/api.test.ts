import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../apps/server/src/app'
import { fakePdf, freshDb, tempDir } from './helpers'

let app: FastifyInstance
let cleanup: () => void
const H = { host: '127.0.0.1:5181', 'x-outreach-client': 'dashboard' }

beforeEach(async () => {
  const t = tempDir()
  cleanup = t.cleanup
  const offline = (async () => { throw new Error('offline') }) as unknown as typeof fetch
  app = await buildApp({ db: freshDb(), dataDir: t.dir, fetchImpl: offline })
})
afterEach(async () => {
  await app.close()
  cleanup()
})

const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, headers: H, payload: payload as object })
const patch = (url: string, payload: unknown) => app.inject({ method: 'PATCH', url, headers: H, payload: payload as object })

describe('local-only API guard', () => {
  it('rejects writes without the dashboard header', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/prospects', headers: { host: '127.0.0.1:5181' }, payload: { company_name: 'X' } })
    expect(r.statusCode).toBe(403)
  })
  it('rejects requests addressed to a non-local host name', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/health', headers: { host: 'evil.example.com' } })
    expect(r.statusCode).toBe(403)
  })
  it('reports that no sending code is present', async () => {
    expect((await app.inject({ url: '/api/health', headers: H })).json()).toEqual({ ok: true, sendingCodePresent: false })
  })
})

describe('settings policy', () => {
  it.each([
    ['outreach.autopilotEnabled', true],
    ['outreach.liveSendingEnabled', true],
    ['outreach.sendingTier', 'established'],
    ['outreach.mode', 'autopilot'],
    ['ai.paidEnabled', true],
    ['ai.provider', 'anthropic'],
  ])('refuses %s = %s', async (key, value) => {
    const r = await patch('/api/settings', { [key]: value })
    expect(r.statusCode).toBe(409)
  })

  it('refuses to turn on automatic follow-ups', async () => {
    const r = await patch('/api/settings', { 'outreach.followUps': { enabled: true, firstAfterBusinessDays: 5, secondAfterBusinessDays: 12, max: 2 } })
    expect(r.statusCode).toBe(409)
  })

  it('saves allowed settings with validation', async () => {
    expect((await patch('/api/settings', { 'ai.provider': 'ollama', 'ai.monthlyBudgetUsd': 0 })).statusCode).toBe(200)
    expect((await patch('/api/settings', { 'business.email': 'not-an-email' })).statusCode).toBe(400)
    expect((await patch('/api/settings', { 'ai.ollama': { baseUrl: 'https://remote.example.com', model: 'x' } })).statusCode).toBe(400)
    const s = (await app.inject({ url: '/api/settings', headers: H })).json()
    expect(s.values['ai.provider']).toBe('ollama')
  })
})

describe('CRM endpoints', () => {
  it('creates a company with a contact and blocks a duplicate domain', async () => {
    const r = await post('/api/prospects', { company_name: 'Elgato', website: 'elgato.com', contact: { email: 'partners@elgato.com' }, tags: ['creator'] })
    expect(r.statusCode).toBe(201)
    expect(r.json().contacts[0].eligibility.status).toBe('needs_review')
    const dup = await post('/api/prospects', { company_name: 'Elgato Gaming', website: 'https://www.elgato.com' })
    expect(dup.statusCode).toBe(409)
    expect(dup.json().error.code).toBe('duplicate')
  })

  it('exports CSV with a download header', async () => {
    await post('/api/prospects', { company_name: 'Elgato', website: 'elgato.com' })
    const r = await app.inject({ url: '/api/export/prospects.csv', headers: H })
    expect(r.headers['content-type']).toMatch(/text\/csv/)
    expect(r.headers['content-disposition']).toMatch(/attachment/)
    expect(r.body).toContain('Elgato')
  })

  it('imports CSV as a dry run by default', async () => {
    const r = await post('/api/import/prospects', { csv: 'company_name,website\nRazer,razer.com\n' })
    expect(r.json().created).toBe(1)
    expect((await app.inject({ url: '/api/prospects', headers: H })).json()).toHaveLength(0)
  })

  it('computes the overview from stored data', async () => {
    const created = (await post('/api/prospects', { company_name: 'Brand', website: 'brand.com', negotiated_value_cents: 200000 })).json()
    await post(`/api/prospects/${created.prospect.id}/stage`, { stage: 'won' })
    const o = (await app.inject({ url: '/api/overview', headers: H })).json()
    expect(o.revenue.contractedCents).toBe(200000)
    expect(o.revenue.collectedCents).toBe(0)
    expect(o.outreach).toMatchObject({ autopilotEnabled: false, liveSendingEnabled: false, sentToday: 0, remainingToday: 0 })
  })
})

describe('media kit endpoints', () => {
  it('uploads through the file picker endpoint and serves the PDF back', async () => {
    const boundary = '----test'
    const pdf = fakePdf('upload')
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="label"\r\n\r\nTest kit\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="makeDefault"\r\n\r\ntrue\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="kit.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
      pdf,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ])
    const up = await app.inject({ method: 'POST', url: '/api/media-kits', headers: { ...H, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body })
    expect(up.statusCode).toBe(201)
    const { kit } = up.json()
    expect(kit).toMatchObject({ version: 1, label: 'Test kit', is_default: 1, page_count: 2 })
    const file = await app.inject({ url: `/api/media-kits/${kit.id}/file`, headers: H })
    expect(file.headers['content-type']).toBe('application/pdf')
    expect(file.rawPayload.equals(pdf)).toBe(true)
  })
})

describe('discovery and review endpoints', () => {
  it('reports worker status and the starter pool', async () => {
    const s = (await app.inject({ url: '/api/research/status', headers: H })).json()
    expect(s).toMatchObject({ workerRunning: false, active: null, pendingReview: 0 })
    const pool = (await app.inject({ url: '/api/research/pool?summary=1', headers: H })).json()
    expect(pool.summary).toHaveLength(8)
    expect(pool.summary.reduce((n: number, c: { available: number }) => n + c.available, 0)).toBeGreaterThan(150)
  })

  it('queues a batch, blocks a second one, and cancels', async () => {
    const r = await post('/api/research/batches', { size: 20 })
    expect(r.statusCode).toBe(201)
    expect(r.json().batch.total).toBe(20)
    expect((await post('/api/research/batches', { size: 20 })).statusCode).toBe(409)
    expect((await post(`/api/research/batches/${r.json().batch.id}/cancel`, {})).json().batch.status).toBe('cancelled')
    expect((await post('/api/research/batches', { size: 25 })).statusCode).toBe(400)
  })

  it('rejects duplicate candidates', async () => {
    expect((await post('/api/research/pool', { company_name: 'Razer', website: 'razer.com', category_id: 1 })).statusCode).toBe(409)
    expect((await post('/api/research/pool', { company_name: 'New Brand', website: 'newbrand.test', category_id: 1 })).statusCode).toBe(201)
  })

  it('approves through the review endpoint and gates outreach stages', async () => {
    const id = (await post('/api/prospects', { company_name: 'Brand', website: 'brand.test' })).json().prospect.id
    expect((await post(`/api/prospects/${id}/stage`, { stage: 'draft_ready' })).statusCode).toBe(409)
    const approved = (await post(`/api/prospects/${id}/review`, { decision: 'approved' })).json()
    expect(approved.prospect).toMatchObject({ review_status: 'approved', stage: 'qualified' })
    expect((await post(`/api/prospects/${id}/stage`, { stage: 'draft_ready' })).statusCode).toBe(200)
    const queue = (await app.inject({ url: '/api/prospects?review=pending', headers: H })).json()
    expect(queue).toHaveLength(0)
  })

  it('validates research settings', async () => {
    expect((await patch('/api/settings', { 'research.requestDelayMs': 200 })).statusCode).toBe(400)
    expect((await patch('/api/settings', { 'research.concurrency': 2 })).statusCode).toBe(200)
  })
})

describe('AI endpoints', () => {
  it('runs a test prompt on the free mock provider and records $0', async () => {
    const r = await post('/api/ai/test', { prompt: 'hello' })
    expect(r.json()).toMatchObject({ provider: 'mock', billing: 'free_mock', costUsd: 0 })
    const usage = (await app.inject({ url: '/api/ai/usage', headers: H })).json()
    expect(usage.paidSpendUsd).toBe(0)
    expect(usage.budgetUsd).toBe(0)
  })

  it('reports Ollama as unreachable without failing', async () => {
    const s = (await app.inject({ url: '/api/ai/status', headers: H })).json()
    expect(s.ollama.reachable).toBe(false)
    expect(s.anthropicIntegrationInstalled).toBe(false)
  })
})
