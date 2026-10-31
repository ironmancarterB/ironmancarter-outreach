// CRM pipeline stages, in board order. Shared by the server and the dashboard.
export const STAGES = [
  { id: 'discovered', label: 'Discovered', group: 'research' },
  { id: 'researching', label: 'Researching', group: 'research' },
  { id: 'qualified', label: 'Qualified', group: 'research' },
  { id: 'draft_ready', label: 'Draft Ready', group: 'outreach' },
  { id: 'awaiting_approval', label: 'Awaiting Initial Approval', group: 'outreach' },
  { id: 'approved_autopilot', label: 'Approved for Autopilot', group: 'outreach' },
  { id: 'contacted', label: 'Contacted', group: 'outreach' },
  { id: 'replied', label: 'Replied', group: 'deal' },
  { id: 'negotiating', label: 'Negotiating', group: 'deal' },
  { id: 'proposal_sent', label: 'Proposal Sent', group: 'deal' },
  { id: 'won', label: 'Won', group: 'closed' },
  { id: 'lost', label: 'Lost', group: 'closed' },
  { id: 'not_interested', label: 'Not Interested', group: 'closed' },
  { id: 'opted_out', label: 'Opted Out', group: 'closed' },
  { id: 'paused', label: 'Paused', group: 'closed' },
] as const

export type StageId = (typeof STAGES)[number]['id']

export const STAGE_IDS = STAGES.map((s) => s.id) as StageId[]
export const isStage = (v: unknown): v is StageId => typeof v === 'string' && (STAGE_IDS as string[]).includes(v)
export const stageLabel = (id: string) => STAGES.find((s) => s.id === id)?.label ?? id

// Stages that end automated outreach for a company.
export const OUTREACH_BLOCKING_STAGES: StageId[] = ['replied', 'negotiating', 'proposal_sent', 'won', 'lost', 'not_interested', 'opted_out', 'paused']

// Stages counted as an active deal conversation.
export const ACTIVE_DEAL_STAGES: StageId[] = ['replied', 'negotiating', 'proposal_sent']
