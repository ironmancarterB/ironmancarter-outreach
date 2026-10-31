import { useEffect, useState, type ReactNode } from 'react'
import { Badge, Button, Drawer, EligibilityBadge, Field, Input, Loading, Notice, Select, Textarea, TierBadge, useToast } from '../components/ui'
import { api, useApi } from '../lib/api'
import { dateTime, relative, usd } from '../lib/format'
import type { Category, Contact, ProspectDetail as Detail } from '../lib/types'
import { STAGES } from '../../../../packages/core/stages'
import { FIT_FACTORS, fitTier } from '../../../../packages/core/scoring'

export default function ProspectDetail({ id, categories, onClose, onChanged }: { id: number; categories: Category[]; onClose: () => void; onChanged: () => void }) {
  const toast = useToast()
  const { data, error, setData } = useApi<Detail>(`/api/prospects/${id}`)

  // Every mutation returns the refreshed detail.
  const mutate = async (fn: () => Promise<Detail>, ok?: string) => {
    try {
      setData(await fn())
      if (ok) toast(ok)
      onChanged()
      return true
    } catch (e) {
      toast((e as Error).message, 'error')
      return false
    }
  }

  return (
    <Drawer open onClose={onClose} title="Company">
      {error ? <div className="p-6"><Notice tone="red">{error.message}</Notice></div> : !data ? <Loading /> : (
        <DetailBody d={data} categories={categories} mutate={mutate} onClose={onClose} onDeleted={() => { onChanged(); onClose() }} />
      )}
    </Drawer>
  )
}

type Mutate = (fn: () => Promise<Detail>, ok?: string) => Promise<boolean>

function DetailBody({ d, categories, mutate, onClose, onDeleted }: { d: Detail; categories: Category[]; mutate: Mutate; onClose: () => void; onDeleted: () => void }) {
  const p = d.prospect
  const toast = useToast()
  const del = async () => {
    if (!confirm(`Delete ${p.company_name} and all its contacts, notes and sources? The activity log keeps a record of the deletion.`)) return
    try {
      await api.del(`/api/prospects/${p.id}`)
      toast(`Deleted ${p.company_name}`)
      onDeleted()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }
  return (
    <>
      <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white px-6 py-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold">{p.company_name}</h2>
            <div className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-zinc-500">
              {p.website ? <a href={p.website} target="_blank" rel="noreferrer noopener" className="hover:underline">{p.domain} ↗</a> : 'No website'}
              {d.category && <Badge>{d.category.name}</Badge>}
              <TierBadge tier={p.fit_tier} score={p.fit_score} />
            </div>
          </div>
          <button onClick={onClose} className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800" aria-label="Close">✕</button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Select className="w-auto" value={p.stage} aria-label="Stage"
            onChange={(e) => mutate(() => api.post(`/api/prospects/${p.id}/stage`, { stage: e.target.value }), 'Stage updated')}>
            {STAGES.map((s) => <option key={s.id} value={s.id} disabled={s.id === 'approved_autopilot'}>{s.label}{s.id === 'approved_autopilot' ? ' (approval gate, Phase 5)' : ''}</option>)}
          </Select>
          <Button variant="ghost" size="sm" onClick={del} className="ml-auto text-rose-600">Delete</Button>
        </div>
      </header>

      <div className="space-y-5 p-6">
        {d.category?.compliance_note && <Notice tone="amber" title="Category guardrail">{d.category.compliance_note}</Notice>}
        <ProfileSection d={d} categories={categories} mutate={mutate} />
        <ContactsSection d={d} mutate={mutate} />
        <FitSection d={d} mutate={mutate} />
        <DealSection d={d} mutate={mutate} />
        <TagsSection d={d} mutate={mutate} />
        <SourcesSection d={d} mutate={mutate} />
        <NotesSection d={d} mutate={mutate} />
        <Section title="Activity history">
          <ul className="space-y-2 text-sm">
            {d.activities.map((a) => (
              <li key={a.id} className="flex justify-between gap-3">
                <span className="text-zinc-700 dark:text-zinc-300">{a.summary}</span>
                <span className="shrink-0 text-xs text-zinc-400" title={a.created_at}>{dateTime(a.created_at)}</span>
              </li>
            ))}
          </ul>
        </Section>
      </div>
    </>
  )
}

function Section({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  )
}

const Row = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="grid grid-cols-[9rem_1fr] gap-3 py-1 text-sm">
    <dt className="text-zinc-500">{label}</dt>
    <dd className="whitespace-pre-wrap break-words">{children || <span className="text-zinc-400">—</span>}</dd>
  </div>
)

function ProfileSection({ d, categories, mutate }: { d: Detail; categories: Category[]; mutate: Mutate }) {
  const p = d.prospect
  const [editing, setEditing] = useState(false)
  const init = () => ({ company_name: p.company_name, website: p.website ?? '', category_id: p.category_id ? String(p.category_id) : '', products: p.products ?? '',
    sponsorship_evidence: p.sponsorship_evidence ?? '', campaign_concept: p.campaign_concept ?? '', research_confidence: p.research_confidence ?? '' })
  const [f, setF] = useState(init)
  useEffect(() => { if (!editing) setF(init()) }, [d, editing])
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  const save = async () => {
    const ok = await mutate(() => api.patch(`/api/prospects/${p.id}`, {
      ...f, website: f.website || null, category_id: f.category_id ? Number(f.category_id) : null, research_confidence: f.research_confidence || null,
    }), 'Saved')
    if (ok) setEditing(false)
  }
  return (
    <Section title="Company profile" actions={!editing && <Button size="sm" onClick={() => setEditing(true)}>Edit</Button>}>
      {editing ? (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Company name"><Input value={f.company_name} onChange={set('company_name')} /></Field>
            <Field label="Website"><Input value={f.website} onChange={set('website')} /></Field>
            <Field label="Category">
              <Select value={f.category_id} onChange={set('category_id')}>
                <option value="">None</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </Field>
            <Field label="Research confidence">
              <Select value={f.research_confidence} onChange={set('research_confidence')}>
                <option value="">Not set</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
              </Select>
            </Field>
          </div>
          <Field label="Relevant products"><Input value={f.products} onChange={set('products')} /></Field>
          <Field label="Evidence of creator sponsorships"><Textarea value={f.sponsorship_evidence} onChange={set('sponsorship_evidence')} /></Field>
          <Field label="Campaign concept"><Textarea value={f.campaign_concept} onChange={set('campaign_concept')} /></Field>
          <div className="flex justify-end gap-2"><Button onClick={() => setEditing(false)}>Cancel</Button><Button variant="primary" onClick={save}>Save</Button></div>
        </div>
      ) : (
        <dl>
          <Row label="Products">{p.products}</Row>
          <Row label="Sponsorship evidence">{p.sponsorship_evidence}</Row>
          <Row label="Campaign concept">{p.campaign_concept}</Row>
          <Row label="Research confidence">{p.research_confidence}</Row>
          <Row label="Added">{`${relative(p.created_at)} · ${p.source}`}</Row>
        </dl>
      )}
    </Section>
  )
}

function ContactsSection({ d, mutate }: { d: Detail; mutate: Mutate }) {
  const [adding, setAdding] = useState(false)
  return (
    <Section title="Contacts & eligibility" actions={!adding && <Button size="sm" onClick={() => setAdding(true)}>Add contact</Button>}>
      {d.contacts.length === 0 && !adding && <p className="text-sm text-zinc-500">No contacts. Only add addresses or forms the company publishes for partnership inquiries.</p>}
      <ul className="space-y-3">
        {d.contacts.map((c) => <ContactRow key={c.id} c={c} mutate={mutate} />)}
      </ul>
      {adding && <ContactForm onCancel={() => setAdding(false)} onSave={async (body) => {
        const ok = await mutate(() => api.post(`/api/prospects/${d.prospect.id}/contacts`, body), 'Contact added')
        if (ok) setAdding(false)
      }} />}
      <p className="mt-3 text-xs text-zinc-500">Eligibility shows whether a contact could ever be emailed automatically. Nothing is sent in this build.</p>
    </Section>
  )
}

function ContactRow({ c, mutate }: { c: Contact; mutate: Mutate }) {
  const [editing, setEditing] = useState(false)
  if (editing) {
    return <li><ContactForm initial={c} onCancel={() => setEditing(false)} onSave={async (body) => {
      const ok = await mutate(() => api.patch(`/api/contacts/${c.id}`, body), 'Contact updated')
      if (ok) setEditing(false)
    }} /></li>
  }
  return (
    <li className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{c.email ?? 'Contact form'}</span>
        {c.is_primary ? <Badge tone="blue">Primary</Badge> : null}
        <EligibilityBadge status={c.eligibility.status} />
        <Badge tone={c.verification_status === 'verified' ? 'green' : c.verification_status === 'failed' ? 'red' : 'gray'}>
          {c.verification_status}{c.verified_at ? ` ${relative(c.verified_at)}` : ''}
        </Badge>
        <Badge>{c.jurisdiction === 'unknown' ? 'Jurisdiction unknown' : c.jurisdiction}</Badge>
      </div>
      {(c.name || c.role) && <div className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{[c.name, c.role].filter(Boolean).join(' · ')}</div>}
      <div className="mt-1 space-y-0.5 text-xs text-zinc-500">
        {c.source_url ? <div>Source: <a className="text-brand-600 hover:underline" href={c.source_url} target="_blank" rel="noreferrer noopener">{c.source_url}</a></div> : <div className="text-amber-600">No source URL recorded</div>}
        {c.contact_form_url && <div>Form: <a className="text-brand-600 hover:underline" href={c.contact_form_url} target="_blank" rel="noreferrer noopener">{c.contact_form_url}</a></div>}
      </div>
      <ul className="mt-2 list-disc pl-5 text-xs text-zinc-500">{c.eligibility.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" onClick={() => setEditing(true)}>Edit</Button>
        {c.verification_status !== 'verified' && (
          <Button size="sm" disabled={!c.source_url} title={c.source_url ? 'I opened the source page and the contact is published there' : 'Add a source URL first'}
            onClick={() => mutate(() => api.patch(`/api/contacts/${c.id}`, { verification_status: 'verified' }), 'Marked verified')}>
            Mark verified
          </Button>
        )}
        <Button size="sm" variant="ghost" className="text-rose-600" onClick={() => confirm('Remove this contact?') && mutate(() => api.del(`/api/contacts/${c.id}`), 'Contact removed')}>Remove</Button>
      </div>
    </li>
  )
}

function ContactForm({ initial, onSave, onCancel }: { initial?: Contact; onSave: (body: Record<string, unknown>) => void; onCancel: () => void }) {
  const [f, setF] = useState({ email: initial?.email ?? '', name: initial?.name ?? '', role: initial?.role ?? '', source_url: initial?.source_url ?? '',
    contact_form_url: initial?.contact_form_url ?? '', jurisdiction: initial?.jurisdiction ?? 'unknown', is_primary: initial ? !!initial.is_primary : true })
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  return (
    <form className="mt-3 space-y-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800" onSubmit={(e) => {
      e.preventDefault()
      onSave({ ...f, email: f.email || null, name: f.name || null, role: f.role || null, source_url: f.source_url || null, contact_form_url: f.contact_form_url || null })
    }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Email"><Input type="email" value={f.email} onChange={set('email')} /></Field>
        <Field label="Source URL (where it's published)"><Input value={f.source_url} onChange={set('source_url')} /></Field>
        <Field label="Name"><Input value={f.name} onChange={set('name')} /></Field>
        <Field label="Role"><Input value={f.role} onChange={set('role')} /></Field>
        <Field label="Contact form URL"><Input value={f.contact_form_url} onChange={set('contact_form_url')} /></Field>
        <Field label="Jurisdiction" hint="2-letter country code, or unknown"><Input value={f.jurisdiction} onChange={set('jurisdiction')} /></Field>
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.is_primary} onChange={(e) => setF({ ...f, is_primary: e.target.checked })} /> Primary contact</label>
      {initial && <p className="text-xs text-zinc-500">Changing the email or source URL resets verification.</p>}
      <div className="flex justify-end gap-2"><Button onClick={onCancel}>Cancel</Button><Button type="submit" variant="primary">Save contact</Button></div>
    </form>
  )
}

function FitSection({ d, mutate }: { d: Detail; mutate: Mutate }) {
  const p = d.prospect
  const [editing, setEditing] = useState(false)
  const [b, setB] = useState<Record<string, string>>({})
  const [explanation, setExplanation] = useState('')
  const start = () => {
    setB(Object.fromEntries(FIT_FACTORS.map((f) => [f.key, String(p.fit_breakdown?.[f.key] ?? '')])))
    setExplanation(p.fit_explanation ?? '')
    setEditing(true)
  }
  const total = FIT_FACTORS.reduce((n, f) => n + (Number(b[f.key]) || 0), 0)
  const save = async () => {
    const breakdown = Object.fromEntries(FIT_FACTORS.map((f) => [f.key, Number(b[f.key]) || 0]))
    const ok = await mutate(() => api.patch(`/api/prospects/${p.id}`, { fit_breakdown: breakdown, fit_explanation: explanation }), 'Score saved')
    if (ok) setEditing(false)
  }
  return (
    <Section title="Sponsorship fit" actions={!editing && <Button size="sm" onClick={start}>{p.fit_score == null ? 'Score' : 'Edit score'}</Button>}>
      {editing ? (
        <div className="space-y-3">
          {FIT_FACTORS.map((f) => (
            <div key={f.key} className="grid grid-cols-[1fr_5rem] items-center gap-3 text-sm">
              <label htmlFor={`fit-${f.key}`}>{f.label} <span className="text-zinc-400">/ {f.max}</span></label>
              <Input id={`fit-${f.key}`} type="number" min={0} max={f.max} value={b[f.key]} onChange={(e) => setB({ ...b, [f.key]: e.target.value })} />
            </div>
          ))}
          <div className="text-sm font-medium">Total: {total} / 100 · Tier {fitTier(total)}</div>
          <Field label="Explanation (required, based on evidence)"><Textarea value={explanation} onChange={(e) => setExplanation(e.target.value)} /></Field>
          <div className="flex justify-end gap-2"><Button onClick={() => setEditing(false)}>Cancel</Button><Button variant="primary" onClick={save} disabled={!explanation.trim()}>Save score</Button></div>
        </div>
      ) : p.fit_score == null ? (
        <p className="text-sm text-zinc-500">Not scored. Automated scoring arrives with research in Phase 2. A score never authorizes sending by itself.</p>
      ) : (
        <div className="space-y-2 text-sm">
          {FIT_FACTORS.map((f) => (
            <div key={f.key} className="grid grid-cols-[1fr_8rem_3rem] items-center gap-3">
              <span className="text-zinc-600 dark:text-zinc-400">{f.label}</span>
              <span className="h-1.5 rounded-full bg-zinc-100 dark:bg-zinc-800"><span className="block h-1.5 rounded-full bg-brand-500" style={{ width: `${((p.fit_breakdown?.[f.key] ?? 0) / f.max) * 100}%` }} /></span>
              <span className="text-right tabular-nums">{p.fit_breakdown?.[f.key] ?? 0}/{f.max}</span>
            </div>
          ))}
          <p className="pt-1 text-zinc-700 dark:text-zinc-300">{p.fit_explanation}</p>
        </div>
      )}
    </Section>
  )
}

function DealSection({ d, mutate }: { d: Detail; mutate: Mutate }) {
  const p = d.prospect
  const [editing, setEditing] = useState(false)
  const init = () => ({
    potential: p.potential_value_cents != null ? String(p.potential_value_cents / 100) : '',
    negotiated: p.negotiated_value_cents != null ? String(p.negotiated_value_cents / 100) : '',
    contract_duration: p.contract_duration ?? '', deliverables: p.deliverables ?? '', usage_rights: p.usage_rights ?? '',
    payment_status: p.payment_status, renewal_date: p.renewal_date ?? '', next_follow_up_date: p.next_follow_up_date ?? '',
  })
  const [f, setF] = useState(init)
  const set = (k: keyof ReturnType<typeof init>) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  const toCents = (s: string) => (s === '' ? null : Math.round(Number(s) * 100))
  const save = async () => {
    const ok = await mutate(() => api.patch(`/api/prospects/${p.id}`, {
      potential_value_cents: toCents(f.potential), negotiated_value_cents: toCents(f.negotiated), contract_duration: f.contract_duration || null,
      deliverables: f.deliverables || null, usage_rights: f.usage_rights || null, payment_status: f.payment_status,
      renewal_date: f.renewal_date || null, next_follow_up_date: f.next_follow_up_date || null,
    }), 'Deal saved')
    if (ok) setEditing(false)
  }
  return (
    <Section title="Deal" actions={!editing && <Button size="sm" onClick={() => { setF(init()); setEditing(true) }}>Edit</Button>}>
      {editing ? (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Potential value (USD)"><Input type="number" min="0" value={f.potential} onChange={set('potential')} /></Field>
            <Field label="Negotiated value (USD)"><Input type="number" min="0" value={f.negotiated} onChange={set('negotiated')} /></Field>
            <Field label="Contract duration"><Input value={f.contract_duration} onChange={set('contract_duration')} placeholder="e.g. 3 months" /></Field>
            <Field label="Payment status">
              <Select value={f.payment_status} onChange={set('payment_status')}>
                <option value="none">None</option><option value="invoiced">Invoiced</option><option value="partial">Partially paid</option><option value="paid">Paid</option>
              </Select>
            </Field>
            <Field label="Renewal date"><Input type="date" value={f.renewal_date} onChange={set('renewal_date')} /></Field>
            <Field label="Follow-up reminder"><Input type="date" value={f.next_follow_up_date} onChange={set('next_follow_up_date')} /></Field>
          </div>
          <Field label="Deliverables"><Textarea value={f.deliverables} onChange={set('deliverables')} /></Field>
          <Field label="Usage rights" hint="Record only what was agreed. Nothing is granted by default."><Textarea value={f.usage_rights} onChange={set('usage_rights')} /></Field>
          <div className="flex justify-end gap-2"><Button onClick={() => setEditing(false)}>Cancel</Button><Button variant="primary" onClick={save}>Save</Button></div>
        </div>
      ) : (
        <dl>
          <Row label="Potential value">{p.potential_value_cents != null ? usd(p.potential_value_cents) : null}</Row>
          <Row label="Negotiated value">{p.negotiated_value_cents != null ? usd(p.negotiated_value_cents) : null}</Row>
          <Row label="Contract duration">{p.contract_duration}</Row>
          <Row label="Deliverables">{p.deliverables}</Row>
          <Row label="Usage rights">{p.usage_rights}</Row>
          <Row label="Payment status">{p.payment_status === 'none' ? null : p.payment_status}</Row>
          <Row label="Renewal date">{p.renewal_date}</Row>
          <Row label="Follow-up reminder">{p.next_follow_up_date}</Row>
        </dl>
      )}
    </Section>
  )
}

function TagsSection({ d, mutate }: { d: Detail; mutate: Mutate }) {
  const [value, setValue] = useState('')
  const save = (tags: string[]) => mutate(() => api.put(`/api/prospects/${d.prospect.id}/tags`, { tags }))
  return (
    <Section title="Tags">
      <div className="flex flex-wrap items-center gap-1.5">
        {d.tags.map((t) => (
          <span key={t} className="inline-flex items-center gap-1 rounded-md bg-zinc-100 px-2 py-0.5 text-xs dark:bg-zinc-800">
            {t}<button onClick={() => save(d.tags.filter((x) => x !== t))} className="text-zinc-400 hover:text-rose-600" aria-label={`Remove ${t}`}>✕</button>
          </span>
        ))}
        <form onSubmit={(e) => { e.preventDefault(); if (value.trim()) { save([...d.tags, value.trim()]); setValue('') } }}>
          <Input className="h-7 w-36 py-0.5 text-xs" placeholder="Add tag…" value={value} onChange={(e) => setValue(e.target.value)} />
        </form>
      </div>
    </Section>
  )
}

function SourcesSection({ d, mutate }: { d: Detail; mutate: Mutate }) {
  const [f, setF] = useState({ url: '', title: '', kind: 'sponsorship_evidence' })
  return (
    <Section title="Research sources">
      {d.sources.length === 0 && <p className="mb-3 text-sm text-zinc-500">No sources yet. Every claim in a pitch should trace back to one.</p>}
      <ul className="mb-3 space-y-1.5 text-sm">
        {d.sources.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-2">
            <Badge>{s.kind.replace(/_/g, ' ')}</Badge>
            <a href={s.url} target="_blank" rel="noreferrer noopener" className="break-all text-brand-600 hover:underline">{s.title || s.url}</a>
            <span className="text-xs text-zinc-400">{relative(s.retrieved_at)}</span>
          </li>
        ))}
      </ul>
      <form className="flex flex-wrap gap-2" onSubmit={async (e) => {
        e.preventDefault()
        if (await mutate(() => api.post(`/api/prospects/${d.prospect.id}/sources`, f), 'Source added')) setF({ ...f, url: '', title: '' })
      }}>
        <Input className="min-w-48 flex-1" placeholder="https://…" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} required />
        <Input className="w-40" placeholder="Title (optional)" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        <Select className="w-auto" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
          <option value="sponsorship_evidence">Sponsorship evidence</option><option value="partnership_page">Partnership page</option>
          <option value="contact">Contact</option><option value="website">Website</option><option value="other">Other</option>
        </Select>
        <Button type="submit">Add</Button>
      </form>
    </Section>
  )
}

function NotesSection({ d, mutate }: { d: Detail; mutate: Mutate }) {
  const [body, setBody] = useState('')
  return (
    <Section title="Notes">
      <form className="mb-3 space-y-2" onSubmit={async (e) => {
        e.preventDefault()
        if (await mutate(() => api.post(`/api/prospects/${d.prospect.id}/notes`, { body }), 'Note added')) setBody('')
      }}>
        <Textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Add a note…" />
        <div className="flex justify-end"><Button type="submit" disabled={!body.trim()}>Add note</Button></div>
      </form>
      <ul className="space-y-3">
        {d.notes.map((n) => (
          <li key={n.id} className="border-l-2 border-zinc-200 pl-3 text-sm dark:border-zinc-700">
            <div className="whitespace-pre-wrap">{n.body}</div>
            <div className="mt-0.5 text-xs text-zinc-400">{dateTime(n.created_at)}</div>
          </li>
        ))}
      </ul>
    </Section>
  )
}
