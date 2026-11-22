import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { subscribe } from 'node:diagnostics_channel'
import { appendFileSync, renameSync, statSync } from 'node:fs'
import type { Socket } from 'node:net'

/**
 * A small log of the connections that failed, `sync.log` in the profile folder, for finding out why
 * an account said "Couldn't reach". One line each: when, which account (its service and a short hash,
 * never the address), what it was doing, where the connection got to, the error's code, how long it
 * took, and the addresses tried. Never what a server said, nothing of the mail, and no secrets.
 */

/** Past this the file is moved aside as `sync.log.1` and a new one begun, so twice this at most is kept. */
export const LOG_MAX_BYTES = 256 * 1024

/** One failure, as the service tells of it. */
export interface Failure {
  account: string
  provider: string
  doing: 'sync' | 'watch' | 'changes' | 'drafts' | 'sent' | 'send'
  /** Nothing when a watch's connection ended without one. */
  error: unknown
  /** From opening the connection to giving up. */
  ms: number
  /** The watch was open on the inbox when it ended. */
  idle?: boolean
}

/** An address a connection tried, and what came of it. */
export interface Attempt {
  address: string
  port: number
  family: number
  result: string
}

/** What an error carries of the addresses tried by the connection it ended. */
export const TRIED = Symbol('tried')

interface Noting {
  tried: Attempt[]
  open: boolean
}

const noting = new AsyncLocalStorage<Noting>()

/** A short code, as Node and the mail libraries give them: anything else written could be a server's words. */
const CODE = /^[A-Za-z0-9_.-]{1,40}$/
const codeOf = (value: unknown): string | null => (typeof value === 'string' && CODE.test(value) ? value : null)

// Every socket the main process opens is told of here. Only those opened while a connection is
// being noted (noteAttempts) are followed, and only until it's up or has failed.
subscribe('net.client.socket', (message) => {
  const notes = noting.getStore()
  const socket = (message as { socket?: Socket }).socket
  if (!notes?.open || !socket) return
  const find = (address: string, port: number): Attempt | undefined => notes.tried.findLast((a) => a.address === address && a.port === port)
  socket.on('connectionAttempt', (address: string, port: number, family: number) => {
    if (notes.open && notes.tried.length < 16) notes.tried.push({ address, port, family, result: 'no answer' })
  })
  socket.on('connectionAttemptFailed', (address: string, port: number, _family: number, error: unknown) => {
    const found = find(address, port)
    if (found) found.result = codeOf((error as { code?: unknown })?.code) ?? 'failed'
  })
  socket.on('connectionAttemptTimeout', (address: string, port: number) => {
    const found = find(address, port)
    if (found) found.result = 'timeout'
  })
  socket.once('connect', () => {
    const found = find(socket.remoteAddress ?? '', socket.remotePort ?? 0)
    if (found) found.result = 'up'
  })
})

/** Connects with [work], noting each address tried. Failing, the error carries them under [TRIED]. */
export async function noteAttempts<T>(work: () => Promise<T>): Promise<T> {
  const notes: Noting = { tried: [], open: true }
  try {
    return await noting.run(notes, work)
  } catch (e) {
    if (e && typeof e === 'object' && !(TRIED in e)) Object.defineProperty(e, TRIED, { value: notes.tried })
    throw e
  } finally {
    notes.open = false
  }
}

interface Shape {
  code?: unknown
  syscall?: unknown
  address?: unknown
  port?: unknown
  errors?: unknown
  authenticationFailed?: boolean
  responseStatus?: unknown
  serverResponseCode?: unknown
  responseCode?: unknown
  cause?: unknown
  [TRIED]?: Attempt[]
}

/** The error itself, or the one inside an error of the app's own that says what it means. */
function shapeOf(error: unknown): Shape {
  const e = (error ?? {}) as Shape
  return !codeOf(e.code) && e.cause && typeof e.cause === 'object' ? (e.cause as Shape) : e
}

const DNS = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NODATA', 'EAI_NONAME', 'ENODATA', 'ESERVFAIL', 'EDNS'])
const CONNECT = new Set(['CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'EHOSTDOWN', 'EADDRNOTAVAIL', 'ECONNECTION'])
const TLS = /^(ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|SELF_SIGNED|DEPTH_ZERO|ClosedAfterConnectTLS$|UPGRADE_TIMEOUT$|ETLS$)/
const GREETING = new Set(['GREETING_TIMEOUT', 'ClosedAfterConnectText'])

/** How far the connection got before it failed. */
export function stageOf(failure: Pick<Failure, 'doing' | 'error' | 'idle'>): string {
  const e = shapeOf(failure.error)
  const code = codeOf(e.code) ?? ''
  if (failure.doing === 'send') return code || typeof e.responseCode === 'number' ? 'smtp' : 'other'
  if (DNS.has(code) || e.syscall === 'getaddrinfo') return 'dns'
  if (TLS.test(code)) return 'tls'
  if (CONNECT.has(code) || e.syscall === 'connect' || Array.isArray(e.errors)) return 'connect'
  if (GREETING.has(code)) return 'greeting'
  if (e.authenticationFailed) return 'login'
  if (failure.idle) return 'idle'
  return code || e.responseStatus ? 'command' : 'other'
}

/** The error's own codes, never its words: Node's or the library's, the IMAP status and response
 *  code, or the SMTP reply's number. */
function codesOf(error: unknown): string {
  if (error === null || error === undefined) return 'closed'
  const e = shapeOf(error)
  const server = codeOf(e.serverResponseCode)
  const reply = typeof e.responseCode === 'number' && Number.isInteger(e.responseCode) ? String(e.responseCode) : null
  const codes = [codeOf(e.code), codeOf(e.responseStatus), server && `[${server}]`, reply].filter(Boolean)
  return codes.length > 0 ? codes.join(' ') : '-'
}

const where = ({ address, port, family }: Pick<Attempt, 'address' | 'port' | 'family'>): string =>
  `ipv${family} ${family === 6 ? `[${address}]` : address}:${port}`

/** The addresses tried: as followed on the sockets, or else as the error names them. */
function triedOf(error: unknown): string {
  const e = shapeOf(error)
  const followed = e[TRIED]
  if (followed && followed.length > 0) return followed.map((a) => `${where(a)} ${a.result}`).join(', ')
  const named = (Array.isArray(e.errors) ? e.errors : [e]) as Shape[]
  return named
    .filter((n) => typeof n.address === 'string' && typeof n.port === 'number')
    .map((n) => `${where({ address: String(n.address), port: Number(n.port), family: String(n.address).includes(':') ? 6 : 4 })} ${codeOf(n.code) ?? 'failed'}`)
    .join(', ')
}

/** Enough to tell two accounts on the same service apart, and nothing that names either. */
const accountOf = (failure: Failure): string =>
  `${codeOf(failure.provider) ?? 'other'}:${createHash('sha256').update(failure.account.toLowerCase()).digest('hex').slice(0, 6)}`

/** One line of the log. */
export function failureLine(failure: Failure, at: Date): string {
  const tried = triedOf(failure.error)
  return [at.toISOString(), accountOf(failure), failure.doing, stageOf(failure), codesOf(failure.error), `${Math.max(0, Math.round(failure.ms))}ms`, tried]
    .filter(Boolean)
    .join(' ')
}

export class SyncLog {
  constructor(private readonly path: string, private readonly max = LOG_MAX_BYTES) {}

  write(failure: Failure, at = new Date()): void {
    const line = `${failureLine(failure, at)}\n`
    try {
      let size = 0
      try {
        size = statSync(this.path).size
      } catch {
        // Not there yet.
      }
      if (size > 0 && size + line.length > this.max) renameSync(this.path, `${this.path}.1`)
      appendFileSync(this.path, line, { mode: 0o600 })
    } catch {
      // A log that can't be written changes nothing else.
    }
  }
}
