// API response shapes used by the dashboard.
import type { StageId } from '../../../../packages/core/stages'

export type Eligibility = { status: 'eligible' | 'needs_review' | 'ineligible'; reasons: string[] }

export interface ProspectListItem {
  id: number
  company_name: string
  website: string | null
  domain: string | null
  category_id: number | null
  category_name: string | null
  products: string | null
  fit_score: number | null
  fit_tier: 'A' | 'B' | 'C' | null
  stage: StageId
  potential_value_cents: number | null
  negotiated_value_cents: number | null
  payment_status: 'none' | 'invoiced' | 'partial' | 'paid'
  next_follow_up_date: string | null
  first_contacted_at: string | null
  last_contacted_at: string | null
  last_reply_at: string | null
  negotiation_notes: string | null
  outcome_note: string | null
  renewal_date: string | null
  tags: string[]
  contact_count: number
  primary_email: string | null
  source: string
  review_status: 'pending' | 'approved' | 'rejected'
  review_note: string | null
  reviewed_at: string | null
  last_researched_at: string | null
  updated_at: string
  created_at: string
}

export interface Contact {
  id: number
  name: string | null
  role: string | null
  email: string | null
  contact_form_url: string | null
  source_url: string | null
  verification_status: 'unverified' | 'verified' | 'failed'
  verified_at: string | null
  jurisdiction: string
  is_primary: number
  eligibility: Eligibility
  contact_tier: 'VERIFIED_DIRECT' | 'VERIFIED_AGENCY' | 'VERIFIED_PORTAL' | 'PUBLIC_UNVERIFIED'
  agency_confirmed: string | null
  decision_note: string | null
}

export interface ProspectDetail {
  prospect: ProspectListItem & {
    sponsorship_evidence: string | null
    campaign_concept: string | null
    campaign_type?: 'sponsorship' | 'ugc'
    fit_breakdown: Record<string, number> | null
    fit_explanation: string | null
    research_confidence: 'low' | 'medium' | 'high' | null
    contract_duration: string | null
    deliverables: string | null
    usage_rights: string | null
  }
  category: { id: number; name: string; compliance_note: string | null } | null
  contacts: Contact[]
  tags: string[]
  notes: { id: number; body: string; created_at: string }[]
  sources: { id: number; url: string; title: string | null; kind: string; retrieved_at: string; snippet: string | null }[]
  activities: { id: number; type: string; summary: string; created_at: string }[]
  fetches: { id: number; url: string; final_url: string | null; status_code: number | null; outcome: string; title: string | null; fetched_at: string }[]
}

export interface Batch {
  id: number
  requested_size: number
  status: 'queued' | 'running' | 'completed' | 'cancelled' | 'failed'
  shortfall_note: string | null
  ai_provider: string
  created_at: string
  started_at: string | null
  finished_at: string | null
  total: number
  remaining: number
  done: number
  duplicates: number
  problems: number
  qualified: number
  researched: number
}

export interface BatchCandidate {
  id: number
  company_name: string
  domain: string
  category_name: string
  status: 'pending' | 'researching' | 'done' | 'duplicate' | 'unreachable' | 'blocked' | 'failed' | 'cancelled'
  message: string | null
  qualified: number | null
  prospect_id: number | null
  fit_score: number | null
  review_status: string | null
  attempts: number
}

export interface PoolSummaryRow {
  id: number
  name: string
  enabled: number
  priority: number
  research_quota: number
  available: number
  total: number
}

export interface PoolEntry {
  id: number
  company_name: string
  website: string
  domain: string
  category_id: number
  category_name: string
  origin: string
  status: 'available' | 'queued' | 'researched' | 'excluded'
  note: string | null
  in_crm: number
}

export type ProgramType = 'paid_sponsorship' | 'creator_partnerships' | 'affiliate_only' | 'unknown'

export interface Flag { level: 'missing' | 'warning'; code: string; message: string }
export interface Check { level: 'blocker' | 'warning'; code: string; message: string }

export type ClaimSource =
  | { type: 'research'; id: number; url: string; label: string; snippet: string | null; retrieved_at: string }
  | { type: 'metric'; id: number; label: string; platform: string; value: number; period: string | null; as_of: string; source: string }
  | { type: 'package'; id: number; name: string }
  | { type: 'media_kit'; id: number; version: number }
  | { type: 'creator'; note: string }
  | { type: 'concept'; note: string }

export interface Claim { sentence: string; kind: string; sources: ClaimSource[] }

export interface PitchOptions {
  channel: 'email' | 'manual_form'
  contact_id?: number | null
  package_id?: number | null
  include_rates?: boolean
  custom_rate_text?: string | null
  custom_deliverables?: string | null
  concept?: string | null
}

export interface Package {
  id: number
  slug: string
  name: string
  deliverables: string
  price_min_cents: number | null
  price_max_cents: number | null
  price_unit: 'flat' | 'per_month' | 'custom'
  recurring: number
  active: number
  notes: string | null
}

export interface PitchView {
  pitch: {
    id: number; prospect_id: number; version: number; channel: 'email' | 'manual_form'; recipient_email: string | null; application_url: string | null
    subject: string | null; body: string; status: 'draft' | 'approved' | 'rejected' | 'superseded'; generator: 'template' | 'ollama'; ai_model: string | null
    generation_note: string | null; options: PitchOptions; claims: Claim[]; flags: Flag[]; media_kit_id: number | null; edited: number
    reviewed_at: string | null; reject_reason: string | null; created_at: string; updated_at: string
  }
  company: { id: number; name: string; domain: string | null; category: string | null; fitScore: number | null; reviewStatus: string; campaignType?: 'sponsorship' | 'ugc' }
  ugc?: {
    concepts: { title: string; outline: string; basis: string }[]
    signals: { id: number; label: string; url: string; snippet: string | null }[]
    portfolio: { url: string | null; usable: boolean; link: string | null; reason: string | null }
  } | null
  program: { type: ProgramType; label: string; basis: string; overridden: boolean }
  recipient: { id: number; email: string | null; role: string | null; verification_status: string; verified_at: string | null; source_url: string | null; eligibility: Eligibility } | null
  application: { url: string; retrievedAt: string | null; origin: 'research' | 'manual' } | null
  currentFlags: Flag[]
  checks: Check[]
  wordCount: number
  claimValidation: { sentence: string; kind: string; inBody: boolean; problems: string[] }[]
  attachment: {
    mediaKitId: number; version: number; label: string; filename: string; mimeType: string; sizeBytes: number; sha256: string; storedFile: string
    fileExists: boolean; checksumOk: boolean; isCurrentDefault: boolean; gmailAttachmentVerified: boolean
  } | { mediaKitId: number; missing: true } | null
  versions: { id: number; version: number; channel: string; status: string; generator: string; created_at: string }[]
  sendingAvailable: false
  gmail: PitchGmail | null
  send: { id: number; status: string; sent_at: string | null; origin: string } | null
}

export interface PitchSummary {
  id: number; prospect_id: number; company_name: string; fit_score: number | null; version: number; channel: 'email' | 'manual_form'
  recipient_email: string | null; application_url: string | null; subject: string | null; status: string; generator: string; edited: boolean
  updated_at: string; reject_reason: string | null; wordCount: number; blockers: number; warnings: number
  gmail?: GmailDraftView | null
}

export interface OutreachQueue {
  ready: {
    id: number; company_name: string; domain: string | null; fit_score: number | null; category_name: string | null; stage: string
    programType: ProgramType; programLabel: string; evidenceCount: number; hasVerifiedEmail: boolean; suggestedChannel: 'email' | 'manual_form'; priority: number
  }[]
  drafts: PitchSummary[]
  approved: PitchSummary[]
  rejected: PitchSummary[]
  pendingReview: number
}

export interface Application {
  id: number; prospect_id: number; company_name: string; fit_score: number | null; application_url: string; url_origin: 'research' | 'manual'
  url_retrieved_at: string | null; status: string; submitted_at: string | null; follow_up_date: string | null; notes: string | null
}

export interface ProspectOutreach {
  company: { id: number; name: string; reviewStatus: string; concept: string | null }
  program: { type: ProgramType; label: string; basis: string; overridden: boolean }
  emailFlags: Flag[]
  manualFlags: Flag[]
  contacts: { id: number; email: string; role: string | null; verification_status: string }[]
  suggestedApplication: { url: string; retrievedAt: string | null; origin: string } | null
  application: Application | null
  pitches: { id: number; version: number; channel: string; status: string; generator: string; created_at: string }[]
  packages: Package[]
}

export interface ResearchStatus {
  workerHeartbeatAt: string | null
  workerRunning: boolean
  active: { id: number; status: string } | null
  pendingReview: number
}

export interface Category {
  id: number
  slug: string
  name: string
  description: string
  compliance_note: string | null
  enabled: number
  priority: number
  research_quota: number
}

export interface MediaKit {
  id: number
  version: number
  label: string
  original_filename: string
  stored_filename: string
  sha256: string
  size_bytes: number
  page_count: number | null
  is_default: number
  public_url: string | null
  notes: string | null
  created_at: string
  kind?: 'sponsorship' | 'ugc'
}

export interface Metric {
  id: number
  platform: string
  metric_key: string
  label: string
  value: number
  unit: 'count' | 'percent' | 'hours' | 'average'
  approximate: number
  period_label: string | null
  period_start: string | null
  period_end: string | null
  as_of: string
  source: string
  notes: string | null
  pitchable: number
  updated_at: string
}

export interface Activity {
  id: number
  prospect_id: number | null
  type: string
  summary: string
  created_at: string
  company_name: string | null
}

export interface Overview {
  leads: LeadMetrics
  outreach: {
    autopilotEnabled: boolean
    liveSendingEnabled: boolean
    mode: string
    tier: { slug: string; name: string; daily_limit: number; weekly_limit: number }
    sentToday: number
    sentThisWeek: number
    remainingToday: number
    remainingThisWeek: number
  }
  prospects: {
    total: number
    byStage: Record<string, number>
    verifiedAvailable: number
    needsReview: number
    manualContactQueue: number
    activeNegotiations: number
    followUpsScheduled: number
    pendingReview: number
    approved: number
  }
  repliesNeedingAttention: number
  revenue: { contractedCents: number; collectedCents: number; openPipelineCents: number; dealsWon: number }
  mediaKit: MediaKit | null
  ai: { provider: string; paidEnabled: boolean; budgetUsd: number; paidSpendThisMonthUsd: number }
  categories: { id: number; name: string; enabled: number; prospects: number }[]
  recentActivity: Activity[]
}

export interface GmailVerification {
  ok: boolean
  checkedAt: string
  checks: { label: string; ok: boolean; detail: string }[]
}

export interface GmailDraftView {
  id: number; kind: 'pitch' | 'test' | 'follow_up'; status: 'creating' | 'created' | 'uncertain' | 'failed' | 'gone' | 'unlinked' | 'sent'; pitchId: number | null
  recipient: string; subject: string | null; gmailDraftId: string | null; threadId: string | null; openUrl: string | null
  attachment: { filename: string | null; sha256: string | null; mediaKitId: number | null }
  verification: GmailVerification | null; editedInGmail: boolean; outOfDate: boolean
  lastSyncedAt: string | null; note: string | null; error: string | null; createdAt: string; updatedAt: string
  companyName?: string | null; prospectId?: number | null
}

export interface PitchGmail {
  connected: boolean
  account: string | null
  draft: GmailDraftView | null
  history: { id: number; status: string; created_at: string }[]
}

export interface GmailStatus {
  expectedAccount: string
  clientConfigured: boolean
  clientId: string | null
  secretStorage: string
  redirectUri: string
  requestedScopes: string[]
  account: { email: string; status: 'connected' | 'needs_reconnect'; scopes: string[]; missingScopes: string[]; readAccess: boolean; connectedAt: string; lastCheckedAt: string | null; lastError: string | null } | null
  liveSendingEnabled: boolean
  drafts: Record<string, number>
  lastSyncAt: string | null
}

export interface GmailOperation {
  id: number; account_id: number | null; draft_row_id: number | null; operation: string; status: 'started' | 'ok' | 'failed' | 'uncertain'
  http_status: number | null; detail: string | null; started_at: string; finished_at: string | null
}

export type LeadConfidence = 'high' | 'medium' | 'unverified'
export type OutreachStatus = 'needs_review' | 'ready_to_draft' | 'pitch_drafted' | 'pitch_approved' | 'gmail_draft' | 'contacted' | 'replied' | 'closed'

export interface Lead {
  id: number
  company_name: string
  website: string | null
  domain: string | null
  category_id: number | null
  category_name: string | null
  fit_score: number | null
  review_status: 'pending' | 'approved' | 'rejected'
  stage: StageId
  actionable: boolean
  has_qualifying_email: boolean
  exclusion: { code: string; label: string; detail: string } | null
  contact_id: number | null
  email: string | null
  department: string | null
  source_url: string | null
  verified_at: string | null
  confidence: LeadConfidence | null
  delivery_evidence: string
  bounce_status: 'none' | 'bounced'
  relevance: 'high' | 'medium' | 'none'
  relevance_label: string
  outreach_status: OutreachStatus
  previously_contacted: boolean
  last_contacted_at: string | null
  needs_before_send: string[]
}

export interface LeadMetrics {
  totalBrands: number
  actionable: number
  withQualifyingEmail: number
  withoutUsableEmail: number
  alreadyContacted: number
  awaitingOutreach: number
  awaitingReview: number
  discoveryRate: number
  excluded: Record<string, number>
  research: { researched: number; qualifying: number; duplicates: number; rejected: number; rate: number }
}

export interface LeadsResponse {
  metrics: LeadMetrics
  actionable: Lead[]
  excluded: Lead[]
}
