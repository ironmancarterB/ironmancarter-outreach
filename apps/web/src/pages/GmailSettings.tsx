// Settings → Gmail: connect the account with Google's OAuth, create a test draft, and see every Gmail draft and API call.
import { useCallback, useState } from 'react'
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, Notice, Textarea, useToast } from '../components/ui'
import { GmailStatusBadge, Verification } from '../components/gmail'
import { api, useApi, usePoll } from '../lib/api'
import { dateTime, relative } from '../lib/format'
import type { GmailDraftView, GmailOperation, GmailStatus } from '../lib/types'

export default function GmailSettings() {
  const toast = useToast()
  const status = useApi<GmailStatus>('/api/gmail/status')
  const drafts = useApi<GmailDraftView[]>('/api/gmail/drafts')
  const ops = useApi<GmailOperation[]>('/api/gmail/operations')
  const [waiting, setWaiting] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const reloadAll = useCallback(() => { status.reload(); drafts.reload(); ops.reload() }, [status.reload, drafts.reload, ops.reload])

  // While you are on Google's consent page, check every few seconds whether the connection arrived.
  const poll = useCallback(async () => {
    const s = await api.get<GmailStatus>('/api/gmail/status').catch(() => null)
    if (s?.account?.status === 'connected') {
      setWaiting(false)
      toast(`Connected ${s.account.email}`)
      reloadAll()
    }
  }, [reloadAll, toast])
  usePoll(poll, 3000, waiting)

  if (status.error) return <ErrorBox error={status.error} />
  if (!status.data) return <Loading />
  const s = status.data
  const connected = s.account?.status === 'connected'

  const act = async (label: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(label)
    try {
      await fn()
      toast(ok)
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(null)
      reloadAll()
    }
  }
  const connect = () => act('connect', async () => {
    const { url } = await api.post<{ url: string }>('/api/gmail/connect')
    window.open(url, '_blank', 'noopener')
    setWaiting(true)
  }, 'Google’s sign-in page opened in a new tab')
  const disconnect = () => {
    if (!confirm(`Disconnect ${s.account?.email}? The app revokes its access at Google and deletes the stored token. Drafts already in Gmail are left there.`)) return
    act('disconnect', () => api.post('/api/gmail/disconnect', { confirm: true }), 'Disconnected')
  }
  const testDraft = () => {
    if (!confirm(`Create one test draft addressed to ${s.account?.email} (yourself), with your media kit attached?\n\nIt goes into your Gmail Drafts folder. Nothing is sent and no brand is involved.`)) return
    act('test', () => api.post('/api/gmail/test-draft', { confirm: true }), 'Test draft created in Gmail. Nothing was sent.')
  }
  const sync = () => act('sync', async () => {
    const r = await api.post<{ checked: number; gone: number; edited: number; errors: number }>('/api/gmail/sync')
    toast(`Checked ${r.checked}: ${r.gone} no longer in Gmail, ${r.edited} changed in Gmail${r.errors ? `, ${r.errors} errors` : ''}`)
  }, 'Synced with Gmail')

  return (
    <div className="space-y-5">
      <Notice tone="green" title="Drafts only. Sending is disabled.">
        The app can create and update drafts in your Gmail Drafts folder. It has no code that sends email, and approving a pitch is not permission to send.
        Sending is built in Phase 5 and stays off until you explicitly enable it.
      </Notice>

      <Card title="Connection" actions={connected ? <Badge tone="green">Connected</Badge> : s.account?.status === 'needs_reconnect' ? <Badge tone="amber">Reconnect needed</Badge> : <Badge tone="gray">Not connected</Badge>}>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[12rem_1fr]">
          <dt className="text-zinc-500">Account</dt>
          <dd className="break-all">{s.account ? s.account.email : `Only ${s.expectedAccount} can connect`}{s.account && ` · since ${dateTime(s.account.connectedAt)}`}</dd>
          <dt className="text-zinc-500">Permission requested</dt>
          <dd><code className="break-all text-xs">{s.requestedScopes.join(' ')}</code><div className="text-xs text-zinc-500">Create, read and update drafts. Google describes it as “Manage drafts and send emails”; this app has no sending code. It is the narrowest permission that can create drafts.</div></dd>
          <dt className="text-zinc-500">Tokens stored in</dt>
          <dd>{s.secretStorage}. Never in the database, the project folder or Git. Your Gmail password never reaches the app.</dd>
          <dt className="text-zinc-500">OAuth client</dt>
          <dd>{s.clientConfigured ? <code className="text-xs">{s.clientId}</code> : 'Not added yet'}</dd>
          <dt className="text-zinc-500">Gmail drafts</dt>
          <dd>{Object.keys(s.drafts).length ? Object.entries(s.drafts).map(([k, n]) => `${n} ${k}`).join(' · ') : 'None yet'}{s.lastSyncAt && ` · last checked ${relative(s.lastSyncAt)}`}</dd>
        </dl>
        {s.account?.lastError && <div className="mt-3"><Notice tone="amber">{s.account.lastError}</Notice></div>}
        <div className="mt-4 flex flex-wrap gap-2">
          {!connected && <Button variant="primary" onClick={connect} disabled={!s.clientConfigured || busy !== null}>{s.account?.status === 'needs_reconnect' ? 'Reconnect Gmail' : `Connect ${s.expectedAccount}`}</Button>}
          {connected && <Button variant="primary" onClick={testDraft} disabled={busy !== null}>{busy === 'test' ? 'Creating…' : 'Create test draft to myself'}</Button>}
          {connected && <Button onClick={sync} disabled={busy !== null}>{busy === 'sync' ? 'Syncing…' : 'Sync with Gmail'}</Button>}
          {s.account && <Button variant="danger" onClick={disconnect} disabled={busy !== null}>Disconnect</Button>}
        </div>
        {waiting && <p className="mt-3 text-sm text-brand-600">Waiting for you to finish on Google’s page… <button className="underline" onClick={() => setWaiting(false)}>Stop waiting</button></p>}
      </Card>

      {!s.account && <Setup s={s} onSaved={reloadAll} />}

      <Card title="Gmail drafts created by the app" padded={false}>
        {!drafts.data ? <Loading /> : drafts.data.length === 0 ? <div className="p-5"><Empty title="No Gmail drafts yet">Create the test draft first, then drafts from approved pitches (Email Drafts → Approved).</Empty></div> : (
          <ul>
            {drafts.data.map((d) => (
              <li key={d.id} className="space-y-1.5 border-b border-zinc-100 px-5 py-3 last:border-0 dark:border-zinc-800">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{d.kind === 'test' ? 'Test draft (to yourself)' : d.companyName ?? 'Deleted company'}</span>
                  <GmailStatusBadge draft={d} />
                  {d.pitchId && <a className="text-xs text-brand-600 hover:underline" href={`#/drafts/pitch/${d.pitchId}`}>Pitch</a>}
                  {d.openUrl && <a className="text-xs text-brand-600 hover:underline" href={d.openUrl} target="_blank" rel="noreferrer noopener">Open in Gmail ↗</a>}
                  <span className="ml-auto text-xs text-zinc-500">{relative(d.createdAt)}</span>
                </div>
                <div className="truncate text-sm text-zinc-600 dark:text-zinc-400">To {d.recipient} · {d.subject}</div>
                {d.note && <div className="text-xs text-zinc-500">{d.note}</div>}
                {d.status === 'created' && <Verification v={d.verification} />}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Gmail API activity (newest first)" padded={false}>
        {!ops.data ? <Loading /> : ops.data.length === 0 ? <p className="p-5 text-sm text-zinc-500">No calls to Gmail yet.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <tbody>
                {ops.data.map((o) => (
                  <tr key={o.id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800">
                    <td className="whitespace-nowrap px-4 py-2 text-xs text-zinc-400">{dateTime(o.started_at)}</td>
                    <td className="px-4 py-2"><code className="text-xs">{o.operation}</code></td>
                    <td className="px-4 py-2"><Badge tone={o.status === 'ok' ? 'green' : o.status === 'failed' ? 'red' : 'amber'}>{o.status}{o.http_status ? ` ${o.http_status}` : ''}</Badge></td>
                    <td className="min-w-[14rem] px-4 py-2 text-xs text-zinc-500">{o.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}

function Setup({ s, onSaved }: { s: GmailStatus; onSaved: () => void }) {
  const toast = useToast()
  const [json, setJson] = useState('')
  const [id, setId] = useState('')
  const [secret, setSecret] = useState('')
  const save = async () => {
    try {
      await api.put('/api/gmail/client', json.trim() ? { json } : { client_id: id, client_secret: secret })
      setJson(''); setId(''); setSecret('')
      toast('OAuth client saved in your Keychain')
      onSaved()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }
  return (
    <Card title="One-time setup in Google Cloud (free)">
      <ol className="list-decimal space-y-2 pl-5 text-sm">
        <li>Open <a className="text-brand-600 hover:underline" href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noreferrer noopener">console.cloud.google.com</a> signed in as {s.expectedAccount} and create a project (for example “IronmanCarter Outreach”). No billing account is needed.</li>
        <li>APIs &amp; Services → Library → <strong>Gmail API</strong> → Enable.</li>
        <li>Google Auth Platform (OAuth consent screen) → Get started: app name “IronmanCarter Outreach”, support email {s.expectedAccount}, audience <strong>External</strong>, contact email, agree to the policy.</li>
        <li>Audience → Test users → add <strong>{s.expectedAccount}</strong>. (In Testing mode Google ends the connection every 7 days; you reconnect with one click.)</li>
        <li>Data access → Add or remove scopes → add <code className="text-xs">{s.requestedScopes[0]}</code> only.</li>
        <li>Clients → Create client → Application type <strong>Desktop app</strong> → Create → <strong>Download JSON</strong>.</li>
        <li>Paste the downloaded file’s contents below (or the client ID and secret) and save. Then press Connect.</li>
      </ol>
      <p className="mt-3 text-xs text-zinc-500">The redirect address is <code>{s.redirectUri}</code> (this computer only). Desktop clients accept it without extra configuration.</p>
      <div className="mt-4 space-y-3">
        <Field label="Downloaded client JSON" hint="Starts with {&quot;installed&quot;: …}. Stored in your macOS Keychain, not in the project.">
          <Textarea value={json} onChange={(e) => setJson(e.target.value)} placeholder='{"installed":{"client_id":"…","client_secret":"…", …}}' spellCheck={false} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="…or client ID"><Input value={id} onChange={(e) => setId(e.target.value)} placeholder="….apps.googleusercontent.com" spellCheck={false} /></Field>
          <Field label="Client secret"><Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" /></Field>
        </div>
        <Button variant="primary" onClick={save} disabled={!json.trim() && (!id.trim() || !secret.trim())}>Save OAuth client</Button>
      </div>
    </Card>
  )
}
