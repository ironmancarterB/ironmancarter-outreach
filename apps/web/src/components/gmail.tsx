// Gmail draft status and actions. Drafts only: nothing here can send.
import { useState } from 'react'
import { api } from '../lib/api'
import { relative } from '../lib/format'
import type { GmailDraftView, GmailVerification, PitchView } from '../lib/types'
import { Badge, Button, Card, Notice, useToast } from './ui'
import { SendDialog } from './send'

const STATUS: Record<GmailDraftView['status'], { label: string; tone: 'green' | 'amber' | 'red' | 'gray' | 'blue' }> = {
  creating: { label: 'Creating…', tone: 'blue' },
  created: { label: 'In Gmail drafts', tone: 'green' },
  uncertain: { label: 'Status uncertain', tone: 'amber' },
  failed: { label: 'Not created', tone: 'red' },
  gone: { label: 'No longer in Gmail drafts', tone: 'gray' },
  unlinked: { label: 'Unlinked', tone: 'gray' },
  sent: { label: 'Sent', tone: 'green' },
}

export function GmailStatusBadge({ draft }: { draft: GmailDraftView | null | undefined }) {
  if (!draft) return <Badge tone="gray">No Gmail draft</Badge>
  const s = STATUS[draft.status]
  return <Badge tone={draft.status === 'created' && (draft.outOfDate || draft.editedInGmail) ? 'amber' : s.tone}>
    {s.label}{draft.status === 'created' && draft.outOfDate ? ' · out of date' : ''}{draft.status === 'created' && draft.editedInGmail ? ' · changed in Gmail' : ''}
  </Badge>
}

export function Verification({ v }: { v: GmailVerification | null }) {
  if (!v) return <p className="text-xs text-zinc-500">Not yet read back from Gmail.</p>
  return (
    <div className="space-y-1">
      <p className={`text-xs font-medium ${v.ok ? 'text-emerald-600' : 'text-rose-600'}`}>
        {v.ok ? 'Read back from Gmail and verified' : 'Verification found problems'} · {relative(v.checkedAt)}
      </p>
      <ul className="space-y-0.5 text-xs">
        {v.checks.map((c) => (
          <li key={c.label} className="flex gap-1.5">
            <span className={c.ok ? 'text-emerald-600' : 'text-rose-600'} aria-hidden>{c.ok ? '✓' : '✗'}</span>
            <span><span className="sr-only">{c.ok ? 'Passed: ' : 'Failed: '}</span>{c.label}{c.label.includes('SHA-256') ? '' : <span className="text-zinc-500"> · {c.detail}</span>}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function GmailPanel({ view, onChange }: { view: PitchView; onChange: (v: PitchView) => void }) {
  const toast = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const g = view.gmail
  const p = view.pitch
  if (!g || p.channel !== 'email') return null
  const d = g.draft
  const run = async (label: string, fn: () => Promise<unknown>, ok: string, reload = true) => {
    setBusy(label)
    try {
      const r = await fn()
      if (reload) onChange(await api.get<PitchView>(`/api/pitches/${p.id}`))
      else onChange(r as PitchView)
      toast(ok)
    } catch (e) {
      toast((e as Error).message, 'error')
      onChange(await api.get<PitchView>(`/api/pitches/${p.id}`))
    } finally {
      setBusy(null)
    }
  }
  const create = () => {
    if (!confirm(`Create a Gmail draft to ${p.recipient_email} in ${g.account}?\n\nIt goes into your Gmail Drafts folder with your media kit attached. Nothing is sent. You can review, edit or delete it in Gmail.`)) return
    run('create', () => api.post(`/api/pitches/${p.id}/gmail-draft`, { confirm: true }), 'Gmail draft created. Nothing was sent.')
  }
  const update = () => {
    const overwrite = d?.editedInGmail
    if (!confirm(overwrite
      ? 'This draft was changed in Gmail. Replace it with the approved pitch? Your Gmail changes will be lost. Nothing is sent.'
      : 'Replace the Gmail draft’s content with this approved version? It stays the same draft. Nothing is sent.')) return
    run('update', () => api.put(`/api/pitches/${p.id}/gmail-draft`, { confirm: true, overwriteGmailEdits: !!overwrite }), 'Gmail draft updated. Nothing was sent.')
  }
  const check = () => run('check', async () => {
    const r = await api.post<{ found: boolean }>(`/api/gmail/drafts/${d!.id}/check`)
    if (!r.found) throw new Error('Not found in Gmail drafts. Look in Gmail yourself; if it is not there, choose "It was not created".')
  }, 'Found in Gmail and linked')
  const notCreated = () => {
    if (!confirm('Record that this draft was NOT created in Gmail? Only do this if you checked Gmail Drafts yourself. You can then create it again.')) return
    run('nc', () => api.post(`/api/gmail/drafts/${d!.id}/not-created`, { confirm: true }), 'Recorded')
  }
  const verify = () => run('verify', () => api.post(`/api/gmail/drafts/${d!.id}/verify`), 'Checked against Gmail')
  const unlink = () => {
    if (!confirm('Stop tracking this Gmail draft? The copy in Gmail is left exactly as it is (delete it there yourself if you want). You can then create a new draft.')) return
    run('unlink', () => api.post(`/api/gmail/drafts/${d!.id}/unlink`, { confirm: true }), 'Unlinked')
  }

  const live = d && ['created', 'uncertain', 'creating'].includes(d.status)
  const forThisVersion = d?.pitchId === p.id
  const sent = view.send && ['sent', 'sending', 'uncertain'].includes(view.send.status) ? view.send : null
  const reload = async () => onChange(await api.get<PitchView>(`/api/pitches/${p.id}`))
  return (
    <Card title="Gmail draft" actions={sent ? <Badge tone={sent.status === 'sent' ? 'green' : 'amber'}>{sent.status === 'sent' ? 'Sent' : 'Send status uncertain'}</Badge> : <GmailStatusBadge draft={live ? d : null} />}>
      <div className="space-y-3 text-sm">
        {sent && (
          <Notice tone={sent.status === 'sent' ? 'green' : 'amber'} title={sent.status === 'sent' ? `Sent${sent.sent_at ? ` ${relative(sent.sent_at)}` : ''}${sent.origin === 'gmail' ? ' by you from Gmail' : ''}` : 'Send status uncertain'}>
            {sent.status === 'sent' ? 'Replies and follow-ups are tracked in Outreach.' : 'It was not retried. Reconcile it in Outreach → Sent before doing anything else.'}{' '}
            <a className="underline" href={sent.status === 'sent' ? '#/outreach/conversations' : '#/outreach/sent'}>Open Outreach</a>
          </Notice>
        )}
        {!g.connected ? (
          <Notice tone="amber">Gmail is not connected. <a className="underline" href="#/settings/gmail">Connect it in Settings → Gmail</a>.</Notice>
        ) : p.status !== 'approved' && !live ? (
          <p className="text-zinc-500">Approve this pitch to create a Gmail draft. Approval is not permission to send; the draft only goes into your Drafts folder.</p>
        ) : null}

        {d && live && (
          <div className="space-y-2">
            <div className="text-xs text-zinc-500">
              To {d.recipient} · created {relative(d.createdAt)}{d.lastSyncedAt ? ` · checked ${relative(d.lastSyncedAt)}` : ''}
              {!forThisVersion && d.status === 'created' && ' · made from an earlier version of this pitch'}
            </div>
            {d.status === 'created' && d.outOfDate && <Notice tone="amber">The Gmail copy differs from this {p.status === 'approved' ? 'approved' : 'unapproved'} version.{p.status === 'approved' ? ' Use "Update Gmail draft" to replace it.' : ' Approve it first to update Gmail.'}</Notice>}
            {d.editedInGmail && <Notice tone="amber">You changed this draft in Gmail. The app has not changed it back.</Notice>}
            {d.status === 'uncertain' && (
              <Notice tone="amber" title="Draft status uncertain">
                {d.note ?? 'Google did not confirm whether this draft was created. It was not retried.'} Check Gmail before doing anything else.
              </Notice>
            )}
            {d.note && d.status !== 'uncertain' && <p className="text-xs text-zinc-500">{d.note}</p>}
            {d.status === 'created' && <Verification v={d.verification} />}
          </div>
        )}
        {d && !live && d.note && <p className="text-xs text-zinc-500">Last draft: {STATUS[d.status].label.toLowerCase()}. {d.note}</p>}

        <div className="flex flex-wrap gap-2">
          {d?.openUrl && <a href={d.openUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center rounded-lg bg-brand-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-brand-700">Open in Gmail ↗</a>}
          {g.connected && !live && p.status === 'approved' && <Button size="sm" variant="primary" onClick={create} disabled={busy !== null}>{busy === 'create' ? 'Creating…' : 'Create Gmail draft'}</Button>}
          {g.connected && d?.status === 'created' && p.status === 'approved' && (d.outOfDate || d.editedInGmail) && <Button size="sm" onClick={update} disabled={busy !== null}>{busy === 'update' ? 'Updating…' : 'Update Gmail draft'}</Button>}
          {g.connected && d?.status === 'created' && <Button size="sm" onClick={verify} disabled={busy !== null}>{busy === 'verify' ? 'Checking…' : 'Re-check in Gmail'}</Button>}
          {g.connected && d?.status === 'uncertain' && <Button size="sm" variant="primary" onClick={check} disabled={busy !== null}>{busy === 'check' ? 'Checking…' : 'Check Gmail'}</Button>}
          {d?.status === 'uncertain' && /not found/.test(d.note ?? '') && <Button size="sm" onClick={notCreated} disabled={busy !== null}>It was not created</Button>}
          {g.connected && !sent && d?.status === 'created' && p.status === 'approved' && !d.outOfDate && !d.editedInGmail && <Button size="sm" variant="secondary" onClick={() => setSending(true)}>Review &amp; send…</Button>}
          {d?.status === 'created' && <Button size="sm" variant="ghost" onClick={unlink} disabled={busy !== null}>Unlink</Button>}
        </div>
        <p className="text-xs text-zinc-500">Approval is not permission to send. Sending happens only from the review dialog, one email at a time, after every safeguard passes and you confirm.</p>
      </div>
      <SendDialog target={sending ? { pitchId: p.id } : null} title={`Send first email to ${view.company.name}`} onClose={() => setSending(false)} onSent={reload} />
    </Card>
  )
}
