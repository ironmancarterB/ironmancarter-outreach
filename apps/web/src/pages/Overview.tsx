import { Badge, Card, ErrorBox, Loading, Notice, PageHeader, Stat } from '../components/ui'
import { useApi } from '../lib/api'
import { bytes, relative, usd, usdAmount } from '../lib/format'
import type { Overview as OverviewData } from '../lib/types'
import { STAGES } from '../../../../packages/core/stages'

export default function Overview() {
  const { data, error } = useApi<OverviewData>('/api/overview')
  if (error) return <ErrorBox error={error} />
  if (!data) return <Loading />
  const { outreach: o, prospects: p, revenue: r } = data
  const funnel = STAGES.filter((s) => s.group !== 'closed' || s.id === 'won')
  const maxStage = Math.max(1, ...funnel.map((s) => p.byStage[s.id] ?? 0))

  return (
    <>
      <PageHeader title="Overview" subtitle="Every number here comes from data stored in this app." />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Sending mode" value={o.liveSendingEnabled ? 'Manual (live)' : 'Off'} tone={o.liveSendingEnabled ? 'warn' : 'muted'}
          hint="Autopilot is not available; you confirm every email" />
        <Stat label="Sending tier" value={o.tier.name} hint={`${o.tier.daily_limit}/day · ${o.tier.weekly_limit}/week (upper bounds)`} />
        <Stat label="Emails sent" value={`${o.sentToday} today`} hint={`${o.sentThisWeek} this week`} />
        <Stat label="Remaining capacity" value={`${o.remainingToday} today`} hint={o.liveSendingEnabled ? `${o.remainingThisWeek} new this week. Ceilings, not targets` : 'Zero while live sending is off'} />
        <Stat label="Actionable brands" value={<a className="hover:underline" href="#/discovery/leads">{data.leads.actionable}</a>}
          hint={<>{data.leads.withQualifyingEmail} brands have a qualifying email · {data.leads.withoutUsableEmail} don't · <a className="text-brand-600 hover:underline" href="#/discovery/review">{p.pendingReview} awaiting your review</a></>} />
        <Stat label="Replies needing attention" value={data.repliesNeedingAttention} hint="Conversations flagged for your review" />
        <Stat label="Follow-ups scheduled" value={p.followUpsScheduled} hint="Your reminder dates" />
        <Stat label="Active negotiations" value={p.activeNegotiations} hint="Replied, negotiating or proposal sent" />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Pipeline" className="lg:col-span-2" actions={<a className="text-xs font-medium text-brand-600 hover:underline" href="#/prospects">Open CRM →</a>}>
          {p.total === 0 ? (
            <p className="text-sm text-zinc-500">No companies yet. Add one from <a className="text-brand-600 hover:underline" href="#/prospects">Prospects</a> or import a CSV. Automated research arrives in Phase 2.</p>
          ) : (
            <ul className="space-y-2">
              {funnel.map((s) => {
                const n = p.byStage[s.id] ?? 0
                return (
                  <li key={s.id} className="grid grid-cols-[10rem_1fr_2.5rem] items-center gap-3 text-sm">
                    <span className="truncate text-zinc-600 dark:text-zinc-400">{s.label}</span>
                    <span className="h-2 rounded-full bg-zinc-100 dark:bg-zinc-800">
                      <span className="block h-2 rounded-full bg-brand-500" style={{ width: `${(n / maxStage) * 100}%` }} />
                    </span>
                    <span className="text-right tabular-nums">{n}</span>
                  </li>
                )
              })}
            </ul>
          )}
        </Card>

        <Card title="Sponsorship revenue">
          <dl className="space-y-3 text-sm">
            <div className="flex justify-between"><dt className="text-zinc-500">Contracted (won deals)</dt><dd className="font-semibold tabular-nums">{usd(r.contractedCents)}</dd></div>
            <div className="flex justify-between"><dt className="text-zinc-500">Collected</dt><dd className="font-semibold tabular-nums">{usd(r.collectedCents)}</dd></div>
            <div className="flex justify-between"><dt className="text-zinc-500">Open pipeline</dt><dd className="tabular-nums">{usd(r.openPipelineCents)}</dd></div>
            <div className="flex justify-between"><dt className="text-zinc-500">Deals won</dt><dd className="tabular-nums">{r.dealsWon}</dd></div>
          </dl>
        </Card>

        <Card title="Media kit">
          {data.mediaKit ? (
            <div className="text-sm">
              <div className="flex items-center gap-2"><span className="font-medium">v{data.mediaKit.version} · {data.mediaKit.label}</span><Badge tone="green">Default</Badge></div>
              <div className="mt-1 text-zinc-500">{data.mediaKit.page_count ?? '?'} pages · {bytes(data.mediaKit.size_bytes)}</div>
              <a className="mt-3 inline-block text-xs font-medium text-brand-600 hover:underline" href="#/media-kit">Preview →</a>
            </div>
          ) : (
            <Notice tone="amber">No media kit imported yet. <a className="underline" href="#/media-kit">Import it</a>.</Notice>
          )}
        </Card>

        <Card title="AI & costs">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between"><dt className="text-zinc-500">Provider</dt><dd className="capitalize">{data.ai.provider}</dd></div>
            <div className="flex justify-between"><dt className="text-zinc-500">Paid AI</dt><dd>{data.ai.paidEnabled ? 'On' : 'Off'}</dd></div>
            <div className="flex justify-between"><dt className="text-zinc-500">Paid spend this month</dt><dd className="tabular-nums">{usdAmount(data.ai.paidSpendThisMonthUsd)}</dd></div>
            <div className="flex justify-between"><dt className="text-zinc-500">Monthly budget</dt><dd className="tabular-nums">{usdAmount(data.ai.budgetUsd)}</dd></div>
          </dl>
        </Card>

        <Card title="Recent activity">
          {data.recentActivity.length === 0 ? <p className="text-sm text-zinc-500">Nothing yet.</p> : (
            <ul className="space-y-2.5 text-sm">
              {data.recentActivity.slice(0, 8).map((a) => (
                <li key={a.id} className="flex gap-2">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-300 dark:bg-zinc-600" />
                  <span className="min-w-0 flex-1">
                    {a.prospect_id && a.company_name ? <a href={`#/prospects/${a.prospect_id}`} className="font-medium hover:underline">{a.company_name}: </a> : null}
                    <span className="text-zinc-600 dark:text-zinc-400">{a.summary}</span>
                    <span className="block text-xs text-zinc-400">{relative(a.created_at)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  )
}
