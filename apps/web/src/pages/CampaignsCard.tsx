// Both campaigns on one sending budget: today's slots per campaign, the shared daily and weekly caps, follow-ups,
// what is ready or blocked, replies, and an independent pause switch per campaign.
import { Badge, Button, Card, ErrorBox, Loading, Stat, useToast } from '../components/ui'
import { api, useApi } from '../lib/api'

interface Side {
  enabled: boolean; paused: boolean; autoPause: { reason: string | null }
  today: { allocated: number; sent: number; remaining: number }
  followUpsToday: number; weekSent: number; ready: number; replies: number; interested: number
  blocked: { reason: string; count: number }[]
}
interface Dual {
  tier: string; allocation: { sponsorship: number; ugc: number; redistributeUnused: boolean }
  combined: { sent: number; limit: number }; week: { sent: number; limit: number }
  followUps: { sent: number; limit: number }; inSendWindow: boolean; emergencyStop: { active: boolean }
  sponsorship: Side; ugc: Side
}

export default function CampaignsCard() {
  const d = useApi<Dual>('/api/outreach/campaigns')
  const toast = useToast()
  if (d.error) return <ErrorBox error={d.error} />
  if (!d.data) return <Loading />
  const x = d.data
  const toggle = async (c: 'sponsorship' | 'ugc', paused: boolean) => {
    try { await api.post(`/api/outreach/campaigns/${c}/pause`, { paused }); toast(`${c === 'ugc' ? 'UGC' : 'Sponsorship'} ${paused ? 'paused' : 'resumed'}`); d.reload() } catch (e) { toast((e as Error).message, 'error') }
  }
  const side = (c: 'sponsorship' | 'ugc', s: Side) => (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold">{c === 'ugc' ? 'UGC' : 'Sponsorship'}</h3>
        {!s.enabled ? <Badge tone="gray">Autopilot off</Badge> : s.paused ? <Badge tone="amber">Paused</Badge> : <Badge tone="green">Running</Badge>}
      </div>
      {!s.enabled && s.autoPause.reason && <p className="text-xs text-amber-600">{s.autoPause.reason}</p>}
      <div className="grid grid-cols-2 gap-2">
        <Stat label="New emails today" value={`${s.today.sent} / ${s.today.allocated}`} />
        <Stat label="Follow-ups today" value={s.followUpsToday} />
        <Stat label="Ready to send" value={s.ready} tone={s.ready ? 'good' : 'muted'} />
        <Stat label="Replies · interested" value={`${s.replies} · ${s.interested}`} />
      </div>
      {s.blocked.length > 0 && (
        <details className="text-sm"><summary className="cursor-pointer">Blocked contacts ({s.blocked.reduce((a, b) => a + b.count, 0)})</summary>
          <ul className="mt-1 space-y-0.5 text-zinc-500">{s.blocked.map((b) => <li key={b.reason}>{b.count} × {b.reason}</li>)}</ul>
        </details>
      )}
      {s.enabled && <Button size="sm" onClick={() => toggle(c, !s.paused)}>{s.paused ? 'Resume' : 'Pause'} {c === 'ugc' ? 'UGC' : 'sponsorship'}</Button>}
    </div>
  )
  return (
    <Card title="Both campaigns: shared sending budget">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Combined new emails today" value={`${x.combined.sent} / ${x.combined.limit}`} hint={`${x.tier} tier`} />
        <Stat label="New emails this week" value={`${x.week.sent} / ${x.week.limit}`} hint="Rolling 7 days" />
        <Stat label="Follow-ups today (shared)" value={`${x.followUps.sent} / ${x.followUps.limit}`} />
      </div>
      <p className="my-3 text-xs text-zinc-500">
        Slots: {x.allocation.sponsorship} sponsorship + {x.allocation.ugc} UGC a day{x.allocation.redistributeUnused ? ', unused slots may move to the other campaign' : '; neither campaign can use the other’s slots'}.
        {x.inSendWindow ? ' Sending hours now.' : ' Outside sending hours.'}{x.emergencyStop.active ? ' STOP ALL OUTREACH is active.' : ''}
      </p>
      <div className="grid gap-6 md:grid-cols-2">{side('sponsorship', x.sponsorship)}{side('ugc', x.ugc)}</div>
    </Card>
  )
}
