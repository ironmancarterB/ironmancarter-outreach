// UGC client acquisition routes. They research, score, draft and track; none of them sends an email.
// UGC emails go out only through the existing approve → prepare → confirm send flow.
import type { FastifyInstance } from 'fastify'
import { get, getSetting, logActivity, nowIso, run, type DB } from '../../../packages/db'
import { AppError, invalid } from '../../../packages/core/errors'
import type { GmailDeps } from '../../../packages/gmail/account'
import { addPoolCandidate, createBatch, listBatches, poolSummary } from '../../../packages/research/batches'
import { checkPortfolio, portfolioStatus, setPortfolioUrl } from '../../../packages/ugc/portfolio'
import { ugcCosts, ugcMetrics, ugcOverview, ugcPipeline, type Period } from '../../../packages/ugc/dashboard'
import { createUgcGmailDrafts, draftCandidates, prepareUgcDrafts } from '../../../packages/ugc/drafting'
import { listTemplates, updateTemplate } from '../../../packages/ugc/templates'
import { createDeal, deleteDeal, listDeals, renderDealTemplate, updateDeal } from '../../../packages/ugc/deals'
import { UGC_FIT_LABELS } from '../../../packages/ugc/research'
import { getProspect, updateContact } from '../../../packages/crm/prospects'
import { disableUgcAutopilot, enableUgcAutopilot, tick, ugcStatus } from '../../../packages/outreach/autopilot'
import { confirmVideosPermission, runLaunchGate } from '../../../packages/ugc/gate'
import { discoverCompanies } from '../../../packages/ugc/discovery'

type Body = Record<string, unknown>
const id = (v: unknown) => {
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0) throw invalid('Invalid id')
  return n
}

export function ugcRoutes(app: FastifyInstance, ctx: { db: DB; gmail: GmailDeps; dataDir: string; fetchImpl?: typeof fetch }) {
  const { db, gmail, dataDir } = ctx
  const params = (req: { params: unknown }) => req.params as Body
  const body = (req: { body: unknown }) => (req.body ?? {}) as Body

  app.get('/api/ugc/overview', async () => ({ ...ugcOverview(db), costs: ugcCosts(db), fitLabels: UGC_FIT_LABELS }))
  app.get('/api/ugc/metrics', async (req) => {
    const p = (req.query as Body).period
    const period: Period = p === 'week' || p === 'month' ? p : 'day'
    return ugcMetrics(db, period)
  })
  app.get('/api/ugc/pipeline', async (req) => {
    const stage = (req.query as Body).stage
    const rows = ugcPipeline(db)
    return typeof stage === 'string' && stage ? rows.filter((r) => r.stage === stage) : rows
  })

  // ---------- Research ----------
  app.get('/api/ugc/research', async () => ({
    categories: poolSummary(db, 'ugc'),
    batches: listBatches(db, 'ugc'),
    settings: getSetting(db, 'ugc.research'),
    readyToDraft: draftCandidates(db).length,
  }))
  app.post('/api/ugc/research', async (req, reply) => {
    const b = body(req)
    const categoryIds = Array.isArray(b.categoryIds) ? b.categoryIds.map(id) : undefined
    return reply.code(201).send(createBatch(db, { size: Number(b.size), categoryIds, campaign: 'ugc' }))
  })
  app.post('/api/ugc/candidates', async (req, reply) => {
    const b = body(req)
    const cat = get<{ campaign_type: string }>(db, 'SELECT campaign_type FROM categories WHERE id = ?', id(b.category_id))
    if (cat?.campaign_type !== 'ugc') throw invalid('Choose a UGC category')
    return reply.code(201).send(addPoolCandidate(db, { company_name: String(b.company_name ?? ''), website: String(b.website ?? ''), category_id: id(b.category_id) }))
  })

  // ---------- Portfolio link ----------
  app.get('/api/ugc/portfolio', async () => portfolioStatus(db))
  app.post('/api/ugc/portfolio', async (req) => {
    setPortfolioUrl(db, body(req).url)
    return checkPortfolio(db, ctx.fetchImpl ?? fetch)
  })
  app.post('/api/ugc/portfolio/check', async () => checkPortfolio(db, ctx.fetchImpl ?? fetch))

  // ---------- Drafts (never sent from here) ----------
  app.post('/api/ugc/drafts', async (req) => prepareUgcDrafts(db, { count: Number(body(req).count), gmail, dataDir }))
  app.post('/api/ugc/gmail-drafts', async () => createUgcGmailDrafts(db, { gmail, dataDir }))

  // ---------- Prospect concepts ----------
  app.patch('/api/ugc/prospects/:id/concepts', async (req) => {
    const p = getProspect(db, id(params(req).id))
    if (p.campaign_type !== 'ugc') throw new AppError(409, 'not_ugc', 'Concepts are for UGC companies')
    const list = body(req).concepts
    if (!Array.isArray(list) || !list.length || list.length > 2) throw invalid('Give one or two concepts')
    const concepts = list.map((c) => {
      const o = (c ?? {}) as Body
      const title = String(o.title ?? '').trim().slice(0, 80)
      const outline = String(o.outline ?? '').trim().slice(0, 400)
      if (!title || !outline) throw invalid('Each concept needs a title and an outline')
      return { title, outline, basis: String(o.basis ?? 'Edited by you').slice(0, 400) }
    })
    run(db, 'UPDATE prospects SET ugc_concepts = ?, campaign_concept = ?, updated_at = ? WHERE id = ?', JSON.stringify(concepts),
      concepts.map((c) => `${c.title}: ${c.outline}`).join('\n'), nowIso(), p.id)
    logActivity(db, 'ugc.concepts_edited', 'Edited the UGC video concepts (regenerate the pitch to use them)', { prospectId: p.id })
    return concepts
  })

  // ---------- UGC autopilot ----------
  app.get('/api/ugc/autopilot', async () => ugcStatus(db))
  app.post('/api/ugc/autopilot', async (req) => {
    const b = body(req)
    if (b.enable === false) return disableUgcAutopilot(db)
    return enableUgcAutopilot(db, gmail, b.phrase, ctx.fetchImpl ?? fetch)
  })
  // Plans one UGC run without sending or writing anything to Gmail.
  app.post('/api/ugc/autopilot/dry-run', async () => tick(db, gmail, { dataDir, forceDryRun: true, campaigns: ['ugc'], holder: 'ugc-dry-run' }))
  app.post('/api/ugc/gate', async () => runLaunchGate(db, ctx.fetchImpl ?? fetch))
  app.post('/api/ugc/videos-permission', async (req) => {
    try { confirmVideosPermission(db, String(body(req).note ?? '')) } catch (e) { throw invalid((e as Error).message) }
    return ugcStatus(db)
  })
  // Your confirmation of recipient countries (the app never infers a country). Only UGC contacts with an email.
  app.post('/api/ugc/confirm-countries', async (req) => {
    const b = body(req)
    const jurisdiction = String(b.jurisdiction ?? '').toUpperCase()
    if (!/^[A-Z]{2}$/.test(jurisdiction)) throw invalid('Choose a 2-letter country code')
    if (!Array.isArray(b.contactIds) || !b.contactIds.length || b.contactIds.length > 200) throw invalid('Choose 1 to 200 contacts')
    let n = 0
    for (const raw of b.contactIds) {
      const c = get<{ id: number; campaign_type: string }>(db, 'SELECT c.id, p.campaign_type FROM contacts c JOIN prospects p ON p.id = c.prospect_id WHERE c.id = ? AND c.email IS NOT NULL', id(raw))
      if (c?.campaign_type !== 'ugc') continue
      updateContact(db, c.id, { jurisdiction } as never)
      n++
    }
    logActivity(db, 'ugc.countries_confirmed', `You confirmed ${jurisdiction} as the recipient country for ${n} UGC contact(s).`)
    return { updated: n, status: ugcStatus(db) }
  })
  app.post('/api/ugc/discover', async (req) => discoverCompanies(db, Math.min(400, Math.max(1, Number(body(req).count) || 100)), ctx.fetchImpl ?? fetch))

  // ---------- Templates ----------
  app.get('/api/ugc/templates', async () => listTemplates(db))
  app.patch('/api/ugc/templates/:slug', async (req) => updateTemplate(db, String(params(req).slug), body(req)))

  // ---------- Deals ----------
  app.get('/api/ugc/deals', async (req) => {
    const pid = (req.query as Body).prospect_id
    return listDeals(db, pid ? id(pid) : undefined)
  })
  app.post('/api/ugc/deals', async (req, reply) => {
    const b = body(req)
    return reply.code(201).send(createDeal(db, id(b.prospect_id), b))
  })
  app.patch('/api/ugc/deals/:id', async (req) => updateDeal(db, id(params(req).id), body(req)))
  app.delete('/api/ugc/deals/:id', async (req) => {
    deleteDeal(db, id(params(req).id))
    return { ok: true }
  })
  app.get('/api/ugc/deals/:id/template/:slug', async (req) => renderDealTemplate(db, id(params(req).id), String(params(req).slug)))
}
