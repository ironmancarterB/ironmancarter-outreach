// UGC client acquisition: research, drafts for your review, the UGC pipeline, deals, templates and settings.
// Nothing on this page sends email. UGC emails go out only from Outreach after you approve each one.
import { useCallback, useEffect, useState } from 'react'
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, Modal, Notice, PageHeader, Select, Stat, Tabs, Textarea, useToast } from '../components/ui'
import { api, useApi, usePoll } from '../lib/api'
import { dateTime, num, usd } from '../lib/format'

type Tab = 'overview' | 'autopilot' | 'pipeline' | 'deals' | 'templates' | 'settings'

interface Overview {
  totals: Record<'prospects' | 'verifiedContacts' | 'draftsAwaitingApproval' | 'emailsSent' | 'replies' | 'interested' | 'negotiating' | 'booked' | 'recurringClients' | 'revenueBookedCents' | 'revenueCollectedCents', number>
  sponsorship: { revenueBookedCents: number; revenueCollectedCents: number }
  stages: { id: string; label: string; count: number }[]
  portfolio: { url: string | null; usable: boolean; reason: string | null; check: { detail: string | null; checkedAt: string | null } }
  research: { dailyTarget: number; autoDaily: boolean; minScore: number; autoDraft: boolean; poolAvailable: number }
  lastDaily: { day: string; note: string } | null
  costs: { estimatedUsd: number; alertUsd: number; flags: string[]; lines: { item: string; detail: string; usd: number }[] }
}
interface Metrics {
  discovered: number; sendingErrors: number; interestedNew: number
  period: string; researched: number; qualified: number; verifiedContacts: number; pitchesDrafted: number; gmailDrafts: number; approved: number
  sent: number; followUpsSent: number; failures: number; replies: number; positive: number; meetings: number; closed: number
  revenueBookedCents: number; revenueCollectedCents: number; conversion: Record<string, number | null>
}
interface Research { batches: { id: number; requested_size: number; status: string; qualified: number; researched: number; total: number; origin: string; created_at: string; shortfall_note: string | null }[]; readyToDraft: number; categories: { id: number; name: string; available: number }[] }
interface PipelineRow { id: number; company_name: string; domain: string | null; category_name: string | null; fit_score: number | null; stage: string; stage_label: string; email: string | null; pitch_id: number | null; pitch_status: string | null; gmail_draft: boolean; sent_at: string | null; next_follow_up_at: string | null; booked_cents: number; exclusion: string | null }
interface Deal { id: number; prospect_id: number; company_name: string; title: string; status: string; video_count: number | null; quoted_cents: number | null; negotiated_cents: number | null; usage_rights: string; usage_fee_cents: number | null; paid_ads_duration: string | null; raw_footage: string; exclusivity: string | null; revisions: number | null; deadline: string | null; contract_status: string; payment_status: string; amount_paid_cents: number; recurring: number; meeting_at: string | null; deliverables: string | null; notes: string | null; value_cents: number | null; warnings: string[] }
interface Template { slug: string; kind: string; name: string; subject: string | null; body: string }

const pct = (v: number | null) => (v == null ? '—' : `${v}%`)

export default function Ugc({ tab }: { tab?: string }) {
  const fromRoute = (['overview', 'autopilot', 'pipeline', 'deals', 'templates', 'settings'] as Tab[]).find((x) => x === tab) ?? 'overview'
  const [t, setT] = useState<Tab>(fromRoute)
  useEffect(() => setT(fromRoute), [fromRoute])
  const go = (v: Tab) => { setT(v); location.hash = `#/ugc/${v}` }
  return (
    <>
      <PageHeader title="UGC Clients" subtitle="Find companies that pay for creator-made videos. Research runs every business day; UGC autopilot sends within its limits once switched on, and interested brands wait here for you." />
      <Tabs value={t} onChange={go} tabs={[{ id: 'overview', label: 'Overview' }, { id: 'autopilot', label: 'Autopilot' }, { id: 'pipeline', label: 'Pipeline' }, { id: 'deals', label: 'Deals' }, { id: 'templates', label: 'Templates' }, { id: 'settings', label: 'Settings' }]} />
      <div className="mt-6">
        {t === 'overview' && <OverviewTab />}
        {t === 'autopilot' && <AutopilotTab />}
        {t === 'pipeline' && <PipelineTab />}
        {t === 'deals' && <DealsTab />}
        {t === 'templates' && <TemplatesTab />}
        {t === 'settings' && <SettingsTab />}
      </div>
    </>
  )
}

function OverviewTab() {
  const ov = useApi<Overview>('/api/ugc/overview')
  const [period, setPeriod] = useState<'day' | 'week' | 'month'>('day')
  const m = useApi<Metrics>(`/api/ugc/metrics?period=${period}`)
  const rs = useApi<Research>('/api/ugc/research')
  const running = !!rs.data?.batches.some((b) => ['queued', 'running'].includes(b.status))
  const refresh = useCallback(() => { rs.reload(); ov.reload(); m.reload() }, [rs, ov, m])
  usePoll(refresh, 5000, running)
  if (ov.error) return <ErrorBox error={ov.error} />
  if (!ov.data) return <Loading />
  const o = ov.data
  return (
    <div className="space-y-6">
      <PortfolioCard p={o.portfolio} onChange={ov.reload} />
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="New prospects" value={num(o.totals.prospects)} />
        <Stat label="Verified contacts" value={num(o.totals.verifiedContacts)} />
        <Stat label="Drafts awaiting approval" value={num(o.totals.draftsAwaitingApproval)} tone={o.totals.draftsAwaitingApproval ? 'warn' : 'muted'} />
        <Stat label="Emails sent" value={num(o.totals.emailsSent)} />
        <Stat label="Replies" value={num(o.totals.replies)} />
        <Stat label="Interested" value={num(o.totals.interested)} tone={o.totals.interested ? 'good' : 'muted'} />
        <Stat label="Negotiating" value={num(o.totals.negotiating)} />
        <Stat label="Booked projects" value={num(o.totals.booked)} />
        <Stat label="Recurring clients" value={num(o.totals.recurringClients)} />
        <Stat label="UGC revenue booked" value={usd(o.totals.revenueBookedCents)} hint="Booked projects with an agreed price" />
        <Stat label="UGC revenue collected" value={usd(o.totals.revenueCollectedCents)} hint="Payments you recorded" />
        <Stat label="Sponsorship revenue" value={usd(o.sponsorship.revenueBookedCents)} hint={`${usd(o.sponsorship.revenueCollectedCents)} collected (separate)`} tone="muted" />
      </div>

      <ResearchCard o={o} rs={rs.data} onDone={refresh} />

      <Card title="Performance" actions={
        <Select value={period} onChange={(e) => setPeriod(e.target.value as typeof period)} aria-label="Period">
          <option value="day">Today</option><option value="week">This week</option><option value="month">This month</option>
        </Select>}>
        {!m.data ? <Loading /> : (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-4 lg:grid-cols-7">
              <Stat label="Companies discovered" value={m.data.discovered} hint="New candidates from Wikidata" />
              <Stat label="Researched" value={m.data.researched} />
              <Stat label="Qualified" value={m.data.qualified} hint={`${pct(m.data.conversion.qualifiedOfResearched)} of researched`} />
              <Stat label="Verified contacts" value={m.data.verifiedContacts} />
              <Stat label="Pitches drafted" value={m.data.pitchesDrafted} />
              <Stat label="Gmail drafts" value={m.data.gmailDrafts} />
              <Stat label="Approved" value={m.data.approved} hint={`${pct(m.data.conversion.approvedOfDrafted)} of drafted`} />
              <Stat label="Sent" value={m.data.sent} hint={`${m.data.followUpsSent} follow-up(s) counted separately`} />
              <Stat label="Delivery failures" value={m.data.failures} tone={m.data.failures ? 'bad' : 'muted'} />
              <Stat label="Replies" value={m.data.replies} hint={`${pct(m.data.conversion.repliesOfSent)} of sent`} />
              <Stat label="Positive replies" value={m.data.positive} hint={`${pct(m.data.conversion.positiveOfReplies)} of replies`} />
              <Stat label="Interested brands" value={m.data.interestedNew} tone={m.data.interestedNew ? 'good' : 'muted'} />
              <Stat label="Sending errors" value={m.data.sendingErrors} tone={m.data.sendingErrors ? 'bad' : 'muted'} />
              <Stat label="Meetings booked" value={m.data.meetings} />
              <Stat label="Projects closed" value={m.data.closed} hint={`${pct(m.data.conversion.closedOfPositive)} of positive`} />
              <Stat label="Revenue booked" value={usd(m.data.revenueBookedCents)} />
              <Stat label="Revenue collected" value={usd(m.data.revenueCollectedCents)} />
            </div>
          </div>
        )}
      </Card>

      <Card title="Operating cost today" actions={<span className="text-sm font-semibold">${o.costs.estimatedUsd.toFixed(2)}</span>}>
        {o.costs.flags.map((f) => <Notice key={f} tone="amber">{f}</Notice>)}
        <ul className="divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
          {o.costs.lines.map((l) => <li key={l.item} className="flex justify-between gap-4 py-2"><span><span className="font-medium">{l.item}</span> <span className="text-zinc-500">· {l.detail}</span></span><span className="tabular-nums">${l.usd.toFixed(2)}</span></li>)}
        </ul>
        <p className="mt-2 text-xs text-zinc-500">Alert above ${o.costs.alertUsd}/day (UGC → Settings). Paid AI and paid verification services are off.</p>
      </Card>
    </div>
  )
}

function PortfolioCard({ p, onChange }: { p: Overview['portfolio']; onChange: () => void }) {
  const toast = useToast()
  const [url, setUrl] = useState(p.url ?? '')
  const [busy, setBusy] = useState(false)
  const save = async (path: string, body?: object) => {
    setBusy(true)
    try {
      const r = await api.post<{ usable: boolean; reason: string | null }>(path, body)
      toast(r.usable ? 'Portfolio link is live and will be used in UGC emails' : `Not usable yet: ${r.reason}`, r.usable ? 'ok' : 'error')
      onChange()
    } catch (e) { toast((e as Error).message, 'error') } finally { setBusy(false) }
  }
  return (
    <Card title={<span className="flex items-center gap-2">UGC portfolio link {p.usable ? <Badge tone="green">Live</Badge> : <Badge tone="amber">Not verified</Badge>}</span>}>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://your-site.com/ugc" aria-label="Portfolio URL" className="flex-1" />
        <Button variant="primary" disabled={busy || !url.trim()} onClick={() => save('/api/ugc/portfolio', { url })}>Save and check</Button>
        {p.url && <Button disabled={busy} onClick={() => save('/api/ugc/portfolio/check')}>Check again</Button>}
      </div>
      <p className="mt-2 text-sm text-zinc-500">
        {p.usable ? `${p.check.detail}. Checked ${p.check.checkedAt ? dateTime(p.check.checkedAt) : ''}; re-checked daily.` : p.reason}
        {' '}UGC emails are only drafted to Gmail once this link passes its live check.
      </p>
    </Card>
  )
}

function ResearchCard({ o, rs, onDone }: { o: Overview; rs: Research | null; onDone: () => void }) {
  const toast = useToast()
  const [size, setSize] = useState('25')
  const [drafts, setDrafts] = useState('10')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ pitches: unknown[]; gmailDrafts: unknown[]; skipped: { company: string; reason: string }[]; notes: string[] } | null>(null)
  const act = async (fn: () => Promise<void>) => { setBusy(true); try { await fn() } catch (e) { toast((e as Error).message, 'error') } finally { setBusy(false); onDone() } }
  const latest = rs?.batches[0]
  return (
    <Card title="Research and drafts">
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-3">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Daily target: <b>{o.research.dailyTarget}</b> qualified leads each business day ({o.research.autoDaily ? 'runs automatically' : 'automatic run is off'}), minimum lead score {o.research.minScore}.
            {' '}{num(o.research.poolAvailable)} candidate companies left to research.
          </p>
          {o.lastDaily && <p className="text-xs text-zinc-500">Last daily run ({o.lastDaily.day}): {o.lastDaily.note}</p>}
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Qualified leads wanted"><Select value={size} onChange={(e) => setSize(e.target.value)}>{['10', '25', '50', '100'].map((s) => <option key={s}>{s}</option>)}</Select></Field>
            <Button disabled={busy} onClick={() => act(async () => { await api.post('/api/ugc/research', { size: Number(size) }); toast('Research started. It only reads public websites.', 'ok') })}>Research now</Button>
          </div>
          {latest && (
            <p className="text-sm">
              Batch #{latest.id} ({latest.origin}): <b>{latest.status}</b>, {latest.qualified} qualified of {latest.researched} researched (target {latest.requested_size}).
              {latest.shortfall_note && <span className="block text-xs text-zinc-500">{latest.shortfall_note}</span>}
            </p>
          )}
        </div>
        <div className="space-y-3">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">{rs?.readyToDraft ?? 0} qualified lead(s) ready to draft. Each draft is written from that company's own research.</p>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Draft batch"><Input type="number" min={1} max={100} value={drafts} onChange={(e) => setDrafts(e.target.value)} className="w-24" /></Field>
            {['10', '25', '50'].map((n) => <Button key={n} size="sm" onClick={() => setDrafts(n)}>{n}</Button>)}
            <Button variant="primary" disabled={busy} onClick={() => act(async () => setResult(await api.post('/api/ugc/drafts', { count: Number(drafts) })))}>Prepare drafts</Button>
          </div>
          {result && (
            <div className="text-sm">
              <p>{result.pitches.length} pitch draft(s), {result.gmailDrafts.length} Gmail draft(s). Nothing was sent.</p>
              {result.notes.map((n) => <p key={n} className="text-xs text-zinc-500">{n}</p>)}
              {result.skipped.length > 0 && <details className="mt-1 text-xs"><summary>{result.skipped.length} skipped</summary>{result.skipped.map((s) => <p key={s.company}>{s.company}: {s.reason}</p>)}</details>}
              <a className="text-brand-600 underline" href="#/ugc/pipeline">Review drafts in the pipeline</a>
            </div>
          )}
        </div>
      </div>
    </Card>
  )
}

function PipelineTab() {
  const [stage, setStage] = useState('')
  const rows = useApi<PipelineRow[]>(`/api/ugc/pipeline${stage ? `?stage=${stage}` : ''}`)
  const ov = useApi<Overview>('/api/ugc/overview')
  if (rows.error) return <ErrorBox error={rows.error} />
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1.5">
        <button onClick={() => setStage('')} className={`rounded-full px-3 py-1 text-xs ${!stage ? 'bg-brand-600 text-white' : 'bg-zinc-100 dark:bg-zinc-800'}`}>All</button>
        {ov.data?.stages.map((s) => (
          <button key={s.id} onClick={() => setStage(s.id)} className={`rounded-full px-3 py-1 text-xs ${stage === s.id ? 'bg-brand-600 text-white' : 'bg-zinc-100 dark:bg-zinc-800'}`}>{s.label} · {s.count}</button>
        ))}
      </div>
      {!rows.data ? <Loading /> : !rows.data.length ? <Empty title="No UGC companies here yet">Research finds them; qualified ones get drafts for your review.</Empty> : (
        <Card padded={false}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-zinc-500"><tr><th className="px-4 py-2">Company</th><th className="px-4 py-2">Stage</th><th className="px-4 py-2">Score</th><th className="px-4 py-2">Contact</th><th className="px-4 py-2">Draft</th><th className="px-4 py-2">Booked</th></tr></thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {rows.data.map((r) => (
                  <tr key={r.id}>
                    <td className="px-4 py-2"><a className="font-medium hover:underline" href={`#/prospects/${r.id}`}>{r.company_name}</a><div className="text-xs text-zinc-500">{r.category_name}</div></td>
                    <td className="px-4 py-2"><Badge tone={r.stage === 'declined' ? 'red' : ['interested', 'negotiating', 'contract_pending', 'project_booked', 'content_delivered', 'payment_received', 'recurring_client'].includes(r.stage) ? 'green' : r.stage === 'follow_up_due' ? 'amber' : 'gray'}>{r.stage_label}</Badge>
                      {r.next_follow_up_at && <div className="text-xs text-zinc-500">Follow-up {dateTime(r.next_follow_up_at)}</div>}</td>
                    <td className="px-4 py-2 tabular-nums">{r.fit_score ?? '—'}</td>
                    <td className="px-4 py-2">{r.email ?? <span className="text-xs text-zinc-500">{r.exclusion ?? 'None verified'}</span>}</td>
                    <td className="px-4 py-2">{r.pitch_id ? <a className="text-brand-600 hover:underline" href={`#/drafts/pitch/${r.pitch_id}`}>{r.pitch_status === 'approved' ? 'Approved' : 'Review'}{r.gmail_draft ? ' · in Gmail' : ''}</a> : '—'}</td>
                    <td className="px-4 py-2 tabular-nums">{r.booked_cents ? usd(r.booked_cents) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  )
}

const DEAL_STATUS = ['interested', 'negotiating', 'contract_pending', 'booked', 'delivered', 'declined']
const label = (s: string) => s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())

function DealsTab() {
  const deals = useApi<Deal[]>('/api/ugc/deals')
  const companies = useApi<PipelineRow[]>('/api/ugc/pipeline')
  const [edit, setEdit] = useState<Partial<Deal> & { prospect_id?: number } | null>(null)
  const [preview, setPreview] = useState<{ name: string; body: string; note: string } | null>(null)
  const toast = useToast()
  if (deals.error) return <ErrorBox error={deals.error} />
  const showTemplate = async (d: Deal, slug: string) => {
    try { setPreview(await api.get(`/api/ugc/deals/${d.id}/template/${slug}`)) } catch (e) { toast((e as Error).message, 'error') }
  }
  return (
    <div className="space-y-4">
      <div className="flex justify-between gap-3">
        <p className="text-sm text-zinc-500">Revenue counts only booked projects with an agreed price. Paid ad usage, perpetual usage and raw footage are priced separately; nothing is agreed automatically.</p>
        <Button variant="primary" onClick={() => setEdit({ status: 'interested', usage_rights: 'organic', raw_footage: 'not_included', contract_status: 'none', payment_status: 'none' })}>Add deal</Button>
      </div>
      {!deals.data ? <Loading /> : !deals.data.length ? <Empty title="No UGC deals yet">Add one when a brand is interested.</Empty> : (
        <div className="grid gap-3 lg:grid-cols-2">
          {deals.data.map((d) => (
            <Card key={d.id} title={<span>{d.company_name} · {d.title}</span>} actions={<Badge tone={d.status === 'declined' ? 'red' : ['booked', 'delivered'].includes(d.status) ? 'green' : 'blue'}>{label(d.status)}</Badge>}>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                <dt className="text-zinc-500">Videos</dt><dd>{d.video_count ?? '—'}</dd>
                <dt className="text-zinc-500">Quoted / agreed</dt><dd>{usd(d.quoted_cents)} / {usd(d.negotiated_cents)}</dd>
                <dt className="text-zinc-500">Usage</dt><dd>{label(d.usage_rights)}{d.paid_ads_duration ? ` (${d.paid_ads_duration})` : ''}{d.usage_fee_cents != null ? ` · ${usd(d.usage_fee_cents)} fee` : ''}</dd>
                <dt className="text-zinc-500">Raw footage · revisions</dt><dd>{label(d.raw_footage)} · {d.revisions ?? '—'}</dd>
                <dt className="text-zinc-500">Deadline</dt><dd>{d.deadline ?? '—'}</dd>
                <dt className="text-zinc-500">Contract · payment</dt><dd>{label(d.contract_status)} · {label(d.payment_status)} ({usd(d.amount_paid_cents)})</dd>
              </dl>
              {d.warnings.map((w) => <p key={w} className="mt-1 text-xs text-amber-600">{w}</p>)}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" onClick={() => setEdit(d)}>Edit</Button>
                <Button size="sm" onClick={() => showTemplate(d, 'ugc_reply_interested')}>Reply template</Button>
                <Button size="sm" onClick={() => showTemplate(d, 'ugc_pricing_proposal')}>Pricing proposal</Button>
                <Button size="sm" onClick={() => showTemplate(d, 'ugc_retainer_proposal')}>Retainer proposal</Button>
              </div>
            </Card>
          ))}
        </div>
      )}
      {edit && <DealForm deal={edit} companies={companies.data ?? []} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); deals.reload() }} />}
      <Modal open={!!preview} onClose={() => setPreview(null)} title={preview?.name ?? ''} wide>
        <Notice>{preview?.note}</Notice>
        <Textarea readOnly value={preview?.body ?? ''} className="mt-3 h-72 font-mono text-xs" />
        <div className="mt-3 flex justify-end"><Button onClick={() => { navigator.clipboard?.writeText(preview?.body ?? ''); toast('Copied', 'ok') }}>Copy</Button></div>
      </Modal>
    </div>
  )
}

function DealForm({ deal, companies, onClose, onSaved }: { deal: Partial<Deal>; companies: PipelineRow[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast()
  const dollars = (c: number | null | undefined) => (c == null ? '' : String(c / 100))
  const [f, setF] = useState<Record<string, string | boolean>>({
    prospect_id: String(deal.prospect_id ?? ''), title: deal.title ?? '', status: deal.status ?? 'interested', video_count: deal.video_count == null ? '' : String(deal.video_count),
    quoted_usd: dollars(deal.quoted_cents), negotiated_usd: dollars(deal.negotiated_cents), usage_rights: deal.usage_rights ?? 'organic', usage_fee_usd: dollars(deal.usage_fee_cents),
    paid_ads_duration: deal.paid_ads_duration ?? '', raw_footage: deal.raw_footage ?? 'not_included', exclusivity: deal.exclusivity ?? '', revisions: deal.revisions == null ? '' : String(deal.revisions),
    deadline: deal.deadline ?? '', contract_status: deal.contract_status ?? 'none', payment_status: deal.payment_status ?? 'none', amount_paid_usd: dollars(deal.amount_paid_cents),
    meeting_at: deal.meeting_at ?? '', deliverables: deal.deliverables ?? '', notes: deal.notes ?? '', recurring: !!deal.recurring,
  })
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  const save = async () => {
    const body: Record<string, unknown> = { ...f }
    for (const k of ['video_count', 'quoted_usd', 'negotiated_usd', 'usage_fee_usd', 'amount_paid_usd', 'revisions', 'deadline', 'meeting_at']) if (body[k] === '') body[k] = null
    if (!body.title) delete body.title
    try {
      if (deal.id) { delete body.prospect_id; await api.patch(`/api/ugc/deals/${deal.id}`, body) } else await api.post('/api/ugc/deals', { ...body, prospect_id: Number(f.prospect_id) })
      toast('Deal saved', 'ok'); onSaved()
    } catch (e) { toast((e as Error).message, 'error') }
  }
  const opts = (list: string[]) => list.map((o) => <option key={o} value={o}>{label(o)}</option>)
  return (
    <Modal open onClose={onClose} title={deal.id ? 'Edit UGC deal' : 'New UGC deal'} wide>
      <div className="grid gap-3 sm:grid-cols-2">
        {!deal.id && <Field label="Company"><Select value={String(f.prospect_id)} onChange={set('prospect_id')}><option value="">Choose…</option>{companies.map((c) => <option key={c.id} value={c.id}>{c.company_name}</option>)}</Select></Field>}
        <Field label="Title"><Input value={String(f.title)} onChange={set('title')} placeholder="3-video product demo" /></Field>
        <Field label="Status"><Select value={String(f.status)} onChange={set('status')}>{opts(DEAL_STATUS)}</Select></Field>
        <Field label="Number of videos"><Input type="number" value={String(f.video_count)} onChange={set('video_count')} /></Field>
        <Field label="Quoted price ($)"><Input type="number" value={String(f.quoted_usd)} onChange={set('quoted_usd')} /></Field>
        <Field label="Agreed price ($)" hint="Required to book"><Input type="number" value={String(f.negotiated_usd)} onChange={set('negotiated_usd')} /></Field>
        <Field label="Usage rights"><Select value={String(f.usage_rights)} onChange={set('usage_rights')}>{opts(['organic', 'paid_ads', 'paid_ads_whitelisting', 'perpetual', 'custom'])}</Select></Field>
        <Field label="Usage / license fee ($)" hint="Priced separately"><Input type="number" value={String(f.usage_fee_usd)} onChange={set('usage_fee_usd')} /></Field>
        <Field label="Paid ad duration"><Input value={String(f.paid_ads_duration)} onChange={set('paid_ads_duration')} placeholder="30 days" /></Field>
        <Field label="Raw footage"><Select value={String(f.raw_footage)} onChange={set('raw_footage')}>{opts(['not_included', 'extra_fee', 'included'])}</Select></Field>
        <Field label="Exclusivity"><Input value={String(f.exclusivity)} onChange={set('exclusivity')} placeholder="None" /></Field>
        <Field label="Revisions"><Input type="number" value={String(f.revisions)} onChange={set('revisions')} /></Field>
        <Field label="Deadline"><Input type="date" value={String(f.deadline)} onChange={set('deadline')} /></Field>
        <Field label="Meeting booked for"><Input type="date" value={String(f.meeting_at)} onChange={set('meeting_at')} /></Field>
        <Field label="Contract"><Select value={String(f.contract_status)} onChange={set('contract_status')}>{opts(['none', 'drafted', 'sent', 'signed', 'cancelled'])}</Select></Field>
        <Field label="Payment"><Select value={String(f.payment_status)} onChange={set('payment_status')}>{opts(['none', 'invoiced', 'partial', 'paid', 'refunded'])}</Select></Field>
        <Field label="Amount paid ($)"><Input type="number" value={String(f.amount_paid_usd)} onChange={set('amount_paid_usd')} /></Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!f.recurring} onChange={(e) => setF({ ...f, recurring: e.target.checked })} /> Recurring (retainer)</label>
        <Field label="Deliverables" className="sm:col-span-2"><Textarea value={String(f.deliverables)} onChange={set('deliverables')} /></Field>
        <Field label="Notes" className="sm:col-span-2"><Textarea value={String(f.notes)} onChange={set('notes')} /></Field>
      </div>
      <div className="mt-4 flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} disabled={!deal.id && !f.prospect_id}>Save</Button></div>
    </Modal>
  )
}

function TemplatesTab() {
  const list = useApi<Template[]>('/api/ugc/templates')
  const toast = useToast()
  const [open, setOpen] = useState<Template | null>(null)
  if (list.error) return <ErrorBox error={list.error} />
  if (!list.data) return <Loading />
  const save = async (body: object) => {
    try { setOpen(await api.patch(`/api/ugc/templates/${open!.slug}`, body)); list.reload(); toast('Template saved', 'ok') } catch (e) { toast((e as Error).message, 'error') }
  }
  return (
    <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
      <Card padded={false}>
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {list.data.map((t) => <li key={t.slug}><button onClick={() => setOpen(t)} className={`w-full px-4 py-2.5 text-left text-sm ${open?.slug === t.slug ? 'bg-brand-50 dark:bg-brand-600/15' : ''}`}>{t.name}<div className="text-xs text-zinc-500">{label(t.kind)}</div></button></li>)}
        </ul>
      </Card>
      {open ? <TemplateEditor key={open.slug + open.body} t={open} onSave={save} /> : <Notice>Choose a template. Variables like {'{{company}}'} and {'{{concepts}}'} are filled from each company's research; the signature (Best, Carter) and the compliance footer are added automatically.</Notice>}
    </div>
  )
}

function TemplateEditor({ t, onSave }: { t: Template; onSave: (b: object) => void }) {
  const [subject, setSubject] = useState(t.subject ?? '')
  const [body, setBody] = useState(t.body)
  return (
    <Card title={t.name}>
      {t.kind === 'initial' && <Field label="Subject"><Input value={subject} onChange={(e) => setSubject(e.target.value)} /></Field>}
      <Field label="Body" className="mt-3"><Textarea value={body} onChange={(e) => setBody(e.target.value)} className="h-80 font-mono text-xs" /></Field>
      <p className="mt-2 text-xs text-zinc-500">Variables: {'{{greeting}} {{company}} {{brand_line}} {{concepts}} {{portfolio_line}} {{concept_short}} {{original_date}} {{contact_name}} {{deliverables}} {{price_1}} {{price_3}} {{price_5}} {{price_monthly}} {{revisions}}'}</p>
      <div className="mt-3 flex justify-end gap-2">
        <Button onClick={() => onSave({ reset: true })}>Reset to default</Button>
        <Button variant="primary" onClick={() => onSave({ subject, body })}>Save</Button>
      </div>
    </Card>
  )
}

function SettingsTab() {
  const s = useApi<{ values: Record<string, unknown> }>('/api/settings')
  const toast = useToast()
  if (s.error) return <ErrorBox error={s.error} />
  if (!s.data) return <Loading />
  const v = s.data.values
  const research = v['ugc.research'] as { dailyTarget: number; autoDaily: boolean; minScore: number; autoDraft: boolean }
  const follow = v['ugc.followUps'] as { firstAfterBusinessDays: number; secondAfterBusinessDays: number; max: number }
  const pricing = v['ugc.pricing'] as Record<string, number>
  const costs = v['ugc.costs'] as { dailyAlertUsd: number }
  const auto = v['ugc.autopilot'] as { newPerDay: number; rampMax: number; maxBouncesPerWeek: number }
  const save = async (key: string, value: unknown) => {
    try { await api.patch('/api/settings', { [key]: value }); toast('Saved', 'ok'); s.reload() } catch (e) { toast((e as Error).message, 'error') }
  }
  return (
    <div className="space-y-6">
      <AutopilotLimits auto={auto} save={save} />
      <UgcSettingsForm research={research} follow={follow} pricing={pricing} costs={costs} save={save} />
    </div>
  )
}

function AutopilotLimits({ auto, save }: { auto: { newPerDay: number; rampMax: number; maxBouncesPerWeek: number }; save: (k: string, v: unknown) => void }) {
  const [a, setA] = useState(auto)
  const n = (x: string) => Number(x)
  return (
    <Card title="UGC autopilot sending limits">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Start at (first emails a day)"><Input type="number" value={a.newPerDay} onChange={(e) => setA({ ...a, newPerDay: n(e.target.value) })} /></Field>
        <Field label="Grow to at most" hint="One step per clean week; 10 is the hard maximum"><Input type="number" value={a.rampMax} onChange={(e) => setA({ ...a, rampMax: n(e.target.value) })} /></Field>
        <Field label="Pause after this many bounces in 7 days"><Input type="number" value={a.maxBouncesPerWeek} onChange={(e) => setA({ ...a, maxBouncesPerWeek: n(e.target.value) })} /></Field>
      </div>
      <p className="mt-2 text-xs text-zinc-500">The shared account limits (sending tier and daily limits in Outreach Controls) always apply on top, across sponsorship and UGC together, and are never raised automatically.</p>
      <div className="mt-3 flex justify-end"><Button variant="primary" onClick={() => save('ugc.autopilot', a)}>Save</Button></div>
    </Card>
  )
}

function UgcSettingsForm({ research, follow, pricing, costs, save }: { research: { dailyTarget: number; autoDaily: boolean; minScore: number; autoDraft: boolean }; follow: { firstAfterBusinessDays: number; secondAfterBusinessDays: number; max: number }; pricing: Record<string, number>; costs: { dailyAlertUsd: number }; save: (k: string, v: unknown) => void }) {
  const [r, setR] = useState(research)
  const [fu, setFu] = useState(follow)
  const [p, setP] = useState(pricing)
  const [c, setC] = useState(costs)
  const n = (x: string) => Number(x)
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card title="Prospecting volume">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Qualified leads per business day" hint="25, 50 or 100; never changes sending limits"><Input type="number" value={r.dailyTarget} onChange={(e) => setR({ ...r, dailyTarget: n(e.target.value) })} /></Field>
          <Field label="Minimum lead score" hint="Weaker leads are never counted or drafted"><Input type="number" value={r.minScore} onChange={(e) => setR({ ...r, minScore: n(e.target.value) })} /></Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={r.autoDaily} onChange={(e) => setR({ ...r, autoDaily: e.target.checked })} /> Research automatically each business day</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={r.autoDraft} onChange={(e) => setR({ ...r, autoDraft: e.target.checked })} /> Draft new qualified leads for review</label>
        </div>
        <div className="mt-3 flex justify-end"><Button variant="primary" onClick={() => save('ugc.research', r)}>Save</Button></div>
      </Card>
      <Card title="Follow-up cadence (business days)">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="First follow-up after"><Input type="number" value={fu.firstAfterBusinessDays} onChange={(e) => setFu({ ...fu, firstAfterBusinessDays: n(e.target.value) })} /></Field>
          <Field label="Final follow-up after"><Input type="number" value={fu.secondAfterBusinessDays} onChange={(e) => setFu({ ...fu, secondAfterBusinessDays: n(e.target.value) })} /></Field>
          <Field label="Follow-ups"><Input type="number" value={fu.max} onChange={(e) => setFu({ ...fu, max: n(e.target.value) })} /></Field>
        </div>
        <p className="mt-2 text-xs text-zinc-500">Each follow-up is a draft that needs your approval. They stop on a reply, decline, opt-out, bounce or closed deal.</p>
        <div className="mt-3 flex justify-end"><Button variant="primary" onClick={() => save('ugc.followUps', fu)}>Save</Button></div>
      </Card>
      <Card title="Pricing guidelines (USD)">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="1 edited video"><Input type="number" value={p.oneVideoUsd} onChange={(e) => setP({ ...p, oneVideoUsd: n(e.target.value) })} /></Field>
          <Field label="3 edited videos"><Input type="number" value={p.threeVideosUsd} onChange={(e) => setP({ ...p, threeVideosUsd: n(e.target.value) })} /></Field>
          <Field label="5 edited videos"><Input type="number" value={p.fiveVideosUsd} onChange={(e) => setP({ ...p, fiveVideosUsd: n(e.target.value) })} /></Field>
          <Field label="Monthly 4-video package, from"><Input type="number" value={p.monthlyFourFromUsd} onChange={(e) => setP({ ...p, monthlyFourFromUsd: n(e.target.value) })} /></Field>
        </div>
        <p className="mt-2 text-xs text-zinc-500">Used only in the proposal templates you open yourself. First emails never mention price.</p>
        <div className="mt-3 flex justify-end"><Button variant="primary" onClick={() => save('ugc.pricing', p)}>Save</Button></div>
      </Card>
      <Card title="Cost alert">
        <Field label="Alert when today's estimated cost exceeds ($)"><Input type="number" value={c.dailyAlertUsd} onChange={(e) => setC({ dailyAlertUsd: n(e.target.value) })} /></Field>
        <div className="mt-3 flex justify-end"><Button variant="primary" onClick={() => save('ugc.costs', c)}>Save</Button></div>
      </Card>
    </div>
  )
}

interface Check { label: string; ok: boolean; detail: string }
interface AutoStatus {
  enabled: boolean; cap: number; hardMax: number; phrase: string; sponsorshipEnabled: boolean; inSendWindow: boolean
  config: { newPerDay: number; rampMax: number; maxBouncesPerWeek: number }
  pause: { reason: string | null; at: string | null }
  gate: { ok: boolean; passing: boolean; fresh: boolean; checks: Check[]; checkedAt: string | null }
  permission: { confirmed: boolean; note: string | null }
  emergencyStop: { active: boolean }
  limits: { tier: string; newEmails: { sent: number; limit: number }; weekNew: { sent: number; limit: number }; followUps: { sent: number; limit: number }; total: { sent: number; limit: number } }
  today: { firstEmails: number; followUps: number }
  queue: { id: number; company_name: string; email: string | null; fit_score: number | null }[]
  waiting: { id: number; company_name: string; email: string | null; contact_id: number | null; fit_score: number | null; needs: string[] }[]
  totals: { sent: number; followUpsSent: number; errors7d: number; bounces7d: number; followUpsPending: number }
  events: { id: number; kind: string; detail: string; created_at: string }[]
}

function AutopilotTab() {
  const st = useApi<AutoStatus>('/api/ugc/autopilot')
  const toast = useToast()
  const [phrase, setPhrase] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [country, setCountry] = useState('US')
  const [plan, setPlan] = useState<{ note: string; actions: string[] } | null>(null)
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true)
    try { await fn(); toast(ok); st.reload() } catch (e) { toast((e as Error).message, 'error') } finally { setBusy(false) }
  }
  if (st.error) return <ErrorBox error={st.error} />
  if (!st.data) return <Loading />
  const s = st.data
  const withContact = s.waiting.filter((w) => w.contact_id)
  return (
    <div className="space-y-6">
      {s.emergencyStop.active && <Notice tone="red" title="STOP ALL OUTREACH is active">Nothing is sent until you resume in Outreach Controls.</Notice>}
      {s.pause.reason && !s.enabled && <Notice tone="amber" title="UGC autopilot paused itself">{s.pause.reason}</Notice>}
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="UGC autopilot" value={s.enabled ? 'On' : 'Off'} tone={s.enabled ? 'good' : 'muted'} hint={s.inSendWindow ? 'Sending hours now' : 'Outside sending hours'} />
        <Stat label="UGC limit today" value={`${s.today.firstEmails} / ${s.cap}`} hint={`Grows to ${s.config.rampMax} after clean weeks`} />
        <Stat label="Gmail account today" value={`${s.limits.newEmails.sent} / ${s.limits.newEmails.limit}`} hint={`New emails, both campaigns (${s.limits.tier} tier); ${s.limits.weekNew.sent} / ${s.limits.weekNew.limit} this week`} />
        <Stat label="Ready to send" value={s.queue.length} />
        <Stat label="Waiting on you" value={s.waiting.length} tone={s.waiting.length ? 'warn' : 'muted'} hint="Country to confirm" />
        <Stat label="Errors · bounces (7d)" value={`${s.totals.errors7d} · ${s.totals.bounces7d}`} tone={s.totals.errors7d || s.totals.bounces7d ? 'bad' : 'muted'} />
      </div>

      <Card title={<span className="flex items-center gap-2">Launch gate {s.gate.passing ? <Badge tone="green">Passing</Badge> : <Badge tone="amber">Not passing</Badge>}</span>}
        actions={<Button size="sm" disabled={busy} onClick={() => act(() => api.post('/api/ugc/gate'), 'Launch gate checked')}>Check now</Button>}>
        {s.gate.checks.length ? (
          <ul className="space-y-1.5 text-sm">{s.gate.checks.map((c) => <li key={c.label}>{c.ok ? '✓' : '✗'} <b>{c.label}</b> <span className="text-zinc-500">· {c.detail}</span></li>)}</ul>
        ) : <p className="text-sm text-zinc-500">Not checked yet.</p>}
        {!s.permission.confirmed && (
          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why the videos may be shown, e.g. All three are my own content" className="flex-1" />
            <Button disabled={busy || note.trim().length < 10} onClick={() => act(() => api.post('/api/ugc/videos-permission', { note }), 'Permission recorded')}>Confirm video permission</Button>
          </div>
        )}
      </Card>

      <Card title="Switch">
        {s.enabled ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm">UGC autopilot sends up to <b>{s.cap}</b> UGC first emails a day, plus due UGC follow-ups, during business hours, inside the shared account limits. Sponsorship autopilot is {s.sponsorshipEnabled ? 'on' : 'off'} and controlled separately.</p>
            <Button variant="danger" disabled={busy} onClick={() => act(() => api.post('/api/ugc/autopilot', { enable: false }), 'UGC autopilot switched off')}>Switch UGC autopilot off</Button>
          </div>
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input value={phrase} onChange={(e) => setPhrase(e.target.value)} placeholder={`Type ${s.phrase}`} className="flex-1" />
            <Button variant="primary" disabled={busy || phrase !== s.phrase} onClick={() => act(() => api.post('/api/ugc/autopilot', { enable: true, phrase }), 'UGC autopilot switched on')}>Switch UGC autopilot on</Button>
          </div>
        )}
        <div className="mt-3 flex gap-2">
          <Button size="sm" disabled={busy} onClick={() => act(async () => setPlan(await api.post('/api/ugc/autopilot/dry-run')), 'Dry run finished; nothing was sent')}>Dry run (plan only)</Button>
        </div>
        {plan && <p className="mt-2 text-sm text-zinc-500">{plan.actions.length ? `Would do: ${plan.actions.join(', ')}.` : plan.note || 'Nothing to do right now.'}</p>}
      </Card>

      <Card title={`Waiting on you: recipient country (${s.waiting.length})`}>
        <p className="mb-3 text-sm text-zinc-500">Your rule: a recipient's country is never guessed or taken from a company's headquarters. Confirm the ones you know; only those can be emailed.</p>
        {withContact.length ? (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => setPicked(picked.size === withContact.length ? new Set() : new Set(withContact.map((w) => w.contact_id!)))}>{picked.size === withContact.length ? 'Clear' : 'Select all'}</Button>
              <Select value={country} onChange={(e) => setCountry(e.target.value)} className="w-auto">{['US', 'CA', 'GB', 'AU', 'DE', 'FR', 'NL', 'SE', 'IE', 'NZ'].map((c) => <option key={c}>{c}</option>)}</Select>
              <Button size="sm" variant="primary" disabled={busy || !picked.size} onClick={() => act(async () => { await api.post('/api/ugc/confirm-countries', { contactIds: [...picked], jurisdiction: country }); setPicked(new Set()) }, `Confirmed ${country} for ${picked.size} contact(s)`)}>Confirm {country} for {picked.size} selected</Button>
            </div>
            <ul className="max-h-80 divide-y divide-zinc-100 overflow-y-auto text-sm dark:divide-zinc-800">
              {withContact.map((w) => (
                <li key={w.id} className="flex items-center gap-3 py-2">
                  <input type="checkbox" checked={picked.has(w.contact_id!)} onChange={(e) => { const n = new Set(picked); if (e.target.checked) n.add(w.contact_id!); else n.delete(w.contact_id!); setPicked(n) }} aria-label={`Select ${w.company_name}`} />
                  <a className="font-medium hover:underline" href={`#/prospects/${w.id}`}>{w.company_name}</a>
                  <span className="text-zinc-500">{w.email}</span>
                  <span className="ml-auto text-xs text-zinc-500">score {w.fit_score ?? '—'}</span>
                </li>
              ))}
            </ul>
          </>
        ) : <p className="text-sm text-zinc-500">Nothing waiting.</p>}
      </Card>

      <Card title={`Ready to send (${s.queue.length})`}>
        {s.queue.length ? <ul className="text-sm">{s.queue.slice(0, 30).map((q) => <li key={q.id} className="py-1">{q.company_name} · <span className="text-zinc-500">{q.email} · score {q.fit_score}</span></li>)}</ul> : <p className="text-sm text-zinc-500">No UGC company is ready for an automatic email.</p>}
      </Card>

      <Card title="UGC autopilot activity">
        {s.events.length ? (
          <ul className="max-h-96 space-y-1.5 overflow-y-auto text-sm">{s.events.map((e) => <li key={e.id}><span className="text-xs text-zinc-500">{dateTime(e.created_at)}</span> <Badge tone={e.kind === 'error' || e.kind === 'paused' ? 'red' : e.kind === 'sent' ? 'green' : 'gray'}>{e.kind}</Badge> {e.detail}</li>)}</ul>
        ) : <p className="text-sm text-zinc-500">No activity yet.</p>}
      </Card>
    </div>
  )
}
