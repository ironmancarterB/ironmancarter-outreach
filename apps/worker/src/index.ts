// Background worker: processes research batches. It reads public websites only; it has no
// email-sending code. Safe to stop at any time: interrupted work resumes on the next start.
import { openDb } from '../../../packages/db'
import { runWorker } from '../../../packages/research/worker'
import { config, dbPath } from '../../server/src/config'

const db = openDb(dbPath(config.dataDir))
const controller = new AbortController()
const stop = () => {
  console.log('Worker stopping…')
  controller.abort()
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

const log = (msg: string) => console.log(`[worker ${new Date().toLocaleTimeString()}] ${msg}`)
await runWorker(db, { signal: controller.signal, log })
db.close()
process.exit(0)
