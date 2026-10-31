import { useEffect, useState } from 'react'
import { Badge, Button, Card, EligibilityBadge, ErrorBox, Field, Input, Loading, Notice, Select, Textarea, useToast } from '../components/ui'
import { api, useApi } from '../lib/api'
import { bytes, dateTime, relative } from '../lib/format'
import { navigate } from '../lib/router'
import type { Claim, ClaimSource, Package, PitchView, ProgramType, ProspectOutreach } from '../lib/types'
import { PROGRAM_TONE } from './Drafts'

const wordsIn = (body: string) => body.split(/\n(?:Best|Thanks|Cheers|Talk soon),?\s*\n/i)[0].split(/\s+/).filter((w) => /[a-z0-9]/i.test(w)).length

export default function PitchEditor({ id }: { id: number }) {
  const toast = useToast()
  const { data, error, setData } = useApi<PitchView>(`/api/pitches/${id}`)
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => {
    if (data) { setSubject(data.pitch.subject ?? ''); setBody(data.pitch.body) }
  }, [data])

  if (error) return <ErrorBox error={error} />
  if (!data) return <Loading />
  const p = data.pitch
  const dirty = subject !== (p.subject ?? '') || body !== p.body
  const editable = p.status === 'draft' || p.status === 'approved'
  const blockers = data.checks.filter((c) => c.level === 'blocker')
  const warnings = data.checks.filter((c) => c.level === 'warning')
  const liveWords = wordsIn(body)

  const act = async (label: string, fn: () => Promise<PitchView>, ok: string) => {
    setBusy(label)
    try {
      const v = await fn()
      if (v.pitch.id !== id) navigate(`/drafts/pitch/${v.pitch.id}`)
      else setData(v)
      toast(ok)
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(null)
    }
  }
  const save = () => act('save', () => api.patch<PitchView>(`/api/pitches/${id}`, { subject, body }), p.status === 'approved' ? 'Saved. Approval withdrawn until you re-approve.' : 'Draft saved')
  const approve = () => act('approve', async () => {
    if (dirty) await api.patch(`/api/pitches/${id}`, { subject, body })
    return api.post<PitchView>(`/api/pitches/${id}/approve`)
  }, 'Approved. Nothing was sent.')
  const reject = () => {
    const reason = prompt('Why reject this pitch? (kept for your records)')
    if (!reason?.trim()) return
    act('reject', () => api.post<PitchView>(`/api/pitches/${id}/reject`, { reason }), 'Pitch rejected')
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <a href="#/drafts/drafts" className="text-sm text-brand-600 hover:underline">← All drafts</a>
        <h1 className="text-2xl font-semibold tracking-tight">{data.company.name}</h1>
        <StatusBadge status={p.status} />
        <Badge>{p.channel === 'email' ? 'Email pitch' : 'Manual submission'}</Badge>
        <Badge tone={PROGRAM_TONE[data.program.type]}>{data.program.label}</Badge>
        {data.versions.length > 1 && (
          <Select className="ml-auto w-auto" value={p.id} onChange={(e) => navigate(`/drafts/pitch/${e.target.value}`)} aria-label="Version">
            {data.versions.map((v) => <option key={v.id} value={v.id}>v{v.version} · {v.channel === 'email' ? 'email' : 'manual'} · {v.status}</option>)}
          </Select>
        )}
      </div>

      {p.status === 'superseded' && <Notice tone="amber">This is an older version. A newer one exists for this company.</Notice>}
      {p.status === 'rejected' && <Notice tone="red" title="Rejected">{p.reject_reason}</Notice>}
      {p.status === 'approved' && <Notice tone="green" title={`Approved ${p.reviewed_at ? relative(p.reviewed_at) : ''}`}>
        {p.channel === 'email' ? 'Ready for the future approval gate. It will not be sent until Gmail is connected and you approve live sending.' : 'Ready for you to submit on the brand\'s site (Manual submissions tab).'}
      </Notice>}

      <div className="grid gap-5 xl:grid-cols-[1fr_26rem]">
        <div className="space-y-5">
          <Card title="Message">
            <div className="space-y-4">
              <Recipient view={data} />
              <Field label="Subject"><Input value={subject} onChange={(e) => setSubject(e.target.value)} disabled={!editable} /></Field>
              <Field label={`Body · ${liveWords} words (target 100–150)`}>
                <Textarea className="min-h-[22rem] font-[inherit] leading-relaxed" value={body} onChange={(e) => setBody(e.target.value)} disabled={!editable} />
              </Field>
              {p.channel === 'email' && <Attachment view={data} />}
              <p className="text-xs text-zinc-500">When sending exists (Phase 5), your postal address and an opt-out line are added below the signature automatically.</p>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-zinc-500">{p.generator === 'ollama' ? `Local AI (${p.ai_model})` : 'Template'} · v{p.version} · {dateTime(p.created_at)}{p.edited ? ' · edited by you' : ''}</span>
                <div className="ml-auto flex flex-wrap gap-2">
                  {editable && <Button onClick={save} disabled={!dirty || busy !== null}>{busy === 'save' ? 'Saving…' : 'Save draft'}</Button>}
                  {editable && <Button variant="danger" onClick={reject} disabled={busy !== null}>Reject</Button>}
                  {(p.status === 'draft' || (p.status === 'approved' && dirty)) && (
                    <Button variant="primary" onClick={approve} disabled={busy !== null || (blockers.length > 0 && !dirty)} title={blockers.length ? 'Fix the items marked “to fix” first' : 'Approve this pitch (nothing is sent)'}>
                      {busy === 'approve' ? 'Approving…' : dirty ? 'Save & approve' : 'Approve'}
                    </Button>
                  )}
                </div>
              </div>
              {p.generation_note && <p className="text-xs text-zinc-500">{p.generation_note}</p>}
            </div>
          </Card>
          <Evidence claims={p.claims} validation={data.claimValidation} />
        </div>

        <div className="space-y-5">
          <Card title="Checks">
            {dirty && <p className="mb-2 text-xs text-amber-600">Showing checks for the saved version. Save to re-check your edits.</p>}
            {blockers.length === 0 && warnings.length === 0 && <p className="text-sm text-emerald-600">All checks pass.</p>}
            <ul className="space-y-2 text-sm">
              {blockers.map((c, i) => <li key={`b${i}`} className="flex gap-2"><Badge tone="red">To fix</Badge><span>{c.message}</span></li>)}
              {warnings.map((c, i) => <li key={`w${i}`} className="flex gap-2"><Badge tone="amber">Check</Badge><span>{c.message}</span></li>)}
            </ul>
          </Card>
          {data.currentFlags.length > 0 && (
            <Card title="Missing or uncertain information">
              <ul className="space-y-2 text-sm">
                {data.currentFlags.map((f) => <li key={f.code} className="flex gap-2"><Badge tone={f.level === 'missing' ? 'red' : 'amber'}>{f.level === 'missing' ? 'Missing' : 'Note'}</Badge><span>{f.message}</span></li>)}
              </ul>
            </Card>
          )}
          <Strategy view={data} onRegenerated={(v) => navigate(`/drafts/pitch/${v.pitch.id}`)} />
        </div>
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const tone = status === 'approved' ? 'green' : status === 'rejected' ? 'red' : status === 'draft' ? 'blue' : 'gray'
  return <Badge tone={tone}>{status === 'draft' ? 'Needs approval' : status}</Badge>
}

function Recipient({ view }: { view: PitchView }) {
  if (view.pitch.channel === 'manual_form') {
    const a = view.application
    return (
      <div className="rounded-lg bg-zinc-50 p-3 text-sm dark:bg-zinc-800/50">
        <div className="text-xs font-medium text-zinc-500">Submit through (you do this yourself)</div>
        {a ? (
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <a className="break-all text-brand-600 hover:underline" href={a.url} target="_blank" rel="noreferrer noopener">{a.url} ↗</a>
            <Badge tone={a.origin === 'research' ? 'green' : 'amber'}>{a.origin === 'research' ? `Verified by research${a.retrievedAt ? ` ${relative(a.retrievedAt)}` : ''}` : 'Added by you'}</Badge>
          </div>
        ) : <div className="mt-1 text-rose-600">No verified creator portal or contact form on record.</div>}
      </div>
    )
  }
  const r = view.recipient
  return (
    <div className="rounded-lg bg-zinc-50 p-3 text-sm dark:bg-zinc-800/50">
      <div className="text-xs font-medium text-zinc-500">Proposed recipient</div>
      {r?.email ? (
        <>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <span className="font-medium">{r.email}</span>
            <Badge tone={r.verification_status === 'verified' ? 'green' : 'amber'}>{r.verification_status}{r.verified_at ? ` ${relative(r.verified_at)}` : ''}</Badge>
            <EligibilityBadge status={r.eligibility.status} />
          </div>
          {r.source_url && <div className="mt-1 text-xs text-zinc-500">Published at <a className="text-brand-600 hover:underline" href={r.source_url} target="_blank" rel="noreferrer noopener">{r.source_url}</a></div>}
          {r.eligibility.status !== 'eligible' && <ul className="mt-1 list-disc pl-5 text-xs text-zinc-500">{r.eligibility.reasons.map((x) => <li key={x}>{x}</li>)}</ul>}
        </>
      ) : <div className="mt-1 text-rose-600">No verified business email. Use a manual submission instead.</div>}
    </div>
  )
}

function Attachment({ view }: { view: PitchView }) {
  const a = view.attachment
  if (!a) return <Notice tone="amber">No media kit referenced.</Notice>
  if ('missing' in a) return <Notice tone="red">The referenced media kit no longer exists.</Notice>
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-700">
      <span className="grid h-9 w-9 place-items-center rounded bg-rose-50 text-xs font-bold text-rose-600 dark:bg-rose-500/10">PDF</span>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{a.filename}</div>
        <div className="text-xs text-zinc-500">Media kit v{a.version} · {bytes(a.sizeBytes)} · {a.checksumOk ? 'file verified (checksum matches)' : a.fileExists ? 'checksum mismatch' : 'file missing'}{!a.isCurrentDefault && ' · not the current default'}</div>
      </div>
      <a href={`/api/media-kits/${a.mediaKitId}/file`} target="_blank" rel="noreferrer" className="text-xs text-brand-600 hover:underline">Preview</a>
      <Badge tone="amber">Gmail attachment not tested yet (Phase 4)</Badge>
    </div>
  )
}

function sourceLine(s: ClaimSource) {
  switch (s.type) {
    case 'research': return <><a className="text-brand-600 hover:underline" href={s.url} target="_blank" rel="noreferrer noopener">{s.label}</a>{s.snippet && <span className="italic"> “{s.snippet}”</span>}<span className="text-zinc-400"> · retrieved {dateTime(s.retrieved_at)}</span></>
    case 'metric': return <>{s.platform} {s.label}: {s.value.toLocaleString('en-US')}{s.period ? ` (${s.period})` : ''} <span className="text-zinc-400">· as of {s.as_of} · {s.source}</span></>
    case 'package': return <>Package: {s.name}</>
    case 'media_kit': return <>Media kit v{s.version}</>
    default: return <>{s.note}</>
  }
}

const KIND_LABEL: Record<string, string> = { brand: 'About the brand', metric: 'Your analytics', creator: 'About you', concept: 'Your idea', package: 'Offer', media_kit: 'Media kit' }

function Evidence({ claims, validation }: { claims: Claim[]; validation: PitchView['claimValidation'] }) {
  return (
    <Card title="Evidence behind each claim">
      {claims.length === 0 ? <p className="text-sm text-zinc-500">No claims recorded.</p> : (
        <ul className="space-y-3 text-sm">
          {claims.map((c, i) => {
            const v = validation[i]
            return (
              <li key={i} className={`rounded-lg border p-3 ${v?.problems.length ? 'border-amber-300 dark:border-amber-500/40' : 'border-zinc-200 dark:border-zinc-800'}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={c.kind === 'brand' ? 'blue' : c.kind === 'metric' ? 'violet' : 'gray'}>{KIND_LABEL[c.kind] ?? c.kind}</Badge>
                  {v && !v.inBody && <Badge tone="gray">No longer in the message</Badge>}
                </div>
                <p className="mt-1.5">“{c.sentence}”</p>
                <ul className="mt-1.5 space-y-1 text-xs text-zinc-600 dark:text-zinc-400">
                  {c.sources.map((s, j) => <li key={j}>↳ {sourceLine(s)}</li>)}
                </ul>
                {v?.problems.map((x) => <p key={x} className="mt-1 text-xs text-amber-700 dark:text-amber-400">⚠ {x}</p>)}
              </li>
            )
          })}
        </ul>
      )}
      <p className="mt-3 text-xs text-zinc-500">Sentences you add yourself have no recorded evidence; the checks still flag unsupported numbers, promises and invented relationships.</p>
    </Card>
  )
}

const PROGRAM_OPTIONS: { value: ProgramType | ''; label: string }[] = [
  { value: '', label: 'Automatic (from research)' },
  { value: 'paid_sponsorship', label: 'Paid creator sponsorships' },
  { value: 'creator_partnerships', label: 'Creator partnerships (pay not stated)' },
  { value: 'affiliate_only', label: 'Affiliate program only' },
  { value: 'unknown', label: 'No creator program' },
]

function Strategy({ view, onRegenerated }: { view: PitchView; onRegenerated: (v: PitchView) => void }) {
  const toast = useToast()
  const p = view.pitch
  const outreach = useApi<ProspectOutreach>(`/api/prospects/${p.prospect_id}/outreach`)
  const [o, setO] = useState(p.options)
  const [busy, setBusy] = useState(false)
  useEffect(() => setO(p.options), [p.id, p.options])
  const packages: Package[] = outreach.data?.packages ?? []
  const pkg = packages.find((x) => x.id === o.package_id)

  const setProgram = async (value: string) => {
    try {
      await api.put(`/api/prospects/${p.prospect_id}/program-type`, { value: value || null })
      toast('Program type updated. Regenerate to apply it.')
      outreach.reload()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }
  const regenerate = async () => {
    if (p.status === 'approved' && !confirm('This pitch is approved. Regenerating creates a new draft that needs approval again (the approved version stays in history). Continue?')) return
    if (p.status !== 'approved' && p.edited && !confirm('Regenerating creates a new version and replaces your edits in the live draft (the edited version stays in history). Continue?')) return
    setBusy(true)
    try {
      const v = await api.post<PitchView>(`/api/pitches/${p.id}/regenerate`, o)
      toast(v.pitch.generator === 'ollama' ? 'Regenerated with local AI' : 'Regenerated from the template')
      onRegenerated(v)
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card title="Strategy & options">
      <div className="space-y-3 text-sm">
        <div>
          <div className="text-xs font-medium text-zinc-500">Program type</div>
          <p className="mt-0.5 text-zinc-600 dark:text-zinc-400">{view.program.basis}</p>
          <Select className="mt-1.5" value={view.program.overridden ? view.program.type : ''} onChange={(e) => setProgram(e.target.value)} aria-label="Program type">
            {PROGRAM_OPTIONS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
          </Select>
        </div>
        <Field label="Channel">
          <Select value={o.channel} onChange={(e) => setO({ ...o, channel: e.target.value as 'email' | 'manual_form', contact_id: null })}>
            <option value="email">Email</option><option value="manual_form">Manual submission (portal / form)</option>
          </Select>
        </Field>
        {o.channel === 'email' && (outreach.data?.contacts.length ?? 0) > 1 && (
          <Field label="Recipient">
            <Select value={o.contact_id ?? ''} onChange={(e) => setO({ ...o, contact_id: e.target.value ? Number(e.target.value) : null })}>
              <option value="">Best verified contact</option>
              {outreach.data!.contacts.map((c) => <option key={c.id} value={c.id}>{c.email} ({c.verification_status})</option>)}
            </Select>
          </Field>
        )}
        <Field label="Package to offer">
          <Select value={o.package_id ?? ''} onChange={(e) => setO({ ...o, package_id: e.target.value ? Number(e.target.value) : null })}>
            <option value="">None (ask about a recurring partnership)</option>
            {packages.map((x) => <option key={x.id} value={x.id}>{x.name}{x.recurring ? ' (recurring)' : ''}</option>)}
          </Select>
        </Field>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={!!o.include_rates} onChange={(e) => setO({ ...o, include_rates: e.target.checked })} disabled={!pkg || pkg.price_unit === 'custom'} />
          Include the package's rate range {pkg && pkg.price_unit === 'custom' ? '(custom pricing)' : ''}
        </label>
        <Field label="Custom rate wording (optional)" hint="Used exactly as written, e.g. “$1,500 for two Shorts”. Leave empty to keep pricing out of the pitch.">
          <Input value={o.custom_rate_text ?? ''} onChange={(e) => setO({ ...o, custom_rate_text: e.target.value })} />
        </Field>
        <Field label="Custom deliverables (optional)">
          <Input value={o.custom_deliverables ?? ''} onChange={(e) => setO({ ...o, custom_deliverables: e.target.value })} placeholder={pkg?.deliverables ?? 'e.g. two Shorts and a stream segment'} />
        </Field>
        <Field label="Collaboration idea for this brand" hint="Leave empty to use the concept saved on the company.">
          <Textarea className="min-h-20" value={o.concept ?? ''} onChange={(e) => setO({ ...o, concept: e.target.value })} placeholder={outreach.data?.company.concept ?? ''} />
        </Field>
        <Button variant="primary" className="w-full" onClick={regenerate} disabled={busy || p.status === 'superseded'}>{busy ? 'Regenerating…' : 'Regenerate with these options'}</Button>
        <p className="text-xs text-zinc-500">Uses the provider selected in Settings → AI & costs (mock = template, Ollama = local AI). Never a paid provider.</p>
      </div>
    </Card>
  )
}
