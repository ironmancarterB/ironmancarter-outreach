// Contact Discovery: how every company can be reached, with the source and reason behind each contact.
// "Find more contacts" queues bounded, cached research in the research worker. Nothing here sends anything.
import { useState } from 'react'
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, Modal, Notice, PageHeader, Select, Tabs, Textarea, useToast } from '../components/ui'
import { api, useApi, usePoll } from '../lib/api'
import { dateTime, relative } from '../lib/format'
import { navigate } from '../lib/router'

type Status = 'VERIFIED_DIRECT' | 'VERIFIED_AGENCY' | 'VERIFIED_PORTAL' | 'PUBLIC_UNVERIFIED' | 'NO_CONTACT'
interface ContactRow {
  id: number; email: string | null; contact_form_url: string | null; source_url: string | null; role: string | null; contact_tier: string; contact_type: string | null
  source_category: string | null; evidence: string | null; confidence: string | null; agency_name: string | null; agency_confirmed: string | null; decision_note: string | null
  manually_verified: number; verification_status: string; verified_at: string | null; last_checked_at: string | null; jurisdiction: string; discovered_by: string
}
interface Row {
  id: number; company_name: string; domain: string | null; review_status: string; stage: string; fit_score: number | null; last_researched_at: string | null
  status: Status; contacts: ContactRow[]; findings: number
  lastRun: { id: number; status: string; queued_at: string; finished_at: string | null; error: string | null; summary: { newDirect: number; newAgency: number; newPortals: number; needsReview: number; pagesFetched: number; pagesCached: number } | null } | null
}
interface Data { counts: Record<Status, number>; rows: Row[]; queue: number }
interface Finding { id: number; kind: string; value: string | null; source_url: string; decision: 'accepted' | 'needs_review' | 'rejected'; tier: string | null; reason: string; evidence: string | null; created_at: string }

const STATUS: Record<Status, { label: string; tone: 'green' | 'blue' | 'violet' | 'amber' | 'gray' }> = {
  VERIFIED_DIRECT: { label: 'Verified email', tone: 'green' },
  VERIFIED_AGENCY: { label: 'Verified agency', tone: 'violet' },
  VERIFIED_PORTAL: { label: 'Official portal / form', tone: 'blue' },
  PUBLIC_UNVERIFIED: { label: 'Needs manual verification', tone: 'amber' },
  NO_CONTACT: { label: 'No contact method', tone: 'gray' },
}
const TIER_LABEL: Record<string, string> = { VERIFIED_DIRECT: 'Direct (verified)', VERIFIED_AGENCY: 'Agency', VERIFIED_PORTAL: 'Portal / form', PUBLIC_UNVERIFIED: 'Public, unverified' }
const TABS = [{ id: 'all', label: 'All' }, ...(Object.keys(STATUS) as Status[]).map((s) => ({ id: s, label: STATUS[s].label }))] as const
const SOURCE_CATEGORIES = [
  ['official_contact', 'Official contact page'], ['official_creator', 'Official creator / influencer page'], ['official_affiliate', 'Official affiliate / ambassador page'],
  ['official_press', 'Official press / media page'], ['official_site', 'Other official page'], ['social', 'Official social profile'], ['agency', 'Agency website'],
  ['professional_profile', 'Professional profile'], ['directory', 'Business directory'], ['manual', 'Other (explain in evidence)'],
] as const

export default function Contacts({ tab }: { tab?: string }) {
  const toast = useToast()
  const { data, error, reload } = useApi<Data>('/api/contact-discovery')
  usePoll(reload, 5000, !!data && data.queue > 0)
  const [open, setOpen] = useState<number | null>(null)
  const current = (TABS.find((t) => t.id === tab)?.id ?? 'all') as (typeof TABS)[number]['id']
  if (error) return <ErrorBox error={error} />
  if (!data) return <Loading />
  const rows = current === 'all' ? data.rows : data.rows.filter((r) => r.status === current)
  const backfill = async () => {
    try {
      const r = await api.post<{ queued: number; considered: number }>('/api/contact-discovery/backfill')
      toast(r.queued ? `Queued ${r.queued} compan${r.queued === 1 ? 'y' : 'ies'} for contact research` : 'Nothing new to queue')
      reload()
    } catch (e) { toast((e as Error).message, 'error') }
  }
  return (
    <>
      <PageHeader title="Contact Discovery" subtitle="Only business contacts published by the brand (or its confirmed agency) can ever be emailed. Every contact shows its source and why it was accepted."
        actions={<Button onClick={backfill}>Research all without a verified email</Button>} />
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
        {(Object.keys(STATUS) as Status[]).map((s) => (
          <button key={s} onClick={() => navigate(`/contacts/${s}`)} className="rounded-xl border border-zinc-200 bg-white p-4 text-left shadow-sm hover:border-brand-400 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">{STATUS[s].label}</div>
            <div className="mt-1.5 text-2xl font-semibold tabular-nums">{data.counts[s]}</div>
          </button>
        ))}
      </div>
      {data.queue > 0 && <div className="mb-4"><Notice tone="blue">{data.queue} compan{data.queue === 1 ? 'y is' : 'ies are'} queued for contact research. The research worker visits each site politely (robots.txt obeyed, one request per site every 1.5 s, at most 14 pages), so this takes a few minutes. This page updates by itself.</Notice></div>}
      <Tabs tabs={TABS.map((t) => ({ ...t, label: t.id === 'all' ? `All (${data.rows.length})` : `${t.label} (${data.counts[t.id as Status]})` }))} value={current} onChange={(t) => navigate(`/contacts/${t}`)} />
      {rows.length === 0 ? <Empty title="No companies here" /> : (
        <Card padded={false}>
          <ul>{rows.map((r) => <CompanyRow key={r.id} r={r} open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)} onChange={reload} />)}</ul>
        </Card>
      )}
      <p className="mt-4 text-xs text-zinc-500">Social profiles, professional profiles and business directories are not read automatically (they need logins, forbid automated access, or charge for data). Add contacts you find there by hand, with the page and the evidence.</p>
    </>
  )
}

function CompanyRow({ r, open, onToggle, onChange }: { r: Row; open: boolean; onToggle: () => void; onChange: () => void }) {
  const toast = useToast()
  const [adding, setAdding] = useState(false)
  const active = r.lastRun && ['queued', 'running'].includes(r.lastRun.status)
  const find = async (refresh: boolean) => {
    try {
      const x = await api.post<{ alreadyQueued: boolean }>(`/api/prospects/${r.id}/find-contacts`, { refresh })
      toast(x.alreadyQueued ? 'Already queued' : refresh ? 'Queued a fresh check (cached pages ignored)' : 'Queued: the research worker will look for contacts')
      onChange()
    } catch (e) { toast((e as Error).message, 'error') }
  }
  const best = r.contacts.find((c) => c.verification_status !== 'failed')
  return (
    <li className="border-b border-zinc-100 last:border-0 dark:border-zinc-800">
      <div className="flex flex-wrap items-center gap-2 px-5 py-3">
        <button className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-left" onClick={onToggle} aria-expanded={open}>
          <span className="font-medium">{r.company_name}</span>
          <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
          {r.review_status !== 'approved' && <Badge tone="gray">{r.review_status === 'pending' ? 'Awaiting your review' : r.review_status}</Badge>}
          <span className="min-w-0 truncate text-sm text-zinc-500">{best ? best.email ?? best.contact_form_url : r.domain}</span>
        </button>
        <span className="text-xs text-zinc-500">{active ? `Research ${r.lastRun!.status}…` : r.lastRun?.finished_at ? `Checked ${relative(r.lastRun.finished_at)}` : r.last_researched_at ? `Researched ${relative(r.last_researched_at)}` : ''}</span>
        <div className="flex gap-1.5">
          <Button size="sm" variant={r.status === 'VERIFIED_DIRECT' ? 'secondary' : 'primary'} disabled={!!active} onClick={() => find(false)}>Find more contacts</Button>
          <Button size="sm" variant="ghost" disabled={!!active} onClick={() => find(true)} title="Ignore cached pages and read them again">Refresh</Button>
          <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>Add manually</Button>
        </div>
      </div>
      {open && <CompanyDetail r={r} onChange={onChange} />}
      <ManualContact r={r} open={adding} onClose={() => setAdding(false)} onSaved={onChange} />
    </li>
  )
}

function CompanyDetail({ r, onChange }: { r: Row; onChange: () => void }) {
  const toast = useToast()
  const findings = useApi<Finding[]>(`/api/prospects/${r.id}/contact-findings`)
  const [reviewing, setReviewing] = useState<ContactRow | null>(null)
  const portal = r.contacts.find((c) => c.contact_tier === 'VERIFIED_PORTAL' && c.verification_status !== 'failed')
  const s = r.lastRun?.summary
  return (
    <div className="space-y-4 bg-zinc-50/60 px-5 py-4 text-sm dark:bg-zinc-900/40">
      {r.lastRun?.status === 'failed' && <Notice tone="red">Last research failed: {r.lastRun.error}</Notice>}
      {s && <p className="text-xs text-zinc-500">Last run: {s.pagesFetched} page(s) fetched, {s.pagesCached} from cache · {s.newDirect} new direct, {s.newAgency} agency, {s.newPortals} portal(s), {s.needsReview} to verify.</p>}
      <div className="space-y-2">
        <h3 className="font-medium">Contacts</h3>
        {r.contacts.length === 0 ? <p className="text-zinc-500">None yet. Use “Find more contacts” or add one you found yourself.</p> : r.contacts.map((c) => (
          <div key={c.id} className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-700 dark:bg-zinc-900">
            <div className="flex flex-wrap items-center gap-2">
              {c.email ? <span className="break-all font-medium">{c.email}</span> : <a className="break-all font-medium text-brand-600 hover:underline" href={c.contact_form_url!} target="_blank" rel="noreferrer noopener">{c.contact_form_url} ↗</a>}
              <Badge tone={c.verification_status === 'failed' ? 'red' : c.contact_tier === 'VERIFIED_DIRECT' ? 'green' : c.contact_tier === 'VERIFIED_PORTAL' ? 'blue' : c.contact_tier === 'VERIFIED_AGENCY' && c.agency_confirmed ? 'violet' : 'amber'}>
                {c.verification_status === 'failed' ? 'Failed / rejected' : TIER_LABEL[c.contact_tier]}{c.contact_tier === 'VERIFIED_AGENCY' && !c.agency_confirmed ? ' (not confirmed)' : ''}
              </Badge>
              {c.confidence && <Badge tone="gray">{c.confidence} confidence</Badge>}
              {c.manually_verified ? <Badge tone="gray">verified by you</Badge> : null}
              {c.email && <Badge tone={c.jurisdiction === 'unknown' ? 'amber' : 'gray'}>Country: {c.jurisdiction}</Badge>}
            </div>
            <dl className="mt-2 grid gap-x-3 gap-y-0.5 text-xs sm:grid-cols-[8rem_1fr]">
              <dt className="text-zinc-500">Why</dt><dd>{c.decision_note ?? '—'}</dd>
              <dt className="text-zinc-500">Source</dt><dd className="break-all">{c.source_url ? <a className="text-brand-600 hover:underline" href={c.source_url} target="_blank" rel="noreferrer noopener">{c.source_url}</a> : '—'}{c.source_category ? ` · ${c.source_category.replace(/_/g, ' ')}` : ''}</dd>
              {c.evidence && <><dt className="text-zinc-500">Evidence</dt><dd className="italic">“{c.evidence}”</dd></>}
              {c.agency_name && <><dt className="text-zinc-500">Agency</dt><dd>{c.agency_name}{c.agency_confirmed ? ` · confirmed (${c.agency_confirmed === 'brand_site' ? 'named on the brand’s site' : 'by you'})` : ''}</dd></>}
              <dt className="text-zinc-500">Verified</dt><dd>{c.last_checked_at ? dateTime(c.last_checked_at) : c.verified_at ? dateTime(c.verified_at) : 'not yet'}</dd>
            </dl>
            {c.email && c.verification_status !== 'failed' && (c.contact_tier === 'PUBLIC_UNVERIFIED' || (c.contact_tier === 'VERIFIED_AGENCY' && !c.agency_confirmed)) && (
              <div className="mt-2 flex gap-2"><Button size="sm" variant="primary" onClick={() => setReviewing(c)}>Verify…</Button><Button size="sm" variant="ghost" onClick={() => setReviewing(c)}>Reject…</Button></div>
            )}
          </div>
        ))}
      </div>
      {portal && r.status === 'VERIFIED_PORTAL' && (
        <Notice tone="blue" title="Apply through the official portal">
          No verified email, but {r.company_name} has an official application page. Draft a tailored application message, copy it, submit it yourself, and record it so a follow-up reminder is set.{' '}
          {r.review_status === 'approved' ? <a className="underline" href="#/drafts/ready">Email Drafts → Draft manual message</a> : <a className="underline" href="#/discovery/review">Approve the company first</a>}
        </Notice>
      )}
      <div>
        <h3 className="mb-2 font-medium">What research found</h3>
        {!findings.data ? <Loading /> : findings.data.length === 0 ? <p className="text-zinc-500">No findings yet.</p> : (
          <ul className="space-y-1.5 text-xs">
            {findings.data.slice(0, 60).map((f) => (
              <li key={f.id} className="flex gap-2">
                <Badge tone={f.decision === 'accepted' ? 'green' : f.decision === 'needs_review' ? 'amber' : 'gray'}>{f.decision === 'needs_review' ? 'check' : f.decision}</Badge>
                <span className="min-w-0"><span className="break-all font-medium">{f.value ?? f.kind.replace('_', ' ')}</span>: {f.reason} <a className="break-all text-brand-600 hover:underline" href={f.source_url} target="_blank" rel="noreferrer noopener">source</a></span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <ReviewDialog contact={reviewing} onClose={() => setReviewing(null)} onDone={() => { setReviewing(null); findings.reload(); onChange(); toast('Saved') }} />
    </div>
  )
}

function ReviewDialog({ contact, onClose, onDone }: { contact: ContactRow | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast()
  const [evidence, setEvidence] = useState('')
  const [agency, setAgency] = useState('')
  const [confirmation, setConfirmation] = useState('')
  if (!contact) return null
  const agencyCase = contact.contact_tier === 'VERIFIED_AGENCY' || (contact.email && contact.source_category === 'agency')
  const submit = async (decision: 'verify' | 'confirm_agency' | 'reject') => {
    try {
      await api.post(`/api/contacts/${contact.id}/review`, { decision, evidence, agency_name: agency || undefined, brand_confirmation: confirmation || undefined })
      setEvidence(''); setAgency(''); setConfirmation('')
      onDone()
    } catch (e) { toast((e as Error).message, 'error') }
  }
  return (
    <Modal open onClose={onClose} title={`Verify ${contact.email}`}>
      <div className="space-y-3 text-sm">
        <p>Open the source page and confirm the address is published there for business inquiries. {contact.source_url && <a className="text-brand-600 hover:underline" href={contact.source_url} target="_blank" rel="noreferrer noopener">Open source ↗</a>}</p>
        <Field label="What you checked" hint="For example: “Shown on the Contact page under Partnerships”."><Textarea className="min-h-16" value={evidence} onChange={(e) => setEvidence(e.target.value)} /></Field>
        {agencyCase && <>
          <Field label="Agency name"><Input value={agency} onChange={(e) => setAgency(e.target.value)} placeholder={contact.agency_name ?? ''} /></Field>
          <Field label="Where the brand confirms this agency" hint="Required for agency contacts: a page on the brand’s site, or how you confirmed it with the brand."><Textarea className="min-h-16" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} /></Field>
        </>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="danger" onClick={() => submit('reject')}>Reject</Button>
          <Button variant="primary" onClick={() => submit(agencyCase ? 'confirm_agency' : 'verify')}>{agencyCase ? 'Confirm agency' : 'Mark verified'}</Button>
        </div>
      </div>
    </Modal>
  )
}

function ManualContact({ r, open, onClose, onSaved }: { r: Row; open: boolean; onClose: () => void; onSaved: () => void }) {
  const toast = useToast()
  const [f, setF] = useState({ kind: 'email', email: '', portal_url: '', source_url: '', source_category: 'official_contact', evidence: '', agency_name: '', brand_confirmation: '', official_profile: false })
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  const save = async () => {
    try {
      const res = await api.post<{ contact: ContactRow }>(`/api/prospects/${r.id}/contacts/manual`, {
        ...(f.kind === 'email' ? { email: f.email } : { portal_url: f.portal_url }), source_url: f.source_url, source_category: f.source_category, evidence: f.evidence,
        agency_name: f.agency_name || undefined, brand_confirmation: f.brand_confirmation || undefined, official_profile: f.official_profile,
      })
      toast(`Added as ${TIER_LABEL[res.contact.contact_tier].toLowerCase()}`)
      onSaved()
      onClose()
    } catch (e) { toast((e as Error).message, 'error') }
  }
  return (
    <Modal open={open} onClose={onClose} title={`Add a contact for ${r.company_name}`}>
      <div className="space-y-3 text-sm">
        <Notice>Only contacts published for business inquiries. No personal addresses, no guessed addresses, no data from private databases. The tier is set by the same rules as automated research.</Notice>
        <Field label="Type"><Select value={f.kind} onChange={set('kind')}><option value="email">Business email</option><option value="portal">Official application page / creator portal</option></Select></Field>
        {f.kind === 'email'
          ? <Field label="Business email"><Input type="email" value={f.email} onChange={set('email')} placeholder={`partnerships@${r.domain ?? 'brand.com'}`} /></Field>
          : <Field label="Application URL"><Input value={f.portal_url} onChange={set('portal_url')} placeholder="https://…" /></Field>}
        <Field label="Exact source page" hint="The page where it is published."><Input value={f.source_url} onChange={set('source_url')} placeholder={`https://${r.domain ?? 'brand.com'}/contact`} /></Field>
        <Field label="Source category"><Select value={f.source_category} onChange={set('source_category')}>{SOURCE_CATEGORIES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
        <Field label="Evidence" hint="The text on that page showing this contact belongs to the brand."><Textarea className="min-h-16" value={f.evidence} onChange={set('evidence')} /></Field>
        {f.source_category === 'social' && <label className="flex items-center gap-2"><input type="checkbox" checked={f.official_profile} onChange={(e) => setF({ ...f, official_profile: e.target.checked })} /> This is the brand’s official, verified profile</label>}
        {f.source_category === 'agency' && <>
          <Field label="Agency name"><Input value={f.agency_name} onChange={set('agency_name')} /></Field>
          <Field label="Where the brand confirms this agency (optional)" hint="Without it, the contact stays blocked until you confirm the relationship."><Textarea className="min-h-16" value={f.brand_confirmation} onChange={set('brand_confirmation')} /></Field>
        </>}
        <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>Add contact</Button></div>
      </div>
    </Modal>
  )
}
