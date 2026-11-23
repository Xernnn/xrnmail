import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { connect, createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { failureLine, noteAttempts, SyncLog, TRIED, type Failure } from '@main/sync-log'

const AT = new Date(Date.UTC(2026, 10, 23, 1, 2, 3, 456))
const ME = 'alex@example.com'

const failure = (error: unknown, over: Partial<Failure> = {}): Failure => ({ account: ME, provider: 'gmail', doing: 'sync', error, ms: 30_012.4, ...over })

/** Node's error for a name with two addresses, both of which failed. */
const both = Object.assign(new AggregateError([
  Object.assign(new Error('connect ECONNREFUSED ::1:993'), { code: 'ECONNREFUSED', syscall: 'connect', address: '::1', port: 993 }),
  Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:993'), { code: 'ECONNREFUSED', syscall: 'connect', address: '127.0.0.1', port: 993 })
]), { code: 'ECONNREFUSED' })

describe('a line in the log of failures', () => {
  it('says when, which account by a hash, what, where, the code, how long and the addresses tried', () => {
    const line = failureLine(failure(both), AT)
    expect(line).toMatch(/^2026-11-23T01:02:03\.456Z gmail:[0-9a-f]{6} sync connect ECONNREFUSED 30012ms ipv6 \[::1\]:993 ECONNREFUSED, ipv4 127\.0\.0\.1:993 ECONNREFUSED$/)
    expect(line).not.toContain(ME)
    expect(line).not.toContain('alex')
  })

  it('tells two accounts on the same service apart, without naming either', () => {
    const one = failureLine(failure(both), AT).split(' ')[1]
    const two = failureLine(failure(both, { account: 'mai@example.com' }), AT).split(' ')[1]
    expect(one).not.toBe(two)
  })

  it('keeps a server\'s codes and never its words', () => {
    const refused = Object.assign(new Error('Command failed'), {
      authenticationFailed: true, responseStatus: 'NO', serverResponseCode: 'UNAVAILABLE',
      responseText: 'Temporary System Problem for alex@example.com <script>', response: 'NO [UNAVAILABLE] Temporary System Problem', executedCommand: '2 LOGIN "alex@example.com" "secret"'
    })
    const line = failureLine(failure(refused, { ms: 812 }), AT)
    expect(line).toMatch(/ sync login NO \[UNAVAILABLE\] 812ms$/)
    for (const word of ['Temporary', 'alex', 'secret', 'script', 'LOGIN']) expect(line).not.toContain(word)
  })

  it('names how far a connection got: dns, connect, tls, greeting, login, a command, idle, smtp', () => {
    const stage = (error: unknown, over: Partial<Failure> = {}): string | undefined => failureLine(failure(error, over), AT).split(' ')[3]
    expect(stage({ code: 'ENOTFOUND', syscall: 'getaddrinfo' })).toBe('dns')
    expect(stage({ code: 'CONNECT_TIMEOUT' })).toBe('connect')
    expect(stage({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' })).toBe('tls')
    expect(stage({ code: 'GREETING_TIMEOUT' })).toBe('greeting')
    expect(stage({ authenticationFailed: true, responseStatus: 'NO', serverResponseCode: 'AUTHENTICATIONFAILED' })).toBe('login')
    expect(stage({ code: 'ETIMEOUT' })).toBe('command')
    expect(stage({ code: 'ECONNRESET', syscall: 'read' }, { doing: 'watch', idle: true })).toBe('idle')
    expect(stage(null, { doing: 'watch', idle: true })).toBe('idle')
    expect(stage({ code: 'EAUTH', responseCode: 535 }, { doing: 'send' })).toBe('smtp')
    expect(stage(new Error('Unlock your system keyring, then restart xrnmail.'))).toBe('other')
  })

  it('says a watch that ended without an error was closed', () => {
    expect(failureLine(failure(null, { doing: 'watch', idle: true, ms: 3_600_000 }), AT)).toMatch(/ watch idle closed 3600000ms$/)
  })

  it('looks inside an error of the app\'s own for the one it stands for', () => {
    const lost = new Error('no connection', { cause: { code: 'ETIMEDOUT', syscall: 'connect', address: '192.0.2.1', port: 587 } })
    expect(failureLine(failure(lost, { doing: 'send' }), AT)).toMatch(/ send smtp ETIMEDOUT 30012ms ipv4 192\.0\.2\.1:587 ETIMEDOUT$/)
  })
})

describe('the log of failures', () => {
  let folder: string

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'xrnmail-log-'))
  })

  afterEach(() => rmSync(folder, { recursive: true, force: true }))

  it('adds a line for each, and keeps only the last of them past its size', () => {
    const path = join(folder, 'sync.log')
    const log = new SyncLog(path, 1_000)
    for (let i = 0; i < 40; i++) log.write(failure(both, { ms: i }), AT)
    const lines = readFileSync(path, 'utf8').trimEnd().split('\n')
    expect(statSync(path).size).toBeLessThanOrEqual(1_000)
    expect(statSync(`${path}.1`).size).toBeLessThanOrEqual(1_000)
    expect(lines.at(-1)).toContain(' 39ms ')
    expect(lines.every((line) => line.startsWith('2026-11-23T01:02:03.456Z gmail:'))).toBe(true)
  })

  it('changes nothing else when it can\'t be written', () => {
    const log = new SyncLog(join(folder, 'gone', 'sync.log'))
    expect(() => log.write(failure(both), AT)).not.toThrow()
  })
})

describe('noting the addresses a connection tries', () => {
  it('hands them over with the error, as they went', async () => {
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    await new Promise((resolve) => server.close(resolve))
    const failed = await noteAttempts(() => new Promise<void>((resolve, reject) => {
      connect({ host: '127.0.0.1', port }).once('connect', resolve).once('error', reject)
    })).catch((e: unknown) => e)
    expect((failed as { [TRIED]?: unknown })[TRIED]).toEqual([{ address: '127.0.0.1', port, family: 4, result: 'ECONNREFUSED' }])
    expect(failureLine(failure(failed), AT)).toContain(`connect ECONNREFUSED 30012ms ipv4 127.0.0.1:${port} ECONNREFUSED`)
  })

  it('notes nothing for a connection made outside it', async () => {
    const server = createServer((socket) => socket.end())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const outside = connect({ host: '127.0.0.1', port })
    const failed = await noteAttempts(async () => {
      await new Promise((resolve) => outside.once('connect', resolve))
      throw new Error('later')
    }).catch((e: unknown) => e)
    expect((failed as { [TRIED]?: unknown })[TRIED]).toEqual([])
    outside.destroy()
    await new Promise((resolve) => server.close(resolve))
  })
})
