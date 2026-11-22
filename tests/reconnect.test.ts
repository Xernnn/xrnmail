import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DraftFiles } from '@main/draft-files'
import { MemorySecrets } from '@main/secrets'
import { SmtpSender } from '@main/sender'
import { MailService, type ServiceDeps } from '@main/service'
import { ImapSource, ImapWatcher, type ImapTimeouts } from '@main/source'
import { Store } from '@main/store'
import { ImapWriter } from '@main/writer'
import { FakeGmail } from './fake-gmail'
import { FakeSmtp } from './fake-smtp'

/** Getting back through: after waking, a network change or a server's blip, the account's error
 *  goes as soon as the server can be reached again, not at the next three-minute pass. */

const eventually = (check: () => void): Promise<void> => vi.waitFor(check, { timeout: 15_000, interval: 15 })
const ME = 'me@example.com'

let gmail: FakeGmail
let smtp: FakeSmtp
/** Where the IMAP connections go: the fake Gmail, or a port nothing listens on. */
let port: number
/** How long the IMAP connections wait before giving up, when a test needs it short. */
let timeouts: Partial<ImapTimeouts> | undefined
let folder: string
let store: Store
let secrets: MemorySecrets
let service: MailService

const make = (over: Partial<ServiceDeps> = {}): MailService =>
  new MailService({
    store, secrets,
    changed: () => undefined,
    now: () => Date.now(),
    files: new DraftFiles(folder),
    openSource: (account, login) => new ImapSource({ host: '127.0.0.1', port, security: 'none', user: account.user, ...login, timeouts }),
    openWriter: (account, login) => new ImapWriter({ host: '127.0.0.1', port, security: 'none', user: account.user, ...login, timeouts }),
    openWatcher: (account, login) => new ImapWatcher({ host: '127.0.0.1', port, security: 'none', user: account.user, ...login }),
    openSender: (account, login) => new SmtpSender({ host: '127.0.0.1', port: smtp.port, security: 'none', user: account.user, ...login }),
    ...over
  })

/** A port nothing listens on, so a connection there is refused at once. */
async function closedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const free = (server.address() as AddressInfo).port
  await new Promise((resolve) => server.close(resolve))
  return free
}

const error = (): string | null | undefined => service.accounts()[0]?.error
/** Passes that reached the server: each one lists its folders first. */
const passes = (): number => gmail.commands.filter((line) => line.startsWith('LIST')).length

async function signedIn(): Promise<void> {
  await service.addAccount({ email: ME, secret: gmail.secret, provider: 'gmail' })
  await eventually(() => expect(service.accounts()[0]?.syncedAt).not.toBeNull())
  await eventually(() => expect(service.accounts()[0]?.syncing).toBe(false))
}

/** Only the timers: sockets stay real, against the fake servers. */
const fakeTimers = (): void => void vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

beforeEach(async () => {
  gmail = new FakeGmail()
  port = await gmail.listen()
  smtp = new FakeSmtp(gmail.secret)
  await smtp.listen()
  folder = mkdtempSync(join(tmpdir(), 'xrnmail-test-'))
  store = new Store(':memory:')
  secrets = new MemorySecrets()
  timeouts = undefined
  service = make()
  await signedIn()
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  service.stopWatching()
  await eventually(() => expect(service.accounts().every((a) => !a.syncing)).toBe(true))
  await new Promise((resolve) => setTimeout(resolve, 20))
  store.close()
  await gmail.stop()
  await smtp.stop()
  rmSync(folder, { recursive: true, force: true })
})

describe('a pass that could not get through', () => {
  it('is tried again within seconds, and the error goes once it gets through', async () => {
    fakeTimers()
    gmail.dropNextConnection = true
    await service.syncAll()
    expect(error()).toBe("Couldn't reach Gmail.")
    const before = passes()
    await vi.advanceTimersByTimeAsync(5_000)
    await eventually(() => expect(error()).toBeNull())
    expect(passes() - before).toBe(1)
  })

  it('waits longer each time it fails again, then leaves it to the passes every three minutes', async () => {
    fakeTimers()
    const tries = vi.spyOn(ImapSource.prototype, 'connect')
    const open = port
    port = await closedPort()
    try {
      await service.syncAll()
      expect(error()).toBe("Couldn't reach Gmail.")
      for (const wait of [5_000, 15_000, 30_000, 60_000]) {
        const before = tries.mock.calls.length
        await vi.advanceTimersByTimeAsync(wait / 2)
        expect(tries.mock.calls.length).toBe(before)
        await vi.advanceTimersByTimeAsync(wait / 2 + 500)
        await eventually(() => expect(tries.mock.calls.length).toBe(before + 1))
        await eventually(() => expect(service.accounts()[0]?.syncing).toBe(false))
      }
      const last = tries.mock.calls.length
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(tries.mock.calls.length).toBe(last)
      expect(error()).toBe("Couldn't reach Gmail.")
    } finally {
      port = open
    }
  })

  it('starts the waits over after waking, so a pass that fails before the network is back is tried again soon', async () => {
    fakeTimers()
    const tries = vi.spyOn(ImapSource.prototype, 'connect')
    const open = port
    port = await closedPort()
    try {
      await service.syncAll()
      for (const wait of [5_000, 15_000, 30_000, 60_000]) {
        const before = tries.mock.calls.length
        await vi.advanceTimersByTimeAsync(wait + 500)
        await eventually(() => expect(tries.mock.calls.length).toBe(before + 1))
        await eventually(() => expect(service.accounts()[0]?.syncing).toBe(false))
      }
      await service.reconnect() // the laptop wakes, and the network isn't up yet
      expect(error()).toBe("Couldn't reach Gmail.")
      port = open // now it is
      await vi.advanceTimersByTimeAsync(5_500)
      await eventually(() => expect(error()).toBeNull())
    } finally {
      port = open
    }
  })
})

describe('a sync asked for while one is running', () => {
  it('runs once more when the one running ends, so one stuck on a dead connection is followed at once', async () => {
    timeouts = { connect: 1000, greeting: 600, quiet: 800 }
    gmail.stall = /^LIST$/ // the laptop slept with this pass on the wire
    const stuck = service.syncAll()
    await eventually(() => expect(gmail.commands.at(-1)).toMatch(/^LIST/))
    gmail.stall = null // awake, and the network is back
    const before = passes()
    await service.syncAll() // waking, the window coming back, or F5
    await stuck
    expect(passes() - before).toBe(1)
    expect(error()).toBeNull()
  })

  it('asked for many times, runs once more, not once for each', async () => {
    gmail.hold = /^LIST$/
    const first = service.syncAll()
    await eventually(() => expect(gmail.holding).toHaveLength(1))
    const before = passes()
    for (let i = 0; i < 5; i++) void service.syncAll()
    gmail.release()
    await first
    await eventually(() => expect(service.accounts()[0]?.syncing).toBe(false))
    expect(passes() - before).toBe(2) // the one held, then one more
  })
})
