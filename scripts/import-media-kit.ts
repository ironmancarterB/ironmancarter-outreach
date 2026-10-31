// Import a media kit PDF from the command line:
//   npm run media-kit:import -- "/path/to/Media Kit.pdf" [--label "Corrected email"] [--default]
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { openDb } from '../packages/db'
import { importMediaKit } from '../packages/mediakit/store'
import { config, dbPath } from '../apps/server/src/config'

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--label')
if (!file) {
  console.error('Usage: npm run media-kit:import -- "/path/to/kit.pdf" [--label "Name"] [--default]')
  process.exit(1)
}
const labelIdx = args.indexOf('--label')
const db = openDb(dbPath(config.dataDir))
const { kit, duplicate } = importMediaKit(db, config.dataDir, {
  buffer: readFileSync(file),
  originalFilename: basename(file),
  label: labelIdx >= 0 ? args[labelIdx + 1] : undefined,
  makeDefault: args.includes('--default'),
})
console.log(duplicate
  ? `Already imported as v${kit.version} (${kit.label}); nothing changed.`
  : `Imported v${kit.version} "${kit.label}" (${kit.page_count ?? '?'} pages, ${(kit.size_bytes / 1024).toFixed(0)} KB)${kit.is_default ? ' as the default attachment' : ''}.`)
console.log(`sha256 ${kit.sha256}`)
db.close()
