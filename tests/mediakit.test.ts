import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { countPdfPages, getDefaultMediaKit, importMediaKit, listMediaKits, mediaKitFilePath, setDefaultMediaKit, updateMediaKit } from '../packages/mediakit/store'
import { fakePdf, freshDb, tempDir } from './helpers'

let cleanup: (() => void) | undefined
afterEach(() => cleanup?.())

describe('media kit manager', () => {
  it('stores a byte-identical copy, records a checksum and makes the first version default', () => {
    const t = tempDir()
    cleanup = t.cleanup
    const db = freshDb()
    const pdf = fakePdf('one')
    const { kit, duplicate } = importMediaKit(db, t.dir, { buffer: pdf, originalFilename: 'Kit.pdf' })
    expect(duplicate).toBe(false)
    expect(kit.version).toBe(1)
    expect(kit.is_default).toBe(1)
    expect(kit.page_count).toBe(2)
    expect(readFileSync(mediaKitFilePath(t.dir, kit)).equals(pdf)).toBe(true)
  })

  it('versions new uploads, ignores exact re-uploads and switches the default', () => {
    const t = tempDir()
    cleanup = t.cleanup
    const db = freshDb()
    importMediaKit(db, t.dir, { buffer: fakePdf('one'), originalFilename: 'a.pdf' })
    const v2 = importMediaKit(db, t.dir, { buffer: fakePdf('two'), originalFilename: 'b.pdf' }).kit
    expect(v2.version).toBe(2)
    expect(getDefaultMediaKit(db)?.version).toBe(1)
    const again = importMediaKit(db, t.dir, { buffer: fakePdf('two'), originalFilename: 'b copy.pdf' })
    expect(again.duplicate).toBe(true)
    expect(listMediaKits(db)).toHaveLength(2)
    setDefaultMediaKit(db, v2.id)
    expect(getDefaultMediaKit(db)?.version).toBe(2)
    expect(listMediaKits(db).filter((k) => k.is_default)).toHaveLength(1)
  })

  it('rejects files that are not PDFs', () => {
    const t = tempDir()
    cleanup = t.cleanup
    expect(() => importMediaKit(freshDb(), t.dir, { buffer: Buffer.from('hello'), originalFilename: 'x.pdf' })).toThrow(/not a PDF/)
  })

  it('accepts only https public links', () => {
    const t = tempDir()
    cleanup = t.cleanup
    const db = freshDb()
    const { kit } = importMediaKit(db, t.dir, { buffer: fakePdf(), originalFilename: 'a.pdf' })
    expect(() => updateMediaKit(db, kit.id, { public_url: 'http://example.com/kit.pdf' })).toThrow(/https/)
    expect(updateMediaKit(db, kit.id, { public_url: 'https://example.com/kit.pdf' }).public_url).toBe('https://example.com/kit.pdf')
  })
})

// Checks the real corrected kit when it exists locally (data/ is not in git).
const ORIGINALS = join(import.meta.dirname, '..', 'data', 'media-kit', 'originals')
const corrected = join(ORIGINALS, 'Content Media Kit Final (corrected email).pdf')
const original = join(ORIGINALS, 'Content Media Kit Final (original, incorrect email).pdf')

describe.skipIf(!existsSync(corrected) || !existsSync(original))('corrected media kit', () => {
  const hex = (s: string) => Buffer.from(s).toString('hex')
  // Decompresses every Flate stream so text drawn on the pages can be searched.
  const allText = (buf: Buffer) => {
    const s = buf.toString('latin1')
    let out = s
    for (const m of s.matchAll(/<<[^>]*\/Length (\d+)\/Filter\/FlateDecode>>\s*stream\r?\n/g)) {
      const start = m.index! + m[0].length
      try { out += inflateSync(buf.subarray(start, start + Number(m[1]))).toString('latin1') } catch { /* not a plain flate stream */ }
    }
    return out
  }

  it('contains the correct address and not the misspelled one', () => {
    const text = allText(readFileSync(corrected))
    expect(text).toContain(hex('ironmancarterbusiness@gmail.com'))
    expect(text).not.toContain(hex('Ironmancaerterbusiness@gmail.com'))
  })

  it('leaves the original untouched and keeps the same two pages and photo', () => {
    const a = readFileSync(original)
    const b = readFileSync(corrected)
    expect(allText(a)).toContain(hex('Ironmancaerterbusiness@gmail.com'))
    expect(countPdfPages(b)).toBe(2)
    // Everything before the edited object (fonts, page 1, the photo) is byte-identical.
    const editedAt = a.indexOf('15 0 obj')
    expect(b.subarray(0, editedAt).equals(a.subarray(0, editedAt))).toBe(true)
  })
})
