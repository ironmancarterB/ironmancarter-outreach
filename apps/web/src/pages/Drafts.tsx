import { useState } from 'react'
import { Badge, Button, Card, Empty, ErrorBox, Input, Loading, Notice, PageHeader, Select, Tabs, TierBadge, useToast } from '../components/ui'
import { api, useApi } from '../lib/api'
import { relative } from '../lib/format'
import { navigate } from '../lib/router'
import { GmailStatusBadge } from '../components/gmail'
import type { Application, OutreachQueue, PitchSummary, PitchView, ProgramType } from '../lib/types'

const TABS = [
  { id: 'ready', label: 'Ready to draft' },
  { id: 'drafts', label: 'Needs approval' },
  { id: 'approved', label: 'Approved' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'manual', label: 'Manual submissions' },
] as const
type TabId = (typeof TABS)[number]['id']

export const PROGRAM_TONE: Record<ProgramType, 'green' | 'blue' | 'amber' | 'gray'> = {
  paid_sponsorship: 'green', creator_partnerships: 'blue', affiliate_only: 'amber', unknown: 'gray',
}

export default function Drafts({ tab }: { tab?: string }) {
  const current = (TABS.find((t) => t.id === tab)?.id ?? 'ready') as TabId
  const { data, error, reload } = useApi<OutreachQueue>('/api/outreach/queue')
  const apps = useApi<Application[]>('/api/applications')
  const counts: Record<TabId, number | undefined> = {
    ready: data?.ready.length, drafts: data?.drafts.length, approved: data?.approved.length, rejected: data?.rejected.length, manual: apps.data?.length,
  }
  return (
    <>
      <PageHeader title="Email Drafts" subtitle="Personalized pitches built from verified research. Draft mode only: nothing here can be sent." />
      <div className="mb-5">
        <Notice tone="green" title="Approval is not permission to send">
          Approved email pitches become Gmail drafts (open a pitch → Gmail draft). Each email is sent only from Outreach → Sending queue, one at a time,
          after you review and confirm it. Manual submissions are always made by you on the brand's own site.
        </Notice>
      </div>
      <Tabs tabs={TABS.map((t) => ({ ...t, label: counts[t.id] != null ? `${t.label} (${counts[t.id]})` : t.label }))} value={current} onChange={(t) => navigate(`/drafts/${t}`)} />
      {error ? <ErrorBox error={error} /> : !data ? <Loading /> : (
        <>
          {current === 'ready' && <Ready data={data} onChange={reload} />}
          {current === 'drafts' && <PitchList items={data.drafts} empty="No drafts waiting. Draft one from “Ready to draft”." />}
          {current === 'approved' && <PitchList items={data.approved} empty="Nothing approved yet." showGmail />}
          {current === 'rejected' && <PitchList items={data.rejected} empty="Nothing rejected." />}
          {current === 'manual' && <ManualSubmissions apps={apps.data} onChange={() => { apps.reload(); reload() }} />}
        </>
      )}
    </>
  )
}

function Ready({ data, onChange }: { data: OutreachQueue; onChange: () => void }) {
  const toast = useToast()
  const [busy, setBusy] = useState<number | null>(null)
  const draft = async (id: number, channel: 'email' | 'manual_form') => {
    setBusy(id)
    try {
      const v = await api.post<PitchView>(`/api/prospects/${id}/pitches`, { channel })
      toast(v.pitch.generator === 'ollama' ? 'Drafted with local AI' : 'Drafted from the template')
      onChange()
      navigate(`/drafts/pitch/${v.pitch.id}`)
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="space-y-4">
      {data.pendingReview > 0 && (
        <Notice tone="amber">
          {data.pendingReview} researched {data.pendingReview === 1 ? 'company is' : 'companies are'} still awaiting your review. Only approved companies can be drafted.{' '}
          <a className="underline" href="#/discovery/review">Open the review queue</a>
        </Notice>
      )}
      {data.ready.length === 0 ? (
        <Empty title="No approved companies without a pitch">Approve companies in Brand Discovery → Review queue, then draft their pitches here.</Empty>
      ) : (
        <Card padded={false} title="Best first: demonstrated creator partnerships, then fit and contact quality">
          <ul>
            {data.ready.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-3 border-b border-zinc-100 px-5 py-3 last:border-0 dark:border-zinc-800">
                <div className="min-w-[16rem] flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <a className="font-medium hover:underline" href={`#/prospects/${p.id}`}>{p.company_name}</a>
                    <TierBadge tier={p.fit_score == null ? null : p.fit_score >= 80 ? 'A' : p.fit_score >= 60 ? 'B' : 'C'} score={p.fit_score} />
                    <Badge tone={PROGRAM_TONE[p.programType]}>{p.programLabel}</Badge>
                  </div>
                  <div className="mt-0.5 text-xs text-zinc-500">
                    {p.category_name} · {p.evidenceCount} evidence source{p.evidenceCount === 1 ? '' : 's'} · {p.hasVerifiedEmail ? 'verified email' : p.suggestedChannel === 'manual_form' ? 'creator portal / form' : 'no verified email'}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant={p.suggestedChannel === 'email' ? 'primary' : 'secondary'} disabled={busy !== null} onClick={() => draft(p.id, 'email')}>
                    {busy === p.id ? 'Drafting…' : 'Draft email'}
                  </Button>
                  <Button size="sm" variant={p.suggestedChannel === 'manual_form' ? 'primary' : 'secondary'} disabled={busy !== null} onClick={() => draft(p.id, 'manual_form')}>Draft manual message</Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}

function PitchList({ items, empty, showGmail }: { items: PitchSummary[]; empty: string; showGmail?: boolean }) {
  if (!items.length) return <Empty title={empty} />
  return (
    <Card padded={false}>
      <ul>
        {items.map((p) => (
          <li key={p.id}>
            <a href={`#/drafts/pitch/${p.id}`} className="flex flex-wrap items-center gap-3 border-b border-zinc-100 px-5 py-3 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800/50">
              <div className="min-w-[16rem] flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{p.company_name}</span>
                  <Badge>{p.channel === 'email' ? 'Email' : 'Manual submission'}</Badge>
                  <Badge tone="gray">v{p.version} · {p.generator === 'ollama' ? 'local AI' : 'template'}{p.edited ? ' · edited' : ''}</Badge>
                </div>
                <div className="mt-0.5 truncate text-sm text-zinc-600 dark:text-zinc-400">{p.subject}</div>
                <div className="text-xs text-zinc-500">{p.channel === 'email' ? `To ${p.recipient_email ?? 'no recipient'}` : p.application_url} · {p.wordCount} words · {relative(p.updated_at)}</div>
                {p.reject_reason && <div className="text-xs text-rose-600">Rejected: {p.reject_reason}</div>}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {showGmail && p.channel === 'email' && <GmailStatusBadge draft={p.gmail} />}
                {p.blockers > 0 && <Badge tone="red">{p.blockers} to fix</Badge>}
                {p.warnings > 0 && <Badge tone="amber">{p.warnings} warning{p.warnings === 1 ? '' : 's'}</Badge>}
                {p.blockers === 0 && p.warnings === 0 && <Badge tone="green">Checks pass</Badge>}
              </div>
            </a>
          </li>
        ))}
      </ul>
    </Card>
  )
}

const APP_STATUSES = ['not_started', 'ready', 'submitted', 'responded', 'accepted', 'declined', 'no_response']

function ManualSubmissions({ apps, onChange }: { apps: Application[] | null; onChange: () => void }) {
  const toast = useToast()
  if (!apps) return <Loading />
  const save = async (a: Application, patch: Record<string, unknown>) => {
    try {
      await api.put(`/api/prospects/${a.prospect_id}/application`, patch)
      onChange()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }
  const submitted = async (a: Application) => {
    if (!confirm(`Record that you submitted the ${a.company_name} application yourself? This sets a follow-up reminder for one week.`)) return
    try {
      await api.post(`/api/prospects/${a.prospect_id}/application/submitted`, {})
      toast('Recorded as submitted by you')
      onChange()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }
  const copy = async (a: Application) => {
    try {
      const outreach = await api.get<{ pitches: { id: number; channel: string; status: string }[] }>(`/api/prospects/${a.prospect_id}/outreach`)
      const live = outreach.pitches.find((p) => p.channel === 'manual_form' && p.status === 'approved') ?? outreach.pitches.find((p) => p.channel === 'manual_form' && p.status === 'draft')
      if (!live) return toast('No manual message drafted yet', 'error')
      const v = await api.get<PitchView>(`/api/pitches/${live.id}`)
      await navigator.clipboard.writeText(v.pitch.body)
      toast(live.status === 'approved' ? 'Approved message copied' : 'Draft copied (not approved yet)')
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }
  if (!apps.length) return <Empty title="No manual submissions">Draft a manual message for a brand that uses a creator portal or contact form.</Empty>
  return (
    <div className="space-y-4">
      <Notice>Open the brand's page, paste your approved message and submit it yourself. The app never fills in or submits forms, and never gets around CAPTCHAs or logins.</Notice>
      <Card padded={false}>
        <ul>
          {apps.map((a) => (
            <li key={a.id} className="space-y-2 border-b border-zinc-100 px-5 py-4 last:border-0 dark:border-zinc-800">
              <div className="flex flex-wrap items-center gap-2">
                <a className="font-medium hover:underline" href={`#/prospects/${a.prospect_id}`}>{a.company_name}</a>
                <Badge tone={a.url_origin === 'research' ? 'green' : 'amber'}>{a.url_origin === 'research' ? `Verified by research${a.url_retrieved_at ? ` ${relative(a.url_retrieved_at)}` : ''}` : 'Added by you (not fetched)'}</Badge>
                {a.submitted_at && <Badge tone="blue">Submitted {relative(a.submitted_at)}</Badge>}
              </div>
              <a className="block break-all text-sm text-brand-600 hover:underline" href={a.application_url} target="_blank" rel="noreferrer noopener">{a.application_url} ↗</a>
              <div className="flex flex-wrap items-center gap-2">
                <Select className="w-auto" value={a.status} onChange={(e) => save(a, { status: e.target.value })} aria-label="Application status">
                  {APP_STATUSES.map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
                </Select>
                <label className="flex items-center gap-1.5 text-sm text-zinc-500">Follow up
                  <Input type="date" className="w-auto" value={a.follow_up_date ?? ''} onChange={(e) => save(a, { follow_up_date: e.target.value || null })} />
                </label>
                <Button size="sm" onClick={() => copy(a)}>Copy message</Button>
                {a.status !== 'submitted' && <Button size="sm" variant="primary" onClick={() => submitted(a)}>I submitted it</Button>}
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}
