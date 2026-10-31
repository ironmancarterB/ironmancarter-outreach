import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)))

export const config = {
  dataDir: process.env.OUTREACH_DATA_DIR ? resolve(process.env.OUTREACH_DATA_DIR) : join(ROOT, 'data'),
  // Bound to this computer only. Nothing on your network or the internet can reach it.
  host: '127.0.0.1',
  port: Number(process.env.OUTREACH_API_PORT ?? 5181),
  webPort: Number(process.env.OUTREACH_WEB_PORT ?? 5180),
  production: process.env.NODE_ENV === 'production',
}

export const dbPath = (dataDir: string) => join(dataDir, 'outreach.db')
