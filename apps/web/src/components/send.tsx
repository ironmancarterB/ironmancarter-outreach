// The only place in the dashboard that can send an email: review every safeguard and the exact message,
// tick that you reviewed it, then press Send. One email per confirmation; there is no bulk send.
import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { Badge, Button, Loading, Modal, Notice, useToast } from './ui'

export interface Preparation {
  ready: boolean
  checks: { label: string; ok: boolean; detail: string }[]
  preview: { from: string; to: string; subject: string; body: string; attachment: { filename: string; sha256: string } | null } | null
  contentSha256: string | null
  token: string | null
  expiresAt: string | null
  limits: { newEmails: { sent: number; limit: number }; followUps: { sent: number; limit: number }; total: { sent: number; limit: number } }
}

export function SendDialog({ target, title, onClose, onSent }: { target: { pitchId: number } | { followUpId: number } | null; title: string; onClose: () => void; onSent: () => void }) {
  const toast = useToast()
  const [prep, setPrep] = useState<Preparation | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reviewed, setReviewed] = useState(false)
  const [busy, setBusy] = useState(false)
  const key = target ? JSON.stringify(target) : null
  useEffect(() => {
    if (!target) return
    setPrep(null); setError(null); setReviewed(false)
    api.post<Preparation>('/api/outreach/send/prepare', target).then(setPrep).catch((e: Error) => setError(e.message))
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps

  const send = async () => {
    if (!prep?.token || !prep.preview) return
    setBusy(true)
    try {
      await api.post('/api/outreach/send/confirm', { token: prep.token, recipient: prep.preview.to, subject: prep.preview.subject, contentSha256: prep.contentSha256 })
      toast(`Sent to ${prep.preview.to}`)
      onSent()
      onClose()
    } catch (e) {
      toast((e as Error).message, 'error')
      setError((e as Error).message)
      setPrep((p) => (p ? { ...p, token: null, ready: false } : p))
    } finally {
      setBusy(false)
    }
  }

  const failing = prep?.checks.filter((c) => !c.ok) ?? []
  return (
    <Modal open={!!target} onClose={onClose} title={title} wide>
      {error && <div className="mb-3"><Notice tone="red">{error}</Notice></div>}
      {!prep && !error ? <Loading /> : prep && (
        <div className="space-y-4 text-sm">
          {prep.ready
            ? <Notice tone="amber" title="Review this exact email">Pressing Send sends this one email from your Gmail, now. It cannot be undone.</Notice>
            : <Notice tone={failing.length === 1 && failing[0].label === 'Live sending is switched on' ? 'blue' : 'red'} title="Not ready to send">
                {failing.length === 1 && failing[0].label === 'Live sending is switched on' ? 'Everything else passes. Live sending is off, so this is a preview only.' : `${failing.length} safeguard${failing.length === 1 ? '' : 's'} not met (below). Nothing can be sent.`}
              </Notice>}
          <ul className="grid gap-1 sm:grid-cols-2">
            {prep.checks.map((c) => (
              <li key={c.label} className="flex gap-1.5">
                <span className={c.ok ? 'text-emerald-600' : 'text-rose-600'} aria-hidden>{c.ok ? '✓' : '✗'}</span>
                <span><span className="sr-only">{c.ok ? 'Passed: ' : 'Not met: '}</span>{c.label}<span className="block text-xs text-zinc-500">{c.detail}</span></span>
              </li>
            ))}
          </ul>
          {prep.preview && (
            <div className="rounded-lg border border-zinc-200 dark:border-zinc-700">
              <dl className="grid grid-cols-[4.5rem_1fr] gap-x-3 gap-y-1 border-b border-zinc-100 p-3 text-xs dark:border-zinc-800">
                <dt className="text-zinc-500">From</dt><dd className="break-all">{prep.preview.from}</dd>
                <dt className="text-zinc-500">To</dt><dd className="break-all font-semibold">{prep.preview.to}</dd>
                <dt className="text-zinc-500">Subject</dt><dd className="font-semibold">{prep.preview.subject}</dd>
                <dt className="text-zinc-500">Attached</dt><dd className="break-all">{prep.preview.attachment ? <>{prep.preview.attachment.filename} <span className="text-zinc-500">· SHA-256 {prep.preview.attachment.sha256.slice(0, 12)}…</span></> : 'Nothing'}</dd>
              </dl>
              <pre className="max-h-80 overflow-y-auto whitespace-pre-wrap p-3 font-sans text-sm leading-relaxed">{prep.preview.body}</pre>
            </div>
          )}
          <p className="text-xs text-zinc-500">Today: {prep.limits.newEmails.sent}/{prep.limits.newEmails.limit} new emails · {prep.limits.followUps.sent}/{prep.limits.followUps.limit} follow-ups · {prep.limits.total.sent}/{prep.limits.total.limit} total (safety ceilings, not targets).</p>
          {prep.ready && (
            <label className="flex items-start gap-2 rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800/60">
              <input type="checkbox" className="mt-0.5" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} />
              <span>I reviewed the recipient, subject, message and attachment above, and I want to send this one email now.</span>
            </label>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            {prep.ready && <Button variant="danger" onClick={send} disabled={!reviewed || busy}>{busy ? 'Sending…' : `Send to ${prep.preview?.to}`}</Button>}
          </div>
          {prep.expiresAt && <p className="text-right text-xs text-zinc-400">This confirmation expires in 10 minutes. <Badge tone="gray">One email</Badge></p>}
        </div>
      )}
    </Modal>
  )
}
