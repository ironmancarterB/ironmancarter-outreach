// Connecting the Gmail account: OAuth client details, the consent flow, tokens and disconnecting.
// Only the account in gmail.expectedAccount can be connected. Your Gmail password never reaches this app:
// you sign in on Google's own page and Google hands back a token.
import { randomBytes } from 'node:crypto'
import { get, getSetting, logActivity, nowIso, run, type DB } from '../db'
import { AppError, invalid } from '../core/errors'
import { authUrl, GMAIL_SCOPES, GoogleApi, GoogleError, newPkce, type OAuthClient } from './google'
import type { SecretStore } from './secrets'

export interface GmailDeps {
  api: GoogleApi
  secrets: SecretStore
  redirectUri: string
}

export interface MailAccount {
  id: number
  provider: 'gmail'
  email: string
  status: 'connected' | 'needs_reconnect' | 'disconnected'
  scopes: string
  secret_ref: string
  connected_at: string
  last_checked_at: string | null
  last_error: string | null
  disconnected_at: string | null
}

const CLIENT_SECRET = 'gmail-oauth-client'
const refreshRef = (email: string) => `gmail-refresh-token:${email}`
const STATE_TTL_MS = 10 * 60_000

// Pending consent requests, kept in memory only (a restart simply means clicking Connect again).
const pending = new Map<string, { verifier: string; expected: string; expiresAt: number }>()
const accessTokens = new Map<number, { token: string; expiresAt: number }>()

// Drops cached access tokens (tests, and after disconnecting).
export const forgetAccessTokens = () => accessTokens.clear()

export const activeAccount = (db: DB) => get<MailAccount>(db, "SELECT * FROM mail_accounts WHERE provider = 'gmail' AND status != 'disconnected'")

// ---------- Audit trail of Gmail API calls ----------

export function opStart(db: DB, operation: string, accountId: number | null, draftRowId: number | null = null, detail?: string) {
  return run(db, "INSERT INTO gmail_operations (account_id, draft_row_id, operation, status, detail, started_at) VALUES (?, ?, ?, 'started', ?, ?)",
    accountId, draftRowId, operation, detail ?? null, nowIso()).lastId
}

export function opFinish(db: DB, id: number, status: 'ok' | 'failed' | 'uncertain', detail?: string | null, httpStatus?: number | null) {
  run(db, 'UPDATE gmail_operations SET status = ?, detail = COALESCE(?, detail), http_status = ?, finished_at = ? WHERE id = ?',
    status, detail ?? null, httpStatus ?? null, nowIso(), id)
}

export const opFail = (db: DB, id: number, err: unknown) => {
  const g = err instanceof GoogleError ? err : null
  opFinish(db, id, g?.outcome === 'unknown' ? 'uncertain' : 'failed', (err as Error).message, g?.status)
}

// ---------- OAuth client (from Google Cloud Console) ----------

export async function getClient(deps: GmailDeps): Promise<OAuthClient | null> {
  const raw = await deps.secrets.get(CLIENT_SECRET)
  return raw ? (JSON.parse(raw) as OAuthClient) : null
}

// Accepts either the downloaded client_secret_….json contents or the two values typed in.
export function parseClient(input: { json?: unknown; client_id?: unknown; client_secret?: unknown }): OAuthClient {
  let id = input.client_id, secret = input.client_secret
  if (typeof input.json === 'string' && input.json.trim()) {
    let parsed: Record<string, { client_id?: string; client_secret?: string }>
    try {
      parsed = JSON.parse(input.json)
    } catch {
      throw invalid('That is not valid JSON. Paste the whole contents of the downloaded client_secret file.')
    }
    if (parsed.web && !parsed.installed) throw invalid('This is a "Web application" client. Create an OAuth client of type "Desktop app" instead.')
    if (!parsed.installed) throw invalid('Expected a Desktop app client file (it starts with {"installed": …}).')
    id = parsed.installed.client_id
    secret = parsed.installed.client_secret
  }
  if (typeof id !== 'string' || !/^[\w-]+\.apps\.googleusercontent\.com$/.test(id.trim())) throw invalid('The client ID should end in .apps.googleusercontent.com')
  if (typeof secret !== 'string' || secret.trim().length < 10 || secret.length > 200) throw invalid('Enter the client secret')
  return { client_id: id.trim(), client_secret: secret.trim() }
}

export async function saveClient(db: DB, deps: GmailDeps, input: Parameters<typeof parseClient>[0]) {
  if (activeAccount(db)) throw new AppError(409, 'connected', 'Disconnect Gmail before replacing the OAuth client.')
  const client = parseClient(input)
  await deps.secrets.set(CLIENT_SECRET, JSON.stringify(client))
  logActivity(db, 'gmail.client_saved', `Saved the Google OAuth client ${maskClientId(client.client_id)} in ${deps.secrets.description}`)
}

export async function removeClient(db: DB, deps: GmailDeps) {
  if (activeAccount(db)) throw new AppError(409, 'connected', 'Disconnect Gmail first.')
  await deps.secrets.delete(CLIENT_SECRET)
  logActivity(db, 'gmail.client_removed', 'Removed the Google OAuth client')
}

const maskClientId = (id: string) => `${id.slice(0, 8)}…${id.slice(id.indexOf('.apps'))}`

// ---------- Consent flow ----------

export async function startConnect(db: DB, deps: GmailDeps) {
  const client = await getClient(deps)
  if (!client) throw new AppError(409, 'no_client', 'Add your Google OAuth client first (step 1).')
  const expected = getSetting<string>(db, 'gmail.expectedAccount')
  const active = activeAccount(db)
  if (active && active.status === 'connected' && active.email === expected) throw new AppError(409, 'connected', `Gmail is already connected as ${active.email}.`)
  if (active && active.email !== expected) throw new AppError(409, 'connected', `Disconnect ${active.email} before connecting ${expected}.`)
  for (const [k, v] of pending) if (v.expiresAt < Date.now()) pending.delete(k)
  const state = randomBytes(24).toString('base64url')
  const { verifier, challenge } = newPkce()
  pending.set(state, { verifier, expected, expiresAt: Date.now() + STATE_TTL_MS })
  logActivity(db, 'gmail.connect_started', `Opened Google's consent page for ${expected} (scope: drafts only)`)
  return { url: authUrl(client, { redirectUri: deps.redirectUri, state, challenge, loginHint: expected }), expected, scopes: GMAIL_SCOPES }
}

// Google redirects the browser here after you approve (or decline) access.
export async function finishConnect(db: DB, deps: GmailDeps, query: Record<string, unknown>): Promise<{ email: string }> {
  const state = typeof query.state === 'string' ? query.state : ''
  const p = pending.get(state)
  pending.delete(state)
  if (!p || p.expiresAt < Date.now()) throw new AppError(400, 'bad_state', 'This sign-in link expired or was already used. Start again from Settings → Gmail.')
  if (typeof query.error === 'string') {
    logActivity(db, 'gmail.connect_declined', `Google sign-in was not completed (${query.error})`)
    throw new AppError(400, 'declined', query.error === 'access_denied' ? 'You declined access, so nothing was connected.' : `Google returned an error: ${query.error}`)
  }
  if (typeof query.code !== 'string' || !query.code) throw new AppError(400, 'no_code', 'Google did not return an authorization code.')
  const client = await getClient(deps)
  if (!client) throw new AppError(409, 'no_client', 'The OAuth client was removed during sign-in.')

  const op = opStart(db, 'connect', null)
  let tokens
  try {
    tokens = await deps.api.exchangeCode(client, query.code, p.verifier, deps.redirectUri)
  } catch (err) {
    opFail(db, op, err)
    throw new AppError(502, 'google', `Could not finish signing in: ${(err as Error).message}`)
  }
  const granted = tokens.scope.split(/\s+/).filter(Boolean)
  const discard = async (why: string) => {
    await deps.api.revoke(tokens.refresh_token ?? tokens.access_token).catch(() => undefined)
    opFinish(db, op, 'failed', why)
    logActivity(db, 'gmail.connect_refused', why)
    throw new AppError(409, 'refused', why)
  }
  if (!GMAIL_SCOPES.every((s) => granted.includes(s))) {
    await discard('The "Manage drafts" permission was not granted, so the connection was discarded. Try again and leave that box ticked.')
  }
  const extra = granted.filter((s) => !(GMAIL_SCOPES as readonly string[]).includes(s) && !['openid', 'email', 'profile'].includes(s))
  if (extra.length) await discard(`Google granted permissions the app did not ask for (${extra.join(', ')}), so the connection was discarded.`)
  if (!tokens.refresh_token) await discard('Google did not return a refresh token. Remove the app at myaccount.google.com/permissions and connect again.')

  let email: string
  try {
    email = (await deps.api.profile(tokens.access_token)).emailAddress.toLowerCase()
  } catch (err) {
    await deps.api.revoke(tokens.refresh_token!).catch(() => undefined)
    opFail(db, op, err)
    throw new AppError(502, 'google', `Signed in, but could not read the account address: ${(err as Error).message}`)
  }
  if (email !== p.expected) await discard(`You signed in as ${email}, but this app only accepts ${p.expected}. Nothing was connected and the access was revoked.`)

  await deps.secrets.set(refreshRef(email), tokens.refresh_token!)
  const now = nowIso()
  const existing = get<{ id: number }>(db, 'SELECT id FROM mail_accounts WHERE email = ?', email)
  const accountId = existing
    ? (run(db, "UPDATE mail_accounts SET status = 'connected', scopes = ?, secret_ref = ?, connected_at = ?, last_checked_at = ?, last_error = NULL, disconnected_at = NULL, updated_at = ? WHERE id = ?",
      JSON.stringify(granted), refreshRef(email), now, now, now, existing.id), existing.id)
    : run(db, "INSERT INTO mail_accounts (provider, email, status, scopes, secret_ref, connected_at, last_checked_at, created_at, updated_at) VALUES ('gmail', ?, 'connected', ?, ?, ?, ?, ?, ?)",
      email, JSON.stringify(granted), refreshRef(email), now, now, now, now).lastId
  accessTokens.set(accountId, { token: tokens.access_token, expiresAt: tokens.expires_at })
  run(db, 'UPDATE gmail_operations SET account_id = ? WHERE id = ?', accountId, op)
  opFinish(db, op, 'ok', `Connected ${email} with ${granted.join(' ')}`)
  logActivity(db, 'gmail.connected', `Connected Gmail ${email} (permission: manage drafts). Sending stays disabled.`)
  return { email }
}

// A short-lived access token, refreshed from the stored refresh token when needed.
export async function accessToken(db: DB, deps: GmailDeps): Promise<{ account: MailAccount; token: string }> {
  const account = activeAccount(db)
  if (!account) throw new AppError(409, 'not_connected', 'Gmail is not connected. Connect it in Settings → Gmail.')
  if (account.status === 'needs_reconnect') throw new AppError(409, 'needs_reconnect', `Google needs you to reconnect ${account.email} (Settings → Gmail).`)
  const expected = getSetting<string>(db, 'gmail.expectedAccount')
  if (account.email !== expected) throw new AppError(409, 'wrong_account', `Connected as ${account.email}, but the sending account is set to ${expected}. Disconnect and reconnect.`)
  const cached = accessTokens.get(account.id)
  if (cached && cached.expiresAt - 60_000 > Date.now()) return { account, token: cached.token }

  const client = await getClient(deps)
  const refresh = await deps.secrets.get(account.secret_ref)
  if (!client || !refresh) {
    markNeedsReconnect(db, account, 'The stored Google credentials are missing.')
    throw new AppError(409, 'needs_reconnect', 'The stored Google credentials are missing. Reconnect Gmail in Settings → Gmail.')
  }
  try {
    const t = await deps.api.refresh(client, refresh)
    accessTokens.set(account.id, { token: t.access_token, expiresAt: t.expires_at })
    run(db, 'UPDATE mail_accounts SET last_checked_at = ?, last_error = NULL, updated_at = ? WHERE id = ?', nowIso(), nowIso(), account.id)
    return { account, token: t.access_token }
  } catch (err) {
    if (err instanceof GoogleError && err.reason === 'invalid_grant') {
      markNeedsReconnect(db, account, 'Google revoked or expired the access (apps in Testing mode must reconnect every 7 days).')
      throw new AppError(409, 'needs_reconnect', `Google ended the connection for ${account.email}. Reconnect in Settings → Gmail.`)
    }
    throw new AppError(502, 'google', `Could not reach Google: ${(err as Error).message}`)
  }
}

function markNeedsReconnect(db: DB, account: MailAccount, why: string) {
  accessTokens.delete(account.id)
  run(db, "UPDATE mail_accounts SET status = 'needs_reconnect', last_error = ?, updated_at = ? WHERE id = ?", why, nowIso(), account.id)
  logActivity(db, 'gmail.needs_reconnect', `${account.email}: ${why}`)
}

export async function disconnect(db: DB, deps: GmailDeps) {
  const account = activeAccount(db)
  if (!account) throw new AppError(409, 'not_connected', 'Gmail is not connected.')
  const refresh = await deps.secrets.get(account.secret_ref)
  let revoked = 'no stored token to revoke'
  if (refresh) {
    const op = opStart(db, 'revoke', account.id)
    try {
      await deps.api.revoke(refresh)
      opFinish(db, op, 'ok')
      revoked = 'access revoked at Google'
    } catch (err) {
      opFail(db, op, err)
      revoked = `could not reach Google to revoke (${(err as Error).message}); remove the app at myaccount.google.com/permissions`
    }
  }
  await deps.secrets.delete(account.secret_ref)
  accessTokens.delete(account.id)
  run(db, "UPDATE mail_accounts SET status = 'disconnected', disconnected_at = ?, updated_at = ? WHERE id = ?", nowIso(), nowIso(), account.id)
  logActivity(db, 'gmail.disconnected', `Disconnected Gmail ${account.email}: ${revoked}. Existing Gmail drafts were left in Gmail.`)
  return { revoked }
}

export async function connectionStatus(db: DB, deps: GmailDeps) {
  const client = await getClient(deps).catch(() => null)
  const account = activeAccount(db)
  return {
    expectedAccount: getSetting<string>(db, 'gmail.expectedAccount'),
    clientConfigured: !!client,
    clientId: client ? maskClientId(client.client_id) : null,
    secretStorage: deps.secrets.description,
    redirectUri: deps.redirectUri,
    requestedScopes: GMAIL_SCOPES,
    account: account ? {
      email: account.email, status: account.status, scopes: JSON.parse(account.scopes) as string[], connectedAt: account.connected_at,
      lastCheckedAt: account.last_checked_at, lastError: account.last_error,
    } : null,
    sendingEnabled: false,
  }
}
