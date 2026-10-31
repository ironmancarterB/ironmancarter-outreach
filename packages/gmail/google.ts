// Google's OAuth 2.0 for installed apps (loopback redirect + PKCE) and the Gmail API calls the app makes.
// Plain fetch against Google's documented endpoints; no Google SDK and nothing that costs money.
//
// SAFETY: the only call that can send mail is sendDraft(), which sends one existing, verified draft and
// requires a SendAuthorization that only the manual-send confirmation step (packages/outreach/send.ts)
// can create. request() refuses every other send URL, including messages/send.
import { createHash, randomBytes } from 'node:crypto'

export const SCOPE_COMPOSE = 'https://www.googleapis.com/auth/gmail.compose'
export const SCOPE_READONLY = 'https://www.googleapis.com/auth/gmail.readonly'

// gmail.compose: create/update/send drafts and read the account address (Google lists only mail.google.com,
// gmail.modify and gmail.compose for drafts.create and drafts.send).
// gmail.readonly: read threads, replies and Sent Mail, and search with q (gmail.metadata cannot search or read
// bodies). Neither scope can delete mail or change labels. Full access (mail.google.com) and gmail.modify are
// never requested.
export const GMAIL_SCOPES = [SCOPE_COMPOSE, SCOPE_READONLY] as const
export const REQUIRED_SCOPES = [SCOPE_COMPOSE] as const

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
export const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me'
export const GMAIL_UPLOAD = 'https://gmail.googleapis.com/upload/gmail/v1/users/me'

const TIMEOUT_MS = 30_000

export interface OAuthClient {
  client_id: string
  client_secret: string
}

export interface TokenSet {
  access_token: string
  expires_at: number
  refresh_token?: string
  scope: string
}

// outcome tells the caller whether the request could have changed anything at Google:
// 'rejected' = Google answered with a definite refusal (nothing changed);
// 'unknown'  = timeout, network failure or server error (it may or may not have been applied).
export class GoogleError extends Error {
  constructor(message: string, readonly outcome: 'rejected' | 'unknown', readonly status: number | null, readonly reason?: string) {
    super(message)
  }
}

const b64url = (buf: Buffer) => buf.toString('base64url')

export function newPkce() {
  const verifier = b64url(randomBytes(48))
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) }
}

export function authUrl(client: OAuthClient, opts: { redirectUri: string; state: string; challenge: string; loginHint: string }) {
  const u = new URL(GOOGLE_AUTH_URL)
  u.search = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: opts.redirectUri,
    response_type: 'code',
    scope: GMAIL_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'false',
    state: opts.state,
    code_challenge: opts.challenge,
    code_challenge_method: 'S256',
    login_hint: opts.loginHint,
  }).toString()
  return u.toString()
}

const isSendUrl = (url: string) => /\/send(\b|$|\?)/i.test(new URL(url).pathname)

// Proof that the user confirmed this exact draft moments ago. Only send.ts can mint one (the symbol is not
// exported elsewhere), and each is single-use.
export const SEND_AUTHORITY = Symbol('manual-send-confirmation')
export class SendAuthorization {
  used = false
  constructor(key: symbol, readonly draftId: string, readonly sendAttemptId: number) {
    if (key !== SEND_AUTHORITY) throw new Error('Refused: sending needs your confirmation in the dashboard.')
  }
}

export class GoogleApi {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  private async request(url: string, init: RequestInit, auth?: SendAuthorization): Promise<Response> {
    if (isSendUrl(url) && !(auth && url === `${GMAIL_API}/drafts/send`)) throw new Error('Refused: the app only sends a confirmed draft, never any other way.')
    try {
      return await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch (err) {
      throw new GoogleError(`No response from Google (${(err as Error).name === 'TimeoutError' ? 'timed out' : (err as Error).message})`, 'unknown', null)
    }
  }

  private async json<T>(res: Response): Promise<T> {
    const text = await res.text()
    let body: Record<string, unknown> = {}
    try {
      body = text ? JSON.parse(text) : {}
    } catch {
      /* non-JSON error page */
    }
    if (res.ok) return body as T
    const err = body.error as { message?: string; status?: string; errors?: { reason?: string }[] } | string | undefined
    const message = typeof err === 'string' ? `${err}${body.error_description ? `: ${body.error_description}` : ''}` : err?.message ?? `HTTP ${res.status}`
    const reason = typeof err === 'string' ? err : err?.errors?.[0]?.reason ?? err?.status
    // 4xx (other than timeouts and rate limits) means Google refused the request outright.
    const definite = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429
    throw new GoogleError(`Google: ${message}`, definite ? 'rejected' : 'unknown', res.status, reason)
  }

  private token(params: Record<string, string>) {
    return this.request(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    }).then((r) => this.json<{ access_token: string; expires_in: number; refresh_token?: string; scope: string }>(r))
      .then((t): TokenSet => ({ access_token: t.access_token, refresh_token: t.refresh_token, scope: t.scope ?? '', expires_at: Date.now() + (t.expires_in ?? 3600) * 1000 }))
  }

  exchangeCode(client: OAuthClient, code: string, verifier: string, redirectUri: string) {
    return this.token({ ...client, code, code_verifier: verifier, redirect_uri: redirectUri, grant_type: 'authorization_code' })
  }

  refresh(client: OAuthClient, refreshToken: string) {
    return this.token({ ...client, refresh_token: refreshToken, grant_type: 'refresh_token' })
  }

  async revoke(token: string) {
    const res = await this.request(GOOGLE_REVOKE_URL, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }).toString(),
    })
    if (!res.ok && res.status !== 400) await this.json(res) // 400 = already invalid; nothing left to revoke
  }

  private gmail<T>(accessToken: string, url: string, init: RequestInit = {}, auth?: SendAuthorization) {
    return this.request(url, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${accessToken}` } }, auth).then((r) => this.json<T>(r))
  }

  profile(accessToken: string) {
    return this.gmail<{ emailAddress: string; historyId: string }>(accessToken, `${GMAIL_API}/profile`)
  }

  // Media upload (message/rfc822) supports messages up to 35 MB.
  createDraft(accessToken: string, raw: Buffer) {
    return this.gmail<GmailDraft>(accessToken, `${GMAIL_UPLOAD}/drafts?uploadType=media`, {
      method: 'POST', headers: { 'content-type': 'message/rfc822' }, body: new Uint8Array(raw),
    })
  }

  // Replaces the content of an existing draft (same draft id), so repeating it cannot create a second draft.
  updateDraft(accessToken: string, draftId: string, raw: Buffer) {
    return this.gmail<GmailDraft>(accessToken, `${GMAIL_UPLOAD}/drafts/${encodeURIComponent(draftId)}?uploadType=media`, {
      method: 'PUT', headers: { 'content-type': 'message/rfc822' }, body: new Uint8Array(raw),
    })
  }

  getDraft(accessToken: string, draftId: string, format: 'raw' | 'metadata' | 'minimal' = 'minimal') {
    const q = format === 'metadata' ? '&metadataHeaders=Message-ID&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Content-Type' : ''
    return this.gmail<GmailDraft>(accessToken, `${GMAIL_API}/drafts/${encodeURIComponent(draftId)}?format=${format}${q}`)
  }

  // Threaded draft (follow-ups). JSON body so the thread id can be given; follow-ups carry no attachment.
  createDraftInThread(accessToken: string, raw: Buffer, threadId: string) {
    return this.gmail<GmailDraft>(accessToken, `${GMAIL_API}/drafts`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: { raw: raw.toString('base64url'), threadId } }),
    })
  }

  updateDraftInThread(accessToken: string, draftId: string, raw: Buffer, threadId: string) {
    return this.gmail<GmailDraft>(accessToken, `${GMAIL_API}/drafts/${encodeURIComponent(draftId)}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: draftId, message: { raw: raw.toString('base64url'), threadId } }),
    })
  }

  // Sends ONE existing draft. A sent draft stops existing, so the same draft can never be sent twice.
  sendDraft(accessToken: string, auth: SendAuthorization) {
    if (auth.used) throw new Error('Refused: this confirmation was already used.')
    auth.used = true
    return this.gmail<GmailMessage>(accessToken, `${GMAIL_API}/drafts/send`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: auth.draftId }),
    }, auth)
  }

  // ---------- Read-only (gmail.readonly) ----------

  getThread(accessToken: string, threadId: string, format: 'full' | 'metadata' = 'full') {
    return this.gmail<{ id: string; messages?: GmailMessage[] }>(accessToken, `${GMAIL_API}/threads/${encodeURIComponent(threadId)}?format=${format}`)
  }

  getMessage(accessToken: string, messageId: string, format: 'full' | 'metadata' = 'full') {
    return this.gmail<GmailMessage>(accessToken, `${GMAIL_API}/messages/${encodeURIComponent(messageId)}?format=${format}`)
  }

  listMessages(accessToken: string, query: string) {
    return this.gmail<{ messages?: { id: string; threadId: string }[] }>(accessToken, `${GMAIL_API}/messages?maxResults=50&q=${encodeURIComponent(query)}`)
  }

  listDrafts(accessToken: string, query: string) {
    return this.gmail<{ drafts?: { id: string; message: { id: string; threadId: string } }[] }>(accessToken,
      `${GMAIL_API}/drafts?maxResults=50&q=${encodeURIComponent(query)}`)
  }
}

export interface GmailDraft {
  id: string
  message: {
    id: string
    threadId: string
    labelIds?: string[]
    raw?: string
    snippet?: string
    payload?: { headers?: { name: string; value: string }[] }
  }
}

export interface GmailPart {
  mimeType?: string
  filename?: string
  headers?: { name: string; value: string }[]
  body?: { data?: string; size?: number; attachmentId?: string }
  parts?: GmailPart[]
}

export interface GmailMessage {
  id: string
  threadId: string
  labelIds?: string[]
  snippet?: string
  internalDate?: string
  payload?: GmailPart
}

export const headerValue = (m: { payload?: GmailPart }, name: string) =>
  m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null

// Opens the draft in Gmail's web app, signed in as the right account.
export const gmailThreadLink = (account: string, threadId: string) =>
  `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(account)}#all/${encodeURIComponent(threadId)}`

export const gmailDraftLink = (account: string, messageId: string) =>
  `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(account)}#drafts?compose=${encodeURIComponent(messageId)}`
