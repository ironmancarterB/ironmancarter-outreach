// Manual submissions through creator portals and contact forms. The app stores the verified page and
// your message, and tracks status; you open the page and submit it yourself. Forms are never filled in
// or submitted automatically.
import { all, get, logActivity, nowIso, run, tx, type DB } from '../db'
import { AppError, invalid } from '../core/errors'
import { normalizeDomain, normalizeUrl } from '../core/normalize'
import { getProspect, setStage } from '../crm/prospects'

export const APPLICATION_STATUSES = ['not_started', 'ready', 'submitted', 'responded', 'accepted', 'declined', 'no_response'] as const
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number]

export interface Application {
  id: number
  prospect_id: number
  application_url: string
  url_origin: 'research' | 'manual'
  url_retrieved_at: string | null
  status: ApplicationStatus
  submitted_at: string | null
  follow_up_date: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

export function ensureApplication(db: DB, prospectId: number, app: { url: string; retrievedAt: string | null; origin: 'research' | 'manual' }) {
  if (get(db, 'SELECT 1 FROM manual_applications WHERE prospect_id = ?', prospectId)) return
  const now = nowIso()
  run(db, 'INSERT INTO manual_applications (prospect_id, application_url, url_origin, url_retrieved_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    prospectId, app.url, app.origin, app.retrievedAt, now, now)
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function updateApplication(db: DB, prospectId: number, input: { application_url?: string; status?: string; follow_up_date?: string | null; notes?: string | null }) {
  const p = getProspect(db, prospectId)
  const existing = get<Application>(db, 'SELECT * FROM manual_applications WHERE prospect_id = ?', prospectId)
  let url = existing?.application_url ?? null
  let origin = existing?.url_origin ?? 'manual'
  let retrievedAt = existing?.url_retrieved_at ?? null
  if (input.application_url !== undefined) {
    const u = normalizeUrl(input.application_url)
    if (!u) throw invalid('Application URL must be a valid web address')
    // On the brand's own site, or an official portal on record (an application platform linked from the brand's program page).
    const portal = get(db, "SELECT 1 FROM contacts WHERE prospect_id = ? AND contact_tier = 'VERIFIED_PORTAL' AND contact_form_url = ? AND verification_status != 'failed'", prospectId, u)
    if (!portal && (!p.domain || normalizeDomain(u) !== p.domain)) throw invalid(`The application page must be on ${p.company_name}'s own site (${p.domain ?? 'no website on record'}) or an official portal found in Contact Discovery`)
    // Pages research actually fetched count as verified; anything else is marked as added by you.
    const seen = get<{ retrieved_at: string }>(db, 'SELECT retrieved_at FROM research_sources WHERE prospect_id = ? AND url = ?', prospectId, u)
      ?? get<{ retrieved_at: string }>(db, 'SELECT fetched_at AS retrieved_at FROM research_fetches WHERE prospect_id = ? AND (url = ? OR final_url = ?) AND outcome = \'ok\'', prospectId, u, u)
    url = u
    origin = seen ? 'research' : 'manual'
    retrievedAt = seen?.retrieved_at ?? null
  }
  if (!url) throw invalid('Add the creator portal or contact form URL first')
  if (input.status !== undefined && !APPLICATION_STATUSES.includes(input.status as ApplicationStatus)) throw invalid('Unknown application status')
  if (input.follow_up_date && !DATE_RE.test(input.follow_up_date)) throw invalid('Follow-up date must be YYYY-MM-DD')
  const now = nowIso()
  tx(db, () => {
    if (!existing) {
      run(db, 'INSERT INTO manual_applications (prospect_id, application_url, url_origin, url_retrieved_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', prospectId, url, origin, retrievedAt, now, now)
    }
    run(db, `UPDATE manual_applications SET application_url = ?, url_origin = ?, url_retrieved_at = ?, status = COALESCE(?, status),
      follow_up_date = CASE WHEN ? THEN ? ELSE follow_up_date END, notes = CASE WHEN ? THEN ? ELSE notes END, updated_at = ? WHERE prospect_id = ?`,
      url, origin, retrievedAt, input.status ?? null, input.follow_up_date !== undefined ? 1 : 0, input.follow_up_date || null,
      input.notes !== undefined ? 1 : 0, input.notes?.trim() || null, now, prospectId)
    if (input.follow_up_date !== undefined) run(db, 'UPDATE prospects SET next_follow_up_date = ?, updated_at = ? WHERE id = ?', input.follow_up_date || null, now, prospectId)
    logActivity(db, 'application.updated', `Manual application updated${input.status ? `: ${input.status.replace('_', ' ')}` : ''}`, { prospectId })
  })
  return getApplication(db, prospectId)
}

// You submitted the form yourself; record it and set a follow-up reminder (default one week).
export function markSubmitted(db: DB, prospectId: number, followUpDate?: string | null, now = new Date()) {
  const p = getProspect(db, prospectId)
  const app = get<Application>(db, 'SELECT * FROM manual_applications WHERE prospect_id = ?', prospectId)
  if (!app) throw new AppError(409, 'no_application', 'Draft a manual submission pitch first.')
  if (!get(db, "SELECT 1 FROM pitches WHERE prospect_id = ? AND channel = 'manual_form' AND status = 'approved'", prospectId)) {
    throw new AppError(409, 'not_approved', 'Approve the manual submission message before recording it as submitted.')
  }
  if (followUpDate && !DATE_RE.test(followUpDate)) throw invalid('Follow-up date must be YYYY-MM-DD')
  const follow = followUpDate || new Date(now.getTime() + 7 * 86_400_000).toISOString().slice(0, 10)
  tx(db, () => {
    run(db, "UPDATE manual_applications SET status = 'submitted', submitted_at = ?, follow_up_date = ?, updated_at = ? WHERE prospect_id = ?", now.toISOString(), follow, nowIso(), prospectId)
    run(db, 'UPDATE prospects SET next_follow_up_date = ?, updated_at = ? WHERE id = ?', follow, nowIso(), prospectId)
    if (!['contacted', 'replied', 'negotiating', 'proposal_sent', 'won'].includes(p.stage)) setStage(db, prospectId, 'contacted', 'You submitted the application manually')
    logActivity(db, 'application.submitted', `You recorded a manual submission via ${app.application_url}; follow up ${follow}`, { prospectId })
  })
  return getApplication(db, prospectId)
}

export const getApplication = (db: DB, prospectId: number) => get<Application>(db, 'SELECT * FROM manual_applications WHERE prospect_id = ?', prospectId) ?? null

export const listApplications = (db: DB) => all<Application & { company_name: string; fit_score: number | null }>(db, `
  SELECT a.*, p.company_name, p.fit_score FROM manual_applications a JOIN prospects p ON p.id = a.prospect_id
  ORDER BY CASE a.status WHEN 'ready' THEN 0 WHEN 'submitted' THEN 1 WHEN 'not_started' THEN 2 ELSE 3 END, a.follow_up_date`)
