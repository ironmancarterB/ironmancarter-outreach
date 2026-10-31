import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type DB } from '../packages/db'

export const freshDb = (): DB => openDb(':memory:')

export function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'outreach-test-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

// A tiny but structurally valid two-page PDF.
export function fakePdf(marker = 'test'): Buffer {
  return Buffer.from(
    `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 2/Kids[3 0 R 4 0 R]>>endobj\n` +
    `3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n4 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n` +
    `% ${marker}\ntrailer<</Root 1 0 R>>\n%%EOF\n`, 'latin1')
}
