// Outreach Controls: STOP ALL OUTREACH, the live-sending activation gate, daily safety ceilings and holidays.
// Autopilot (automatic sending) is not available; every email is sent by you, one at a time.
import { useState } from 'react'
import { Badge, Button, Card, ErrorBox, Field, Input, Loading, Notice, PageHeader, useToast } from '../components/ui'
import { api, useApi } from '../lib/api'
import { dateTime } from '../lib/format'

interface Controls {
  liveSendingEnabled: boolean
  emergencyStop: { active: boolean; at: string | null; reason: string | null }
  limits: { day: string; tier: string; newEmails: { sent: number; limit: number }; followUps: { sent: number; limit: number }; total: { sent: number; limit: number }; weekNew: { sent: number; limit: number } }
  checklist: { label: string; ok: boolean; detail: string }[]
  activationPhrase: string
}

export default function Autopilot() {
  const toast = useToast()
  const { data, error, reload } = useApi<Controls>('/api/outreach/controls')
  const settings = useApi<{ values: Record<string, unknown> }>('/api/settings')
  const [phrase, setPhrase] = useState('')
  const [busy, setBusy] = useState(false)
  if (error) return <ErrorBox error={error} />
  if (!data || !settings.data) return <Loading />
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true)
    try {
      await fn()
      toast(ok)
      reload()
      settings.reload()
    } catch (e) { toast((e as Error).message, 'error') } finally { setBusy(false) }
  }
  const stop = () => {
    const reason = prompt('STOP ALL OUTREACH: no email can be sent until you resume. Reason (optional):')
    if (reason === null) return
    act(() => api.post('/api/outreach/stop', { reason }), 'All outreach stopped')
  }
  const ready = data.checklist.every((c) => c.ok)
  return (
    <>
      <PageHeader title="Outreach Controls" subtitle="Manual send mode. Autopilot, scheduled sending and bulk sending are not available." />
      <div className="space-y-5">
        <Card title="Emergency stop" actions={data.emergencyStop.active ? <Badge tone="red">STOPPED</Badge> : <Badge tone="green">Not stopped</Badge>}>
          {data.emergencyStop.active ? (
            <div className="space-y-3">
              <Notice tone="red" title={`Stopped ${data.emergencyStop.at ? dateTime(data.emergencyStop.at) : ''}`}>{data.emergencyStop.reason}. No email can be sent. Drafts, follow-ups and research are untouched.</Notice>
              <Button disabled={busy} onClick={() => confirm('Resume outreach? Every email will still need its own confirmation.') && act(() => api.post('/api/outreach/resume', { confirm: true }), 'Outreach resumed')}>Resume outreach</Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="danger" className="px-6 py-3 text-base" disabled={busy} onClick={stop}>STOP ALL OUTREACH</Button>
              <p className="text-sm text-zinc-500">Blocks every send immediately (including emails you were about to confirm). Nothing is deleted.</p>
            </div>
          )}
        </Card>

        <Card title="Live sending" actions={data.liveSendingEnabled ? <Badge tone="amber">ON (manual)</Badge> : <Badge tone="gray">OFF</Badge>}>
          <div className="space-y-4 text-sm">
            <p>{data.liveSendingEnabled
              ? 'Live sending is on in manual mode: you can send one reviewed, confirmed email at a time from the Sending queue. Nothing is sent automatically.'
              : 'Live sending is off. You can still create Gmail drafts, review follow-ups and open send previews. Turning it on requires every item below and your typed confirmation.'}</p>
            <ul className="space-y-1.5">
              {data.checklist.map((c) => (
                <li key={c.label} className="flex gap-2">
                  <span className={c.ok ? 'text-emerald-600' : 'text-rose-600'} aria-hidden>{c.ok ? '✓' : '✗'}</span>
                  <span><span className="sr-only">{c.ok ? 'Done: ' : 'Missing: '}</span>{c.label}<span className="block text-xs text-zinc-500">{c.detail}</span></span>
                </li>
              ))}
              <li className="flex gap-2"><span aria-hidden>•</span><span>You review applicable commercial email rules (CAN-SPAM in the US; other countries stay in manual review).<span className="block text-xs text-zinc-500">Contacts with an unknown or non-US country are never eligible automatically.</span></span></li>
              <li className="flex gap-2"><span aria-hidden>•</span><span>Every first-contact email is reviewed by you in the send dialog.</span></li>
            </ul>
            {data.liveSendingEnabled ? (
              <Button disabled={busy} onClick={() => act(() => api.post('/api/outreach/live-sending', { enable: false }), 'Live sending switched off')}>Switch live sending off</Button>
            ) : (
              <div className="flex flex-wrap items-end gap-2">
                <Field label={`Type ${data.activationPhrase} to switch it on`} className="min-w-[16rem] flex-1">
                  <Input value={phrase} onChange={(e) => setPhrase(e.target.value)} placeholder={data.activationPhrase} disabled={!ready} />
                </Field>
                <Button variant="danger" disabled={!ready || phrase !== data.activationPhrase || busy}
                  onClick={() => confirm('Switch live sending on? Each email will still need your review and confirmation.') && act(() => api.post('/api/outreach/live-sending', { enable: true, phrase }), 'Live sending is on (manual mode)').then(() => setPhrase(''))}>Switch on</Button>
              </div>
            )}
          </div>
        </Card>

        <Limits data={data} values={settings.data.values} onSaved={() => { reload(); settings.reload() }} />
      </div>
    </>
  )
}

function Limits({ data, values, onSaved }: { data: Controls; values: Record<string, unknown>; onSaved: () => void }) {
  const toast = useToast()
  const cur = values['outreach.dailyLimits'] as { newPerDay: number; followUpsPerDay: number; totalPerDay: number }
  const [f, setF] = useState({ ...cur, holidays: ((values['outreach.holidays'] as string[]) ?? []).join(', ') })
  const hours = values['outreach.businessHours'] as { timezone: string; start: string; end: string; days: number[] }
  const save = async () => {
    try {
      await api.patch('/api/settings', {
        'outreach.dailyLimits': { newPerDay: Number(f.newPerDay), followUpsPerDay: Number(f.followUpsPerDay), totalPerDay: Number(f.totalPerDay) },
        'outreach.holidays': f.holidays.split(/[\s,]+/).filter(Boolean),
      })
      toast('Saved')
      onSaved()
    } catch (e) { toast((e as Error).message, 'error') }
  }
  const l = data.limits
  return (
    <Card title="Daily safety ceilings (not targets)">
      <div className="space-y-4 text-sm">
        <p>Today ({l.day}): {l.newEmails.sent}/{l.newEmails.limit} new emails · {l.followUps.sent}/{l.followUps.limit} follow-ups · {l.total.sent}/{l.total.limit} total · this week {l.weekNew.sent}/{l.weekNew.limit} new ({l.tier} tier). Counted from the send records on the server, so they survive restarts. Uncertain sends count. Unused capacity is never filled automatically.</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="New emails per day" hint={`Also capped by the ${l.tier} tier`}><Input type="number" min={0} max={50} value={f.newPerDay} onChange={(e) => setF({ ...f, newPerDay: Number(e.target.value) })} /></Field>
          <Field label="Follow-ups per day"><Input type="number" min={0} max={25} value={f.followUpsPerDay} onChange={(e) => setF({ ...f, followUpsPerDay: Number(e.target.value) })} /></Field>
          <Field label="All sponsorship emails per day"><Input type="number" min={0} max={75} value={f.totalPerDay} onChange={(e) => setF({ ...f, totalPerDay: Number(e.target.value) })} /></Field>
        </div>
        <Field label="Holidays skipped for follow-ups" hint={`Business days: ${hours.days.map((d) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]).join(', ')} in ${hours.timezone}, follow-ups due at ${hours.start} (change in Settings → Sending & compliance). Dates as YYYY-MM-DD.`}>
          <Input value={f.holidays} onChange={(e) => setF({ ...f, holidays: e.target.value })} placeholder="2026-11-26, 2026-12-25" />
        </Field>
        <Button variant="primary" onClick={save}>Save</Button>
      </div>
    </Card>
  )
}
