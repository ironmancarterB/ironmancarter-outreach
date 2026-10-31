import { useEffect, useMemo, useState, type DragEvent } from 'react'
import { Badge, Button, cx, Empty, ErrorBox, Field, Input, Loading, Modal, Notice, PageHeader, Select, Textarea, TierBadge, useToast } from '../components/ui'
import { api, ApiError, useApi } from '../lib/api'
import { relative, usd } from '../lib/format'
import { navigate } from '../lib/router'
import type { Category, ProspectListItem } from '../lib/types'
import { STAGES, stageLabel } from '../../../../packages/core/stages'
import ProspectDetail from './ProspectDetail'

type View = 'board' | 'table'

function readView(): View {
  try {
    return localStorage.getItem('prospects.view') === 'table' ? 'table' : 'board'
  } catch {
    return 'board'
  }
}

export default function Prospects({ openId }: { openId: number | null }) {
  const toast = useToast()
  const [view, setViewState] = useState<View>(readView)
  const setView = (v: View) => {
    setViewState(v)
    try { localStorage.setItem('prospects.view', v) } catch { /* ignore */ }
  }
  const [q, setQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')
  const [stage, setStage] = useState('')
  const [category, setCategory] = useState('')
  const [tier, setTier] = useState('')
  const [tag, setTag] = useState('')
  const [sort, setSort] = useState('updated')
  const [dir, setDir] = useState<'asc' | 'desc'>('desc')
  const [showNew, setShowNew] = useState(false)
  const [showImport, setShowImport] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 200)
    return () => clearTimeout(t)
  }, [q])

  const qs = new URLSearchParams(Object.entries({ q: debouncedQ, stage, category_id: category, tier, tag, sort, dir }).filter(([, v]) => v)).toString()
  const { data, error, reload } = useApi<ProspectListItem[]>(`/api/prospects?${qs}`)
  const { data: categories } = useApi<Category[]>('/api/categories')
  const { data: tags } = useApi<{ name: string; count: number }[]>(`/api/tags?r=${data?.length ?? 0}`)

  const moveTo = async (id: number, to: string) => {
    try {
      await api.post(`/api/prospects/${id}/stage`, { stage: to })
      toast(`Moved to ${stageLabel(to)}`)
      reload()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  const sortBy = (col: string) => {
    if (sort === col) setDir(dir === 'asc' ? 'desc' : 'asc')
    else { setSort(col); setDir(col === 'name' ? 'asc' : 'desc') }
  }

  return (
    <>
      <PageHeader
        title="Prospects"
        subtitle="Sponsorship CRM: every company, contact, source and stage change is recorded."
        actions={<>
          <a href="/api/export/prospects.csv"><Button>Export CSV</Button></a>
          <Button onClick={() => setShowImport(true)}>Import CSV</Button>
          <Button variant="primary" onClick={() => setShowNew(true)}>Add company</Button>
        </>}
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Input className="max-w-xs" placeholder="Search name, domain, email, tag…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
        <Select className="w-auto" value={stage} onChange={(e) => setStage(e.target.value)} aria-label="Stage">
          <option value="">All stages</option>
          {STAGES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </Select>
        <Select className="w-auto" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
          <option value="">All categories</option>
          {categories?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <Select className="w-auto" value={tier} onChange={(e) => setTier(e.target.value)} aria-label="Fit tier">
          <option value="">Any tier</option>
          <option value="A">Tier A (80–100)</option>
          <option value="B">Tier B (60–79)</option>
          <option value="C">Tier C (&lt;60)</option>
        </Select>
        {!!tags?.length && (
          <Select className="w-auto" value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Tag">
            <option value="">Any tag</option>
            {tags.map((t) => <option key={t.name} value={t.name}>{t.name} ({t.count})</option>)}
          </Select>
        )}
        <div className="ml-auto flex rounded-lg border border-zinc-300 p-0.5 text-sm dark:border-zinc-700" role="group" aria-label="View">
          {(['board', 'table'] as const).map((v) => (
            <button key={v} onClick={() => setView(v)} className={cx('rounded-md px-3 py-1 capitalize', view === v ? 'bg-brand-600 text-white' : 'text-zinc-600 dark:text-zinc-300')}>{v}</button>
          ))}
        </div>
      </div>

      {error ? <ErrorBox error={error} /> : !data ? <Loading /> : data.length === 0 && !(debouncedQ || stage || category || tier || tag) ? (
        <Empty title="No companies yet">Add a company by hand or import a CSV. Brand research (Phase 2) will fill this automatically, using only verified sources.</Empty>
      ) : view === 'board' ? (
        <Board items={data} onMove={moveTo} />
      ) : (
        <Table items={data} sort={sort} dir={dir} onSort={sortBy} />
      )}

      {showNew && <NewProspectModal categories={categories ?? []} onClose={() => setShowNew(false)} onCreated={(id) => { setShowNew(false); reload(); navigate(`/prospects/${id}`) }} />}
      {showImport && <ImportModal onClose={() => setShowImport(false)} onDone={() => { setShowImport(false); reload() }} />}
      {openId && <ProspectDetail id={openId} categories={categories ?? []} onClose={() => navigate('/prospects')} onChanged={reload} />}
    </>
  )
}

function Board({ items, onMove }: { items: ProspectListItem[]; onMove: (id: number, stage: string) => void }) {
  const [over, setOver] = useState<string | null>(null)
  const byStage = useMemo(() => {
    const m: Record<string, ProspectListItem[]> = {}
    for (const s of STAGES) m[s.id] = []
    for (const p of items) m[p.stage]?.push(p)
    return m
  }, [items])
  const onDrop = (e: DragEvent, stage: string) => {
    e.preventDefault()
    setOver(null)
    const id = Number(e.dataTransfer.getData('text/plain'))
    const item = items.find((p) => p.id === id)
    if (item && item.stage !== stage) onMove(id, stage)
  }
  return (
    <div className="-mx-4 overflow-x-auto px-4 pb-4 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
      <div className="flex gap-3" style={{ minWidth: STAGES.length * 236 }}>
        {STAGES.map((s) => (
          <div key={s.id}
            onDragOver={(e) => { e.preventDefault(); setOver(s.id) }}
            onDragLeave={() => setOver((o) => (o === s.id ? null : o))}
            onDrop={(e) => onDrop(e, s.id)}
            className={cx('flex w-56 shrink-0 flex-col rounded-xl border bg-zinc-100/70 dark:bg-zinc-900/60',
              over === s.id ? 'border-brand-500' : 'border-transparent')}>
            <div className="flex items-center justify-between px-3 py-2.5">
              <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{s.label}</span>
              <span className="rounded bg-white px-1.5 text-xs tabular-nums text-zinc-500 dark:bg-zinc-800">{byStage[s.id].length}</span>
            </div>
            <div className="flex min-h-24 flex-col gap-2 px-2 pb-2">
              {byStage[s.id].map((p) => (
                <a key={p.id} href={`#/prospects/${p.id}`} draggable
                  onDragStart={(e) => e.dataTransfer.setData('text/plain', String(p.id))}
                  className="block cursor-grab rounded-lg border border-zinc-200 bg-white p-3 text-sm shadow-sm hover:border-brand-500 active:cursor-grabbing dark:border-zinc-800 dark:bg-zinc-900">
                  <div className="font-medium leading-snug">{p.company_name}</div>
                  <div className="mt-0.5 truncate text-xs text-zinc-500">{p.domain ?? 'No website'}</div>
                  <div className="mt-2 flex flex-wrap items-center gap-1">
                    <TierBadge tier={p.fit_tier} score={p.fit_score} />
                    {p.category_name && <Badge>{p.category_name}</Badge>}
                  </div>
                  {(p.negotiated_value_cents ?? p.potential_value_cents) != null && (
                    <div className="mt-2 text-xs tabular-nums text-zinc-600 dark:text-zinc-400">{usd(p.negotiated_value_cents ?? p.potential_value_cents)}</div>
                  )}
                </a>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function Table({ items, sort, dir, onSort }: { items: ProspectListItem[]; sort: string; dir: string; onSort: (c: string) => void }) {
  const H = ({ col, children, className }: { col?: string; children: string; className?: string }) => (
    <th className={cx('px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500', className)}>
      {col ? <button onClick={() => onSort(col)} className="hover:text-zinc-800 dark:hover:text-zinc-200">{children}{sort === col ? (dir === 'asc' ? ' ↑' : ' ↓') : ''}</button> : children}
    </th>
  )
  if (!items.length) return <Empty title="No matches">Try clearing a filter.</Empty>
  return (
    <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <table className="w-full min-w-[56rem] text-sm">
        <thead className="border-b border-zinc-200 dark:border-zinc-800">
          <tr><H col="name">Company</H><H>Category</H><H>Stage</H><H col="score">Fit</H><H>Contact</H><H>Tags</H><H col="value" className="text-right">Value</H><H col="updated">Updated</H></tr>
        </thead>
        <tbody>
          {items.map((p) => (
            <tr key={p.id} onClick={() => navigate(`/prospects/${p.id}`)} className="cursor-pointer border-b border-zinc-100 last:border-0 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800/50">
              <td className="px-3 py-2.5"><div className="font-medium">{p.company_name}</div><div className="text-xs text-zinc-500">{p.domain ?? '—'}</div></td>
              <td className="px-3 py-2.5 text-zinc-600 dark:text-zinc-400">{p.category_name ?? '—'}</td>
              <td className="px-3 py-2.5"><Badge tone="blue">{stageLabel(p.stage)}</Badge></td>
              <td className="px-3 py-2.5"><TierBadge tier={p.fit_tier} score={p.fit_score} /></td>
              <td className="px-3 py-2.5 text-zinc-600 dark:text-zinc-400">{p.primary_email ?? (p.contact_count ? 'Form only' : '—')}</td>
              <td className="px-3 py-2.5"><div className="flex flex-wrap gap-1">{p.tags.map((t) => <Badge key={t}>{t}</Badge>)}</div></td>
              <td className="px-3 py-2.5 text-right tabular-nums">{usd(p.negotiated_value_cents ?? p.potential_value_cents)}</td>
              <td className="px-3 py-2.5 text-zinc-500">{relative(p.updated_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

type Dupe = { prospect_id: number; company_name: string; reason: string; value: string }

function NewProspectModal({ categories, onClose, onCreated }: { categories: Category[]; onClose: () => void; onCreated: (id: number) => void }) {
  const toast = useToast()
  const [f, setF] = useState({ company_name: '', website: '', category_id: '', products: '', sponsorship_evidence: '', campaign_concept: '', potential_value: '', tags: '',
    email: '', contact_name: '', contact_role: '', source_url: '', contact_form_url: '' })
  const [dupes, setDupes] = useState<Dupe[]>([])
  const [needsConfirm, setNeedsConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })

  const check = async () => {
    if (!f.company_name && !f.website && !f.email) return
    try {
      setDupes(await api.post<Dupe[]>('/api/prospects/check-duplicates', { company_name: f.company_name, website: f.website, email: f.email }))
    } catch { /* checked again on save */ }
  }

  const save = async (allowSimilarName = false) => {
    setBusy(true)
    try {
      const contact = f.email || f.contact_form_url
        ? { email: f.email || null, name: f.contact_name || null, role: f.contact_role || null, source_url: f.source_url || null, contact_form_url: f.contact_form_url || null }
        : undefined
      const res = await api.post<{ prospect: { id: number } }>('/api/prospects', {
        company_name: f.company_name,
        website: f.website || null,
        category_id: f.category_id ? Number(f.category_id) : null,
        products: f.products || null,
        sponsorship_evidence: f.sponsorship_evidence || null,
        campaign_concept: f.campaign_concept || null,
        potential_value_cents: f.potential_value ? Math.round(Number(f.potential_value) * 100) : null,
        tags: f.tags.split(',').map((t) => t.trim()).filter(Boolean),
        contact,
        allowSimilarName,
      })
      toast(`Added ${f.company_name}`)
      onCreated(res.prospect.id)
    } catch (e) {
      if (e instanceof ApiError && e.code === 'possible_duplicate') {
        setDupes(e.details as Dupe[])
        setNeedsConfirm(true)
      } else toast((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const hard = dupes.filter((d) => d.reason !== 'name')
  return (
    <Modal open onClose={onClose} title="Add company" wide>
      <form onSubmit={(e) => { e.preventDefault(); save(needsConfirm) }} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Company name *"><Input required value={f.company_name} onChange={set('company_name')} onBlur={check} autoFocus /></Field>
          <Field label="Official website"><Input value={f.website} onChange={set('website')} onBlur={check} placeholder="https://brand.com" /></Field>
          <Field label="Category">
            <Select value={f.category_id} onChange={set('category_id')}>
              <option value="">Choose…</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
          <Field label="Potential deal value (USD)"><Input type="number" min="0" step="1" value={f.potential_value} onChange={set('potential_value')} /></Field>
        </div>
        <Field label="Relevant products"><Input value={f.products} onChange={set('products')} /></Field>
        <Field label="Evidence of creator sponsorships" hint="Only what you can point to. Add the source link in the company's Research sources."><Textarea value={f.sponsorship_evidence} onChange={set('sponsorship_evidence')} /></Field>
        <Field label="Campaign concept"><Textarea value={f.campaign_concept} onChange={set('campaign_concept')} /></Field>
        <Field label="Tags (comma separated)"><Input value={f.tags} onChange={set('tags')} /></Field>

        <fieldset className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <legend className="px-1 text-xs font-semibold text-zinc-500">Partnership contact (optional)</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Email"><Input type="email" value={f.email} onChange={set('email')} onBlur={check} placeholder="partnerships@brand.com" /></Field>
            <Field label="Where it was published (source URL)"><Input value={f.source_url} onChange={set('source_url')} placeholder="https://brand.com/partners" /></Field>
            <Field label="Name"><Input value={f.contact_name} onChange={set('contact_name')} /></Field>
            <Field label="Role"><Input value={f.contact_role} onChange={set('contact_role')} /></Field>
            <Field label="Contact form URL" className="sm:col-span-2"><Input value={f.contact_form_url} onChange={set('contact_form_url')} /></Field>
          </div>
          <p className="mt-2 text-xs text-zinc-500">New contacts start unverified. Never enter guessed addresses.</p>
        </fieldset>

        {hard.length > 0 && <Notice tone="red" title="Already in the CRM">{hard.map((d) => <div key={d.prospect_id + d.reason}><a className="underline" href={`#/prospects/${d.prospect_id}`}>{d.company_name}</a> has the same {d.reason} ({d.value}).</div>)}</Notice>}
        {hard.length === 0 && dupes.length > 0 && (
          <Notice tone="amber" title="Possible duplicate">
            {dupes.map((d) => <div key={d.prospect_id}><a className="underline" href={`#/prospects/${d.prospect_id}`}>{d.company_name}</a> has a similar name.</div>)}
            {needsConfirm && <div className="mt-1">If this is a different company, choose “Add anyway”.</div>}
          </Notice>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy || hard.length > 0}>{needsConfirm ? 'Add anyway' : 'Add company'}</Button>
        </div>
      </form>
    </Modal>
  )
}

type ImportResult = { results: { row: number; company_name: string; status: string; message?: string }[]; created: number }

function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast()
  const [csv, setCsv] = useState('')
  const [preview, setPreview] = useState<ImportResult | null>(null)
  const [busy, setBusy] = useState(false)
  const run = async (dryRun: boolean) => {
    setBusy(true)
    try {
      const r = await api.post<ImportResult>('/api/import/prospects', { csv, dryRun })
      if (dryRun) setPreview(r)
      else { toast(`Imported ${r.created} companies`); onDone() }
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }
  const tone = (s: string) => (s === 'created' ? 'green' : s === 'error' ? 'red' : 'amber') as 'green' | 'red' | 'amber'
  return (
    <Modal open onClose={onClose} title="Import companies from CSV" wide>
      <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-400">
        Columns: <code className="text-xs">company_name</code> (required), website, category, stage, products, sponsorship_evidence, campaign_concept,
        potential_value_usd, negotiated_value_usd, tags (separated by ;), contact_name, contact_role, contact_email, contact_source_url, contact_form_url, notes.
        Duplicates are skipped. Imported contacts start unverified.
      </p>
      <input type="file" accept=".csv,text/csv" className="mb-3 block text-sm" onChange={async (e) => {
        const file = e.target.files?.[0]
        if (file) { setCsv(await file.text()); setPreview(null) }
      }} />
      <Textarea className="h-40 font-mono text-xs" value={csv} onChange={(e) => { setCsv(e.target.value); setPreview(null) }} placeholder="…or paste CSV here" />
      {preview && (
        <div className="mt-4 max-h-64 overflow-y-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-sm">
            <tbody>
              {preview.results.map((r) => (
                <tr key={r.row} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800">
                  <td className="px-3 py-1.5 text-xs text-zinc-400">Row {r.row}</td>
                  <td className="px-3 py-1.5">{r.company_name || <em>blank</em>}</td>
                  <td className="px-3 py-1.5"><Badge tone={tone(r.status)}>{r.status.replace('_', ' ')}</Badge></td>
                  <td className="px-3 py-1.5 text-xs text-zinc-500">{r.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        {!preview ? <Button variant="primary" disabled={!csv.trim() || busy} onClick={() => run(true)}>Check file</Button>
          : <Button variant="primary" disabled={!preview.created || busy} onClick={() => run(false)}>Import {preview.created} {preview.created === 1 ? 'company' : 'companies'}</Button>}
      </div>
    </Modal>
  )
}
