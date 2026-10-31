import { Card, ErrorBox, Loading, Notice, PageHeader, Stat } from '../components/ui'
import { useApi } from '../lib/api'
import { usd } from '../lib/format'
import type { Overview } from '../lib/types'

export default function Revenue() {
  const ov = useApi<Overview>('/api/overview')
  const settings = useApi<{ values: Record<string, unknown> }>('/api/settings')
  if (ov.error) return <ErrorBox error={ov.error} />
  if (!ov.data || !settings.data) return <Loading />
  const r = ov.data.revenue
  const milestones = settings.data.values['business.sponsorshipMilestonesUsd'] as number[]
  const goal = settings.data.values['business.revenueGoalMonthlyUsd'] as number
  return (
    <>
      <PageHeader title="Revenue Analytics" subtitle="Calculated from recorded deals only." />
      <div className="space-y-6">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Open pipeline" value={usd(r.openPipelineCents)} hint="Replied, negotiating, proposal sent" />
          <Stat label="Contracted" value={usd(r.contractedCents)} hint={`${r.dealsWon} won deal${r.dealsWon === 1 ? '' : 's'}`} />
          <Stat label="Collected" value={usd(r.collectedCents)} hint="Won deals marked paid" />
          <Stat label="Business goal" value={`$${goal.toLocaleString('en-US')}/mo`} hint="Gross creator-business revenue" />
        </div>
        <Card title="Monthly sponsorship milestones (goals, not projections)">
          <ul className="space-y-3">
            {milestones.map((m) => (
              <li key={m} className="flex justify-between border-b border-zinc-100 pb-2 text-sm last:border-0 dark:border-zinc-800">
                <span>${m.toLocaleString('en-US')}/month</span><span className="text-zinc-500">Monthly tracking arrives in Phase 6</span>
              </li>
            ))}
          </ul>
        </Card>
        <Notice>Phase 6 adds monthly recurring revenue, projected vs contracted vs invoiced vs collected by month, average deal size, conversion rates from recorded activity, revenue by category and renewal opportunities.</Notice>
      </div>
    </>
  )
}
