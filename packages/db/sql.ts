import type { DatabaseSync } from 'node:sqlite'

export type DB = DatabaseSync
export type Param = string | number | bigint | null | Uint8Array

export const nowIso = () => new Date().toISOString()

export const all = <T>(db: DB, sql: string, ...params: Param[]) => db.prepare(sql).all(...params) as T[]
export const get = <T>(db: DB, sql: string, ...params: Param[]) => db.prepare(sql).get(...params) as T | undefined
export const run = (db: DB, sql: string, ...params: Param[]) => {
  const r = db.prepare(sql).run(...params)
  return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) }
}

let savepointSeq = 0

// Runs fn atomically. Nested calls become savepoints inside the outer transaction.
export function tx<T>(db: DB, fn: () => T): T {
  if (db.isTransaction) {
    const name = `sp_${++savepointSeq}`
    db.exec(`SAVEPOINT ${name}`)
    try {
      const result = fn()
      db.exec(`RELEASE ${name}`)
      return result
    } catch (err) {
      db.exec(`ROLLBACK TO ${name}`)
      db.exec(`RELEASE ${name}`)
      throw err
    }
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}
