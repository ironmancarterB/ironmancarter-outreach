// Background worker: research batches, and the autopilot scheduler. Autopilot only sends when you switched it on in
// Outreach Controls, and only through the same checks as a manual send. Safe to stop at any time: interrupted
// research resumes on the next start, and a send interrupted mid-flight is marked uncertain and never retried.
import { openDb } from '../../../packages/db'
import { runWorker } from '../../../packages/research/worker'
import { runAutopilot } from '../../../packages/outreach/autopilot'
import { recoverInterruptedSends } from '../../../packages/outreach/send'
import { GoogleApi } from '../../../packages/gmail/google'
import { defaultSecretStore } from '../../../packages/gmail/secrets'
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
const gmail = { api: new GoogleApi(), secrets: defaultSecretStore(config.dataDir), redirectUri: `http://127.0.0.1:${config.port}/api/gmail/oauth/callback` }
recoverInterruptedSends(db)
await Promise.all([
  runWorker(db, { signal: controller.signal, log }),
  runAutopilot(db, gmail, { dataDir: config.dataDir, signal: controller.signal, log }),
])
db.close()
process.exit(0)
