// Media kit versions. Files are copied into the app's data folder and never modified or deleted,
// so every sent email can be traced to the exact PDF it carried.
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { all, get, logActivity, nowIso, run, tx, type DB } from '../db'
import { AppError, invalid, notFound } from '../core/errors'

export interface MediaKit {
  id: number
  version: number
  label: string
  original_filename: string
  stored_filename: string
  sha256: string
  size_bytes: number
  page_count: number | null
  is_default: number
  public_url: string | null
  notes: string | null
  created_at: string
  kind: MediaKitKind
}

// The sponsorship media kit and the UGC rate card / portfolio PDF are separate, each with its own default.
export type MediaKitKind = 'sponsorship' | 'ugc'

// Gmail's limit is 25 MB per message; leave room for the email body and encoding overhead.
export const MAX_MEDIA_KIT_BYTES = 15 * 1024 * 1024

export const mediaKitDir = (dataDir: string) => join(dataDir, 'media-kit')

export function countPdfPages(buf: Buffer): number | null {
  const n = buf.toString('latin1').match(/\/Type\s*\/Page(?!s)\b/g)?.length ?? 0
  return n || null
}

export function importMediaKit(db: DB, dataDir: string, input: {
  buffer: Buffer; originalFilename: string; label?: string; notes?: string | null; makeDefault?: boolean; kind?: MediaKitKind
}): { kit: MediaKit; duplicate: boolean } {
  const { buffer } = input
  const kind: MediaKitKind = input.kind === 'ugc' ? 'ugc' : 'sponsorship'
  if (!buffer.length) throw invalid('The file is empty')
  if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') throw invalid('The file is not a PDF')
  if (buffer.length > MAX_MEDIA_KIT_BYTES) throw invalid(`The PDF is larger than ${MAX_MEDIA_KIT_BYTES / 1024 / 1024} MB`)
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  const existing = get<MediaKit>(db, 'SELECT * FROM media_kits WHERE sha256 = ?', sha256)
  if (existing) return { kit: existing, duplicate: true }

  const version = (get<{ v: number | null }>(db, 'SELECT max(version) AS v FROM media_kits')?.v ?? 0) + 1
  const storedFilename = `v${version}-${sha256.slice(0, 8)}.pdf`
  const dir = mediaKitDir(dataDir)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, storedFilename), buffer, { flag: 'wx' })

  const isFirst = !get(db, 'SELECT 1 FROM media_kits WHERE kind = ? LIMIT 1', kind)
  const makeDefault = input.makeDefault || isFirst
  const id = tx(db, () => {
    if (makeDefault) run(db, 'UPDATE media_kits SET is_default = 0 WHERE is_default = 1 AND kind = ?', kind)
    return run(db, `INSERT INTO media_kits (version, label, original_filename, stored_filename, sha256, size_bytes, page_count, is_default, notes, created_at, kind)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      version, input.label?.trim() || `Version ${version}`, input.originalFilename, storedFilename, sha256, buffer.length,
      countPdfPages(buffer), makeDefault ? 1 : 0, input.notes ?? null, nowIso(), kind).lastId
  })
  logActivity(db, 'media_kit.imported', `Imported ${kind === 'ugc' ? 'UGC rate card / portfolio PDF' : 'media kit'} v${version} (${input.originalFilename})${makeDefault ? ' as default' : ''}`,
    { data: { sha256, size: buffer.length } })
  return { kit: getMediaKit(db, id), duplicate: false }
}

export const listMediaKits = (db: DB) => all<MediaKit>(db, 'SELECT * FROM media_kits ORDER BY version DESC')

export function getMediaKit(db: DB, id: number): MediaKit {
  const kit = get<MediaKit>(db, 'SELECT * FROM media_kits WHERE id = ?', id)
  if (!kit) throw notFound('Media kit')
  return kit
}

export const getDefaultMediaKit = (db: DB, kind: MediaKitKind = 'sponsorship') => get<MediaKit>(db, 'SELECT * FROM media_kits WHERE is_default = 1 AND kind = ?', kind)

export function setDefaultMediaKit(db: DB, id: number): MediaKit {
  const kit = getMediaKit(db, id)
  tx(db, () => {
    run(db, 'UPDATE media_kits SET is_default = 0 WHERE is_default = 1 AND kind = ?', kit.kind)
    run(db, 'UPDATE media_kits SET is_default = 1 WHERE id = ?', id)
  })
  logActivity(db, 'media_kit.default', `${kit.kind === 'ugc' ? 'UGC rate card' : 'Media kit'} v${kit.version} is now the default ${kit.kind === 'ugc' ? 'UGC ' : ''}attachment`)
  return getMediaKit(db, id)
}

export function updateMediaKit(db: DB, id: number, input: { label?: string; public_url?: string | null; notes?: string | null }): MediaKit {
  getMediaKit(db, id)
  if (input.label !== undefined) {
    if (!input.label.trim()) throw invalid('Label cannot be empty')
    run(db, 'UPDATE media_kits SET label = ? WHERE id = ?', input.label.trim(), id)
  }
  if (input.public_url !== undefined) {
    let url: string | null = null
    if (input.public_url) {
      try {
        const u = new URL(input.public_url)
        if (u.protocol !== 'https:') throw new Error()
        url = u.toString()
      } catch {
        throw new AppError(400, 'invalid', 'Public link must be an https:// URL')
      }
    }
    run(db, 'UPDATE media_kits SET public_url = ? WHERE id = ?', url, id)
  }
  if (input.notes !== undefined) run(db, 'UPDATE media_kits SET notes = ? WHERE id = ?', input.notes?.trim() || null, id)
  return getMediaKit(db, id)
}

export const mediaKitFilePath = (dataDir: string, kit: MediaKit) => join(mediaKitDir(dataDir), kit.stored_filename)
