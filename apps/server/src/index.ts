// Starts the local API (and, in production mode, serves the built dashboard).
import { openDb } from '../../../packages/db'
import { buildApp, webDistPath } from './app'
import { config, dbPath, ROOT } from './config'

const db = openDb(dbPath(config.dataDir))
const app = await buildApp({
  db,
  dataDir: config.dataDir,
  webDist: config.production ? webDistPath(ROOT) : undefined,
  logger: true,
})

const shutdown = async () => {
  await app.close()
  db.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

await app.listen({ host: config.host, port: config.port })
console.log(`\nIronmanCarter Outreach API on http://${config.host}:${config.port}`)
console.log(config.production ? `Dashboard: http://localhost:${config.port}` : `Dashboard (dev): http://localhost:${config.webPort}`)
console.log('Sending: manual only (live sending is a setting; every email needs your confirmation).\n')
