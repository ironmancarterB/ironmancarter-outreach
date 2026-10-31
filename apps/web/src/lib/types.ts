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
}

export interface ProspectDetail {
  prospect: ProspectListItem & {
    sponsorship_evidence: string | null
    campaign_concept: string | null
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
}

export interface BatchCandidate {
  id: number
  company_name: string
  domain: string
  category_name: string
  status: 'pending' | 'researching' | 'done' | 'duplicate' | 'unreachable' | 'blocked' | 'failed' | 'cancelled'
  message: string | null
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
