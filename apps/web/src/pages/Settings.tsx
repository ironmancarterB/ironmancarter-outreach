import { useEffect, useState } from 'react'
import { Badge, Button, Card, ErrorBox, Field, Input, Loading, Notice, PageHeader, Select, Tabs, Textarea, useToast } from '../components/ui'
import { api, useApi } from '../lib/api'
import { dateTime, metricValue, usdAmount } from '../lib/format'
import { navigate } from '../lib/router'
import type { Activity, Category, Metric, Package } from '../lib/types'

type SettingsData = { values: Record<string, unknown>; locked: Record<string, string>; editable: string[] }

const TABS = [
  { id: 'business', label: 'Business' },
  { id: 'analytics', label: 'Creator analytics' },
  { id: 'categories', label: 'Categories' },
  { id: 'packages', label: 'Packages & rates' },
  { id: 'ai', label: 'AI & costs' },
  { id: 'sending', label: 'Sending & compliance' },
  { id: 'suppression', label: 'Suppression list' },
  { id: 'activity', label: 'Audit log' },
] as const
type TabId = (typeof TABS)[number]['id']

export default function Settings({ tab }: { tab?: string }) {
  const current = (TABS.find((t) => t.id === tab)?.id ?? 'business') as TabId
  const settings = useApi<SettingsData>('/api/settings')
  return (
    <>
      <PageHeader title="Settings" />
      <Tabs tabs={[...TABS]} value={current} onChange={(t) => navigate(`/settings/${t}`)} />
      {settings.error ? <ErrorBox error={settings.error} /> : !settings.data ? <Loading /> : (
        <>
          {current === 'business' && <Business s={settings.data} reload={settings.reload} />}
          {current === 'analytics' && <Analytics />}
          {current === 'categories' && <Categories />}
          {current === 'packages' && <Packages />}
          {current === 'ai' && <AISettings s={settings.data} reload={settings.reload} />}
          {current === 'sending' && <Sending s={settings.data} reload={settings.reload} />}
          {current === 'suppression' && <Suppression />}
          {current === 'activity' && <AuditLog />}
        </>
      )}
    </>
  )
}

function useSave(reload: () => void) {
  const toast = useToast()
  return async (patch: Record<string, unknown>, ok = 'Saved') => {
    try {
      await api.patch('/api/settings', patch)
      toast(ok)
      reload()
      return true
    } catch (e) {
      toast((e as Error).message, 'error')
      return false
    }
  }
}

function Business({ s, reload }: { s: SettingsData; reload: () => void }) {
  const save = useSave(reload)
  const v = s.values
  const [f, setF] = useState({
    name: String(v['business.creatorName']), handle: String(v['business.handle']), email: String(v['business.email']),
    gmail: String(v['gmail.expectedAccount']), address: String(v['business.postalAddress'] ?? ''),
    goal: String(v['business.revenueGoalMonthlyUsd']), milestones: (v['business.sponsorshipMilestonesUsd'] as number[]).join(', '),
  })
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card title="Creator & contact">
        <div className="space-y-3">
          <Field label="Creator name"><Input value={f.name} onChange={set('name')} /></Field>
          <Field label="Handle"><Input value={f.handle} onChange={set('handle')} /></Field>
          <Field label="Business email (shown in emails)"><Input type="email" value={f.email} onChange={set('email')} /></Field>
          <Field label="Gmail account to connect (Phase 4)" hint="The app will refuse to connect any other Google account."><Input type="email" value={f.gmail} onChange={set('gmail')} /></Field>
          <Field label="Postal address for email footers" hint="Required by US CAN-SPAM in commercial email. A PO box or virtual mailbox works. Needed before live sending; not legal advice.">
            <Textarea className="min-h-16" value={f.address} onChange={set('address')} />
          </Field>
        </div>
      </Card>
      <Card title="Goals">
        <div className="space-y-3">
          <Field label="Monthly gross creator-business revenue goal (USD)"><Input type="number" min="0" value={f.goal} onChange={set('goal')} /></Field>
          <Field label="Monthly sponsorship milestones (USD, comma separated)" hint="Goals, not projections."><Input value={f.milestones} onChange={set('milestones')} /></Field>
        </div>
      </Card>
      <div className="lg:col-span-2 flex justify-end">
        <Button variant="primary" onClick={() => save({
          'business.creatorName': f.name, 'business.handle': f.handle, 'business.email': f.email, 'gmail.expectedAccount': f.gmail,
          'business.postalAddress': f.address, 'business.revenueGoalMonthlyUsd': Number(f.goal),
          'business.sponsorshipMilestonesUsd': f.milestones.split(',').map((x) => Number(x.trim())).filter((x) => !Number.isNaN(x) && x > 0),
        })}>Save business settings</Button>
      </div>
    </div>
  )
}

const PLATFORM_LABEL: Record<string, string> = { instagram: 'Instagram', youtube: 'YouTube', tiktok: 'TikTok', twitch: 'Twitch', combined: 'Combined' }

function Analytics() {
  const { data, error, reload } = useApi<Metric[]>('/api/metrics')
  const [editing, setEditing] = useState<number | null>(null)
  if (error) return <ErrorBox error={error} />
  if (!data) return <Loading />
  const platforms = [...new Set(data.map((m) => m.platform))]
  return (
    <div className="space-y-6">
      <Notice>These are the figures you supplied, with their reporting periods. Pitches will only ever quote numbers from this list. Edit them whenever you have fresh analytics; every change is logged.</Notice>
      {platforms.map((pl) => (
        <Card key={pl} title={PLATFORM_LABEL[pl] ?? pl} padded={false}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[44rem] text-sm">
              <thead className="border-b border-zinc-100 text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
                <tr><th className="px-4 py-2 text-left">Metric</th><th className="px-4 py-2 text-right">Value</th><th className="px-4 py-2 text-left">Period</th><th className="px-4 py-2 text-left">As of</th><th className="px-4 py-2 text-left">Source</th><th className="px-4 py-2" /></tr>
              </thead>
              <tbody>
                {data.filter((m) => m.platform === pl).map((m) => editing === m.id
                  ? <MetricEditor key={m.id} m={m} onDone={() => { setEditing(null); reload() }} onCancel={() => setEditing(null)} />
                  : (
                    <tr key={m.id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800">
                      <td className="px-4 py-2.5">
                        {m.label}
                        {!m.pitchable && <Badge tone="gray">Not used in pitches</Badge>}
                        {m.notes && <div className="text-xs text-zinc-500">{m.notes}</div>}
                      </td>
                      <td className="px-4 py-2.5 text-right font-medium tabular-nums">{metricValue(m.value, m.unit, !!m.approximate)}</td>
                      <td className="px-4 py-2.5 text-zinc-600 dark:text-zinc-400">{m.period_label ?? 'Point in time'}{m.period_start && m.period_end ? <div className="text-xs text-zinc-500">{m.period_start} → {m.period_end}</div> : null}</td>
                      <td className="px-4 py-2.5 text-zinc-600 dark:text-zinc-400">{m.as_of}</td>
                      <td className="px-4 py-2.5 text-xs text-zinc-500">{m.source}</td>
                      <td className="px-4 py-2.5 text-right"><Button size="sm" onClick={() => setEditing(m.id)}>Edit</Button></td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </Card>
      ))}
    </div>
  )
}

function MetricEditor({ m, onDone, onCancel }: { m: Metric; onDone: () => void; onCancel: () => void }) {
  const toast = useToast()
  const [f, setF] = useState({ value: String(m.value), as_of: m.as_of, period_label: m.period_label ?? '', period_start: m.period_start ?? '', period_end: m.period_end ?? '',
    source: m.source, notes: m.notes ?? '', approximate: !!m.approximate, pitchable: !!m.pitchable })
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  const save = async () => {
    try {
      await api.patch(`/api/metrics/${m.id}`, { ...f, value: Number(f.value) })
      toast(`Updated ${m.label}`)
      onDone()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }
  return (
    <tr className="border-b border-zinc-100 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-800/40">
      <td colSpan={6} className="px-4 py-3">
        <div className="mb-2 text-sm font-medium">{m.label}</div>
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Field label={`Value${m.unit === 'percent' ? ' (%)' : ''}`}><Input type="number" step="any" min="0" value={f.value} onChange={set('value')} /></Field>
          <Field label="As of (YYYY-MM-DD)"><Input value={f.as_of} onChange={set('as_of')} /></Field>
          <Field label="Period label"><Input value={f.period_label} onChange={set('period_label')} placeholder="90 days" /></Field>
          <Field label="Period start"><Input type="date" value={f.period_start} onChange={set('period_start')} /></Field>
          <Field label="Period end"><Input type="date" value={f.period_end} onChange={set('period_end')} /></Field>
          <Field label="Source"><Input value={f.source} onChange={set('source')} /></Field>
        </div>
        <Field label="Notes" className="mt-3"><Input value={f.notes} onChange={set('notes')} /></Field>
        <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" checked={f.approximate} onChange={(e) => setF({ ...f, approximate: e.target.checked })} /> Approximate</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={f.pitchable} onChange={(e) => setF({ ...f, pitchable: e.target.checked })} /> May be quoted in pitches</label>
          <div className="ml-auto flex gap-2"><Button onClick={onCancel}>Cancel</Button><Button variant="primary" onClick={save}>Save</Button></div>
        </div>
      </td>
    </tr>
  )
}

function Categories() {
  const toast = useToast()
  const { data, error, reload } = useApi<Category[]>('/api/categories')
  if (error) return <ErrorBox error={error} />
  if (!data) return <Loading />
  const update = async (id: number, patch: Record<string, unknown>) => {
    try {
      await api.patch(`/api/categories/${id}`, patch)
      reload()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }
  return (
    <div className="space-y-3">
      <Notice>Controls how Brand Discovery (Phase 2) spends its research effort. Priority 1 is highest. Quotas cap brands researched per category per batch.</Notice>
      {data.map((c) => (
        <Card key={c.id}>
          <div className="flex flex-wrap items-start gap-4">
            <label className="mt-0.5 flex items-center gap-2">
              <input type="checkbox" checked={!!c.enabled} onChange={(e) => update(c.id, { enabled: e.target.checked })} aria-label={`Enable ${c.name}`} />
            </label>
            <div className="min-w-0 flex-1">
              <div className="font-medium">{c.name} {!c.enabled && <Badge>Disabled</Badge>}</div>
              <div className="text-sm text-zinc-500">{c.description}</div>
              {c.compliance_note && <div className="mt-1 text-xs text-amber-700 dark:text-amber-400">Guardrail: {c.compliance_note}</div>}
            </div>
            <Field label="Priority" className="w-24">
              <Select value={c.priority} onChange={(e) => update(c.id, { priority: Number(e.target.value) })}>
                {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
              </Select>
            </Field>
            <Field label="Research quota" className="w-28">
              <Input type="number" min="0" max="500" defaultValue={c.research_quota}
                onBlur={(e) => Number(e.target.value) !== c.research_quota && update(c.id, { research_quota: Number(e.target.value) })} />
            </Field>
          </div>
        </Card>
      ))}
    </div>
  )
}

function Packages() {
  const toast = useToast()
  const { data, error, reload } = useApi<Package[]>('/api/packages')
  if (error) return <ErrorBox error={error} />
  if (!data) return <Loading />
  return (
    <div className="space-y-4">
      <Notice>
        Your sponsorship packages. Prices are exploratory ranges, not guaranteed market rates. A pitch only mentions a price when you tick
        “include rate” or type custom rate wording for that pitch. Usage rights, paid ads, whitelisting and exclusivity are never included automatically.
      </Notice>
      {data.map((p) => <PackageCard key={p.id} p={p} onSaved={() => { toast(`Saved ${p.name}`); reload() }} onError={(m) => toast(m, 'error')} />)}
    </div>
  )
}

function PackageCard({ p, onSaved, onError }: { p: Package; onSaved: () => void; onError: (m: string) => void }) {
  const [f, setF] = useState({
    name: p.name, deliverables: p.deliverables, min: p.price_min_cents != null ? String(p.price_min_cents / 100) : '',
    max: p.price_max_cents != null ? String(p.price_max_cents / 100) : '', unit: p.price_unit, recurring: !!p.recurring, active: !!p.active,
  })
  const toCents = (s: string) => (s === '' ? null : Math.round(Number(s) * 100))
  const save = async () => {
    try {
      await api.patch(`/api/packages/${p.id}`, {
        name: f.name, deliverables: f.deliverables, price_min_cents: toCents(f.min), price_max_cents: toCents(f.max), price_unit: f.unit, recurring: f.recurring, active: f.active,
      })
      onSaved()
    } catch (e) {
      onError((e as Error).message)
    }
  }
  return (
    <Card>
      <div className="grid gap-3 md:grid-cols-[1fr_1.5fr]">
        <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Deliverables (as written in pitches)"><Input value={f.deliverables} onChange={(e) => setF({ ...f, deliverables: e.target.value })} /></Field>
      </div>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <Field label="Price type" className="w-44">
          <Select value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value as Package['price_unit'] })}>
            <option value="flat">Flat</option><option value="per_month">Per month</option><option value="custom">Custom quote</option>
          </Select>
        </Field>
        <Field label="From (USD)" className="w-28"><Input type="number" min="0" value={f.min} onChange={(e) => setF({ ...f, min: e.target.value })} disabled={f.unit === 'custom'} /></Field>
        <Field label="To (USD)" className="w-28"><Input type="number" min="0" value={f.max} onChange={(e) => setF({ ...f, max: e.target.value })} disabled={f.unit === 'custom'} /></Field>
        <label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" checked={f.recurring} onChange={(e) => setF({ ...f, recurring: e.target.checked })} /> Recurring</label>
        <label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Offer in pitches</label>
        <Button className="ml-auto" onClick={save}>Save</Button>
      </div>
    </Card>
  )
}

type AIStatus = {
  provider: string; paidEnabled: boolean; monthlyBudgetUsd: number; anthropicKeyPresent: boolean; anthropicIntegrationInstalled: boolean
  ollama: { baseUrl: string; model: string; reachable: boolean; models: string[]; error?: string }
  prices: Record<string, { inputPerMTok: number; outputPerMTok: number; verifiedAt: string | null; note: string }>
}
type Usage = {
  budgetUsd: number; paidSpendUsd: number; remainingUsd: number
  byBilling: { billing: string; status: string; calls: number; input: number; output: number; cost: number }[]
  recent: { id: number; provider: string; model: string; purpose: string; billing: string; status: string; input_tokens: number; output_tokens: number; est_cost_usd: number; detail: string | null; created_at: string }[]
}

function AISettings({ s, reload }: { s: SettingsData; reload: () => void }) {
  const save = useSave(reload)
  const toast = useToast()
  const status = useApi<AIStatus>(`/api/ai/status?v=${JSON.stringify(s.values['ai.ollama'])}`)
  const usage = useApi<Usage>('/api/ai/usage')
  const ollama = s.values['ai.ollama'] as { baseUrl: string; model: string }
  const [model, setModel] = useState(ollama.model)
  const [budget, setBudget] = useState(String(s.values['ai.monthlyBudgetUsd']))
  const [prompt, setPrompt] = useState('Write one sentence introducing IronmanCarter, a League of Legends creator.')
  const [result, setResult] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => setModel(ollama.model), [ollama.model])

  const test = async () => {
    setBusy(true)
    setResult(null)
    try {
      const r = await api.post<{ text: string; provider: string; model: string; billing: string; costUsd: number; cached: boolean; inputTokens: number; outputTokens: number }>('/api/ai/test', { prompt })
      setResult(`${r.text}\n\n— ${r.provider} / ${r.model} · ${r.billing.replace('_', ' ')} · ${r.inputTokens}+${r.outputTokens} tokens · ${usdAmount(r.costUsd)}${r.cached ? ' · from cache' : ''}`)
      usage.reload()
    } catch (e) {
      toast((e as Error).message, 'error')
      usage.reload()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <Notice tone="green" title="Current additional AI spend: $0">
        Your Claude Pro subscription covers Claude Code (the assistant building this app). It is billed separately from the Anthropic API, which charges per token to an
        API key. This app uses no paid API: the mock provider runs offline, Ollama runs on your Mac, and the paid Anthropic integration is not installed. A failed free
        provider never falls back to a paid one.
      </Notice>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Provider">
          <div className="space-y-3">
            {[
              { id: 'mock', title: 'Mock (offline)', desc: 'Deterministic placeholder responses for development and tests. $0.' },
              { id: 'ollama', title: 'Ollama (local)', desc: 'Runs models on this Mac. $0 beyond electricity. Slower, lower quality than paid models.' },
              { id: 'anthropic', title: 'Anthropic API (paid)', desc: 'Disabled. Needs your approval, verified prices, a budget above $0, an API key and the integration installed.' },
            ].map((p) => (
              <label key={p.id} className={`flex gap-3 rounded-lg border p-3 ${s.values['ai.provider'] === p.id ? 'border-brand-500' : 'border-zinc-200 dark:border-zinc-800'} ${p.id === 'anthropic' ? 'opacity-60' : 'cursor-pointer'}`}>
                <input type="radio" name="provider" disabled={p.id === 'anthropic'} checked={s.values['ai.provider'] === p.id}
                  onChange={() => save({ 'ai.provider': p.id }, `Provider: ${p.title}`)} />
                <span><span className="block text-sm font-medium">{p.title}</span><span className="text-xs text-zinc-500">{p.desc}</span></span>
              </label>
            ))}
          </div>
        </Card>

        <Card title="Ollama">
          {status.data ? (
            <div className="space-y-3 text-sm">
              <div>Status: {status.data.ollama.reachable ? <Badge tone="green">Running</Badge> : <Badge tone="amber">Not reachable</Badge>} <span className="text-xs text-zinc-500">{status.data.ollama.baseUrl}</span></div>
              {status.data.ollama.error && <div className="text-xs text-zinc-500">{status.data.ollama.error}. Start the Ollama app to use local AI.</div>}
              <Field label="Model">
                {status.data.ollama.models.length ? (
                  <Select value={model} onChange={(e) => setModel(e.target.value)}>
                    {!status.data.ollama.models.includes(model) && <option value={model}>{model} (not installed)</option>}
                    {status.data.ollama.models.map((m) => <option key={m} value={m}>{m}</option>)}
                  </Select>
                ) : <Input value={model} onChange={(e) => setModel(e.target.value)} />}
              </Field>
              <Button onClick={() => save({ 'ai.ollama': { ...ollama, model } }, 'Ollama model saved')} disabled={model === ollama.model}>Save model</Button>
            </div>
          ) : <Loading />}
        </Card>

        <Card title="Paid AI budget">
          <div className="space-y-3 text-sm">
            <Field label="Monthly paid-AI budget (USD)" hint="Paid calls are refused once this month's spend plus the next call's estimate would exceed it.">
              <Input type="number" min="0" step="1" value={budget} onChange={(e) => setBudget(e.target.value)} />
            </Field>
            <Button onClick={() => save({ 'ai.monthlyBudgetUsd': Number(budget) }, 'Budget saved')} disabled={Number(budget) === s.values['ai.monthlyBudgetUsd']}>Save budget</Button>
            {usage.data && (
              <dl className="grid grid-cols-2 gap-1 pt-2">
                <dt className="text-zinc-500">Paid spend this month</dt><dd className="text-right tabular-nums">{usdAmount(usage.data.paidSpendUsd)}</dd>
                <dt className="text-zinc-500">Remaining</dt><dd className="text-right tabular-nums">{usdAmount(usage.data.remainingUsd)}</dd>
              </dl>
            )}
          </div>
        </Card>

        <Card title="Reference prices (unverified)">
          {status.data && (
            <>
              <table className="w-full text-sm">
                <thead className="text-xs text-zinc-500"><tr><th className="text-left">Model</th><th className="text-right">Input / MTok</th><th className="text-right">Output / MTok</th></tr></thead>
                <tbody>
                  {Object.entries(status.data.prices).map(([m, p]) => (
                    <tr key={m}><td className="py-1 font-mono text-xs">{m}</td><td className="text-right tabular-nums">{usdAmount(p.inputPerMTok)}</td><td className="text-right tabular-nums">{usdAmount(p.outputPerMTok)}</td></tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-zinc-500">Not used for any decision until verified against current published pricing. Routine work would use {String((s.values['ai.anthropic'] as { routineModel: string }).routineModel)}; premium is reserved for complex tasks.</p>
            </>
          )}
        </Card>
      </div>

      <Card title="Test the selected provider">
        <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        <div className="mt-2 flex justify-end"><Button variant="primary" onClick={test} disabled={busy || !prompt.trim()}>{busy ? 'Running…' : 'Run test'}</Button></div>
        {result && <pre className="mt-3 whitespace-pre-wrap rounded-lg bg-zinc-100 p-3 text-sm dark:bg-zinc-800">{result}</pre>}
      </Card>

      <Card title="Usage ledger (every call, including blocked and cached)" padded={false}>
        {usage.data && usage.data.recent.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead className="border-b border-zinc-100 text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800"><tr><th className="px-4 py-2 text-left">When</th><th className="px-4 py-2 text-left">Provider</th><th className="px-4 py-2 text-left">Purpose</th><th className="px-4 py-2 text-left">Billing</th><th className="px-4 py-2 text-left">Status</th><th className="px-4 py-2 text-right">Tokens</th><th className="px-4 py-2 text-right">Cost</th></tr></thead>
              <tbody>
                {usage.data.recent.map((r) => (
                  <tr key={r.id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800" title={r.detail ?? ''}>
                    <td className="px-4 py-2 text-zinc-500">{dateTime(r.created_at)}</td>
                    <td className="px-4 py-2">{r.provider} <span className="text-xs text-zinc-500">{r.model}</span></td>
                    <td className="px-4 py-2">{r.purpose}</td>
                    <td className="px-4 py-2"><Badge tone={r.billing === 'paid_api' ? 'amber' : 'green'}>{r.billing.replace('_', ' ')}</Badge></td>
                    <td className="px-4 py-2"><Badge tone={r.status === 'ok' || r.status === 'cached' ? 'gray' : 'red'}>{r.status}</Badge></td>
                    <td className="px-4 py-2 text-right tabular-nums">{r.input_tokens + r.output_tokens}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{usdAmount(r.est_cost_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="p-5 text-sm text-zinc-500">No AI calls yet.</p>}
      </Card>
    </div>
  )
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function Sending({ s, reload }: { s: SettingsData; reload: () => void }) {
  const save = useSave(reload)
  const hours = s.values['outreach.businessHours'] as { timezone: string; start: string; end: string; days: number[] }
  const fu = s.values['outreach.followUps'] as { enabled: boolean; firstAfterBusinessDays: number; secondAfterBusinessDays: number; max: number }
  const [h, setH] = useState(hours)
  const [f, setF] = useState(fu)
  const [fresh, setFresh] = useState(String(s.values['outreach.researchFreshnessDays']))
  const [juris, setJuris] = useState((s.values['outreach.autoEligibleJurisdictions'] as string[]).join(', '))
  return (
    <div className="space-y-6">
      <Card title="Locked until later phases">
        <ul className="space-y-2 text-sm">
          {Object.entries(s.locked).map(([k, why]) => (
            <li key={k} className="flex flex-wrap gap-2"><code className="text-xs">{k}</code><Badge>{String(s.values[k])}</Badge><span className="text-zinc-500">{why}</span></li>
          ))}
        </ul>
      </Card>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Business hours (for future sending)">
          <div className="space-y-3">
            <Field label="Time zone"><Input value={h.timezone} onChange={(e) => setH({ ...h, timezone: e.target.value })} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Start"><Input type="time" value={h.start} onChange={(e) => setH({ ...h, start: e.target.value })} /></Field>
              <Field label="End"><Input type="time" value={h.end} onChange={(e) => setH({ ...h, end: e.target.value })} /></Field>
            </div>
            <div className="flex flex-wrap gap-2">
              {DAYS.map((d, i) => (
                <label key={d} className="flex items-center gap-1 text-sm">
                  <input type="checkbox" checked={h.days.includes(i)} onChange={(e) => setH({ ...h, days: e.target.checked ? [...h.days, i] : h.days.filter((x) => x !== i) })} />{d}
                </label>
              ))}
            </div>
            <Button onClick={() => save({ 'outreach.businessHours': h })}>Save hours</Button>
          </div>
        </Card>
        <Card title="Follow-up schedule">
          <div className="space-y-3">
            <Notice tone="amber">Automatic follow-ups stay off until sending exists and you enable them separately.</Notice>
            <div className="grid grid-cols-3 gap-3">
              <Field label="1st after (business days)"><Input type="number" min="1" value={f.firstAfterBusinessDays} onChange={(e) => setF({ ...f, firstAfterBusinessDays: Number(e.target.value) })} /></Field>
              <Field label="2nd after (business days)"><Input type="number" min="1" value={f.secondAfterBusinessDays} onChange={(e) => setF({ ...f, secondAfterBusinessDays: Number(e.target.value) })} /></Field>
              <Field label="Maximum"><Select value={f.max} onChange={(e) => setF({ ...f, max: Number(e.target.value) })}><option value={0}>0</option><option value={1}>1</option><option value={2}>2</option></Select></Field>
            </div>
            <Button onClick={() => save({ 'outreach.followUps': { ...f, enabled: false } })}>Save schedule</Button>
          </div>
        </Card>
        <Card title="Eligibility rules">
          <div className="space-y-3">
            <Field label="Contact verification stays fresh for (days)"><Input type="number" min="1" value={fresh} onChange={(e) => setFresh(e.target.value)} /></Field>
            <Field label="Jurisdictions allowed without manual review" hint="Others (and unknown) always need your review. Canada, EU and UK have stricter consent rules."><Input value={juris} onChange={(e) => setJuris(e.target.value)} /></Field>
            <Button onClick={() => save({ 'outreach.researchFreshnessDays': Number(fresh), 'outreach.autoEligibleJurisdictions': juris.split(',').map((j) => j.trim()).filter(Boolean) })}>Save rules</Button>
          </div>
        </Card>
      </div>
    </div>
  )
}

type SuppressionRow = { id: number; kind: string; value: string; reason: string; source: string; created_at: string }

function Suppression() {
  const toast = useToast()
  const { data, error, reload } = useApi<SuppressionRow[]>('/api/suppressions')
  const [f, setF] = useState({ kind: 'email', value: '', reason: '' })
  if (error) return <ErrorBox error={error} />
  return (
    <div className="space-y-6">
      <Card title="Add to the do-not-contact list">
        <form className="flex flex-wrap items-end gap-2" onSubmit={async (e) => {
          e.preventDefault()
          try {
            await api.post('/api/suppressions', f)
            toast('Suppressed')
            setF({ ...f, value: '', reason: '' })
            reload()
          } catch (err) {
            toast((err as Error).message, 'error')
          }
        }}>
          <Field label="Type" className="w-32"><Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="email">Email</option><option value="domain">Domain</option></Select></Field>
          <Field label="Value" className="min-w-56 flex-1"><Input required value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} /></Field>
          <Field label="Reason" className="min-w-56 flex-1"><Input required value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
          <Button type="submit" variant="primary">Add</Button>
        </form>
      </Card>
      <Card title="Suppressed" padded={false}>
        {!data ? <Loading /> : data.length === 0 ? <p className="p-5 text-sm text-zinc-500">Nothing suppressed yet. Opt-outs are added here automatically and can never be removed.</p> : (
          <table className="w-full text-sm">
            <tbody>
              {data.map((r) => (
                <tr key={r.id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800">
                  <td className="px-4 py-2"><Badge>{r.kind}</Badge></td>
                  <td className="px-4 py-2 font-medium">{r.value}</td>
                  <td className="px-4 py-2 text-zinc-500">{r.reason}</td>
                  <td className="px-4 py-2"><Badge tone={r.source === 'manual' ? 'gray' : 'red'}>{r.source.replace('_', '-')}</Badge></td>
                  <td className="px-4 py-2 text-xs text-zinc-400">{dateTime(r.created_at)}</td>
                  <td className="px-4 py-2 text-right">{r.source === 'manual' && <Button size="sm" variant="ghost" onClick={async () => {
                    if (!confirm(`Remove ${r.value} from the suppression list?`)) return
                    try { await api.del(`/api/suppressions/${r.id}`); reload() } catch (err) { toast((err as Error).message, 'error') }
                  }}>Remove</Button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  )
}

function AuditLog() {
  const { data, error } = useApi<Activity[]>('/api/activity?limit=300')
  if (error) return <ErrorBox error={error} />
  if (!data) return <Loading />
  return (
    <Card title="Everything the app has done (newest first)" padded={false}>
      <table className="w-full text-sm">
        <tbody>
          {data.map((a) => (
            <tr key={a.id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800">
              <td className="whitespace-nowrap px-4 py-2 text-xs text-zinc-400">{dateTime(a.created_at)}</td>
              <td className="px-4 py-2"><code className="text-xs text-zinc-500">{a.type}</code></td>
              <td className="px-4 py-2">{a.company_name && a.prospect_id ? <a className="font-medium hover:underline" href={`#/prospects/${a.prospect_id}`}>{a.company_name}: </a> : null}{a.summary}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}
