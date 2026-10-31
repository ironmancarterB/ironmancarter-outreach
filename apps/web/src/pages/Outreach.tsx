// Outreach: overview, sending queue, conversations, follow-ups, sent emails and the activity trail.
// Every number comes from stored records. Sending happens one email at a time through the review dialog.
import { useCallback, useState } from 'react'
import { Badge, Button, Card, Empty, ErrorBox, Input, Loading, Notice, PageHeader, Select, Stat, Tabs, Textarea, useToast } from '../components/ui'
import { SendDialog } from '../components/send'
import { api, useApi } from '../lib/api'
import { dateTime, relative } from '../lib/format'
import { navigate } from '../lib/router'

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'queue', label: 'Sending queue' },
  { id: 'conversations', label: 'Conversations' },
  { id: 'follow-ups', label: 'Follow-ups' },
  { id: 'sent', label: 'Sent' },
  { id: 'activity', label: 'Activity' },
] as const
type TabId = (typeof TABS)[number]['id']

type Check = { label: string; ok: boolean; detail: string }
interface OverviewData {
  approvedProspects: number; draftsAwaitingApproval: number; readyToSend: number; emailsSent: number; uncertainSends: number; repliesReceived: number
  needsReview: number; followUpsDue: number; interestedBrands: number; activeNegotiations: number; liveSendingEnabled: boolean
  emergencyStop: { active: boolean; at: string | null; reason: string | null }
  limits: { newEmails: { sent: number; limit: number }; followUps: { sent: number; limit: number }; total: { sent: number; limit: number } }
  lastSync: { status: string; started_at: string; messages_added: number; detail: string | null } | null
}
interface QueueItem {
  pitchId: number; prospectId: number; company: string; contact: string | null; subject: string | null; preview: string; approvedAt: string | null
  mediaKit: string; draftOpenUrl: string | null; checks: Check[]; readyForReview: boolean; followUpsIfSentNow: string[]
}
interface Conversation {
  id: number; prospect_id: number | null; company_name: string | null; subject: string | null; status: string; needs_review: number; review_reason: string | null
  last_message_at: string | null; origin: string; messages: number; inbound: number; latest: { classification: string | null; classification_source: string | null; kind: string } | null; openUrl: string | null
}
interface Message {
  id: number; direction: 'inbound' | 'outbound'; kind: string; from_email: string | null; to_email: string | null; subject: string | null; body_text: string | null; snippet: string | null
  classification: string | null; classification_source: string | null; classification_note: string | null; opt_out: number; needs_review: number; review_reason: string | null; message_at: string | null; created_at: string
}
interface FollowUp {
  id: number; prospect_id: number; company_name: string; recipient: string; sequence: number; due_at: string; status: string; subject: string; body: string; edited: number
  cancel_reason: string | null; group: 'upcoming' | 'overdue' | 'completed' | 'skipped' | 'cancelled'; problems: string[]
  draft: { id: number; status: string; verified: boolean; outOfDate: boolean } | null
}
interface SentRow { id: number; kind: string; origin: string; status: string; recipient: string; subject: string | null; sent_at: string | null; confirmed_at: string; error: string | null; reconcile_note: string | null; prospect_id: number | null; company_name: string | null }

export const CATEGORY_LABELS: Record<string, string> = {
  interested: 'Interested', needs_info: 'Needs more information', negotiating: 'Negotiating', not_interested: 'Not interested',
  out_of_office: 'Out of office', wrong_contact: 'Wrong contact', referral: 'Referral', unclear: 'Unclear',
}
const CATEGORY_TONE: Record<string, 'green' | 'blue' | 'amber' | 'red' | 'gray' | 'violet'> = {
  interested: 'green', needs_info: 'blue', negotiating: 'violet', not_interested: 'red', out_of_office: 'gray', wrong_contact: 'amber', referral: 'amber', unclear: 'amber',
}

export default function Outreach({ tab }: { tab?: string }) {
  const current = (TABS.find((t) => t.id === tab)?.id ?? 'overview') as TabId
  const toast = useToast()
  const [syncing, setSyncing] = useState(false)
  const [tick, setTick] = useState(0)
  const sync = async () => {
    setSyncing(true)
    try {
      const r = await api.post<{ threadsChecked: number; messagesAdded: number; replies: number; followUpsCancelled: number; errors: string[] }>('/api/outreach/sync')
      toast(`Checked ${r.threadsChecked} conversation(s): ${r.replies} new repl${r.replies === 1 ? 'y' : 'ies'}${r.followUpsCancelled ? `, ${r.followUpsCancelled} follow-up(s) cancelled` : ''}${r.errors.length ? `, ${r.errors.length} error(s)` : ''}`, r.errors.length ? 'error' : undefined)
      setTick((t) => t + 1)
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setSyncing(false)
    }
  }
  return (
    <>
      <PageHeader title="Outreach" subtitle="Manual send mode: every email needs your review and its own confirmation. Nothing is sent automatically."
        actions={<Button onClick={sync} disabled={syncing}>{syncing ? 'Checking Gmail…' : 'Check Gmail for replies'}</Button>} />
      <Tabs tabs={[...TABS]} value={current} onChange={(t) => navigate(`/outreach/${t}`)} />
      <div key={tick}>
        {current === 'overview' && <OverviewTab />}
        {current === 'queue' && <QueueTab />}
        {current === 'conversations' && <ConversationsTab />}
        {current === 'follow-ups' && <FollowUpsTab />}
        {current === 'sent' && <SentTab />}
        {current === 'activity' && <ActivityTab />}
      </div>
    </>
  )
}

function OverviewTab() {
  const { data, error } = useApi<OverviewData>('/api/outreach/overview')
  if (error) return <ErrorBox error={error} />
  if (!data) return <Loading />
  return (
    <div className="space-y-5">
      {data.emergencyStop.active
        ? <Notice tone="red" title="STOP ALL OUTREACH is active">{data.emergencyStop.reason}. No email can be sent. <a className="underline" href="#/autopilot">Outreach Controls</a></Notice>
        : !data.liveSendingEnabled && <Notice tone="blue" title="Live sending is off">You can prepare drafts, follow-ups and send previews. Sending is switched on separately in <a className="underline" href="#/autopilot">Outreach Controls</a> after you review it.</Notice>}
      {data.uncertainSends > 0 && <Notice tone="amber" title={`${data.uncertainSends} send${data.uncertainSends === 1 ? '' : 's'} with uncertain status`}>Open the <a className="underline" href="#/outreach/sent">Sent tab</a> and reconcile before doing anything else. Uncertain sends are never retried automatically.</Notice>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Approved prospects" value={data.approvedProspects} />
        <Stat label="Drafts awaiting approval" value={data.draftsAwaitingApproval} />
        <Stat label="Ready for manual sending" value={data.readyToSend} hint="All safeguards pass" />
        <Stat label="Emails sent" value={data.emailsSent} />
        <Stat label="Replies received" value={data.repliesReceived} hint={data.needsReview ? `${data.needsReview} conversation(s) need review` : undefined} tone={data.needsReview ? 'warn' : undefined} />
        <Stat label="Follow-ups due" value={data.followUpsDue} tone={data.followUpsDue ? 'warn' : undefined} />
        <Stat label="Interested brands" value={data.interestedBrands} tone={data.interestedBrands ? 'good' : undefined} />
        <Stat label="Active negotiations" value={data.activeNegotiations} />
      </div>
      <Card title="Today's safety ceilings (not targets)">
        <p className="text-sm">{data.limits.newEmails.sent} of {data.limits.newEmails.limit} new emails · {data.limits.followUps.sent} of {data.limits.followUps.limit} follow-ups · {data.limits.total.sent} of {data.limits.total.limit} total. Unused capacity is never filled automatically.</p>
        <p className="mt-2 text-xs text-zinc-500">Last Gmail check: {data.lastSync ? `${relative(data.lastSync.started_at)} (${data.lastSync.status}, ${data.lastSync.messages_added} new message${data.lastSync.messages_added === 1 ? '' : 's'})` : 'never'}.</p>
      </Card>
    </div>
  )
}

function CheckList({ checks }: { checks: Check[] }) {
  return (
    <ul className="flex flex-wrap gap-1.5">
      {checks.map((c) => <li key={c.label}><Badge tone={c.ok ? 'green' : 'amber'} title={c.detail}>{c.ok ? '✓' : '✗'} {c.label}</Badge></li>)}
    </ul>
  )
}

function QueueTab() {
  const { data, error, reload } = useApi<QueueItem[]>('/api/outreach/sending-queue')
  const fus = useApi<FollowUp[]>('/api/outreach/follow-ups')
  const [target, setTarget] = useState<{ pitchId: number } | { followUpId: number } | null>(null)
  const [title, setTitle] = useState('')
  if (error) return <ErrorBox error={error} />
  if (!data || !fus.data) return <Loading />
  const dueFollowUps = fus.data.filter((f) => f.status === 'approved' && f.group === 'overdue')
  return (
    <div className="space-y-5">
      <Notice>Approving a pitch or a follow-up is not permission to send. Each email is sent only when you open it here, review the exact message and confirm. There is no send-all.</Notice>
      {data.length === 0 && dueFollowUps.length === 0 ? <Empty title="Nothing waiting to be sent">Approve a pitch and create its Gmail draft (Email Drafts → Approved).</Empty> : null}
      {data.length > 0 && (
        <Card title="First emails" padded={false}>
          <ul>
            {data.map((q) => (
              <li key={q.pitchId} className="space-y-2 border-b border-zinc-100 px-5 py-4 last:border-0 dark:border-zinc-800">
                <div className="flex flex-wrap items-center gap-2">
                  <a className="font-medium hover:underline" href={`#/drafts/pitch/${q.pitchId}`}>{q.company}</a>
                  <span className="text-sm text-zinc-500">to {q.contact ?? 'no recipient'}</span>
                  <Badge tone="green">Approved{q.approvedAt ? ` ${relative(q.approvedAt)}` : ''}</Badge>
                  <Badge tone={q.mediaKit === 'verified' ? 'green' : 'amber'}>Media kit: {q.mediaKit}</Badge>
                  <div className="ml-auto flex gap-2">
                    {q.draftOpenUrl && <a className="text-xs text-brand-600 hover:underline" href={q.draftOpenUrl} target="_blank" rel="noreferrer noopener">Gmail draft ↗</a>}
                    <Button size="sm" variant={q.readyForReview ? 'primary' : 'secondary'} onClick={() => { setTitle(`Send first email to ${q.company}`); setTarget({ pitchId: q.pitchId }) }}>Review &amp; send…</Button>
                  </div>
                </div>
                <div className="text-sm font-medium">{q.subject}</div>
                <p className="line-clamp-2 text-sm text-zinc-600 dark:text-zinc-400">{q.preview}…</p>
                <CheckList checks={q.checks} />
                <p className="text-xs text-zinc-500">If sent today, follow-ups would come up for your review on {q.followUpsIfSentNow.map((d) => new Date(d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })).join(' and ')}.</p>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {dueFollowUps.length > 0 && (
        <Card title="Approved follow-ups that are due" padded={false}>
          <ul>
            {dueFollowUps.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center gap-2 border-b border-zinc-100 px-5 py-3 last:border-0 dark:border-zinc-800">
                <span className="font-medium">{f.company_name}</span><Badge>Follow-up {f.sequence}</Badge>
                <span className="text-sm text-zinc-500">to {f.recipient}</span>
                <Button className="ml-auto" size="sm" variant="primary" onClick={() => { setTitle(`Send follow-up ${f.sequence} to ${f.company_name}`); setTarget({ followUpId: f.id }) }}>Review &amp; send…</Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <SendDialog target={target} title={title} onClose={() => setTarget(null)} onSent={() => { reload(); fus.reload() }} />
    </div>
  )
}

function ConversationsTab() {
  const { data, error, reload } = useApi<Conversation[]>('/api/outreach/conversations')
  const [open, setOpen] = useState<number | null>(null)
  if (error) return <ErrorBox error={error} />
  if (!data) return <Loading />
  if (!data.length) return <Empty title="No conversations yet">Conversations appear after a first email is sent. Only sponsorship conversations are read; the rest of your mailbox is never imported.</Empty>
  return (
    <Card padded={false}>
      <ul>
        {data.map((c) => (
          <li key={c.id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800">
            <button className="flex w-full flex-wrap items-center gap-2 px-5 py-3 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/50" onClick={() => setOpen(open === c.id ? null : c.id)} aria-expanded={open === c.id}>
              <span className="font-medium">{c.company_name ?? 'Unknown company'}</span>
              <Badge tone={c.status === 'replied' ? 'green' : 'gray'}>{c.status.replace('_', ' ')}</Badge>
              {c.latest?.classification && <Badge tone={CATEGORY_TONE[c.latest.classification]}>{CATEGORY_LABELS[c.latest.classification]}{c.latest.classification_source === 'manual' ? ' (you)' : ''}</Badge>}
              {c.needs_review ? <Badge tone="amber">Needs review</Badge> : null}
              <span className="min-w-0 flex-1 truncate text-sm text-zinc-500">{c.subject}</span>
              <span className="text-xs text-zinc-500">{c.messages} message{c.messages === 1 ? '' : 's'} · {c.last_message_at ? relative(c.last_message_at) : ''}</span>
            </button>
            {open === c.id && <ConversationDetail c={c} onChange={reload} />}
          </li>
        ))}
      </ul>
    </Card>
  )
}

function ConversationDetail({ c, onChange }: { c: Conversation; onChange: () => void }) {
  const toast = useToast()
  const { data, reload } = useApi<Message[]>(`/api/outreach/conversations/${c.id}`)
  const reviewed = async () => {
    try {
      await api.post(`/api/outreach/conversations/${c.id}/reviewed`)
      toast('Marked as reviewed')
      onChange()
    } catch (e) { toast((e as Error).message, 'error') }
  }
  return (
    <div className="space-y-3 bg-zinc-50/60 px-5 py-4 dark:bg-zinc-900/40">
      {c.needs_review ? <Notice tone="amber" title="Check this conversation">{c.review_reason} <button className="ml-1 underline" onClick={reviewed}>It's correct, mark reviewed</button></Notice> : null}
      <div className="flex flex-wrap gap-3 text-xs">
        {c.prospect_id && <a className="text-brand-600 hover:underline" href={`#/prospects/${c.prospect_id}`}>Company record</a>}
        {c.openUrl && <a className="text-brand-600 hover:underline" href={c.openUrl} target="_blank" rel="noreferrer noopener">Open in Gmail ↗</a>}
      </div>
      {!data ? <Loading /> : <MessageList messages={data} onChange={() => { reload(); onChange() }} />}
      <p className="text-xs text-zinc-500">The app never replies for you, accepts offers or negotiates. Reply from Gmail yourself.</p>
    </div>
  )
}

export function MessageList({ messages, onChange }: { messages: Message[]; onChange: () => void }) {
  const toast = useToast()
  const classify = async (id: number, classification: string) => {
    try {
      await api.patch(`/api/outreach/messages/${id}`, { classification })
      toast('Classification saved')
      onChange()
    } catch (e) { toast((e as Error).message, 'error') }
  }
  if (!messages.length) return <p className="text-sm text-zinc-500">No messages yet.</p>
  return (
    <ol className="space-y-3">
      {messages.map((m) => (
        <li key={m.id} className={`rounded-lg border p-3 text-sm ${m.direction === 'inbound' ? 'border-brand-200 bg-white dark:border-brand-500/30 dark:bg-zinc-900' : 'border-zinc-200 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800/50'}`}>
          <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
            <Badge tone={m.direction === 'inbound' ? 'blue' : 'gray'}>{m.direction === 'inbound' ? (m.kind === 'reply' ? 'Reply' : m.kind === 'auto_reply' ? 'Automatic reply' : 'Delivery failure') : m.kind === 'follow_up' ? 'Your follow-up' : 'You'}</Badge>
            <span className="break-all">{m.from_email}</span><span>· {m.message_at ? dateTime(m.message_at) : ''}</span>
            {m.opt_out ? <Badge tone="red">Opted out</Badge> : null}
          </div>
          {m.direction === 'inbound' && <p className="mt-2 whitespace-pre-wrap">{m.body_text || m.snippet || '(no text)'}</p>}
          {m.direction === 'outbound' && <p className="mt-1 text-zinc-600 dark:text-zinc-400">{m.subject}</p>}
          {m.direction === 'inbound' && m.kind !== 'bounce' && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Select className="w-auto" value={m.classification ?? 'unclear'} onChange={(e) => classify(m.id, e.target.value)} aria-label="Classification">
                {Object.entries(CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
              <span className="text-xs text-zinc-500">{m.classification_source === 'manual' ? 'Set by you' : m.classification_source === 'ollama' ? 'Local AI' : 'Rules'}{m.classification_note ? `: ${m.classification_note}` : ''}</span>
            </div>
          )}
          {m.needs_review && m.review_reason ? <p className="mt-1 text-xs text-amber-600">{m.review_reason}</p> : null}
        </li>
      ))}
    </ol>
  )
}

const GROUPS: { id: FollowUp['group']; title: string }[] = [
  { id: 'overdue', title: 'Due now' }, { id: 'upcoming', title: 'Upcoming' }, { id: 'completed', title: 'Sent' }, { id: 'skipped', title: 'Skipped' }, { id: 'cancelled', title: 'Cancelled' },
]

function FollowUpsTab() {
  const { data, error, reload } = useApi<FollowUp[]>('/api/outreach/follow-ups')
  const [target, setTarget] = useState<{ followUpId: number } | null>(null)
  const [title, setTitle] = useState('')
  if (error) return <ErrorBox error={error} />
  if (!data) return <Loading />
  if (!data.length) return <Empty title="No follow-ups">After a first email is sent, two follow-ups are scheduled (5 and 12 business days later) for your review. They are never sent automatically and stop when the brand replies.</Empty>
  return (
    <div className="space-y-5">
      {GROUPS.map((g) => {
        const items = data.filter((f) => f.group === g.id)
        if (!items.length) return null
        return (
          <Card key={g.id} title={`${g.title} (${items.length})`} padded={false}>
            <ul>{items.map((f) => <FollowUpItem key={f.id} f={f} onChange={reload} onSend={() => { setTitle(`Send follow-up ${f.sequence} to ${f.company_name}`); setTarget({ followUpId: f.id }) }} />)}</ul>
          </Card>
        )
      })}
      <SendDialog target={target} title={title} onClose={() => setTarget(null)} onSent={reload} />
    </div>
  )
}

function FollowUpItem({ f, onChange, onSend }: { f: FollowUp; onChange: () => void; onSend: () => void }) {
  const toast = useToast()
  const [editing, setEditing] = useState(false)
  const [body, setBody] = useState(f.body)
  const [when, setWhen] = useState(f.due_at.slice(0, 16))
  const [busy, setBusy] = useState(false)
  const pending = f.status === 'scheduled' || f.status === 'approved'
  const act = useCallback(async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true)
    try {
      await fn()
      toast(ok)
      onChange()
    } catch (e) { toast((e as Error).message, 'error') } finally { setBusy(false) }
  }, [onChange, toast])
  const base = `/api/outreach/follow-ups/${f.id}`
  return (
    <li className="space-y-2 border-b border-zinc-100 px-5 py-4 last:border-0 dark:border-zinc-800">
      <div className="flex flex-wrap items-center gap-2">
        <a className="font-medium hover:underline" href={`#/prospects/${f.prospect_id}`}>{f.company_name}</a>
        <Badge>Follow-up {f.sequence}</Badge>
        <Badge tone={f.status === 'approved' ? 'green' : f.status === 'cancelled' ? 'red' : 'gray'}>{f.status}</Badge>
        {f.draft && <Badge tone={f.draft.outOfDate ? 'amber' : 'blue'}>Gmail draft: {f.draft.status}{f.draft.outOfDate ? ' (out of date)' : ''}</Badge>}
        <span className="ml-auto text-xs text-zinc-500">{pending ? `Due ${dateTime(f.due_at)}` : ''} · to {f.recipient}</span>
      </div>
      {f.cancel_reason && <p className="text-xs text-rose-600">{f.cancel_reason}</p>}
      {editing ? (
        <div className="space-y-2">
          <Textarea className="min-h-40" value={body} onChange={(e) => setBody(e.target.value)} />
          <div className="flex gap-2">
            <Button size="sm" variant="primary" disabled={busy} onClick={() => act(() => api.patch(base, { body }), 'Saved; approve it again when ready').then(() => setEditing(false))}>Save</Button>
            <Button size="sm" onClick={() => { setBody(f.body); setEditing(false) }}>Cancel</Button>
          </div>
        </div>
      ) : (
        <pre className="whitespace-pre-wrap rounded-lg bg-zinc-50 p-3 font-sans text-sm dark:bg-zinc-800/50">{f.body}</pre>
      )}
      {pending && f.problems.length > 0 && <ul className="text-xs text-amber-600">{f.problems.map((p) => <li key={p}>✗ {p}</li>)}</ul>}
      {pending && !editing && (
        <div className="flex flex-wrap items-center gap-2">
          {f.status === 'scheduled' && <Button size="sm" variant="primary" disabled={busy || f.problems.length > 0} onClick={() => act(() => api.post(`${base}/approve`), 'Approved. Approval is not permission to send.')}>Approve</Button>}
          {f.status === 'approved' && !f.draft?.status.match(/created|uncertain/) && <Button size="sm" variant="primary" disabled={busy} onClick={() => confirm('Create this follow-up as a reply draft in the Gmail conversation? Nothing is sent.') && act(() => api.post(`${base}/gmail-draft`, { confirm: true }), 'Gmail draft created. Nothing was sent.')}>Create Gmail draft</Button>}
          {f.status === 'approved' && f.draft?.status === 'created' && f.draft.outOfDate && <Button size="sm" disabled={busy} onClick={() => act(() => api.put(`${base}/gmail-draft`, { confirm: true }), 'Gmail draft updated')}>Update Gmail draft</Button>}
          {f.status === 'approved' && f.draft?.status === 'created' && <Button size="sm" variant={f.group === 'overdue' ? 'primary' : 'secondary'} onClick={onSend}>Review &amp; send…</Button>}
          <Button size="sm" disabled={busy} onClick={() => setEditing(true)}>Edit</Button>
          <span className="flex items-center gap-1">
            <Input type="datetime-local" className="w-auto" value={when} onChange={(e) => setWhen(e.target.value)} aria-label="New due date" />
            <Button size="sm" disabled={busy} onClick={() => act(() => api.post(`${base}/reschedule`, { dueAt: new Date(when).toISOString() }), 'Rescheduled')}>Reschedule</Button>
          </span>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(() => api.post(`${base}/skip`), 'Skipped')}>Skip</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => { const reason = prompt('Why cancel this follow-up? (optional)'); if (reason !== null) act(() => api.post(`${base}/cancel`, { reason }), 'Cancelled') }}>Cancel follow-up</Button>
        </div>
      )}
    </li>
  )
}

function SentTab() {
  const toast = useToast()
  const { data, error, reload } = useApi<SentRow[]>('/api/outreach/sent')
  if (error) return <ErrorBox error={error} />
  if (!data) return <Loading />
  if (!data.length) return <Empty title="No emails sent">0 emails have been sent.</Empty>
  const reconcile = async (id: number) => {
    try {
      const r = await api.post<SentRow>(`/api/outreach/sends/${id}/reconcile`)
      toast(r.status === 'uncertain' ? 'Still uncertain: check Gmail yourself' : `Reconciled: ${r.status.replace('_', ' ')}`, r.status === 'uncertain' ? 'error' : undefined)
      reload()
    } catch (e) { toast((e as Error).message, 'error') }
  }
  const resolve = async (id: number, outcome: 'sent' | 'not_sent') => {
    if (!confirm(outcome === 'sent' ? 'Record that you found this email in Gmail Sent Mail?' : 'Record that this email was NOT sent? Only do this after checking Gmail Sent Mail yourself.')) return
    try {
      await api.post(`/api/outreach/sends/${id}/resolve`, { confirm: true, outcome })
      reload()
    } catch (e) { toast((e as Error).message, 'error') }
  }
  return (
    <Card padded={false}>
      <ul>
        {data.map((s) => (
          <li key={s.id} className="space-y-1 border-b border-zinc-100 px-5 py-3 text-sm last:border-0 dark:border-zinc-800">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{s.company_name ?? s.recipient}</span>
              <Badge tone={s.status === 'sent' ? 'green' : s.status === 'uncertain' ? 'amber' : s.status === 'sending' ? 'blue' : 'red'}>{s.status === 'uncertain' ? 'SEND STATUS UNCERTAIN' : s.status.replace('_', ' ')}</Badge>
              <Badge tone="gray">{s.kind === 'initial' ? 'First email' : 'Follow-up'}{s.origin === 'gmail' ? ' · sent by you in Gmail' : ''}</Badge>
              <span className="ml-auto text-xs text-zinc-500">{dateTime(s.sent_at ?? s.confirmed_at)}</span>
            </div>
            <div className="truncate text-zinc-600 dark:text-zinc-400">To {s.recipient} · {s.subject}</div>
            {s.error && <div className="text-xs text-rose-600">{s.error}</div>}
            {s.reconcile_note && <div className="text-xs text-zinc-500">{s.reconcile_note}</div>}
            {s.status === 'uncertain' && (
              <div className="flex flex-wrap gap-2 pt-1">
                <Button size="sm" variant="primary" onClick={() => reconcile(s.id)}>Reconcile with Gmail</Button>
                {s.reconcile_note && <><Button size="sm" onClick={() => resolve(s.id, 'sent')}>I found it in Sent</Button><Button size="sm" onClick={() => resolve(s.id, 'not_sent')}>It was not sent</Button></>}
              </div>
            )}
          </li>
        ))}
      </ul>
    </Card>
  )
}

function ActivityTab() {
  const { data, error } = useApi<{ id: number; prospect_id: number | null; type: string; summary: string; created_at: string; company_name: string | null }[]>('/api/outreach/activity')
  if (error) return <ErrorBox error={error} />
  if (!data) return <Loading />
  if (!data.length) return <Empty title="No outreach activity yet" />
  return (
    <Card padded={false}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <tbody>
            {data.map((a) => (
              <tr key={a.id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800">
                <td className="whitespace-nowrap px-4 py-2 text-xs text-zinc-400">{dateTime(a.created_at)}</td>
                <td className="px-4 py-2"><code className="text-xs text-zinc-500">{a.type}</code></td>
                <td className="min-w-[16rem] px-4 py-2">{a.company_name && a.prospect_id ? <a className="font-medium hover:underline" href={`#/prospects/${a.prospect_id}`}>{a.company_name}: </a> : null}{a.summary}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}
