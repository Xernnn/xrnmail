import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dayKey } from '@main/batches'
import { DraftFiles } from '@main/draft-files'
import { MemorySecrets } from '@main/secrets'
import { SmtpSender } from '@main/sender'
import { MailService, type ServiceDeps } from '@main/service'
import { HttpSharedServer } from '@main/shared-server'
import type { JsonObject } from '@main/shared-state'
import { ImapSource, ImapWatcher } from '@main/source'
import { Store } from '@main/store'
import { ImapWriter } from '@main/writer'
import { FakeGmail, rawMail } from './fake-gmail'
import { FakeSmtp } from './fake-smtp'
import { OTHER_TOKEN, PASSWORD, startSyncServer, TOKEN, USER, type SyncServer } from './sync-server'

/** The laptop sharing settings, snoozes, reminders, pins and Deliver now with the phone through the
 *  real xrnmail-sync, the phone played by requests of its own to the same server. */

const eventually = (check: () => void | Promise<void>): Promise<void> => vi.waitFor(check, { timeout: 15_000, interval: 20 })
const at = (hour: number, minute = 0, day = 6): number => new Date(2026, 10, day, hour, minute).getTime()
const ME = 'me@example.com'
const THREAD = '1790000000000000001'
const KEY = `${ME}\n${THREAD}`

let server: SyncServer
let gmail: FakeGmail
let port: number
let smtp: FakeSmtp
let folder: string
let store: Store
let secrets: MemorySecrets
let clock: number
let service: MailService
/** Every request the laptop made to xrnmail-sync: its method, address and Authorization's kind. */
let asked: string[]
/** The phone, as the server sees it. */
let phone: HttpSharedServer

const counted: typeof fetch = async (input, init) => {
  const auth = String((init?.headers as Record<string, string> | undefined)?.['Authorization'] ?? '').split(' ')[0]
  asked.push(`${init?.method ?? 'GET'} ${String(input).replace(server.url, '')} ${auth}`)
  return fetch(input, init)
}

const make = (over: Partial<ServiceDeps> = {}): MailService => {
  return new MailService({
    store, secrets,
    changed: () => undefined,
    now: () => clock,
    files: new DraftFiles(folder),
    openSource: (account, login) => new ImapSource({ host: '127.0.0.1', port, security: 'none', user: account.user, ...login }),
    openWriter: (account, login) => new ImapWriter({ host: '127.0.0.1', port, security: 'none', user: account.user, ...login }),
    openWatcher: (account, login) => new ImapWatcher({ host: '127.0.0.1', port, security: 'none', user: account.user, ...login }),
    openSender: (account, login) => new SmtpSender({ host: '127.0.0.1', port: smtp.port, security: 'none', user: account.user, ...login }),
    openShare: (url, user, secret) => new HttpSharedServer(url, user, secret, counted),
    shareSettleMs: 30,
    sharePollSeconds: 1,
    ...over
  })
}

/** What the phone has, as it wrote it first: everything at its own first values, and for each
 *  account an identity it made up, a colour and nothing else. */
const PHONE_FIRST: JsonObject = {
  schema: 1,
  settings: {
    batch: { live: false, times: ['09:00', '13:00', '17:00'], vip: [], earlyPerDay: 1 },
    identities: { [ME]: { name: '', aliases: [], color: '#3B82F6' } },
    blocked: [], muted: [], readAfter: 3, swipeLeft: 'archive', somethingNewer: { kept: true }
  },
  threads: {}
}

async function phoneWrites(change: (doc: JsonObject) => JsonObject): Promise<void> {
  for (;;) {
    const there = await phone.current()
    const answer = await phone.put(JSON.stringify(change(there.doc)), there.version, there.tag)
    if (answer.kind === 'accepted') return
  }
}

const onServer = async (): Promise<JsonObject> => (await phone.current()).doc
const settingsOn = async (): Promise<JsonObject> => (await onServer())['settings'] as JsonObject

beforeEach(async () => {
  server = await startSyncServer()
  phone = new HttpSharedServer(server.url, USER, PASSWORD, fetch, 'xrnmail-android')
  gmail = new FakeGmail()
  port = await gmail.listen()
  smtp = new FakeSmtp(gmail.secret)
  await smtp.listen()
  folder = mkdtempSync(join(tmpdir(), 'xrnmail-test-'))
  store = new Store(':memory:')
  secrets = new MemorySecrets()
  clock = at(10)
  asked = []
  service = make()
  await service.addAccount({ email: ME, secret: gmail.secret, provider: 'gmail' })
  await eventually(() => expect(service.accounts()[0]?.syncing).toBe(false))
})

afterEach(async () => {
  service.releaseShare('window')
  await service.finishUp()
  await eventually(() => expect(service.accounts().every((a) => !a.syncing)).toBe(true))
  store.close()
  await gmail.stop()
  await smtp.stop()
  await server.stop()
  rmSync(folder, { recursive: true, force: true })
})

describe('signing in to share with the phone', () => {
  // The phone wrote first, with an identity it made up for each account. Merged as any other
  // change, the laptop's first sync would have given every account a blank From name and dropped
  // its aliases, so a reply from an alias would go out from the account.
  it("keeps the laptop's names and aliases on its first sync, takes what it never changed from the phone, and keeps what it doesn't know", async () => {
    await phoneWrites(() => PHONE_FIRST)
    service.saveProfile({ identities: { [ME]: { name: 'Alex Kim', signature: '', aliases: ['ak@example.com'], color: '', notify: true } }, swipeLeft: 'trash' })
    service.block('spam@shop.example')

    await service.connectShare(server.url, USER, PASSWORD)

    const shared = await settingsOn()
    expect(shared['identities']).toEqual({ [ME]: { name: 'Alex Kim', aliases: ['ak@example.com'], color: service.accounts()[0]?.color } })
    expect(shared['blocked']).toEqual(['spam@shop.example'])
    expect(shared['swipeLeft']).toBe('trash') // changed here: the laptop's
    expect(shared['readAfter']).toBe(3) // never changed here: the phone's
    expect(shared['somethingNewer']).toEqual({ kept: true })
    const here = service.settings()
    expect(here.identities[ME]).toMatchObject({ name: 'Alex Kim', aliases: ['ak@example.com'] })
    expect(here.readAfter).toBe(3)
    expect(service.share()).toMatchObject({ on: true, url: server.url, user: USER, problem: null })
    expect(secrets.get('share')).toBe(PASSWORD)
  })

  it('a device login goes as a Bearer token in place of the password, and one not made for xrnmail asks for no new password', async () => {
    await service.connectShare(server.url, '', TOKEN)
    expect(asked.length).toBeGreaterThan(0)
    expect(asked.every((line) => line.endsWith(' Bearer'))).toBe(true)
    expect((await onServer())['settings']).toBeTruthy()

    service.disconnectShare()
    await expect(service.connectShare(server.url, '', OTHER_TOKEN)).rejects.toThrow("Device login doesn't reach xrnmail")
    expect(service.share().on).toBe(false)
  })

  it('a wrong password keeps nothing', async () => {
    await expect(service.connectShare(server.url, USER, 'wrong')).rejects.toThrow('Sign in again')
    expect(service.share().on).toBe(false)
    expect(secrets.get('share')).toBeNull()
    await expect(service.connectShare('http://example.com/xrnmail', USER, PASSWORD)).rejects.toThrow('https')
  })
})

describe('sharing with the phone', () => {
  beforeEach(async () => {
    await service.connectShare(server.url, USER, PASSWORD)
  })

  // Merged as one value, the entry with the newer time won whole: a thread snoozed on the phone and
  // pinned here a moment later lost its snooze, and came back into the phone's inbox.
  it("a snooze set on the phone lands here, and a pin set here meanwhile keeps it, on both", async () => {
    await phoneWrites((doc) => ({ ...doc, threads: { [KEY]: { snooze: { until: at(18), at: at(9, 59) } } } }))
    service.pin([{ account: ME, thread: THREAD }], true)
    await service.syncAll()
    expect(store.snoozeOf({ account: ME, thread: THREAD })).toEqual({ at: at(9, 59), until: at(18) })
    expect(store.pinOf({ account: ME, thread: THREAD })).toBe(clock)
    await eventually(async () => expect(((await onServer())['threads'] as JsonObject)[KEY]).toEqual({ snooze: { until: at(18), at: at(9, 59) }, pin: clock }))
  })

  // The phone keeps an address as it was typed. Its blank identity for "Me@Example.com" was taken
  // into this laptop's me@example.com, wiping its name and aliases, and the key was then sent back
  // as taken away, which the phone put back, and so on, a write each way every few seconds.
  it("an account the phone has in other letter case leaves the laptop's identity alone, and settles", async () => {
    service.saveProfile({ identities: { [ME]: { name: 'Alex Kim', signature: '', aliases: ['ak@example.com'], color: '', notify: true } } })
    await service.syncAll()
    const PHONE_KEY = 'Me@Example.com'
    await phoneWrites((doc) => {
      const settings = doc['settings'] as JsonObject
      return { ...doc, settings: { ...settings, identities: { ...(settings['identities'] as JsonObject), [PHONE_KEY]: { name: '', aliases: [], color: '#3B82F6' } } } }
    })
    await service.syncAll()
    expect(service.settings().identities[ME]).toMatchObject({ name: 'Alex Kim', aliases: ['ak@example.com'] })
    const shared = (await settingsOn())['identities'] as JsonObject
    expect(shared[PHONE_KEY]).toEqual({ name: '', aliases: [], color: '#3B82F6' })
    expect(shared[ME]).toMatchObject({ name: 'Alex Kim' })
    const writes = asked.filter((line) => line.startsWith('PUT')).length
    await service.syncAll()
    await service.syncAll()
    expect(asked.filter((line) => line.startsWith('PUT')).length).toBe(writes)
  })

  it('a setting changed on either side reaches the other, and one archived here ends its snooze there', async () => {
    await phoneWrites((doc) => ({ ...doc, settings: { ...(doc['settings'] as JsonObject), undoSeconds: 20, muted: ['news@paper.example'] } }))
    await service.syncAll()
    expect(service.settings()).toMatchObject({ undoSeconds: 20, muted: ['news@paper.example'] })

    service.saveProfile({ clock24: false })
    await eventually(async () => expect((await settingsOn())['clock24']).toBe(false))

    await phoneWrites((doc) => ({ ...doc, threads: { [KEY]: { snooze: { until: at(18), at: at(9, 59) } } } }))
    await service.syncAll()
    service.act([{ account: ME, thread: THREAD }], { kind: 'archive' })
    await eventually(async () => expect((await onServer())['threads']).toEqual({}))
  })

  it("the phone's change lands at once while the window is up", async () => {
    service.holdShare('window')
    await eventually(() => expect(asked.some((line) => line.startsWith('GET /state?wait='))).toBe(true))
    await phoneWrites((doc) => ({ ...doc, settings: { ...(doc['settings'] as JsonObject), faces: false } }))
    await eventually(() => expect(service.settings().faces).toBe(false))
    service.releaseShare('window')
  })

  it("the phone's Deliver now lets in here what was waiting then, and the day's count is one count", async () => {
    gmail.add(rawMail({ subject: 'Waiting' }), { arrived: new Date(at(10, 30)) })
    clock = at(10, 31)
    await service.syncAll()
    expect(service.overview().held).toBe(1)
    await phoneWrites((doc) => ({ ...doc, early: { day: dayKey(at(10, 32)), used: 1, releases: [at(10, 32)] } }))
    gmail.add(rawMail({ subject: 'Came after' }), { arrived: new Date(at(10, 33)) })
    clock = at(10, 34)
    await service.syncAll()
    expect(service.list({ kind: 'inbox' }).map((row) => row.subject)).toEqual(['Waiting'])
    expect(service.overview()).toMatchObject({ held: 1, earlyLeft: 0 })
  })

  // Sign in again forgot the agreed copy, so the sync after it was a first merge: what the phone
  // had changed meanwhile was decided the laptop's way, and the sender it unblocked was blocked again.
  it("signing in again keeps what the phone changed meanwhile", async () => {
    service.block('spam@shop.example')
    service.saveProfile({ undoSeconds: 20 })
    await service.syncAll()
    expect(await settingsOn()).toMatchObject({ blocked: ['spam@shop.example'], undoSeconds: 20 })
    server.setPassword('a new one')
    phone = new HttpSharedServer(server.url, USER, 'a new one', fetch, 'xrnmail-android')
    await phoneWrites((doc) => ({ ...doc, settings: { ...(doc['settings'] as JsonObject), blocked: [], undoSeconds: 5 } }))
    await service.syncAll()
    expect(service.share().problem).toBe('Sign in again')
    await service.connectShare(server.url, USER, 'a new one')
    expect(await settingsOn()).toMatchObject({ blocked: [], undoSeconds: 5 })
    expect(service.settings()).toMatchObject({ blocked: [], undoSeconds: 5 })
  })

  it('a refused login stops asking until it is entered again', async () => {
    server.setPassword('a new one')
    await service.syncAll()
    expect(service.share()).toMatchObject({ problem: 'Sign in again', stopped: true })
    const before = asked.length
    await service.syncAll()
    service.saveProfile({ clock24: false })
    await new Promise((done) => setTimeout(done, 200))
    await service.syncAll()
    expect(asked.length).toBe(before)

    await service.connectShare(server.url, USER, 'a new one')
    expect(service.share().problem).toBeNull()
    await eventually(async () => {
      const fresh = new HttpSharedServer(server.url, USER, 'a new one')
      expect(((await fresh.current()).doc['settings'] as JsonObject)['clock24']).toBe(false)
    })
  })
})
