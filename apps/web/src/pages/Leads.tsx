import { useMemo, useState } from 'react'
import { Badge, Button, Card, Empty, ErrorBox, Loading, Notice, Select, Stat, useToast } from '../components/ui'
import { api, useApi } from '../lib/api'
import { dateTime } from '../lib/format'
import type { Category, Lead, LeadConfidence, LeadsResponse, OutreachStatus } from '../lib/types'

const CONFIDENCE: Record<LeadConfidence, { label: string; tone: 'green' | 'blue' | 'gray'; title: string }> = {
  high: { label: 'High', tone: 'green', title: 'Listed by the brand on its own domain, source recorded, domain can receive mail, no known bounce. Not a delivery guarantee.' },
  medium: { label: 'Medium', tone: 'blue', title: 'Credible public business source with a documented connection to the brand, domain can receive mail, no known bounce. Not a delivery guarantee.' },
  unverified: { label: 'Unverified', tone: 'gray', title: 'Cannot be used: see the reason.' },
}
const RELEVANCE = { high: { label: 'Works with creators', tone: 'green' }, medium: { label: 'Affiliate program', tone: 'blue' }, none: { label: 'No program found', tone: 'gray' } } as const
const OUTREACH: Record<OutreachStatus, string> = {
  needs_review: 'Awaiting your review', ready_to_draft: 'Ready to draft', pitch_drafted: 'Pitch drafted', pitch_approved: 'Pitch approved',
  gmail_draft: 'In Gmail drafts', contacted: 'Contacted', replied: 'Replied', closed: 'Closed',
}
const percent = (n: number) => `${Math.round(n * 100)}%`
const day = (iso: string | null) => (iso ? dateTime(iso).split(',').slice(0, 2).join(',') : '—')

function Metrics({ data }: { data: LeadsResponse }) {
  const m = data.metrics
  const r = m.research
  return (
    <div className="mb-5 space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <Stat label="Actionable brands" value={m.actionable} tone="good" hint="Ready for your outreach steps" />
        <Stat label="With verified public emails" value={m.withQualifyingEmail} hint="Whatever their outreach status" />
        <Stat label="Without usable emails" value={m.withoutUsableEmail} tone="muted" hint="Kept under Excluded" />
        <Stat label="Already contacted" value={m.alreadyContacted} hint="One sequence per company" />
        <Stat label="Awaiting outreach" value={m.awaitingOutreach} hint={`${m.awaitingReview} more awaiting your review`} />
        <Stat label="Email discovery rate" value={percent(m.discoveryRate)} hint={`${m.withQualifyingEmail} of ${m.totalBrands} brands`} />
      </div>
      <p className="text-xs text-zinc-500">
        Research so far: {r.researched} brands researched · {r.qualifying} with qualifying emails · {r.rejected} rejected · {r.duplicates} duplicates · {percent(r.rate)} valid-contact rate.
      </p>
    </div>
  )
}

export function ActionableLeads({ categories }: { categories: Category[] }) {
  const toast = useToast()
  const { data, error, reload } = useApi<LeadsResponse>('/api/leads')
  const [confidence, setConfidence] = useState('')
  const [category, setCategory] = useState('')
  const [relevance, setRelevance] = useState('')
  const [outreach, setOutreach] = useState('')
  const rows = useMemo(() => (data?.actionable ?? []).filter((l) =>
    (!confidence || l.confidence === confidence) && (!category || String(l.category_id) === category)
    && (!relevance || l.relevance === relevance) && (!outreach || l.outreach_status === outreach)), [data, confidence, category, relevance, outreach])
  if (error) return <ErrorBox error={error} />
  if (!data) return <Loading />
  // Only you can confirm where a recipient is; the app never infers it from the company's headquarters.
  const setCountry = async (l: Lead, country: string) => {
    try {
      await api.patch(`/api/contacts/${l.contact_id}`, { jurisdiction: country })
      toast(`${l.email}: recipient country set to ${country}`)
      reload()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }
  const approve = async (l: Lead) => {
    try {
      await api.post(`/api/prospects/${l.id}/review`, { decision: 'approved' })
      toast(`Approved ${l.company_name}. Nothing was sent.`)
      reload()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }
  return (
    <>
      <Metrics data={data} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Select className="w-auto" value={confidence} onChange={(e) => setConfidence(e.target.value)} aria-label="Contact confidence">
          <option value="">Any confidence</option><option value="high">High</option><option value="medium">Medium</option>
        </Select>
        <Select className="w-auto" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Brand category">
          <option value="">All categories</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <Select className="w-auto" value={relevance} onChange={(e) => setRelevance(e.target.value)} aria-label="Partnership relevance">
          <option value="">Any partnership relevance</option><option value="high">Works with creators</option><option value="medium">Affiliate program</option><option value="none">No program found</option>
        </Select>
        <Select className="w-auto" value={outreach} onChange={(e) => setOutreach(e.target.value)} aria-label="Outreach status">
          <option value="">Any outreach status</option>
          {(['needs_review', 'ready_to_draft', 'pitch_drafted', 'pitch_approved', 'gmail_draft'] as OutreachStatus[]).map((s) => <option key={s} value={s}>{OUTREACH[s]}</option>)}
        </Select>
        <span className="text-sm text-zinc-500">{rows.length} of {data.actionable.length}</span>
      </div>
      {rows.length === 0 ? (
        <Empty title={data.actionable.length ? 'No matches' : 'No actionable brands yet'}>
          {data.actionable.length ? 'Try clearing a filter.' : <>Run research to find brands with qualifying emails. <a className="text-brand-600 hover:underline" href="#/discovery/research">Run research</a></>}
        </Empty>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <table className="w-full min-w-[68rem] text-sm">
            <thead className="border-b border-zinc-200 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
              <tr><th className="px-3 py-2.5">Brand</th><th className="px-3 py-2.5">Contact email</th><th className="px-3 py-2.5">Confidence</th><th className="px-3 py-2.5">Verified</th><th className="px-3 py-2.5">Relevance</th><th className="px-3 py-2.5">Outreach</th><th className="px-3 py-2.5">Next step</th></tr>
            </thead>
            <tbody>
              {rows.map((l) => (
                <tr key={l.id} className="border-b border-zinc-100 align-top last:border-0 dark:border-zinc-800">
                  <td className="px-3 py-2.5">
                    <a className="font-medium hover:underline" href={`#/discovery/leads/${l.id}`}>{l.company_name}</a>
                    <div className="text-xs text-zinc-500">{l.website ? <a className="hover:underline" href={l.website} target="_blank" rel="noreferrer noopener">{l.domain}</a> : '—'}</div>
                    <div className="text-xs text-zinc-500">{l.category_name ?? 'No category'}</div>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="select-all font-medium text-emerald-700 dark:text-emerald-400">{l.email}</div>
                    <div className="text-xs text-zinc-500">{l.department}</div>
                    {l.source_url && <a className="block max-w-72 truncate text-xs text-brand-600 hover:underline" href={l.source_url} target="_blank" rel="noreferrer noopener" title={l.source_url}>Source: {l.source_url.replace(/^https?:\/\/(www\.)?/, '')}</a>}
                  </td>
                  <td className="px-3 py-2.5"><Badge tone={CONFIDENCE[l.confidence ?? 'unverified'].tone} title={CONFIDENCE[l.confidence ?? 'unverified'].title}>{CONFIDENCE[l.confidence ?? 'unverified'].label}</Badge></td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-xs text-zinc-500">
                    {day(l.verified_at)}
                    <div>Bounce: {l.bounce_status === 'none' ? 'none known' : 'bounced'}</div>
                    <div>Delivery: {l.delivery_evidence.toLowerCase()}</div>
                  </td>
                  <td className="px-3 py-2.5"><Badge tone={RELEVANCE[l.relevance].tone} title={l.relevance_label}>{RELEVANCE[l.relevance].label}</Badge></td>
                  <td className="px-3 py-2.5 text-xs">
                    {OUTREACH[l.outreach_status]}
                    <div className="text-zinc-500">{l.last_contacted_at ? `Last contacted ${day(l.last_contacted_at)}` : 'Never contacted'}</div>
                  </td>
                  <td className="px-3 py-2.5 text-xs">
                    {l.review_status === 'pending' ? <Button size="sm" onClick={() => approve(l)}>Approve</Button>
                      : <a className="text-brand-600 hover:underline" href="#/drafts">Open in Email Drafts</a>}
                    {l.needs_before_send.length > 0 && <div className="mt-1 max-w-56 text-amber-700 dark:text-amber-400">Before sending: {l.needs_before_send.join('; ')}</div>}
                    {l.contact_id && l.needs_before_send.some((r) => /jurisdiction/i.test(r)) && (
                      <Select className="mt-1 w-auto text-xs" value="" aria-label={`Recipient country for ${l.email}`} onChange={(e) => e.target.value && setCountry(l, e.target.value)}>
                        <option value="">Confirm recipient country…</option>
                        {['US', 'CA', 'UK', 'DE', 'FR', 'NL', 'SE', 'AU', 'HK', 'SG', 'JP', 'IL', 'LT', 'RO'].map((c) => <option key={c} value={c}>{c}</option>)}
                      </Select>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-xs text-zinc-500">High and Medium mean the address was published and its source is on record. They do not guarantee the mailbox accepts mail; only a reply confirms that.</p>
    </>
  )
}

export function ExcludedBrands() {
  const { data, error } = useApi<LeadsResponse>('/api/leads')
  const [reason, setReason] = useState('')
  if (error) return <ErrorBox error={error} />
  if (!data) return <Loading />
  const groups = new Map<string, { label: string; n: number }>()
  for (const l of data.excluded) groups.set(l.exclusion!.code, { label: l.exclusion!.label, n: (groups.get(l.exclusion!.code)?.n ?? 0) + 1 })
  const rows = data.excluded.filter((l) => !reason || l.exclusion!.code === reason)
  return (
    <div className="space-y-4">
      <Notice>Kept for research history and not counted as leads. A brand moves to Actionable leads by itself if a qualifying email is found later.</Notice>
      <div className="flex flex-wrap items-center gap-2">
        <Select className="w-auto" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason">
          <option value="">All reasons ({data.excluded.length})</option>
          {[...groups].sort((a, b) => b[1].n - a[1].n).map(([code, g]) => <option key={code} value={code}>{g.label} ({g.n})</option>)}
        </Select>
      </div>
      {rows.length === 0 ? <Empty title="Nothing excluded">Every brand on record is actionable.</Empty> : (
        <Card padded={false}>
          <div className="max-h-[70vh] overflow-auto">
            <table className="w-full min-w-[44rem] text-sm">
              <tbody>
                {rows.map((l) => (
                  <tr key={l.id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800">
                    <td className="px-4 py-2.5"><a className="font-medium hover:underline" href={`#/discovery/excluded/${l.id}`}>{l.company_name}</a><div className="text-xs text-zinc-500">{l.domain ?? '—'} · {l.category_name ?? 'No category'}</div></td>
                    <td className="px-4 py-2.5"><Badge tone={l.exclusion!.code === 'bounced' || l.exclusion!.code === 'suppressed' ? 'red' : 'gray'}>{l.exclusion!.label}</Badge></td>
                    <td className="px-4 py-2.5 text-xs text-zinc-500">{l.email && <div className="text-zinc-700 dark:text-zinc-300">{l.email}</div>}{l.exclusion!.detail}</td>
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
