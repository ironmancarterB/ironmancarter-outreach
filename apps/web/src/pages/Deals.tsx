import { Badge, Card, Empty, ErrorBox, Loading, Notice, PageHeader } from '../components/ui'
import { useApi } from '../lib/api'
import { usd } from '../lib/format'
import type { ProspectListItem } from '../lib/types'
import { stageLabel } from '../../../../packages/core/stages'

const DEAL_STAGES = ['replied', 'negotiating', 'proposal_sent', 'won']

export default function Deals() {
  const { data, error } = useApi<ProspectListItem[]>('/api/prospects?sort=value')
  if (error) return <ErrorBox error={error} />
  if (!data) return <Loading />
  const deals = data.filter((p) => DEAL_STAGES.includes(p.stage))
  return (
    <>
      <PageHeader title="Deals" subtitle="Companies in conversation or under contract. Edit values and terms in each company's Deal section." />
      <div className="space-y-4">
        <Notice>Sponsorship packages, contract tracking (rights, exclusivity, milestones) and renewal reminders arrive in Phase 6. Nothing is ever agreed automatically.</Notice>
        {deals.length === 0 ? <Empty title="No active deals">Companies appear here once they reply, negotiate, receive a proposal or are won.</Empty> : (
          <Card padded={false}>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] text-sm">
                <thead className="border-b border-zinc-100 text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
                  <tr><th className="px-4 py-2 text-left">Company</th><th className="px-4 py-2 text-left">Stage</th><th className="px-4 py-2 text-right">Potential</th><th className="px-4 py-2 text-right">Negotiated</th><th className="px-4 py-2 text-left">Payment</th><th className="px-4 py-2 text-left">Renewal</th></tr>
                </thead>
                <tbody>
                  {deals.map((p) => (
                    <tr key={p.id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800">
                      <td className="px-4 py-2.5"><a className="font-medium hover:underline" href={`#/prospects/${p.id}`}>{p.company_name}</a></td>
                      <td className="px-4 py-2.5"><Badge tone={p.stage === 'won' ? 'green' : 'blue'}>{stageLabel(p.stage)}</Badge></td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{usd(p.potential_value_cents)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{usd(p.negotiated_value_cents)}</td>
                      <td className="px-4 py-2.5">{p.payment_status === 'none' ? '—' : p.payment_status}</td>
                      <td className="px-4 py-2.5">{p.renewal_date ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>
    </>
  )
}
