import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DraftFiles } from '@main/draft-files'
import { MemorySecrets } from '@main/secrets'
import { SmtpSender } from '@main/sender'
import { describeFailure, MailService, SEND_FAILED, WATCH_SETTLE_MS, type ServiceDeps } from '@main/service'
import { ImapSource, ImapWatcher, type ImapTimeouts } from '@main/source'
import { Store } from '@main/store'
import { SyncLog } from '@main/sync-log'
import { ImapWriter } from '@main/writer'
import { FakeGmail, rawMail } from './fake-gmail'
import { FakeSmtp } from './fake-smtp'

/** Getting back through: after waking, a network change or a server's blip, the account's error
 *  goes as soon as the server can be reached again, not at the next three-minute pass. */

const eventually = (check: () => void): Promise<void> => vi.waitFor(check, { timeout: 15_000, interval: 15 })
/** Kept before any test fakes the timers. */
const realTimeout = setTimeout
/** As [eventually], without moving faked timers on: for waiting on the network, not on a timer. */
async function soon(check: () => void, ms = 5_000): Promise<void> {
  const end = Date.now() + ms
  for (;;) {
    try {
      return check()
    } catch (e) {
      if (Date.now() > end) throw e
    }
    await new Promise((resolve) => realTimeout(resolve, 15))
  }
}
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
let clock: number
let service: MailService

const make = (over: Partial<ServiceDeps> = {}): MailService =>
  new MailService({
    store, secrets,
    changed: () => undefined,
    now: () => clock,
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
/** Passes that reached the server: each one lists every folder first. A watch lists only the inbox. */
const passes = (): number => gmail.commands.filter((line) => line === 'LIST "" "*"').length

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
  clock = Date.now()
  timeouts = undefined
  service = make()
  await signedIn()
})

afterEach(async () => {
  vi.useRealTimers()
  gmail.release()
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

describe('a watch on the inbox that drops', () => {
  it('is back within seconds, looks for what landed while it was down, and clears the error', async () => {
    fakeTimers()
    let watches = 0
    service = make({
      openWatcher: () => ({
        watch: async (_changed, opened) => {
          if (++watches === 1) return // lost as soon as it began, as when the VPN reconnects
          opened?.()
          await new Promise(() => undefined)
        },
        close: async () => undefined
      })
    })
    gmail.dropNextConnection = true
    await service.syncAll()
    expect(error()).toBe("Couldn't reach Gmail.")
    service.watchAll()
    await eventually(() => expect(watches).toBe(1))
    gmail.add(rawMail({ subject: 'While it was down' }), { arrived: new Date() })
    const stored = store.uids(ME, '@all').size
    const before = passes()
    await vi.advanceTimersByTimeAsync(2_000)
    await eventually(() => expect(watches).toBe(2))
    expect(error()).toBeNull() // the server answered
    await vi.advanceTimersByTimeAsync(WATCH_SETTLE_MS)
    await eventually(() => expect(store.uids(ME, '@all').size).toBe(stored + 1))
    await eventually(() => expect(service.accounts()[0]?.syncing).toBe(false))
    expect(passes() - before).toBe(1)
  })

  it('tries again after 2, 10 and 30 seconds, then every minute, while it can\'t get through', async () => {
    fakeTimers()
    let watches = 0
    service = make({ openWatcher: () => ({ watch: async () => void watches++, close: async () => undefined }) })
    service.watchAll()
    await eventually(() => expect(watches).toBe(1))
    for (const wait of [2_000, 10_000, 30_000, 60_000, 60_000]) {
      const before = watches
      await vi.advanceTimersByTimeAsync(wait - 500)
      expect(watches).toBe(before)
      await vi.advanceTimersByTimeAsync(500)
      await eventually(() => expect(watches).toBe(before + 1))
    }
  })

  it('opened at the start, looks for nothing more than the sync already running', async () => {
    fakeTimers()
    service = make({
      openWatcher: () => ({
        watch: async (_changed, opened) => {
          opened?.()
          await new Promise(() => undefined)
        },
        close: async () => undefined
      })
    })
    const before = passes()
    service.watchAll()
    await vi.advanceTimersByTimeAsync(WATCH_SETTLE_MS + 100)
    expect(passes() - before).toBe(0)
  })
})

// A revoked app password was tried again by the watch every minute, by every pass and by every
// change waiting to go: sixty or more wrong LOGINs an hour per account, which Gmail answers by
// blocking sign-ins for a while.
describe('a password the server refuses', () => {
  const logins = (): number => gmail.commands.filter((line) => line === 'LOGIN').length

  it('is tried again by nothing, even after a restart, until it is entered again', async () => {
    fakeTimers()
    service.watchAll()
    await eventually(() => expect(gmail.idling).toBe(1))
    gmail.secret = 'efghefghefghefgh' // revoked on Google's side, and a new one made
    smtp.secret = gmail.secret
    await service.reconnect() // the watch and a pass sign in again, and are refused
    await eventually(() => expect(error()).toBe('Gmail refused this password.'))
    await eventually(() => expect(service.accounts()[0]?.syncing).toBe(false))
    const refused = logins()

    service.act([{ account: ME, thread: 'any' }], { kind: 'archive' })
    for (let minute = 0; minute < 10; minute++) {
      await vi.advanceTimersByTimeAsync(60_000)
      clock += 60_000
      await service.syncAll()
      await service.tick()
    }
    await service.reconnect()
    service.stopWatching()
    const restarted = make()
    restarted.watchAll()
    await restarted.syncAll()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(logins()).toBe(refused)
    expect(restarted.accounts()[0]?.error).toBe('Gmail refused this password.')
    restarted.stopWatching()

    await service.signInAgain(ME, gmail.secret)
    service.watchAll()
    await eventually(() => expect(error()).toBeNull())
    await eventually(() => expect(gmail.idling).toBe(1))
  })
})

describe('the network changing', () => {
  // sync.log, 24-25 Nov: passes that failed after 61 s (ETIMEOUT) and after 113-186 s
  // (NoConnection), each holding its account all that time. One on a connection the network had
  // dropped waited for imapflow to give up on it: 60 s of quiet, or with the folder locked, a quiet
  // it expects, 60 s, a NOOP, and 60 s more. A change of network now lets go of it at once.
  it('lets go of a pass stuck on the old connection, and passes again at once on the new one', async () => {
    gmail.stall = /^LIST$/ // the pass was on the wire as the VPN reconnected
    const stuck = service.syncAll()
    await eventually(() => expect(gmail.commands.at(-1)).toMatch(/^LIST/))
    gmail.stall = null
    const before = passes()
    await service.reconnect()
    await soon(() => expect(passes() - before).toBe(1), 5_000)
    await stuck
    await soon(() => expect(service.accounts()[0]).toMatchObject({ syncing: false, error: null }))
  })

  it('starts the watch over and syncs, leaving one watch', async () => {
    service.watchAll()
    await eventually(() => expect(gmail.idling).toBe(1))
    const before = passes()
    const idles = gmail.commands.filter((line) => /\bIDLE\b/.test(line)).length
    await service.reconnect()
    expect(passes() - before).toBe(1)
    await eventually(() => expect(gmail.commands.filter((line) => /\bIDLE\b/.test(line)).length).toBe(idles + 1))
    await eventually(() => expect([gmail.connections, gmail.idling]).toEqual([1, 1]))
  })
})

describe('anything that gets through', () => {
  /** The pass failed, and its quick tries are held back, so only what's tested can clear the error. */
  beforeEach(async () => {
    gmail.add(rawMail({ subject: 'One' }), { arrived: new Date(clock - 30 * 3_600_000) })
    await service.syncAll()
    fakeTimers()
    gmail.dropNextConnection = true
    await service.syncAll()
    expect(error()).toBe("Couldn't reach Gmail.")
  })

  it('a change reaching the server clears "Couldn\'t reach"', async () => {
    const row = service.list({ kind: 'all' }).find((r) => r.subject === 'One')
    service.act([{ account: ME, thread: row?.thread ?? '' }], { kind: 'star' })
    await soon(() => expect(gmail.mails[0]?.flags).toContain('\\Flagged'))
    await soon(() => expect(error()).toBeNull())
  })

  it('a message sent clears it too, before the pass that brings it into Sent', async () => {
    const draft = await service.startDraft({ kind: 'new' })
    service.saveDraft(draft.id, { account: ME, from: '', to: 'ada@example.com', cc: '', bcc: '', subject: 'Hi', html: '<p>Hello</p>', text: 'Hello', quote: null })
    service.send(draft.id)
    clock += 11_000
    gmail.hold = /^LIST$/
    const ticking = service.tick()
    await soon(() => expect(smtp.sent).toHaveLength(1))
    await soon(() => expect(error()).toBeNull())
    gmail.release()
    await ticking
  })

  it('leaves an error that isn\'t about reaching the server', async () => {
    gmail.hasAllMail = false
    await service.syncAll()
    const said = error()
    expect(said).toContain('All Mail')
    service.watchAll() // the inbox opens, so the server is there, but All Mail is still missing
    await soon(() => expect(gmail.idling).toBe(1))
    expect(error()).toBe(said)
  })
})

describe('a server too busy to sign in just now', () => {
  it('is said as not reached, and tried again, not as a refused password', () => {
    const refused = 'Gmail refused this password.'
    const busy = "Couldn't reach Gmail."
    const login = (serverResponseCode?: string, responseText = ''): unknown => ({ authenticationFailed: true, responseStatus: 'NO', serverResponseCode, responseText })
    for (const code of ['UNAVAILABLE', 'INUSE', 'LIMIT']) expect(describeFailure(login(code), 'Gmail')).toBe(busy)
    expect(describeFailure(login('ALERT', 'Too many simultaneous connections. (Failure)'), 'Gmail')).toBe(busy)
    for (const code of ['AUTHENTICATIONFAILED', 'AUTHORIZATIONFAILED', 'EXPIRED', undefined]) expect(describeFailure(login(code), 'Gmail')).toBe(refused)
    expect(describeFailure(login('ALERT', 'Application-specific password required'), 'Gmail')).toBe(refused)
  })

  it('a pass turned away at LOGIN with [UNAVAILABLE] gets through on its next try', async () => {
    fakeTimers()
    gmail.loginAnswer = 'NO [UNAVAILABLE] Temporary System Problem. Try again later. (Failure)'
    await service.syncAll()
    expect(error()).toBe("Couldn't reach Gmail.")
    gmail.loginAnswer = null
    await vi.advanceTimersByTimeAsync(5_000)
    await eventually(() => expect(error()).toBeNull())
  })

  it('a message turned away at AUTH with a 4xx waits for a connection, and goes', async () => {
    const draft = await service.startDraft({ kind: 'new' })
    service.saveDraft(draft.id, { account: ME, from: '', to: 'ada@example.com', cc: '', bcc: '', subject: 'Hi', html: '<p>Hello</p>', text: 'Hello', quote: null })
    service.send(draft.id)
    smtp.authAnswer = '454 4.7.0 Too many login attempts, please try again later.'
    clock += 11_000
    await service.tick()
    expect(service.drafts()[0]).toMatchObject({ state: 'queued', error: 'Waiting for a connection.' })
    expect(smtp.received).toBe(0)
    smtp.authAnswer = null
    clock += 61_000
    await service.tick()
    expect(smtp.sent).toHaveLength(1)
  })
})

describe('the log of failures', () => {
  const read = (): string[] => {
    try {
      return readFileSync(join(folder, 'sync.log'), 'utf8').trimEnd().split('\n')
    } catch {
      return []
    }
  }

  beforeEach(() => {
    const log = new SyncLog(join(folder, 'sync.log'))
    service = make({ failed: (failure) => log.write(failure) })
  })

  it('has a line for a pass that couldn\'t connect, with the address tried, and nothing private', async () => {
    fakeTimers()
    const open = port
    port = await closedPort()
    try {
      await service.syncAll()
    } finally {
      port = open
    }
    expect(read()).toHaveLength(1)
    expect(read()[0]).toMatch(/^\S+Z gmail:[0-9a-f]{6} sync connect ECONNREFUSED \d+ms ipv4 127\.0\.0\.1:\d+ ECONNREFUSED$/)
    expect(read()[0]).not.toContain(ME.split('@')[0])
    expect(read()[0]).not.toContain(gmail.secret)
  })

  it('has a line for a watch whose connection went', async () => {
    service.watchAll()
    await eventually(() => expect(gmail.idling).toBe(1))
    await gmail.stop()
    await eventually(() => expect(read().some((line) => / watch idle \S+ \d+ms/.test(line))).toBe(true))
  })

  it('has nothing for a watch stopped on purpose', async () => {
    service.watchAll()
    await eventually(() => expect(gmail.idling).toBe(1))
    service.stopWatching()
    await eventually(() => expect(gmail.connections).toBe(0))
    expect(read()).toEqual([])
  })
})

describe('sending', () => {
  const write = async (): Promise<number> => {
    const draft = await service.startDraft({ kind: 'new' })
    service.saveDraft(draft.id, { account: ME, from: '', to: 'ada@example.com', cc: '', bcc: '', subject: 'Hi', html: '<p>Hello</p>', text: 'Hello', quote: null })
    service.send(draft.id)
    return draft.id
  }

  it('signs in and sends on one connection, so the network going between the two can\'t fail it', async () => {
    await write()
    const before = smtp.connections
    smtp.refuseAfter = before + 1
    clock += 11_000
    await service.tick()
    expect(smtp.sent).toHaveLength(1)
    expect(smtp.connections).toBe(before + 1)
    expect(service.drafts()).toEqual([])
  })

  it('is marked as sending only once signed in, so quitting during a slow connect leaves it to go next time', async () => {
    const id = await write()
    const before = smtp.connections
    smtp.silent = true
    clock += 11_000
    const ticking = service.tick()
    await soon(() => expect(smtp.connections).toBe(before + 1)) // connecting, and nothing heard yet
    expect(store.draft(id)?.state).toBe('queued')
    service = make() // the app quits there, and starts again
    expect(service.drafts()[0]).toMatchObject({ id, state: 'queued' })
    smtp.silent = false
    const where = smtp.port
    await smtp.stop() // the slow connection goes
    await smtp.listen(where)
    await ticking
    clock += 61_000
    await service.tick()
    expect(smtp.sent).toHaveLength(1)
    expect(service.drafts()).toEqual([])
  })

  it('a refused password still fails it, in fixed words, with nothing sent', async () => {
    await write()
    smtp.secret = 'changed'
    clock += 11_000
    await service.tick()
    expect(service.drafts()[0]).toMatchObject({ state: 'failed', error: 'The mail server refused this password.' })
    expect(smtp.received).toBe(0)
    expect(service.accounts()[0]?.error).toBe(SEND_FAILED) // said beside the account, like any other failed send
  })
})

describe('a thread of messages too big to keep whole', () => {
  it('lists their files over one connection at a time, not one each at once', async () => {
    for (const c of ['a', 'b', 'c']) {
      const attachment = { name: `${c}.pdf`, type: 'application/pdf', body: c.repeat(4.2 * 1024 * 1024) }
      gmail.add(rawMail({ subject: `Scan ${c}`, attachment }), { arrived: new Date(clock - 30 * 3_600_000), thread: 99n })
    }
    await service.syncAll()
    const ids = service.thread(ME, '99', false, false, false).map((m) => m.id)
    expect(store.filesCut(ids)).toHaveLength(3)
    gmail.most = gmail.connections
    service.thread(ME, '99')
    await eventually(() => expect(store.filesCut(ids)).toEqual([]))
    expect(gmail.most).toBeLessThanOrEqual(2) // the files, and marking the thread read
  })
})
