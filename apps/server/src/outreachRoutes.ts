// Phase 5 routes: conversations, follow-ups, manual sending, autopilot and the outreach controls.
// There is no bulk-send route. Manual sends need prepare → confirm; autopilot sends only from the worker's schedule.
import type { FastifyInstance } from 'fastify'
import { getSetting, type DB } from '../../../packages/db'
import { invalid } from '../../../packages/core/errors'
import type { RouterDeps } from '../../../packages/ai/router'
import type { GmailDeps } from '../../../packages/gmail/account'
import {
  classifyMessage, conversationMessages, conversations, markThreadReviewed, outreachActivity, outreachOverview, sendingQueue, sentList,
} from '../../../packages/outreach/dashboard'
import {
  approveFollowUp, cancelFollowUp, createFollowUpDraft, editFollowUp, listFollowUps, reconcileFollowUps, rescheduleFollowUp, skipFollowUp, updateFollowUpDraft,
} from '../../../packages/outreach/followups'
import {
  ACTIVATION_PHRASE, activationChecklist, confirmSend, pendingFollowUp, emergencyStop, limitsStatus, prepareSend, reconcileSend, resolveSend, resumeOutreach, setLiveSending, stopState,
  type SendTarget,
} from '../../../packages/outreach/send'
import { checkThreadBeforeFollowUp, syncConversations } from '../../../packages/outreach/sync'
import { disableAutopilot, disableUgcAutopilot, enableAutopilot, readiness, setDryRun, status as autopilotStatus, tick } from '../../../packages/outreach/autopilot'
import { CATEGORIES } from '../../../packages/outreach/classify'
import { refreshSignatures } from '../../../packages/outreach/signatureRefresh'

type Body = Record<string, unknown>
const id = (v: unknown) => {
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0) throw invalid('Invalid id')
  return n
}
const confirmed = (body: unknown) => {
  if ((body as Body | undefined)?.confirm !== true) throw invalid('Confirm this action first')
}

export function outreachRoutes(app: FastifyInstance, ctx: { db: DB; gmail: GmailDeps; dataDir: string; aiDeps?: RouterDeps }) {
  const { db, gmail, dataDir } = ctx
  const params = (req: { params: unknown }) => req.params as Body
  const body = (req: { body: unknown }) => (req.body ?? {}) as Body

  app.get('/api/outreach/overview', async () => outreachOverview(db))
  app.get('/api/outreach/sending-queue', async () => sendingQueue(db))
  app.get('/api/outreach/sent', async () => sentList(db))
  app.get('/api/outreach/activity', async (req) => outreachActivity(db, (req.query as Body).prospect ? id((req.query as Body).prospect) : undefined))

  // ---------- Conversations ----------
  app.get('/api/outreach/conversations', async () => conversations(db))
  app.get('/api/outreach/conversations/:id', async (req) => conversationMessages(db, { threadId: id(params(req).id) }))
  app.get('/api/prospects/:id/conversation', async (req) => conversationMessages(db, { prospectId: id(params(req).id) }))
  app.post('/api/outreach/conversations/:id/reviewed', async (req) => markThreadReviewed(db, id(params(req).id)))
  app.patch('/api/outreach/messages/:id', async (req) => classifyMessage(db, id(params(req).id), body(req)))
  app.get('/api/outreach/categories', async () => CATEGORIES)
  app.post('/api/outreach/sync', async () => syncConversations(db, gmail, { ai: ctx.aiDeps }))

  // ---------- Follow-ups ----------
  app.get('/api/outreach/follow-ups', async () => listFollowUps(db))
  app.patch('/api/outreach/follow-ups/:id', async (req) => editFollowUp(db, id(params(req).id), body(req)))
  app.post('/api/outreach/follow-ups/:id/approve', async (req) => approveFollowUp(db, id(params(req).id)))
  app.post('/api/outreach/follow-ups/:id/reschedule', async (req) => rescheduleFollowUp(db, id(params(req).id), body(req).dueAt))
  app.post('/api/outreach/follow-ups/:id/skip', async (req) => skipFollowUp(db, id(params(req).id)))
  app.post('/api/outreach/follow-ups/:id/cancel', async (req) => cancelFollowUp(db, id(params(req).id), body(req).reason))
  app.post('/api/outreach/follow-ups/:id/gmail-draft', async (req) => {
    confirmed(req.body)
    return createFollowUpDraft(db, gmail, dataDir, id(params(req).id))
  })
  app.put('/api/outreach/follow-ups/:id/gmail-draft', async (req) => {
    confirmed(req.body)
    return updateFollowUpDraft(db, gmail, id(params(req).id))
  })

  // ---------- Manual sending: prepare (review the exact email) → confirm (send that one email) ----------
  const target = (b: Body): SendTarget => {
    if (b.pitchId != null) return { kind: 'initial', pitchId: id(b.pitchId) }
    if (b.followUpId != null) return { kind: 'follow_up', followUpId: id(b.followUpId) }
    throw invalid('Choose one pitch or follow-up')
  }
  app.post('/api/outreach/send/prepare', async (req) => {
    const t = target(body(req))
    if (t.kind === 'follow_up') await checkThreadBeforeFollowUp(db, gmail, t.followUpId, { ai: ctx.aiDeps }).catch(() => undefined)
    return prepareSend(db, gmail, t)
  })
  app.post('/api/outreach/send/confirm', async (req) => {
    const b = body(req)
    const followUpId = pendingFollowUp(typeof b.token === 'string' ? b.token : '')
    if (followUpId) await checkThreadBeforeFollowUp(db, gmail, followUpId, { ai: ctx.aiDeps }).catch(() => undefined)
    return confirmSend(db, gmail, b)
  })
  app.post('/api/outreach/sends/:id/reconcile', async (req) => reconcileSend(db, gmail, id(params(req).id)))
  app.post('/api/outreach/sends/:id/resolve', async (req) => {
    confirmed(req.body)
    return resolveSend(db, gmail, id(params(req).id), body(req).outcome)
  })

  // Puts the current signature on every unsent draft (and its Gmail copy). Never sends.
  app.post('/api/outreach/refresh-signatures', async () => refreshSignatures(db, gmail, dataDir))

  // ---------- Controls ----------
  app.get('/api/outreach/controls', async () => ({
    liveSendingEnabled: getSetting<boolean>(db, 'outreach.liveSendingEnabled'),
    emergencyStop: stopState(db),
    limits: limitsStatus(db),
    checklist: activationChecklist(db),
    activationPhrase: ACTIVATION_PHRASE,
  }))
  app.post('/api/outreach/stop', async (req) => emergencyStop(db, body(req).reason))
  app.post('/api/outreach/resume', async (req) => {
    confirmed(req.body)
    return resumeOutreach(db)
  })
  // ---------- Autopilot ----------
  app.get('/api/outreach/autopilot', async () => ({ ...autopilotStatus(db), readiness: await readiness(db, gmail) }))
  app.post('/api/outreach/autopilot', async (req) => {
    const b = body(req)
    if (b.enable === true) return enableAutopilot(db, gmail, b.phrase)
    if (b.enable === false) return disableAutopilot(db)
    throw invalid('enable must be true or false')
  })
  app.post('/api/outreach/autopilot/mode', async (req) => {
    const b = body(req)
    if (typeof b.dryRun !== 'boolean') throw invalid('dryRun must be true or false')
    if (!b.dryRun) confirmed(b)
    return setDryRun(db, b.dryRun)
  })
  // Plans one run against your real data without sending anything or touching Gmail.
  app.post('/api/outreach/autopilot/dry-run', async () => tick(db, gmail, { dataDir, ai: ctx.aiDeps, forceDryRun: true, holder: 'dashboard-dry-run' }))

  app.post('/api/outreach/live-sending', async (req) => {
    const b = body(req)
    if (b.enable === true) return { liveSendingEnabled: setLiveSending(db, true, b.phrase) }
    if (b.enable === false) {
      if (getSetting<boolean>(db, 'outreach.autopilotEnabled')) disableAutopilot(db, 'Live sending was switched off')
      if (getSetting<boolean>(db, 'ugc.autopilotEnabled')) disableUgcAutopilot(db, 'Live sending was switched off')
      return { liveSendingEnabled: setLiveSending(db, false) }
    }
    throw invalid('enable must be true or false')
  })
}

// Things that must re-check pending follow-ups after a CRM change (suppressions, stage changes).
export const afterCrmChange = (db: DB) => reconcileFollowUps(db)
