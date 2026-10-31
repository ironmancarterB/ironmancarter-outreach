import { useEffect, useState } from 'react'
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, Notice, PageHeader, Textarea, useToast } from '../components/ui'
import { api, useApi } from '../lib/api'
import { bytes, dateTime } from '../lib/format'
import type { MediaKit } from '../lib/types'

export default function MediaKitPage() {
  const toast = useToast()
  const { data, error, reload } = useApi<MediaKit[]>('/api/media-kits')
  const [selected, setSelected] = useState<number | null>(null)
  const [showUpload, setShowUpload] = useState(false)

  useEffect(() => {
    if (data && (selected == null || !data.some((k) => k.id === selected))) setSelected(data.find((k) => k.is_default)?.id ?? data[0]?.id ?? null)
  }, [data, selected])

  if (error) return <ErrorBox error={error} />
  if (!data) return <Loading />
  const kit = data.find((k) => k.id === selected) ?? null

  const makeDefault = async (id: number) => {
    try {
      await api.post(`/api/media-kits/${id}/default`)
      toast('Default attachment updated')
      reload()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  return (
    <>
      <PageHeader
        title="Media Kit"
        subtitle="The default version is attached to sponsorship emails. Versions are never edited or deleted, so each sent email can be traced to the exact file it carried."
        actions={<Button variant="primary" onClick={() => setShowUpload((s) => !s)}>{showUpload ? 'Close' : 'Upload new version'}</Button>}
      />
      {showUpload && <UploadForm onDone={(id) => { setShowUpload(false); setSelected(id); reload() }} />}

      {data.length === 0 ? (
        <Empty title="No media kit yet">Upload your PDF with the button above, or run <code>npm run media-kit:import -- "/path/to/kit.pdf" --default</code>.</Empty>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[22rem_1fr]">
          <div className="space-y-3">
            {data.map((k) => (
              <button key={k.id} onClick={() => setSelected(k.id)}
                className={`block w-full rounded-xl border p-4 text-left shadow-sm transition-colors ${k.id === selected ? 'border-brand-500 bg-white dark:bg-zinc-900' : 'border-zinc-200 bg-white hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900'}`}>
                <div className="flex items-center gap-2">
                  <span className="font-medium">v{k.version} · {k.label}</span>
                  {k.is_default ? <Badge tone="green">Default</Badge> : null}
                </div>
                <div className="mt-1 text-xs text-zinc-500">{k.page_count ?? '?'} pages · {bytes(k.size_bytes)} · {dateTime(k.created_at)}</div>
              </button>
            ))}
          </div>
          {kit && <KitDetail kit={kit} onDefault={() => makeDefault(kit.id)} onSaved={reload} />}
        </div>
      )}
    </>
  )
}

function KitDetail({ kit, onDefault, onSaved }: { kit: MediaKit; onDefault: () => void; onSaved: () => void }) {
  const toast = useToast()
  const [link, setLink] = useState(kit.public_url ?? '')
  useEffect(() => setLink(kit.public_url ?? ''), [kit])
  const saveLink = async () => {
    try {
      await api.patch(`/api/media-kits/${kit.id}`, { public_url: link || null })
      toast('Public link saved')
      onSaved()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }
  return (
    <div className="space-y-4">
      <Card title={`Preview: v${kit.version}`} padded={false}
        actions={<div className="flex gap-2">
          <a href={`/api/media-kits/${kit.id}/file?download=1`}><Button size="sm">Download</Button></a>
          {!kit.is_default && <Button size="sm" variant="primary" onClick={onDefault}>Make default</Button>}
        </div>}>
        <iframe title={`Media kit v${kit.version}`} src={`/api/media-kits/${kit.id}/file`} className="h-[75vh] w-full rounded-b-xl bg-zinc-100 dark:bg-zinc-800" />
      </Card>
      <Card title="Details">
        <dl className="grid gap-2 text-sm sm:grid-cols-[10rem_1fr]">
          <dt className="text-zinc-500">Original file</dt><dd className="break-all">{kit.original_filename}</dd>
          <dt className="text-zinc-500">Stored as</dt><dd className="break-all font-mono text-xs">data/media-kit/{kit.stored_filename}</dd>
          <dt className="text-zinc-500">SHA-256</dt><dd className="break-all font-mono text-xs">{kit.sha256}</dd>
          {kit.notes && <><dt className="text-zinc-500">Notes</dt><dd className="whitespace-pre-wrap">{kit.notes}</dd></>}
        </dl>
        <div className="mt-4 flex flex-wrap items-end gap-2">
          <Field label="Optional public link (https)" className="min-w-64 flex-1" hint="Only if you host the kit somewhere public yourself. Files on your Mac are not public.">
            <Input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://…" />
          </Field>
          <Button onClick={saveLink} disabled={link === (kit.public_url ?? '')}>Save link</Button>
        </div>
      </Card>
    </div>
  )
}

function UploadForm({ onDone }: { onDone: (id: number) => void }) {
  const toast = useToast()
  const [file, setFile] = useState<File | null>(null)
  const [label, setLabel] = useState('')
  const [notes, setNotes] = useState('')
  const [makeDefault, setMakeDefault] = useState(true)
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    if (!file) return
    setBusy(true)
    try {
      const form = new FormData()
      form.append('label', label)
      form.append('notes', notes)
      form.append('makeDefault', String(makeDefault))
      form.append('file', file)
      const r = await api.post<{ kit: MediaKit; duplicate: boolean }>('/api/media-kits', form)
      toast(r.duplicate ? `That exact file is already v${r.kit.version}` : `Imported v${r.kit.version}`)
      onDone(r.kit.id)
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card title="Upload a new version" className="mb-6">
      <div className="space-y-3">
        <input type="file" accept="application/pdf,.pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="block text-sm" aria-label="PDF file" />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Label"><Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. November 2026 numbers" /></Field>
          <Field label="Notes"><Textarea className="min-h-10" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} /> Make this the default attachment</label>
        <Notice>The PDF is copied into the app's data folder. Your original file is not moved or changed.</Notice>
        <div className="flex justify-end"><Button variant="primary" disabled={!file || busy} onClick={submit}>{busy ? 'Uploading…' : 'Upload'}</Button></div>
      </div>
    </Card>
  )
}
