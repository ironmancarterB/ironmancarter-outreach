// Applies pending database migrations (they also run automatically when the server starts).
import { migrate, openDb } from '../packages/db'
import { config, dbPath } from '../apps/server/src/config'

const db = openDb(dbPath(config.dataDir))
const ran = migrate(db)
console.log(ran.length ? `Applied: ${ran.join(', ')}` : `Database is up to date (${dbPath(config.dataDir)})`)
db.close()
