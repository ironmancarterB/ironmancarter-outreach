import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { seed } from './seed'
import { all, get, nowIso, run, tx, type DB } from './sql'

export * from './sql'

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url))

// Opens (creating if needed) the database, applies pending migrations and seeds defaults.
// Pass ':memory:' for tests.
export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;')
  migrate(db)
  seed(db)
  return db
}

export function migrate(db: DB): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`)
  const applied = new Set(all<{ version: number }>(db, 'SELECT version FROM schema_migrations').map((r) => r.version))
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.+\.sql$/.test(f)).sort()
  const ran: string[] = []
  for (const file of files) {
    const version = Number(file.split('_')[0])
    if (applied.has(version)) continue
    const sql = readFileSync(`${MIGRATIONS_DIR}/${file}`, 'utf8')
    // Migrations that rebuild a table (SQLite cannot alter CHECK constraints) start with "-- foreign_keys: off".
    // Foreign keys are switched off around the transaction, as SQLite's documented table-rebuild procedure
    // requires, and every reference is checked before the migration commits.
    const rebuild = sql.startsWith('-- foreign_keys: off')
    if (rebuild) db.exec('PRAGMA foreign_keys = OFF')
    try {
      tx(db, () => {
        db.exec(sql)
        if (rebuild) {
          const broken = all(db, 'PRAGMA foreign_key_check')
          if (broken.length) throw new Error(`Migration ${file} left broken references: ${JSON.stringify(broken.slice(0, 5))}`)
        }
        run(db, 'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', version, file, nowIso())
      })
    } finally {
      if (rebuild) db.exec('PRAGMA foreign_keys = ON')
    }
    ran.push(file)
  }
  return ran
}

// Settings are JSON values keyed by name.
export function getSetting<T>(db: DB, key: string): T {
  const row = get<{ value: string }>(db, 'SELECT value FROM settings WHERE key = ?', key)
  if (!row) throw new Error(`Unknown setting: ${key}`)
  return JSON.parse(row.value) as T
}

export function setSetting(db: DB, key: string, value: unknown) {
  run(db, `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key, JSON.stringify(value), nowIso())
}

export function allSettings(db: DB): Record<string, unknown> {
  return Object.fromEntries(all<{ key: string; value: string }>(db, 'SELECT key, value FROM settings ORDER BY key')
    .map((r) => [r.key, JSON.parse(r.value)]))
}

export function logActivity(db: DB, type: string, summary: string, opts: { prospectId?: number | null; data?: unknown } = {}) {
  run(db, 'INSERT INTO activities (prospect_id, type, summary, data, created_at) VALUES (?, ?, ?, ?, ?)',
    opts.prospectId ?? null, type, summary, opts.data === undefined ? null : JSON.stringify(opts.data), nowIso())
}
