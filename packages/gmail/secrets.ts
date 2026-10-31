// Where OAuth secrets live. On macOS: the login Keychain (encrypted, outside the project folder and Git).
// Values are passed to `security` on stdin, hex-encoded, so they never appear in the process list.
import { execFile, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface SecretStore {
  readonly kind: 'keychain' | 'file' | 'memory'
  readonly description: string
  get(name: string): Promise<string | null>
  set(name: string, value: string): Promise<void>
  delete(name: string): Promise<void>
}

export const KEYCHAIN_SERVICE = 'IronmanCarter Outreach'
const NOT_FOUND = 44

const quote = (s: string) => `"${s.replace(/["\\]/g, '')}"`

export function keychainStore(service = KEYCHAIN_SERVICE): SecretStore {
  return {
    kind: 'keychain',
    description: `macOS Keychain (login keychain, service "${service}")`,
    get: (name) => new Promise((resolve, reject) => {
      execFile('security', ['find-generic-password', '-s', service, '-a', name, '-w'], (err, stdout) => {
        if (!err) return resolve(stdout.replace(/\n$/, ''))
        if ((err as { code?: number }).code === NOT_FOUND) return resolve(null)
        reject(new Error(`Keychain read failed: ${err.message}`))
      })
    }),
    set: (name, value) => new Promise((resolve, reject) => {
      const child = spawn('security', ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] })
      let stderr = ''
      child.stderr.on('data', (d) => { stderr += d })
      child.on('error', reject)
      child.on('close', (code) => (code === 0 && !stderr.trim() ? resolve() : reject(new Error(`Keychain write failed: ${stderr.trim() || `exit ${code}`}`))))
      child.stdin.end(`add-generic-password -U -s ${quote(service)} -a ${quote(name)} -X ${Buffer.from(value, 'utf8').toString('hex')}\n`)
    }),
    delete: (name) => new Promise((resolve, reject) => {
      execFile('security', ['delete-generic-password', '-s', service, '-a', name], (err) => {
        if (!err || (err as { code?: number }).code === NOT_FOUND) return resolve()
        reject(new Error(`Keychain delete failed: ${err.message}`))
      })
    }),
  }
}

// Fallback for systems without a Keychain: one file per secret, readable only by your user account.
export function fileStore(dir: string): SecretStore {
  const path = (name: string) => join(dir, `${name.replace(/[^a-z0-9_-]/gi, '_')}.secret`)
  return {
    kind: 'file',
    description: `Files readable only by your user account in ${dir}`,
    get: async (name) => (existsSync(path(name)) ? readFileSync(path(name), 'utf8') : null),
    set: async (name, value) => {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      writeFileSync(path(name), value, { mode: 0o600 })
      chmodSync(path(name), 0o600)
    },
    delete: async (name) => rmSync(path(name), { force: true }),
  }
}

export function memoryStore(): SecretStore & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    kind: 'memory',
    description: 'In memory (tests only)',
    values,
    get: async (name) => values.get(name) ?? null,
    set: async (name, value) => { values.set(name, value) },
    delete: async (name) => { values.delete(name) },
  }
}

export const defaultSecretStore = (dataDir: string): SecretStore =>
  process.platform === 'darwin' ? keychainStore() : fileStore(join(dataDir, 'secrets'))
