/**
 * Signing in to Microsoft. Outlook.com stopped taking passwords over IMAP, so it takes a token, and
 * the device flow is how a desktop app gets one without a web server: the person enters a short code
 * on Microsoft's own page, and nothing here ever sees their password.
 *
 * Microsoft only admits registered apps, and an app id has to come from somewhere. It's the person's
 * own, because using another mail app's would be pretending to be it.
 */

const AUTHORITY = 'https://login.microsoftonline.com/common/oauth2/v2.0'
export const MICROSOFT_SCOPE = 'offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send'

export interface DeviceCode {
  deviceCode: string
  userCode: string
  url: string
  intervalMs: number
  expiresAt: number
}

export interface Tokens {
  access: string
  refresh: string
  expiresAt: number
}

type Post = typeof fetch

async function form(post: Post, url: string, fields: Record<string, string>): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const response = await post(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    redirect: 'error',
    signal: AbortSignal.timeout(20_000)
  })
  return { ok: response.ok, status: response.status, body: (await response.json()) as Record<string, unknown> }
}

/** OAuth errors that only mean "not now". */
const PASSING = new Set(['temporarily_unavailable', 'server_error'])

const tokensFrom = (body: Record<string, unknown>, now: number, fallback = ''): Tokens => ({
  access: String(body['access_token'] ?? ''),
  refresh: String(body['refresh_token'] ?? fallback),
  expiresAt: now + Number(body['expires_in'] ?? 3600) * 1000
})

export async function startDeviceCode(post: Post, clientId: string, now: number): Promise<DeviceCode> {
  const { ok, body } = await form(post, `${AUTHORITY}/devicecode`, { client_id: clientId, scope: MICROSOFT_SCOPE })
  if (!ok || !body['device_code']) throw new Error("Microsoft didn't accept that application ID.")
  return {
    deviceCode: String(body['device_code']),
    userCode: String(body['user_code']),
    url: String(body['verification_uri']),
    intervalMs: Number(body['interval'] ?? 5) * 1000,
    expiresAt: now + Number(body['expires_in'] ?? 900) * 1000
  }
}

/** Null while the person hasn't finished. Throws once it's clear they won't. */
export async function pollDeviceCode(post: Post, clientId: string, code: DeviceCode, now: number): Promise<Tokens | null> {
  const { ok, body } = await form(post, `${AUTHORITY}/token`, {
    client_id: clientId,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: code.deviceCode
  })
  if (ok && body['access_token']) return tokensFrom(body, now)
  const error = String(body['error'] ?? '')
  if (error === 'authorization_pending' || error === 'slow_down') return null
  throw new Error(error === 'authorization_declined' ? 'The sign-in was declined.' : 'The sign-in code ran out. Try again.')
}

/** Only Microsoft refusing in so many words means signing in again. Being busy, failing or
 *  rate-limited passes, and taking it for final would give up mail that's waiting to go. */
export async function refreshTokens(post: Post, clientId: string, refresh: string, now: number): Promise<Tokens> {
  const { ok, status, body } = await form(post, `${AUTHORITY}/token`, {
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: refresh,
    scope: MICROSOFT_SCOPE
  })
  if (ok && body['access_token']) return tokensFrom(body, now, refresh)
  const error = typeof body['error'] === 'string' ? body['error'] : ''
  if (error && !PASSING.has(error) && status !== 429 && !(status >= 500)) throw new SignInExpired()
  throw new Error("Microsoft didn't renew the sign-in this time.")
}

/** Microsoft won't renew this any more, so the person has to sign in again. */
export class SignInExpired extends Error {}
