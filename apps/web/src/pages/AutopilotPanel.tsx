// Autopilot: automatic first emails to qualifying brands and their follow-ups, within hard daily limits.
import { useState } from 'react'
import { Badge, Button, Card, Field, Input, Loading, Notice, Stat, useToast } from '../components/ui'
import { api, useApi, usePoll } from '../lib/api'
import { dateTime, usd } from '../lib/format'

interface AutopilotStatus {
  enabled: boolean
  config: { dryRun: boolean; newPerDay: number; sendGapMinutes: number; syncEveryMinutes: number; maxErrorsPerDay: number; maxBouncesPerWeek: number }
  maxNewPerDay: number
  phrase: string
  pause: { reason: string | null; at: string | null }
  emergencyStop: { active: boolean }
  inSendWindow: boolean
  today: { firstEmails: number; followUps: number; cap: number }
  readyBrands: { id: number; company_name: string; email: string | null; confidence: string | null }[]
  totals: { emailsSent: number; byAutopilot: number; replies: number; positiveReplies: number; followUpsPending: number; dealsWon: number; revenueCents: number }
  events: { id: number; kind: string; detail: string; prospect_id: number | null; created_at: string }[]
  reports: { kind: string; period_key: string; text: string; created_at: string }[]
  readiness: { label: string; ok: boolean; detail: string }[]
}

const TONE: Record<string, 'green' | 'blue' | 'amber' | 'red' | 'gray'> = { sent: 'green', dry_run: 'blue', skipped: 'gray', error: 'red', paused: 'red', enabled: 'amber', disabled: 'gray', research: 'blue', sync: 'gray', report: 'gray' }

export default function AutopilotPanel() {
  const toast = useToast()
  const { data, reload } = useApi<AutopilotStatus>('/api/outreach/autopilot')
  usePoll(reload, 30_000, true)
  const [phrase, setPhrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [plan, setPlan] = useState<{ note: string; actions: string[] } | null>(null)
  if (!data) return <Card title="Autopilot"><Loading /></Card>
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true)
    try { await fn(); toast(ok); reload() } catch (e) { toast((e as Error).message, 'error') } finally { setBusy(false) }
  }
  const ready = data.readiness.every((c) => c.ok)
  const t = data.totals
  return (
    <Card title="Autopilot" actions={data.enabled ? <Badge tone={data.config.dryRun ? 'blue' : 'amber'}>{data.config.dryRun ? 'ON · DRY RUN' : 'ON · SENDING'}</Badge> : <Badge tone="gray">OFF</Badge>}>
      <div className="space-y-5 text-sm">
        <p>
          Sends up to <strong>{data.config.newPerDay}</strong> first emails a day (hard cap {data.maxNewPerDay}) to brands on Actionable leads with a qualifying public email and no open check,
          then follow-ups after {`5`} and {`12`} business days. Business hours only, at least {data.config.sendGapMinutes} minutes apart. Every email goes through the same checks as a manual send.
          A reply, opt-out or bounce stops the sequence. Autopilot never replies to a brand or agrees to anything.
        </p>
        {data.pause.reason && <Notice tone="red" title={`Autopilot paused itself ${data.pause.at ? dateTime(data.pause.at) : ''}`}>{data.pause.reason}</Notice>}
        {data.emergencyStop.active && <Notice tone="red">STOP ALL OUTREACH is active, so autopilot sends nothing.</Notice>}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Today" value={`${data.today.firstEmails}/${data.today.cap}`} hint={`first emails · ${data.today.followUps} follow-ups · ${data.inSendWindow ? 'in sending hours' : 'outside sending hours'}`} />
          <Stat label="Emails sent" value={t.emailsSent} hint={`${t.byAutopilot} by autopilot · ${t.followUpsPending} follow-ups pending`} />
          <Stat label="Replies" value={t.replies} hint={`${t.positiveReplies} positive`} />
          <Stat label="Deals · revenue" value={t.dealsWon} hint={`${usd(t.revenueCents)} contracted`} />
        </div>

        <div>
          <div className="mb-1 font-medium">Ready for an automatic first email ({data.readyBrands.length})</div>
          {data.readyBrands.length ? <p className="text-zinc-600 dark:text-zinc-400">{data.readyBrands.map((b) => `${b.company_name} (${b.email})`).join(' · ')}</p>
            : <p className="text-zinc-500">None. Brands need a qualifying email and a confirmed recipient country; autopilot starts research when it runs low.</p>}
        </div>

        <ul className="space-y-1.5">
          {data.readiness.map((c) => (
            <li key={c.label} className="flex gap-2">
              <span className={c.ok ? 'text-emerald-600' : 'text-rose-600'} aria-hidden>{c.ok ? '✓' : '✗'}</span>
              <span><span className="sr-only">{c.ok ? 'Done: ' : 'Missing: '}</span>{c.label}<span className="block text-xs text-zinc-500">{c.detail}</span></span>
            </li>
          ))}
        </ul>

        <div className="flex flex-wrap items-end gap-2">
          <Button disabled={busy} onClick={() => act(async () => setPlan(await api.post('/api/outreach/autopilot/dry-run', {})), 'Dry run finished; nothing was sent')}>Preview today (dry run)</Button>
          {data.enabled ? (
            <Button variant="danger" disabled={busy} onClick={() => act(() => api.post('/api/outreach/autopilot', { enable: false }), 'Autopilot switched off')}>Switch autopilot off</Button>
          ) : (
            <>
              <Field label={`Type ${data.phrase} to switch it on`} className="min-w-[14rem] flex-1">
                <Input value={phrase} onChange={(e) => setPhrase(e.target.value)} placeholder={data.phrase} disabled={!ready} />
              </Field>
              <Button variant="danger" disabled={!ready || phrase !== data.phrase || busy} onClick={() => act(() => api.post('/api/outreach/autopilot', { enable: true, phrase }), 'Autopilot switched on')}>Switch autopilot on</Button>
            </>
          )}
          {data.config.dryRun
            ? <Button disabled={busy} onClick={() => confirm('Leave dry-run mode? Autopilot will send real emails within its limits.') && act(() => api.post('/api/outreach/autopilot/mode', { dryRun: false, confirm: true }), 'Autopilot now sends for real')}>Leave dry-run mode</Button>
            : <Button disabled={busy} onClick={() => act(() => api.post('/api/outreach/autopilot/mode', { dryRun: true }), 'Dry-run mode on')}>Back to dry run</Button>}
        </div>
        {plan && <Notice title="Dry-run plan (nothing was sent)">{plan.actions.length ? plan.actions.join(' · ') : plan.note || 'Nothing to do right now.'}</Notice>}

        {data.reports.length > 0 && (
          <div>
            <div className="mb-1 font-medium">Reports</div>
            <ul className="space-y-1 text-zinc-600 dark:text-zinc-400">{data.reports.map((r) => <li key={r.kind + r.period_key}><Badge tone={r.kind === 'weekly' ? 'violet' : 'gray'}>{r.kind}</Badge> {r.text}</li>)}</ul>
          </div>
        )}
        <div>
          <div className="mb-1 font-medium">Activity</div>
          {data.events.length === 0 ? <p className="text-zinc-500">Nothing yet.</p> : (
            <ul className="max-h-72 space-y-1 overflow-auto">
              {data.events.map((e) => (
                <li key={e.id} className="flex gap-2"><span className="w-28 shrink-0 text-xs text-zinc-400">{dateTime(e.created_at)}</span><Badge tone={TONE[e.kind] ?? 'gray'}>{e.kind.replace('_', ' ')}</Badge><span className="text-zinc-600 dark:text-zinc-400">{e.detail}</span></li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Card>
  )
}
