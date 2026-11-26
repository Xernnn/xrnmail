import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { isObject, type JsonObject } from './shared-state'

/** The shared document as the home server holds it, from one answer. */
export interface SharedCopy {
  version: number
  /** The server's own name for this copy, new with every write (X-Tag); empty while there's none. */
  tag: string
  doc: JsonObject
  /** False when the server says this copy wasn't written on top of the one this laptop last agreed
   *  with (X-Follows: 0): its data was put back from a backup and written to since, so its numbers
   *  may look newer and still not be. */
  follows: boolean
}

export type SharedPut =
  | { kind: 'accepted'; version: number; tag: string }
  /** Another device wrote first (412), and nothing changed there. [hash] is what its copy hashes to
   *  as it was sent (X-Content-SHA256). */
  | { kind: 'stale'; version: number; tag: string; hash: string }

/** What the home server answered when it wasn't the document: [status] 0 is no answer at all. 503
 *  is "the stored copy can't be read", which is never taken as an empty one. [retryAfter] is how
 *  long a 429 asks to wait, in seconds. */
export class SharedFailure extends Error {
  constructor(readonly status: number, readonly retryAfter: number | null = null) {
    super(`home server: ${status === 0 ? 'no answer' : status}`)
  }

  /** Worth trying again by itself, unlike a refused login or a wrong address. */
  get temporary(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500
  }
}

/** xrnmail-sync's `/state` (server/xrnmail-sync.py). */
export interface SharedServer {
  /** The copy there is now; version 0 and an empty document while there is none. */
  current(): Promise<SharedCopy>
  /** The copy there is, or null while it's still the one at [version] named [tag]. With
   *  [waitSeconds], the server holds the answer back that long for a change (at most 30 s). */
  newerThan(version: number, tag: string, waitSeconds?: number): Promise<SharedCopy | null>
  /** Sends [body] as the copy to follow the one at [version] named [tag]. */
  put(body: string, version: number, tag: string): Promise<SharedPut>
  /** Ends a long-poll waiting now. A write under way goes on. */
  abort(): void
}

export const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/** A device login, made by the server's owner for this laptop and the services it names. */
export const isDeviceLogin = (secret: string): boolean => secret.startsWith('xrndev_')

/** How long a long-poll waits on the server: under its 30 s, and under what Funnel holds a quiet line. */
export const MAX_WAIT_S = 30
const CONNECT_AND_ANSWER_MS = 30_000

/** The address as typed, without the spaces and the last slash. */
export const cleanAddress = (text: string): string => text.trim().replace(/\/+$/, '')

/** https anywhere; http only to this machine, as the tests' server is, so the login never goes out
 *  in the clear. */
export function addressAllowed(address: string): boolean {
  try {
    const url = new URL(cleanAddress(address))
    if (url.username || url.password || url.search || url.hash || !url.hostname) return false
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
  } catch {
    return false
  }
}

/**
 * The home server over HTTPS, signed in with the sync password, or with a device login
 * (`xrndev_…`, sent as a Bearer token in its place, the name then unused). A redirect isn't
 * followed, as a login isn't for wherever it points.
 */
export class HttpSharedServer implements SharedServer {
  private readonly base: string
  private readonly auth: string
  /** The long-polls under way, for [abort]. */
  private readonly open = new Set<AbortController>()
  /** Whether the server said it takes a gzipped body (Accept-Encoding on its /state answers). */
  private takesGzip = false

  constructor(address: string, user: string, secret: string, private readonly fetcher: typeof fetch = fetch, private readonly device = 'xrnmail') {
    this.base = cleanAddress(address)
    if (!addressAllowed(this.base)) throw new Error('https only')
    this.auth = isDeviceLogin(secret) ? `Bearer ${secret}` : `Basic ${Buffer.from(`${user}:${secret}`).toString('base64')}`
  }

  private async call(method: 'GET' | 'PUT', path: string, headers: Record<string, string>, ms: number, body?: Uint8Array<ArrayBuffer> | string, waits = false): Promise<Response> {
    const stop = new AbortController()
    if (waits) this.open.add(stop)
    const timer = setTimeout(() => stop.abort(), ms)
    timer.unref?.()
    try {
      return await this.fetcher(this.base + path, {
        method,
        headers: { Authorization: this.auth, 'X-Device': this.device, Accept: 'application/json', ...headers },
        body,
        redirect: 'error',
        cache: 'no-store',
        signal: stop.signal
      })
    } catch {
      throw new SharedFailure(0)
    } finally {
      clearTimeout(timer)
      this.open.delete(stop)
    }
  }

  private noteGzip(response: Response): void {
    this.takesGzip = (response.headers.get('Accept-Encoding') ?? '').split(',').some((coding) => coding.trim().toLowerCase() === 'gzip')
  }

  private static version(response: Response): number {
    const version = (response.headers.get('ETag') ?? '').trim().replace(/^W\//, '').replace(/^"|"$/g, '')
    if (!/^\d{1,15}$/.test(version)) throw new SharedFailure(response.status)
    return Number(version)
  }

  private static async copy(response: Response): Promise<SharedCopy> {
    let doc: unknown
    try {
      doc = JSON.parse(await response.text())
    } catch {
      doc = null
    }
    // A page in front of the server (a proxy's own error) can answer 200 too: only a document is one.
    if (!isObject(doc as JsonObject)) throw new SharedFailure(0)
    return { version: HttpSharedServer.version(response), tag: response.headers.get('X-Tag') ?? '', doc: doc as JsonObject, follows: response.headers.get('X-Follows') !== '0' }
  }

  private static async failed(response: Response): Promise<never> {
    await response.body?.cancel().catch(() => undefined)
    const wait = Number(response.headers.get('Retry-After'))
    throw new SharedFailure(response.status, Number.isFinite(wait) && wait > 0 ? wait : null)
  }

  async current(): Promise<SharedCopy> {
    const response = await this.call('GET', '/state', {}, CONNECT_AND_ANSWER_MS)
    this.noteGzip(response)
    return response.status === 200 ? HttpSharedServer.copy(response) : HttpSharedServer.failed(response)
  }

  async newerThan(version: number, tag: string, waitSeconds = 0): Promise<SharedCopy | null> {
    const wait = Math.min(Math.max(Math.round(waitSeconds), 0), MAX_WAIT_S)
    const headers: Record<string, string> = { 'If-None-Match': `"${version}"`, ...(tag ? { 'X-Base-Tag': tag } : {}) }
    const response = await this.call('GET', wait > 0 ? `/state?wait=${wait}` : '/state', headers, CONNECT_AND_ANSWER_MS + wait * 1000, undefined, wait > 0)
    this.noteGzip(response)
    if (response.status === 304) return null
    return response.status === 200 ? HttpSharedServer.copy(response) : HttpSharedServer.failed(response)
  }

  async put(body: string, version: number, tag: string): Promise<SharedPut> {
    // Gzipped only to a server that said it takes it: one from before reads it as a broken body.
    const packed = this.takesGzip
    const headers: Record<string, string> = {
      'If-Match': `"${version}"`,
      'Content-Type': 'application/json; charset=utf-8',
      ...(tag && version !== 0 ? { 'X-Base-Tag': tag } : {}),
      ...(packed ? { 'Content-Encoding': 'gzip' } : {})
    }
    const response = await this.call('PUT', '/state', headers, CONNECT_AND_ANSWER_MS, packed ? new Uint8Array(gzipSync(body)) : body)
    if (response.status === 200) {
      await response.body?.cancel().catch(() => undefined)
      return { kind: 'accepted', version: HttpSharedServer.version(response), tag: response.headers.get('X-Tag') ?? '' }
    }
    if (response.status === 412) {
      await response.body?.cancel().catch(() => undefined)
      return { kind: 'stale', version: HttpSharedServer.version(response), tag: response.headers.get('X-Tag') ?? '', hash: response.headers.get('X-Content-SHA256') ?? '' }
    }
    return HttpSharedServer.failed(response)
  }

  abort(): void {
    for (const stop of this.open) stop.abort()
  }
}
