import { useState } from 'react'
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, Notice, PageHeader, Select, Tabs, TierBadge, useToast } from '../components/ui'
import { api, useApi, usePoll } from '../lib/api'
import { dateTime, relative } from '../lib/format'
import { navigate } from '../lib/router'
import type { Batch, BatchCandidate, Category, PoolEntry, PoolSummaryRow, ProspectDetail as Detail, ProspectListItem, ResearchStatus } from '../lib/types'
import ProspectDetail from './ProspectDetail'
import { ActionableLeads, ExcludedBrands } from './Leads'

const TABS = [
  { id: 'leads', label: 'Actionable leads' },
  { id: 'research', label: 'Run research' },
  { id: 'review', label: 'Review queue' },
  { id: 'excluded', label: 'Excluded' },
  { id: 'candidates', label: 'Candidates' },
  { id: 'manual', label: 'Manual contact queue' },
] as const
type TabId = (typeof TABS)[number]['id']

export default function Discovery({ tab, openId }: { tab?: string; openId: number | null }) {
  const current = (TABS.find((t) => t.id === tab)?.id ?? 'leads') as TabId
  const status = useApi<ResearchStatus>('/api/research/status')
  usePoll(status.reload, 5000, true)
  const { data: categories } = useApi<Category[]>('/api/categories')
  const pending = status.data?.pendingReview ?? 0
  return (
    <>
      <PageHeader
        title="Brand Discovery"
        subtitle="Finds brands with a publicly listed business email and records where each one was published. Reads public pages only; obeys robots.txt; $0."
        actions={status.data && (
          <span className="flex items-center gap-2 text-sm">
            <span className={`h-2 w-2 rounded-full ${status.data.workerRunning ? 'bg-emerald-500' : 'bg-zinc-400'}`} aria-hidden />
            {status.data.workerRunning ? 'Research worker running' : 'Research worker stopped'}
          </span>
        )}
      />
      <Tabs tabs={TABS.map((t) => ({ ...t, label: t.id === 'review' && pending ? `Review queue (${pending})` : t.label }))} value={current} onChange={(t) => navigate(`/discovery/${t}`)} />
      {status.data && !status.data.workerRunning && (
        <div className="mb-5"><Notice tone="amber" title="The research worker isn't running">Batches wait until it starts. It starts with <code>npm run dev</code> (or <code>npm run worker</code> on its own).</Notice></div>
      )}
      {current === 'leads' && <ActionableLeads categories={categories ?? []} />}
      {current === 'excluded' && <ExcludedBrands />}
      {current === 'research' && <RunResearch onChange={status.reload} />}
      {current === 'review' && <ReviewQueue onChange={status.reload} />}
      {current === 'candidates' && <Candidates categories={categories ?? []} />}
      {current === 'manual' && <ManualQueue />}
      {openId && <ProspectDetail id={openId} categories={categories ?? []} onClose={() => navigate(`/discovery/${current}`)} onChanged={status.reload} />}
    </>
  )
}

// ---------- Run research ----------

function RunResearch({ onChange }: { onChange: () => void }) {
  const toast = useToast()
  const batches = useApi<Batch[]>('/api/research/batches')
  const pool = useApi<{ summary: PoolSummaryRow[] }>('/api/research/pool?summary=1')
  const active = batches.data?.find((b) => b.status === 'queued' || b.status === 'running')
  usePoll(batches.reload, 3000, !!active)
  const [size, setSize] = useState(20)
  const [selected, setSelected] = useState<number[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [openBatch, setOpenBatch] = useState<number | null>(null)

  const enabled = pool.data?.summary.filter((c) => c.enabled) ?? []
  const chosen = selected ?? enabled.map((c) => c.id)
  const capacity = enabled.filter((c) => chosen.includes(c.id)).reduce((n, c) => n + Math.min(c.available, c.research_quota), 0)
  const limit = Math.min(size * 4, capacity)

  const start = async () => {
    setBusy(true)
    try {
      const r = await api.post<{ batch: Batch }>('/api/research/batches', { size, category_ids: chosen })
      toast(`Batch #${r.batch.id} is looking for up to ${size} brands with qualifying emails`)
      setOpenBatch(r.batch.id)
      batches.reload(); pool.reload(); onChange()
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }
  const cancel = async (id: number) => {
    try {
      await api.post(`/api/research/batches/${id}/cancel`)
      toast('Batch cancelled; unstarted brands returned to the pool')
      batches.reload(); pool.reload()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <Card title="Find brands with qualifying emails">
          {!pool.data ? <Loading /> : (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-2" role="group" aria-label="Batch size">
                {[20, 50, 100, 200, 500].map((n) => (
                  <button key={n} onClick={() => setSize(n)}
                    className={`rounded-lg border px-4 py-2 text-sm font-medium ${size === n ? 'border-brand-600 bg-brand-600 text-white' : 'border-zinc-300 dark:border-zinc-700'}`}>{n}</button>
                ))}
              </div>
              <div className="grid gap-2 xl:grid-cols-2">
                {enabled.map((c) => (
                  <label key={c.id} className="flex items-center justify-between gap-2 rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800">
                    <span className="flex items-center gap-2">
                      <input type="checkbox" checked={chosen.includes(c.id)} onChange={(e) => setSelected(e.target.checked ? [...chosen, c.id] : chosen.filter((x) => x !== c.id))} />
                      {c.name}
                    </span>
                    <span className="whitespace-nowrap text-xs tabular-nums text-zinc-500" title="Available candidates · per-batch quota">{c.available} avail · quota {c.research_quota}</span>
                  </label>
                ))}
              </div>
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                Looks for up to <strong>{size}</strong> brands with qualifying emails, researching at most <strong>{limit}</strong> candidates with these categories and quotas. It stops as soon as it has {size}.
                {limit < size && ' There are fewer candidates than the target, so expect fewer results.'} Empty slots are never filled with unverified contacts.
              </p>
              <div className="flex justify-end"><Button variant="primary" onClick={start} disabled={busy || !!active || !chosen.length || capacity === 0}>{active ? 'A batch is running' : `Find up to ${size} brands`}</Button></div>
            </div>
          )}
        </Card>
        <Card title="How research works">
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-zinc-600 dark:text-zinc-400">
            <li>Visits each brand's official site and its partnership, press and contact pages, one request per site every 1.5 s.</li>
            <li>Obeys robots.txt. Blocked sites are recorded as blocked, never bypassed.</li>
            <li>Keeps only business mailboxes actually published by the brand or its confirmed agency. Addresses are never guessed, and personal addresses are never stored.</li>
            <li>Checks with free public DNS that the domain can receive mail. That does not prove a mailbox exists, so nothing is called deliverable until the address has replied.</li>
            <li>Every finding keeps its page URL, the exact text and the fetch time.</li>
            <li>Brands with a qualifying email wait in the review queue for your approval. The rest go to Excluded with the reason.</li>
          </ul>
        </Card>
      </div>

      <Card title="Batches" padded={false}>
        {!batches.data ? <Loading /> : batches.data.length === 0 ? <p className="p-5 text-sm text-zinc-500">No batches yet.</p> : (
          <ul>
            {batches.data.map((b) => (
              <li key={b.id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800">
                <div className="flex flex-wrap items-center gap-3 px-5 py-3">
                  <button className="font-medium hover:underline" onClick={() => setOpenBatch(openBatch === b.id ? null : b.id)}>Batch #{b.id}</button>
                  <Badge tone={b.status === 'completed' ? 'green' : b.status === 'running' || b.status === 'queued' ? 'blue' : 'gray'}>{b.status}</Badge>
                  <span className="text-sm text-zinc-500">
                    <strong className="text-zinc-700 dark:text-zinc-300">{b.qualified} of {b.requested_size}</strong> with qualifying emails · {b.researched} researched · {Math.max(0, b.researched - b.qualified - b.duplicates)} rejected · {b.duplicates} duplicates
                    {b.researched - b.duplicates > 0 && ` · ${Math.round((b.qualified / (b.researched - b.duplicates)) * 100)}% discovery rate`}
                  </span>
                  <span className="ml-auto text-xs text-zinc-400">{dateTime(b.created_at)}</span>
                  {(b.status === 'running' || b.status === 'queued') && <Button size="sm" onClick={() => cancel(b.id)}>Cancel</Button>}
                </div>
                {(b.status === 'running' || b.status === 'queued') && (
                  <div className="mx-5 mb-3 h-1.5 rounded-full bg-zinc-100 dark:bg-zinc-800"><div className="h-1.5 rounded-full bg-brand-500 transition-all" style={{ width: `${Math.min(100, (b.qualified / b.requested_size) * 100)}%` }} /></div>
                )}
                {b.shortfall_note && openBatch === b.id && <div className="mx-5 mb-3"><Notice tone="amber">{b.shortfall_note}</Notice></div>}
                {openBatch === b.id && <BatchDetail id={b.id} live={b.status === 'running' || b.status === 'queued'} />}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

const STATUS_TONE: Record<BatchCandidate['status'], 'gray' | 'blue' | 'green' | 'amber' | 'red'> = {
  pending: 'gray', researching: 'blue', done: 'green', duplicate: 'amber', unreachable: 'red', blocked: 'red', failed: 'red', cancelled: 'gray',
}

function BatchDetail({ id, live }: { id: number; live: boolean }) {
  const { data, reload } = useApi<{ candidates: BatchCandidate[] }>(`/api/research/batches/${id}`)
  usePoll(reload, 3000, live)
  if (!data) return <Loading />
  return (
    <div className="overflow-x-auto px-5 pb-4">
      <table className="w-full min-w-[40rem] text-sm">
        <tbody>
          {data.candidates.map((c) => (
            <tr key={c.id} className="border-t border-zinc-100 dark:border-zinc-800">
              <td className="py-2 pr-3">
                {c.prospect_id && c.status === 'done'
                  ? <a className="font-medium hover:underline" href={`#/discovery/research/${c.prospect_id}`}>{c.company_name}</a>
                  : <span className="font-medium">{c.company_name}</span>}
                <div className="text-xs text-zinc-500">{c.domain} · {c.category_name}</div>
              </td>
              <td className="py-2 pr-3">{c.status === 'done' ? <Badge tone={c.qualified ? 'green' : 'gray'}>{c.qualified ? 'qualifying email' : 'excluded'}</Badge> : <Badge tone={STATUS_TONE[c.status]}>{c.status}</Badge>}</td>
              <td className="py-2 pr-3">{c.fit_score != null && <TierBadge tier={c.fit_score >= 80 ? 'A' : c.fit_score >= 60 ? 'B' : 'C'} score={c.fit_score} />}</td>
              <td className="py-2 text-xs text-zinc-500">{c.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ---------- Review queue ----------

function ReviewQueue({ onChange }: { onChange: () => void }) {
  const toast = useToast()
  const [sort, setSort] = useState('score')
  const { data, error, reload } = useApi<ProspectListItem[]>(`/api/prospects?review=pending&lead=actionable&sort=${sort}`)
  const decide = async (p: ProspectListItem, decision: 'approved' | 'rejected') => {
    let note: string | null = null
    if (decision === 'rejected') {
      note = prompt(`Why reject ${p.company_name}? (kept for your records)`)
      if (!note?.trim()) return
    }
    try {
      await api.post<Detail>(`/api/prospects/${p.id}/review`, { decision, note })
      toast(decision === 'approved' ? `Approved ${p.company_name}` : `Rejected ${p.company_name}`)
      reload(); onChange()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }
  if (error) return <ErrorBox error={error} />
  if (!data) return <Loading />
  return (
    <div className="space-y-4">
      <Notice>Only brands with a qualifying email appear here; the rest are under Excluded. Approving a brand only lets you draft to it. Nothing is sent, and contacts outside the US or with unknown jurisdiction still need individual review.</Notice>
      <div className="flex items-center gap-2 text-sm">
        <span className="text-zinc-500">Sort by</span>
        <Select className="w-auto" value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="score">Fit score</option><option value="updated">Most recent</option><option value="name">Name</option>
        </Select>
      </div>
      {data.length === 0 ? <Empty title="Nothing to review">Brands with a qualifying email land here after a research batch.</Empty> : (
        <div className="grid gap-3">
          {data.map((p) => (
            <Card key={p.id}>
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-[16rem] flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <a href={`#/discovery/review/${p.id}`} className="font-semibold hover:underline">{p.company_name}</a>
                    <TierBadge tier={p.fit_tier} score={p.fit_score} />
                    {p.category_name && <Badge>{p.category_name}</Badge>}
                    <Badge tone={p.source === 'research' ? 'violet' : 'gray'}>{p.source}</Badge>
                  </div>
                  <div className="mt-1 text-sm text-zinc-500">
                    {p.domain} · {p.primary_email ? <span className="text-emerald-700 dark:text-emerald-400">{p.primary_email}</span> : p.contact_count ? 'Contact form only' : 'No contact found'}
                    {p.last_researched_at && ` · researched ${relative(p.last_researched_at)}`}
                  </div>
                </div>
                <div className="flex gap-2">
                  <a href={`#/discovery/review/${p.id}`}><Button size="sm">Inspect</Button></a>
                  <Button size="sm" variant="danger" onClick={() => decide(p, 'rejected')}>Reject</Button>
                  <Button size="sm" variant="primary" onClick={() => decide(p, 'approved')}>Approve</Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------- Candidate pool ----------

function Candidates({ categories }: { categories: Category[] }) {
  const toast = useToast()
  const [category, setCategory] = useState('')
  const [status, setStatus] = useState('')
  const qs = new URLSearchParams(Object.entries({ category_id: category, status }).filter(([, v]) => v)).toString()
  const { data, error, reload } = useApi<{ summary: PoolSummaryRow[]; entries: PoolEntry[] }>(`/api/research/pool?${qs}`)
  const [f, setF] = useState({ company_name: '', website: '', category_id: '' })
  const add = async () => {
    try {
      await api.post('/api/research/pool', { ...f, category_id: Number(f.category_id) })
      toast(`Added ${f.company_name} as a candidate`)
      setF({ company_name: '', website: '', category_id: f.category_id })
      reload()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }
  const act = async (e: PoolEntry, action: 'release' | 'exclude') => {
    try {
      await api.post(`/api/research/pool/${e.id}/${action}`, action === 'exclude' ? { note: 'Excluded by hand' } : {})
      reload()
    } catch (err) {
      toast((err as Error).message, 'error')
    }
  }
  if (error) return <ErrorBox error={error} />
  return (
    <div className="space-y-6">
      <Notice>
        Candidates are only names and official websites: places to look, not findings. The starter list covers well-known brands in your eight categories.
        Add any brand you want researched; it is checked against the CRM and the pool for duplicates.
      </Notice>
      <Card title="Add a candidate">
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); add() }}>
          <Field label="Company" className="min-w-48 flex-1"><Input required value={f.company_name} onChange={(e) => setF({ ...f, company_name: e.target.value })} /></Field>
          <Field label="Official website" className="min-w-56 flex-1"><Input required value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} placeholder="https://brand.com" /></Field>
          <Field label="Category" className="w-56">
            <Select required value={f.category_id} onChange={(e) => setF({ ...f, category_id: e.target.value })}>
              <option value="">Choose…</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
          <Button type="submit" variant="primary">Add</Button>
        </form>
      </Card>
      <div className="flex flex-wrap gap-2">
        <Select className="w-auto" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
          <option value="">All categories</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <Select className="w-auto" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">Any status</option><option value="available">Available</option><option value="queued">Queued</option>
          <option value="researched">Researched</option><option value="excluded">Excluded</option>
        </Select>
        {data && <span className="self-center text-sm text-zinc-500">{data.entries.length} candidates</span>}
      </div>
      {!data ? <Loading /> : (
        <Card padded={false}>
          <div className="max-h-[60vh] overflow-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <tbody>
                {data.entries.map((e) => (
                  <tr key={e.id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800">
                    <td className="px-4 py-2"><div className="font-medium">{e.company_name}</div><a className="text-xs text-zinc-500 hover:underline" href={e.website} target="_blank" rel="noreferrer noopener">{e.domain}</a></td>
                    <td className="px-4 py-2 text-zinc-600 dark:text-zinc-400">{e.category_name}</td>
                    <td className="px-4 py-2"><Badge>{e.origin}</Badge></td>
                    <td className="px-4 py-2"><Badge tone={e.status === 'available' ? 'green' : e.status === 'queued' ? 'blue' : 'gray'}>{e.in_crm && e.status === 'available' ? 'in CRM' : e.status}</Badge></td>
                    <td className="px-4 py-2 text-right">
                      {(e.status === 'researched' || e.status === 'excluded') && !e.in_crm && <Button size="sm" onClick={() => act(e, 'release')}>Make available</Button>}
                      {e.status === 'available' && !e.in_crm && <Button size="sm" variant="ghost" onClick={() => act(e, 'exclude')}>Exclude</Button>}
                    </td>
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

// ---------- Manual contact queue ----------

function ManualQueue() {
  const { data, error } = useApi<ProspectListItem[]>('/api/prospects?sort=score')
  if (error) return <ErrorBox error={error} />
  if (!data) return <Loading />
  const formOnly = data.filter((p) => p.contact_count > 0 && !p.primary_email && p.review_status !== 'rejected')
  const none = data.filter((p) => p.contact_count === 0 && p.source === 'research' && p.review_status !== 'rejected')
  return (
    <div className="space-y-6">
      <Notice>These companies publish a contact form instead of an email address, or nothing at all. Automatic email never applies to them; reach out by hand if you choose, then log it in the CRM.</Notice>
      <Card title={`Contact form only (${formOnly.length})`} padded={false}>
        {formOnly.length === 0 ? <p className="p-5 text-sm text-zinc-500">None.</p> : (
          <ul>{formOnly.map((p) => (
            <li key={p.id} className="flex items-center justify-between border-b border-zinc-100 px-5 py-3 text-sm last:border-0 dark:border-zinc-800">
              <a className="font-medium hover:underline" href={`#/discovery/manual/${p.id}`}>{p.company_name}</a>
              <TierBadge tier={p.fit_tier} score={p.fit_score} />
            </li>
          ))}</ul>
        )}
      </Card>
      <Card title={`Researched, no published contact (${none.length})`} padded={false}>
        {none.length === 0 ? <p className="p-5 text-sm text-zinc-500">None.</p> : (
          <ul>{none.map((p) => (
            <li key={p.id} className="flex items-center justify-between border-b border-zinc-100 px-5 py-3 text-sm last:border-0 dark:border-zinc-800">
              <a className="font-medium hover:underline" href={`#/discovery/manual/${p.id}`}>{p.company_name}</a>
              <TierBadge tier={p.fit_tier} score={p.fit_score} />
            </li>
          ))}</ul>
        )}
      </Card>
    </div>
  )
}
