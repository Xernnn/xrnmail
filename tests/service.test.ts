import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DraftFiles } from '@main/draft-files'
import { MemorySecrets } from '@main/secrets'
import { SmtpSender } from '@main/sender'
import { parseUnsubscribe } from '@main/parse'
import { cleanBatch, describeFailure, MailService, SEND_FAILED, UNDO_MS, WATCH_SETTLE_MS, type ServiceDeps } from '@main/service'
import type { Draft } from '@shared/types'
import { ImapSource, ImapWatcher, type ImapTimeouts } from '@main/source'
import { Store } from '@main/store'
import { ImapWriter } from '@main/writer'
import { gmailThreadUrl, isSafeExternalUrl, isSafeHubUrl } from '@main/safe-url'
import { FakeGmail, rawMail } from './fake-gmail'
import { FakeSmtp } from './fake-smtp'

/** A busy laptop can take a while; only a wrong answer should fail a test. */
const eventually = (check: () => void): Promise<void> => vi.waitFor(check, { timeout: 15_000, interval: 15 })

const at = (hour: number, minute = 0, day = 6): number => new Date(2026, 10, day, hour, minute).getTime()
const ME = 'me@example.com'

let gmail: FakeGmail
let smtp: FakeSmtp
let port: number
let folder: string
let store: Store
let secrets: MemorySecrets
let clock: number
let changed: Mock<() => void>
let landed: Mock<(count: number, preview?: { from: string; subject: string; account: string; thread: string }) => void>
let summarized: Mock<(count: number, senders: string[]) => void>
let post: Mock<(url: string, init: { body: string; redirect: string }) => Promise<{ ok: boolean }>>
let service: MailService
/** How long the IMAP connections wait before giving up, when a test needs it short. */
let timeouts: Partial<ImapTimeouts> | undefined

const make = (over: Partial<ServiceDeps> = {}): MailService =>
  new MailService({
    ...over,
    store, secrets, changed, landed, summarized,
    post: post as unknown as typeof fetch,
    now: () => clock,
    files: new DraftFiles(folder),
    openSource: (account, login) => new ImapSource({ host: '127.0.0.1', port, security: 'none', user: account.user, ...login, timeouts }),
    openWriter: (account, login) => new ImapWriter({ host: '127.0.0.1', port, security: 'none', user: account.user, ...login, timeouts }),
    openWatcher: over.openWatcher ?? ((account, login) => new ImapWatcher({ host: '127.0.0.1', port, security: 'none', user: account.user, ...login })),
    openSender: (account, login) => new SmtpSender({ host: '127.0.0.1', port: smtp.port, security: 'none', user: account.user, ...login })
  })

const GMAIL = 'gmail'

/** Adds the account and waits for its first sync. */
async function signedIn(): Promise<void> {
  await service.addAccount({ email: ME, secret: gmail.secret, provider: GMAIL })
  await eventually(() => expect(service.accounts()[0]?.syncedAt).not.toBeNull())
  await eventually(() => expect(service.accounts()[0]?.syncing).toBe(false))
}

beforeEach(async () => {
  gmail = new FakeGmail()
  port = await gmail.listen()
  smtp = new FakeSmtp(gmail.secret)
  await smtp.listen()
  // As Gmail does: what's sent turns up in Sent by itself.
  smtp.delivered = (raw) => void gmail.add(raw, { labels: ['\\Sent'], flags: ['\\Seen'], arrived: new Date(clock) })
  folder = mkdtempSync(join(tmpdir(), 'xrnmail-test-'))
  store = new Store(':memory:')
  secrets = new MemorySecrets()
  clock = at(10)
  timeouts = undefined
  changed = vi.fn()
  landed = vi.fn()
  summarized = vi.fn()
  post = vi.fn(async (_url: string, _init: { body: string; redirect: string }) => ({ ok: true }))
  service = make()
})

afterEach(async () => {
  await eventually(() => expect(service.accounts().every((a) => !a.syncing)).toBe(true))
  await new Promise((resolve) => setTimeout(resolve, 20))
  store.close()
  await gmail.stop()
  await smtp.stop()
  rmSync(folder, { recursive: true, force: true })
})

describe('accounts', () => {
  it('signs in before keeping anything', async () => {
    await expect(service.addAccount({ email: ME, secret: 'wrong', provider: GMAIL })).rejects.toThrow('Gmail refused this password.')
    expect(service.accounts()).toEqual([])
    expect(secrets.get(`account:${ME}`)).toBeNull()
  })

  it('keeps a good account and syncs it', async () => {
    gmail.add(rawMail({ subject: 'Hi' }), { arrived: new Date(at(9)) })
    await signedIn()
    expect(service.list({ kind: 'inbox' }).map((r) => r.subject)).toEqual(['Hi'])
  })

  it('never offers the password back', async () => {
    await signedIn()
    expect(JSON.stringify([service.accounts(), service.settings(), service.overview()])).not.toContain(gmail.secret)
  })

  it('rejects junk and duplicates', async () => {
    await expect(service.addAccount({ email: 'nope', secret: 'x', provider: GMAIL })).rejects.toThrow("isn't an email")
    await expect(service.addAccount({ email: ME, secret: '  ', provider: GMAIL })).rejects.toThrow('password')
    await signedIn()
    await expect(service.addAccount({ email: 'ME@example.com', secret: gmail.secret, provider: GMAIL })).rejects.toThrow('already here')
  })

  it('removing one forgets its mail and password', async () => {
    gmail.add(rawMail({ subject: 'Hi' }), { arrived: new Date(at(9)) })
    await signedIn()
    service.removeAccount(ME)
    expect(service.accounts()).toEqual([])
    expect(service.list({ kind: 'inbox' })).toEqual([])
    expect(secrets.get(`account:${ME}`)).toBeNull()
  })

  it('removing one in the middle of its first sync leaves none of its mail behind', async () => {
    for (let i = 0; i < 120; i++) gmail.add(rawMail({ subject: `Old ${i}` }), { arrived: new Date(at(8)) })
    let removed = false
    changed.mockImplementation(() => {
      if (removed || !service.accounts()[0]?.progress) return
      removed = true // the first of three batches is in
      setImmediate(() => service.removeAccount(ME))
    })
    await service.addAccount({ email: ME, secret: gmail.secret, provider: GMAIL })
    await eventually(() => expect(removed).toBe(true))
    await eventually(() => expect(gmail.connections).toBe(0)) // the pass has ended
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(service.list({ kind: 'inbox' })).toEqual([])
    expect(store.uids(ME, '@all').size).toBe(0)
    expect([store.holdFrom(ME), store.boxState(ME, '@all')]).toEqual([null, null])
  })

  it('says what went wrong without showing what a server said', () => {
    expect(describeFailure({ authenticationFailed: true })).toContain('refused')
    expect(describeFailure(new Error('<b>server text</b>'))).toBe("Couldn't reach the mail server.")
    expect(describeFailure(new Error('<b>server text</b>'), 'Gmail')).toBe("Couldn't reach Gmail.")
  })

  it('reports a dropped connection and recovers on the next pass', async () => {
    await signedIn()
    gmail.dropNextConnection = true
    await service.syncAll()
    expect(service.accounts()[0]?.error).toBe("Couldn't reach Gmail.")
    await service.syncAll()
    expect(service.accounts()[0]?.error).toBeNull()
  })

  it('a password lost from the keyring is said, not retried', async () => {
    await signedIn()
    secrets.remove(`account:${ME}`)
    await service.syncAll()
    expect(service.accounts()[0]?.error).toContain('Add this account again')
  })
})

describe('a day of batches', () => {
  beforeEach(signedIn)

  const arrive = async (subject: string, hour: number, minute = 0, from?: string): Promise<void> => {
    gmail.add(rawMail({ subject, from }), { arrived: new Date(at(hour, minute)) })
    clock = at(hour, minute + 1)
    await service.syncAll()
  }

  it('holds until the slot, then lands and tells', async () => {
    await arrive('News', 10, 30)
    expect(service.overview()).toMatchObject({ held: 1, nextBatch: at(13) })
    expect(service.list({ kind: 'inbox' })).toEqual([])
    clock = at(12, 59)
    await service.tick()
    expect(landed).not.toHaveBeenCalled()
    clock = at(13, 0, 6) + 20_000
    await service.tick()
    expect(landed).toHaveBeenCalledWith(1)
    expect(service.list({ kind: 'inbox' }).map((r) => r.subject)).toEqual(['News'])
    await service.tick()
    expect(landed).toHaveBeenCalledTimes(1)
  })

  it('mail that arrived while the laptop was off is simply there', async () => {
    gmail.add(rawMail({ subject: 'Overnight' }), { arrived: new Date(at(10, 30)) })
    clock = at(8, 0, 7)
    await service.syncAll()
    expect(service.overview().held).toBe(0)
    expect(service.list({ kind: 'inbox' })).toHaveLength(1)
  })

  it('a VIP comes straight through', async () => {
    service.saveBatch({ ...service.settings().batch, vip: ['ada@example.com'] })
    await arrive('Urgent', 10, 30, 'Ada <ada@example.com>')
    expect(service.overview().held).toBe(0)
    expect(service.list({ kind: 'inbox' })).toHaveLength(1)
  })

  it('adding a VIP frees what they already sent', async () => {
    await arrive('Urgent', 10, 30, 'Ada <ada@example.com>')
    await arrive('Other', 10, 40, 'Bob <bob@example.com>')
    expect(service.overview().held).toBe(2)
    service.saveBatch({ ...service.settings().batch, vip: ['ada@example.com'] })
    expect(service.overview().held).toBe(1)
    expect(service.list({ kind: 'inbox' }).map((r) => r.subject)).toEqual(['Urgent'])
  })

  it('changing the times never delivers early', async () => {
    await arrive('News', 10, 30)
    clock = at(11)
    service.saveBatch({ ...service.settings().batch, live: false, times: ['10:45', '15:00'] }) // 10:45 has passed
    expect(service.overview()).toMatchObject({ held: 1, nextBatch: at(15) })
  })

  it('turning batches off lets everything through', async () => {
    await arrive('News', 10, 30)
    service.saveBatch({ ...service.settings().batch, times: [] })
    expect(service.overview()).toMatchObject({ held: 0, nextBatch: null })
    expect(service.list({ kind: 'inbox' })).toHaveLength(1)
  })

  it('opening a thread marks it read here only', async () => {
    gmail.add(rawMail({ subject: 'Read me' }), { arrived: new Date(at(9)), thread: 3n })
    await service.syncAll()
    expect(service.list({ kind: 'inbox' })[0]?.unread).toBe(1)
    service.thread(ME, '3')
    expect(service.list({ kind: 'inbox' })[0]?.unread).toBe(0)
    expect(gmail.writes()).toEqual([])
  })

  it('a thread read without marking it read stays unread, for a wait Settings ask for', async () => {
    gmail.add(rawMail({ subject: 'Read me later' }), { arrived: new Date(at(9)), thread: 3n })
    await service.syncAll()
    expect(service.thread(ME, '3', false, true, false).map((m) => [m.subject, m.seen])).toEqual([['Read me later', false]])
    expect(service.list({ kind: 'inbox' })[0]?.unread).toBe(1)
    service.thread(ME, '3')
    expect(service.list({ kind: 'inbox' })[0]?.unread).toBe(0)
    service.saveProfile({ readAfter: 7.4 })
    expect(service.settings().readAfter).toBe(7)
    service.saveProfile({ readAfter: -5 })
    expect(service.settings().readAfter).toBe(-1)
  })
})

describe('as it arrives', () => {
  beforeEach(signedIn)

  /** The app ticks every few seconds, so one has gone by when a sync finds the message. */
  const arrive = async (subject: string, hour: number, minute = 0, from?: string): Promise<void> => {
    gmail.add(rawMail({ subject, from }), { arrived: new Date(at(hour, minute)) })
    clock = at(hour, minute + 1)
    await service.tick()
    await service.syncAll()
  }
  const live = (on: boolean): void => service.saveBatch({ ...service.settings().batch, live: on })

  it('settings saved before there was a switch keep behaving as they did', () => {
    const saved = (batch: object): void => store.setMeta('settings', JSON.stringify({ ...service.settings(), batch }))
    saved({ times: ['09:00', '17:00'], vip: [], earlyPerDay: 1 })
    expect(service.settings().batch).toEqual({ live: false, times: ['09:00', '17:00'], vip: [], earlyPerDay: 1 })
    saved({ times: [], vip: [], earlyPerDay: 1 })
    expect(service.settings().batch.live).toBe(true)
    store.deleteMeta('settings')
    expect(service.settings().batch).toMatchObject({ live: false, times: ['09:00', '13:00', '17:00'] })
  })

  it('going live lets what was waiting through, keeps the times, and leaves no delivery to show', async () => {
    await arrive('News', 10, 30)
    expect(service.overview()).toMatchObject({ held: 1, nextBatch: at(13) })
    live(true)
    expect(service.overview()).toMatchObject({ held: 0, nextBatch: null })
    expect(service.list({ kind: 'inbox' }).map((r) => r.subject)).toEqual(['News'])
    expect(service.settings().batch).toMatchObject({ live: true, times: ['09:00', '13:00', '17:00'] })
  })

  it('live, new mail lands as it comes, while the Summary still waits for its time', async () => {
    live(true)
    service.saveSummary({ senders: ['news@shop.example'], every: 'daily', time: '18:00', day: 1, chosen: true })
    await arrive('Hello', 10, 30, 'Ada <ada@example.com>')
    await arrive('Deals', 10, 40, 'Shop News <news@shop.example>')
    expect(service.list({ kind: 'inbox' }).map((r) => r.subject)).toEqual(['Hello'])
    expect(landed).toHaveBeenCalledWith(1, expect.objectContaining({ from: 'Ada', subject: 'Hello' }))
    expect(service.overview()).toMatchObject({ held: 0, nextBatch: null, summary: { held: 1, next: at(18) } })
  })

  it('the notice for one new message says which thread it is, so clicking it can open that', async () => {
    live(true)
    await arrive('Hello', 10, 30, 'Ada <ada@example.com>')
    expect(landed).toHaveBeenCalledWith(1, { from: 'Ada', subject: 'Hello', account: ME, thread: ref('Hello').thread })
  })

  it('with notices for Focused only, mail sorted into Other arrives without one, as it comes or in a batch', async () => {
    const bulk = (subject: string, hour: number, minute: number): void => {
      gmail.add(rawMail({ subject, from: 'Deals <deals@shop.example>', headers: ['List-Unsubscribe: <https://shop.example/u>'] }), { arrived: new Date(at(hour, minute)) })
    }
    service.saveProfile({ focused: true, notifyFocusedOnly: true })
    live(true)
    bulk('Sale', 10, 30)
    clock = at(10, 31)
    await service.tick()
    await service.syncAll()
    expect(service.list({ kind: 'inbox', focus: 'other' }).map((r) => r.subject)).toEqual(['Sale'])
    expect(landed).not.toHaveBeenCalled()
    await arrive('Hello', 10, 40, 'Ada <ada@example.com>')
    expect(landed).toHaveBeenCalledTimes(1)
    expect(landed).toHaveBeenCalledWith(1, expect.objectContaining({ subject: 'Hello' }))

    landed.mockClear()
    live(false)
    bulk('Another sale', 11, 0)
    await arrive('Lunch', 11, 5, 'Bao <bao@example.com>')
    clock = at(13, 1)
    await service.tick()
    expect(landed).toHaveBeenCalledWith(1) // Lunch, and not the sale beside it
    // With Focused and Other off, there's no Other to keep quiet.
    landed.mockClear()
    service.saveProfile({ focused: false })
    bulk('Last sale', 13, 30)
    clock = at(13, 31)
    await service.tick()
    await service.syncAll()
    clock = at(17, 1)
    await service.tick()
    expect(landed).toHaveBeenCalledWith(1)
  })

  it('back in batches, only what comes next waits, at the times kept', async () => {
    live(true)
    await arrive('Early', 10, 30)
    live(false)
    await arrive('Later', 10, 40)
    expect(service.list({ kind: 'inbox' }).map((r) => r.subject)).toEqual(['Early'])
    expect(service.overview()).toMatchObject({ held: 1, nextBatch: at(13) })
  })
})

describe('delivering early', () => {
  beforeEach(async () => {
    await signedIn()
    gmail.add(rawMail({ subject: 'News' }), { arrived: new Date(at(10, 30)) })
    clock = at(10, 31)
    await service.syncAll()
  })

  it('makes you wait first', async () => {
    await expect(service.finishEarly()).rejects.toThrow('Not yet')
    expect(service.beginEarly()).toBe(30)
    clock += 29_000
    await expect(service.finishEarly()).rejects.toThrow('Not yet')
    expect(service.list({ kind: 'inbox' })).toEqual([])
    clock += 1_000
    expect(await service.finishEarly()).toBe(1)
    expect(service.list({ kind: 'inbox' })).toHaveLength(1)
  })

  it('counts per day and comes back tomorrow', async () => {
    service.beginEarly()
    clock += 30_000
    await service.finishEarly()
    expect(service.overview().earlyLeft).toBe(0)
    expect(() => service.beginEarly()).toThrow('None left')
    clock = at(8, 0, 7)
    expect(service.overview().earlyLeft).toBe(1)
  })

  it('a wait is good for one go', async () => {
    service.saveBatch({ ...service.settings().batch, earlyPerDay: 3 })
    service.beginEarly()
    clock += 30_000
    await service.finishEarly()
    await expect(service.finishEarly()).rejects.toThrow('Not yet')
  })

  it('finding nothing to deliver costs nothing', async () => {
    service.saveBatch({ ...service.settings().batch, times: [], earlyPerDay: 1 })
    service.beginEarly()
    clock += 30_000
    expect(await service.finishEarly()).toBe(0)
    expect(service.overview().earlyLeft).toBe(1)
  })
})

describe('the Summary', () => {
  beforeEach(signedIn)

  const NEWS = 'Shop News <news@shop.example>'
  const SUMMARY = { senders: ['news@shop.example'], every: 'daily' as const, time: '08:00', day: 1, chosen: true }
  const arrive = async (subject: string, hour: number, minute: number, from?: string, day = 6): Promise<void> => {
    gmail.add(rawMail({ subject, from, headers: from === NEWS ? ['List-Unsubscribe: <https://shop.example/u>'] : [] }), { arrived: new Date(at(hour, minute, day)) })
    clock = at(hour, minute + 1, day)
    await service.syncAll()
  }
  const subjects = (kind: 'inbox' | 'summary'): string[] => service.list({ kind }).map((row) => row.subject)

  it('holds its senders until its time, not the next batch, then lands them together and apart from the inbox', async () => {
    service.saveSummary(SUMMARY)
    await arrive('Weekend deals', 10, 30, NEWS)
    await arrive('Lunch?', 10, 40, 'Ada <ada@example.com>')
    expect(service.overview()).toMatchObject({ held: 1, nextBatch: at(13), summary: { held: 1, next: at(8, 0, 7), unread: 0, latest: null } })
    clock = at(13, 0) + 20_000
    await service.tick()
    expect(landed).toHaveBeenCalledWith(1)
    expect(summarized).not.toHaveBeenCalled()
    expect(subjects('inbox')).toEqual(['Lunch?'])
    expect(subjects('summary')).toEqual([])
    expect(service.list({ kind: 'search', text: 'weekend' })).toEqual([]) // waiting is waiting, as for a batch
    landed.mockClear()
    clock = at(8, 0, 7) + 20_000
    await service.tick()
    expect(summarized).toHaveBeenCalledWith(1, ['Shop News'])
    expect(landed).not.toHaveBeenCalled()
    expect(subjects('inbox')).toEqual(['Lunch?']) // kept apart from the inbox
    expect(service.list({ kind: 'summary' }).map((row) => [row.subject, row.summaryAt])).toEqual([['Weekend deals', at(8, 0, 7)]])
    expect(service.list({ kind: 'search', text: 'weekend' }).map((row) => row.subject)).toEqual(['Weekend deals'])
    expect(service.accounts()[0]?.unread).toBe(1) // Lunch? alone: the inbox's count leaves the Summary out
    expect(service.overview().summary).toMatchObject({ held: 0, unread: 1, latest: { at: at(8, 0, 7), unread: 1, senders: ['Shop News'] } })
    service.thread(ME, ref('Weekend deals', { kind: 'summary' }).thread)
    expect(service.overview().summary).toMatchObject({ unread: 0, latest: { at: at(8, 0, 7), unread: 0 } })
    await service.act([ref('Weekend deals', { kind: 'summary' })], { kind: 'archive' })
    expect(subjects('summary')).toEqual([]) // put away like anything else
    expect(gmail.writes().some((command) => /summary/i.test(command))).toBe(false)
  })

  it('gathers each Summary together, the last to land first, with a weekly one landing on its day', async () => {
    service.saveSummary({ ...SUMMARY, every: 'weekly', day: 1 }) // Mondays; the 6th is a Friday
    await arrive('First letter', 10, 30, NEWS)
    await arrive('Second letter', 11, 0, NEWS)
    clock = at(8, 0, 8)
    await service.tick()
    expect(subjects('summary')).toEqual([])
    clock = at(8, 0, 9) + 1000
    await service.tick()
    expect(summarized).toHaveBeenCalledWith(2, ['Shop News'])
    await arrive('Third letter', 9, 0, NEWS, 9)
    clock = at(8, 0, 16) + 1000
    await service.tick()
    expect(service.list({ kind: 'summary' }).map((row) => [row.subject, row.summaryAt])).toEqual([
      ['Third letter', at(8, 0, 16)], ['Second letter', at(8, 0, 9)], ['First letter', at(8, 0, 9)]
    ])
  })

  it('stays waiting when the batch is delivered early or batches are turned off', async () => {
    service.saveSummary(SUMMARY)
    await arrive('Weekend deals', 10, 30, NEWS)
    await arrive('Lunch?', 10, 40, 'Ada <ada@example.com>')
    service.beginEarly()
    clock += 30_000
    expect(await service.finishEarly()).toBe(1)
    expect(service.overview().summary.held).toBe(1)
    await arrive('Later', 11, 0, 'Ada <ada@example.com>')
    service.saveBatch({ ...service.settings().batch, times: [] })
    expect(service.overview()).toMatchObject({ held: 0, summary: { held: 1 } })
    expect(subjects('inbox')).toEqual(['Later', 'Lunch?'])
  })

  it('takes in what a sender has waiting for a batch, gives it back when they leave, and lets go of it all when turned off', async () => {
    await arrive('Weekend deals', 10, 30, NEWS)
    expect(service.overview()).toMatchObject({ held: 1, summary: { held: 0, next: null } })
    service.saveSummary(SUMMARY)
    expect(service.overview()).toMatchObject({ held: 0, summary: { held: 1, next: at(8, 0, 7) } })
    service.saveSummary({ ...SUMMARY, senders: [] })
    expect(service.overview()).toMatchObject({ held: 1, nextBatch: at(13), summary: { held: 0, next: null } })
    service.saveSummary(SUMMARY)
    service.saveSummary({ ...SUMMARY, time: '07:30' }) // a new time takes what's waiting with it
    expect(service.overview().summary).toMatchObject({ held: 1, next: at(7, 30, 7) })
    clock = at(7, 31, 7)
    expect(service.list({ kind: 'summary' }).map((row) => row.summaryAt)).toEqual([at(7, 30, 7)])
    await arrive('Midweek deals', 9, 0, NEWS, 7)
    service.saveSummary({ ...SUMMARY, senders: [], chosen: false }) // Turn off Summary
    expect(service.settings().summary).toMatchObject({ senders: [], chosen: false, time: '08:00' })
    expect(service.overview()).toMatchObject({ held: 1, nextBatch: at(13, 0, 7), summary: { held: 0 } })
  })

  it('and straight through pull opposite ways, so the newer choice wins', async () => {
    service.saveBatch({ ...service.settings().batch, vip: ['news@shop.example', '@shop.example'] })
    service.saveSummary(SUMMARY)
    expect(service.settings().batch.vip).toEqual(['@shop.example']) // the address itself left; a whole domain is a choice for Settings
    await arrive('Weekend deals', 10, 30, NEWS)
    expect(service.overview().summary.held).toBe(1) // the Summary is the narrower choice, and the domain doesn't undo it
    service.saveBatch({ ...service.settings().batch, vip: ['@shop.example', 'news@shop.example'] })
    expect(service.settings().summary.senders).toEqual([])
    expect(subjects('inbox')).toEqual(['Weekend deals'])
  })

  it('announces nothing from a muted sender, and nothing found already landed as ordinary new mail', async () => {
    service.saveSummary({ ...SUMMARY, senders: ['news@shop.example', '@letters.example'] })
    service.saveProfile({ muted: ['news@shop.example'] })
    await arrive('Weekend deals', 10, 30, NEWS)
    await arrive('Letter', 10, 40, 'Letters <hi@letters.example>')
    clock = at(8, 0, 7) + 20_000
    await service.tick()
    expect(summarized).toHaveBeenCalledWith(1, ['Letters'])
    summarized.mockClear()
    // Found by a sync after its Summary has already landed, as when the laptop was off at the time.
    gmail.add(rawMail({ subject: 'Overnight letter', from: 'Letters <hi@letters.example>' }), { arrived: new Date(at(9, 0, 7)) })
    clock = at(9, 0, 8)
    await service.tick()
    await service.syncAll()
    expect(landed).not.toHaveBeenCalled()
    expect(summarized).toHaveBeenCalledWith(1, ['Letters'])
    expect(service.list({ kind: 'summary' }).map((row) => [row.subject, row.summaryAt])[0]).toEqual(['Overnight letter', at(8, 0, 8)])
  })

  it('holds what a sync stores by the rules as they are by then, not as they were when it began', async () => {
    service.saveBatch({ ...service.settings().batch, live: false, times: ['09:00', '13:00', '17:00'] })
    gmail.add(rawMail({ subject: 'Fresh deals', from: NEWS, headers: ['List-Unsubscribe: <https://shop.example/u>'] }), { arrived: new Date(at(10, 30)) })
    clock = at(10, 31)
    // The sender goes into the Summary while the sync is signing in, after it has begun.
    const deps = (service as unknown as { deps: ServiceDeps }).deps
    const open = deps.openSource
    deps.openSource = (account, login) => {
      const source = open(account, login)
      const connect = source.connect.bind(source)
      source.connect = async () => {
        await connect()
        service.saveSummary(SUMMARY)
      }
      return source
    }
    await service.syncAll()
    expect(service.overview().summary.held).toBe(1) // not held for the 13:00 batch
    expect(service.overview().held).toBe(0)
  })

  it('has a side of Subscriptions to itself', async () => {
    service.saveBatch({ ...service.settings().batch, times: [] })
    await arrive('Deals', 9, 0, NEWS)
    await arrive('More deals', 9, 10, NEWS)
    expect(service.subscriptions().map((s) => [s.address, s.count])).toEqual([['news@shop.example', 2]])
    expect(service.summarySenders()).toEqual([])
    service.saveSummary({ ...SUMMARY, senders: ['NEWS@shop.example', 'gone@else.example', 'news@shop.example', 'nonsense'] })
    expect(service.settings().summary.senders).toEqual(['news@shop.example', 'gone@else.example'])
    expect(service.subscriptions()).toEqual([])
    expect(service.summarySenders().map((s) => [s.address, s.count])).toEqual([['news@shop.example', 2], ['gone@else.example', 0]])
    expect(subjects('inbox')).toEqual(['More deals', 'Deals']) // what came before it was in the Summary stays where it was
  })

  it('says how much each sender sends and how much of it is read, and gives each a page of their threads', async () => {
    service.saveBatch({ ...service.settings().batch, times: [] })
    await arrive('Old deals', 9, 0, NEWS, -2) // more than a week before the rest
    await arrive('Deals', 9, 0, NEWS)
    await arrive('More deals', 9, 10, NEWS)
    await arrive('Lunch?', 9, 20)
    service.thread(ME, ref('Deals').thread) // read one
    const [news] = service.subscriptions()
    expect(news).toMatchObject({ address: 'news@shop.example', count: 3, read: 1, week: 2 })
    expect(service.sender(ME, 'NEWS@shop.example')).toMatchObject({ count: 3, read: 1, week: 2, name: 'Shop News' })
    expect(service.sender(ME, 'nobody@else.example')).toBeNull()
    expect(service.list({ kind: 'from', account: ME, address: 'news@shop.example' }).map((r) => r.subject)).toEqual(['More deals', 'Deals', 'Old deals'])
    service.act([ref('More deals')], { kind: 'archive' }) // archived, it's still theirs; in Trash, it isn't
    service.act([ref('Old deals')], { kind: 'trash' })
    expect(service.list({ kind: 'from', account: ME, address: 'news@shop.example' }).map((r) => r.subject)).toEqual(['More deals', 'Deals'])
    expect(service.sender(ME, 'news@shop.example')).toMatchObject({ count: 2, read: 1 })
  })
})

describe('xrnhub', () => {
  const sent = (): Array<{ app: string; kind: string; value: number; detail: { held: number; nextBatch: number } }> =>
    post.mock.calls.flatMap((call) => JSON.parse(call[1].body).events)

  beforeEach(async () => {
    await signedIn()
    await service.connectHub('https://hub.example/xrnhub/', 'alex', 'hub-secret')
    post.mockClear()
  })

  it('checks the login first and never over plain http', async () => {
    await expect(service.connectHub('http://hub.example', 'alex', 'x')).rejects.toThrow('https')
    post.mockResolvedValueOnce({ ok: false })
    await expect(service.connectHub('https://hub.example', 'alex', 'bad')).rejects.toThrow("didn't accept")
  })

  it('sends counts and times, and nothing about the mail', async () => {
    gmail.add(rawMail({ subject: 'Private subject', from: 'Secret Sender <secret@sender.example>', text: 'private body' }),
      { arrived: new Date(at(10, 30)) })
    clock = at(10, 31)
    await service.syncAll()
    expect(sent()).toEqual([expect.objectContaining({ app: 'xrnmail', kind: 'state.held', value: 1, detail: { held: 1, nextBatch: at(13) } })])
    const everything = JSON.stringify(post.mock.calls)
    for (const word of ['Private', 'private', 'Secret', 'secret@', ME]) expect(everything).not.toContain(word)
  })

  it('reports a batch landing', async () => {
    gmail.add(rawMail({ subject: 'A' }), { arrived: new Date(at(10, 30)) })
    clock = at(10, 31)
    await service.syncAll()
    post.mockClear()
    clock = at(13, 0, 6) + 1000
    await service.tick()
    expect(sent()).toEqual([expect.objectContaining({ kind: 'batch', value: 1 })])
    expect(sent()[0]?.detail.held).toBe(0)
  })

  it('going live says nothing waits and no batch is due, and live mail is no batch', async () => {
    gmail.add(rawMail({ subject: 'A' }), { arrived: new Date(at(10, 30)) })
    clock = at(10, 31)
    await service.syncAll()
    post.mockClear()
    service.saveBatch({ ...service.settings().batch, live: true })
    await eventually(() => expect(sent()).toEqual([expect.objectContaining({ kind: 'state.held', value: 0, detail: { held: 0, nextBatch: null } })]))
    await service.tick() // what was waiting landed when the switch was made
    post.mockClear()
    gmail.add(rawMail({ subject: 'B' }), { arrived: new Date(at(10, 35)) })
    clock = at(10, 36)
    await service.syncAll()
    await service.tick()
    expect(sent().filter((event) => event.kind === 'batch' || event.value !== 0)).toEqual([])
  })

  it('says nothing when the count has not moved', async () => {
    await service.syncAll()
    await service.syncAll()
    expect(post.mock.calls.length).toBeLessThanOrEqual(1)
  })

  it('never follows a redirect, which would carry the password away', async () => {
    await service.syncAll()
    gmail.add(rawMail({ subject: 'A' }), { arrived: new Date(at(10, 30)) })
    clock = at(10, 31)
    await service.syncAll()
    expect(post.mock.lastCall?.[1].redirect).toBe('error')
  })

  it('a hub that is down changes nothing here', async () => {
    post.mockRejectedValue(new Error('down'))
    gmail.add(rawMail({ subject: 'A' }), { arrived: new Date(at(10, 30)) })
    clock = at(10, 31)
    await service.syncAll()
    expect(service.overview().held).toBe(1)
    expect(service.accounts()[0]?.error).toBeNull()
  })

  it('disconnecting forgets the password', () => {
    service.disconnectHub()
    expect(secrets.get('hub')).toBeNull()
    expect(service.settings().hub).toEqual({ url: '', user: '', connected: false })
  })
})

describe('settings', () => {
  it('cleans what it is given', () => {
    expect(cleanBatch({ live: false, times: ['17:00', '09:00', '09:00', 'noon'], vip: [' Boss@Work.com ', 'nonsense', ''], earlyPerDay: 99 }))
      .toEqual({ live: false, times: ['09:00', '17:00'], vip: ['boss@work.com'], earlyPerDay: 5 })
    // Batches need a time to land at.
    expect(cleanBatch({ live: false, times: ['noon'], vip: [], earlyPerDay: 1 })).toMatchObject({ live: true, times: [] })
  })

  it('survives a restart', () => {
    service.saveBatch({ live: false, times: ['08:00'], vip: [], earlyPerDay: 2 })
    expect(make().settings().batch).toEqual({ live: false, times: ['08:00'], vip: [], earlyPerDay: 2 })
  })
})

describe('urls', () => {
  it('only hands safe links to the system', () => {
    expect(['https://a.b', 'http://a.b', 'mailto:a@b.c'].every(isSafeExternalUrl)).toBe(true)
    expect(['file:///etc/passwd', 'smb://x/y', 'javascript:alert(1)', 'not a url', ''].some(isSafeExternalUrl)).toBe(false)
  })

  it('keeps hub logins on https or this machine', () => {
    expect(['https://a.b/xrnhub', 'http://127.0.0.1:5238'].every(isSafeHubUrl)).toBe(true)
    expect(['http://a.b', 'https://user:x@a.b', 'ftp://a.b'].some(isSafeHubUrl)).toBe(false)
  })

  it('builds Gmail addresses in hex', () => {
    expect(gmailThreadUrl('me@x.com', '255')).toBe('https://mail.google.com/mail/?authuser=me%40x.com#all/ff')
  })
})

const ids = (): string[] => service.list({ kind: 'inbox' }).map((r) => r.subject)
const ref = (subject: string, query: Parameters<MailService['list']>[0] = { kind: 'inbox' }): { account: string; thread: string } => {
  const row = service.list(query).find((r) => r.subject === subject)
  if (!row) throw new Error(`no thread called ${subject}`)
  return { account: row.account, thread: row.thread }
}
const past = (hours: number): Date => new Date(clock - hours * 3_600_000)
const later = async (ms: number): Promise<void> => {
  clock += ms
  await service.tick()
}

describe('changing mail', () => {
  beforeEach(signedIn)

  /** Two messages from before the account was added, so neither is held. */
  beforeEach(async () => {
    gmail.add(rawMail({ subject: 'One' }), { arrived: past(30) })
    gmail.add(rawMail({ subject: 'Two' }), { arrived: past(20) })
    await service.syncAll()
  })

  const fakeMail = (subject: string): NonNullable<ReturnType<typeof gmail.mails.find>> => {
    const mail = gmail.mails.find((m) => m.raw.toString().includes(`Subject: ${subject}`))
    if (!mail) throw new Error(`Gmail has no ${subject}`)
    return mail
  }

  it('archiving leaves the inbox at once and reaches Gmail after Undo has had its chance', async () => {
    service.act([ref('One')], { kind: 'archive' })
    expect(ids()).toEqual(['Two'])
    await later(1000)
    expect(fakeMail('One').labels).toContain('\\Inbox')
    await later(UNDO_MS)
    expect(fakeMail('One').labels).not.toContain('\\Inbox')
    await service.syncAll()
    expect(ids()).toEqual(['Two'])
  })

  it('Undo lasts as long as Settings say, and the change waits that long before it reaches Gmail', async () => {
    expect(service.settings().undoActionSeconds).toBe(5) // as it always was
    service.saveProfile({ undoActionSeconds: 20 })
    expect(service.settings().undoActionSeconds).toBe(20)
    const token = service.act([ref('One')], { kind: 'archive' })
    await later(UNDO_MS + 1000)
    expect(fakeMail('One').labels).toContain('\\Inbox') // still Undo's to call back
    service.undo(token)
    service.act([ref('Two')], { kind: 'archive' })
    await later(19_000)
    expect(fakeMail('Two').labels).toContain('\\Inbox')
    await later(3000)
    expect(fakeMail('Two').labels).not.toContain('\\Inbox')
    expect(fakeMail('One').labels).toContain('\\Inbox')
    service.saveProfile({ undoActionSeconds: 99 })
    expect(service.settings().undoActionSeconds).toBe(30)
    service.saveProfile({ undoActionSeconds: 0 })
    expect(service.settings().undoActionSeconds).toBe(1)
  })

  it('undo puts it back and Gmail never hears about it', async () => {
    const token = service.act([ref('One')], { kind: 'archive' })
    service.undo(token)
    expect(ids().sort()).toEqual(['One', 'Two'])
    await later(UNDO_MS + 1000)
    expect(fakeMail('One').labels).toContain('\\Inbox')
    expect(gmail.writes().filter((c) => c.includes('STORE'))).toEqual([])
  })

  // "Labelled Receipts", "Marked as read" and "Moved to Inbox" offered Undo for changes that went to
  // Gmail at once, and only a change still waiting can be called back: Undo put the mail back here,
  // the server kept it as changed, and the next sync changed it here again.
  it('a change offered with Undo waits for it, whatever it is, and Undo calls it back before Gmail hears', async () => {
    const labelled = service.act([ref('One')], { kind: 'label', label: 'Receipts', add: true }, true)
    const read = service.act([ref('Two')], { kind: 'read' }, true)
    await later(1000)
    expect(fakeMail('One').labels).not.toContain('Receipts')
    service.undo(labelled)
    service.undo(read)
    await later(UNDO_MS)
    await service.syncAll()
    expect(fakeMail('One').labels).not.toContain('Receipts')
    expect(fakeMail('Two').flags).not.toContain('\\Seen')
    expect(service.list({ kind: 'inbox' }).find((r) => r.subject === 'Two')?.unread).toBe(1)
    expect(gmail.writes().filter((c) => c.includes('STORE'))).toEqual([])
    service.act([ref('One')], { kind: 'label', label: 'Receipts', add: true }, true)
    await later(UNDO_MS - 1000)
    expect(fakeMail('One').labels).not.toContain('Receipts')
    await later(1000)
    await eventually(() => expect(fakeMail('One').labels).toContain('Receipts'))
  })

  // Undo pressed while the change was already on its way put the mail back here, and the server
  // made the change anyway: the inbox showed it until a later sync took it out again.
  it('undo once the change is on its way to Gmail leaves the mail where Gmail will have it', async () => {
    const token = service.act([ref('One')], { kind: 'archive' })
    gmail.hold = /^UID STORE$/
    const going = later(UNDO_MS + 1000)
    await eventually(() => expect(gmail.holding).toHaveLength(1))
    service.undo(token)
    gmail.release()
    await going
    expect(fakeMail('One').labels).not.toContain('\\Inbox')
    expect(ids()).toEqual(['Two'])
    expect(service.accounts()[0]?.error).toBe('Too late to undo')
  })

  it('delete moves to Trash, and the mail is gone from here', async () => {
    const thread = ref('One')
    service.act([thread], { kind: 'trash' })
    expect(ids()).toEqual(['Two'])
    expect(service.list({ kind: 'all' }).map((r) => r.subject)).toEqual(['Two'])
    expect(service.thread(thread.account, thread.thread)).toEqual([])
    await later(UNDO_MS + 1000)
    expect(gmail.moved.map((m) => m.to)).toEqual(['[Gmail]/Trash'])
    await service.syncAll()
    expect(ids()).toEqual(['Two'])
  })

  it('spam goes to the spam folder', async () => {
    service.act([ref('One')], { kind: 'spam' })
    await later(UNDO_MS + 1000)
    expect(gmail.moved.map((m) => m.to)).toEqual(['[Gmail]/Spam'])
  })

  it('opening a thread marks it read in Gmail too, without marking anything else', async () => {
    expect(service.list({ kind: 'inbox' }).find((r) => r.subject === 'One')?.unread).toBe(1)
    const thread = ref('One')
    service.thread(thread.account, thread.thread)
    await eventually(() => expect(fakeMail('One').flags).toContain('\\Seen'))
    expect(fakeMail('Two').flags).not.toContain('\\Seen')
  })

  it('stars, marks unread and labels', async () => {
    const thread = ref('One')
    service.act([thread], { kind: 'star' })
    await eventually(() => expect(fakeMail('One').flags).toContain('\\Flagged'))
    expect(service.list({ kind: 'starred' }).map((r) => r.subject)).toEqual(['One'])
    service.thread(thread.account, thread.thread)
    await eventually(() => expect(fakeMail('One').flags).toContain('\\Seen'))
    service.act([thread], { kind: 'unread' })
    await eventually(() => expect(fakeMail('One').flags).not.toContain('\\Seen'))
    service.act([thread], { kind: 'label', label: 'Work', add: true })
    await eventually(() => expect(fakeMail('One').labels).toContain('Work'))
    expect(service.overview().labels).toEqual([{ account: ME, label: 'Work', count: 1 }])
  })

  it('Gmail\'s importance shows on a thread, both ways, and marking it goes to Gmail as its label, offline too', async () => {
    gmail.add(rawMail({ subject: 'Matters' }), { arrived: past(10), labels: ['\\Inbox', '\\Important'] })
    await service.syncAll()
    const important = (subject: string): boolean | undefined => service.list({ kind: 'inbox' }).find((r) => r.subject === subject)?.important
    expect(important('Matters')).toBe(true)
    expect(important('One')).toBe(false)
    expect(service.overview().labels).toEqual([]) // it's Gmail's own, not one of yours
    // Marked on the phone, it shows here.
    gmail.change(fakeMail('Two').uid, ['\\Inbox', '\\Important'])
    await service.syncAll()
    expect(important('Two')).toBe(true)

    gmail.dropNextConnection = true
    service.act([ref('One')], { kind: 'label', label: '\\Important', add: true })
    service.act([ref('Matters')], { kind: 'label', label: '\\Important', add: false })
    expect(important('One')).toBe(true)
    expect(important('Matters')).toBe(false)
    await eventually(() => expect(service.accounts()[0]?.error).toBe("Couldn't reach Gmail."))
    expect(fakeMail('One').labels).not.toContain('\\Important') // not reached: it waits, and goes again
    await later(61_000)
    await eventually(() => expect(fakeMail('One').labels).toContain('\\Important'))
    await eventually(() => expect(fakeMail('Matters').labels).toEqual(['\\Inbox']))
    expect(important('One')).toBe(true)
  })

  it('never touches a held message in the thread', async () => {
    gmail.add(rawMail({ subject: 'One' }), { arrived: new Date(clock + 60_000), thread: fakeMail('One').thread })
    await later(120_000)
    await service.syncAll()
    expect(service.overview().held).toBe(1)
    service.act([ref('One')], { kind: 'archive' })
    await later(UNDO_MS + 1000)
    const [first, second] = gmail.mails.filter((m) => m.thread === fakeMail('One').thread)
    expect(first?.labels).not.toContain('\\Inbox')
    expect(second?.labels).toContain('\\Inbox')
  })

  it('a sync while a change waits does not bring the mail back', async () => {
    service.act([ref('One')], { kind: 'archive' })
    gmail.change(fakeMail('One').uid, ['\\Inbox', 'Other'])
    await service.syncAll()
    expect(ids()).toEqual(['Two'])
  })

  it('keeps a change through being offline and a restart, then does it', async () => {
    service.act([ref('One')], { kind: 'archive' })
    gmail.dropNextConnection = true
    await later(UNDO_MS + 1000)
    expect(fakeMail('One').labels).toContain('\\Inbox')
    expect(service.accounts()[0]?.error).toBe("Couldn't reach Gmail.")
    service = make()
    await later(61_000)
    expect(fakeMail('One').labels).not.toContain('\\Inbox')
    expect(ids()).toEqual(['Two'])
  })

  it('a change Gmail keeps refusing is put back and said', async () => {
    service.act([ref('One')], { kind: 'archive' })
    gmail.refuseWrites = true
    await later(UNDO_MS + 1000)
    expect(ids()).toEqual(['Two'])
    await later(61_000)
    await later(61_000)
    expect(ids().sort()).toEqual(['One', 'Two'])
    expect(service.accounts()[0]?.error).toBe("Gmail wouldn't make a change, so it's been put back.")
  })

  it('syncing alone still writes nothing', async () => {
    const writes = gmail.writes().length
    gmail.add(rawMail({ subject: 'Three' }), { arrived: past(1) })
    await service.syncAll()
    await service.syncAll()
    expect(gmail.writes()).toHaveLength(writes)
  })
})

// A pass that connected and then heard nothing more sat for minutes, and while it sat the account
// counted as syncing, so every Sync now, timer and wake-up for it was turned away.
describe('a server that goes quiet', () => {
  beforeEach(async () => {
    timeouts = { connect: 1000, greeting: 600, quiet: 800 }
    service = make()
    gmail.add(rawMail({ subject: 'One' }), { arrived: past(30) })
    await signedIn()
  })

  const quietPass = async (): Promise<number> => {
    const started = Date.now()
    await service.syncAll()
    return Date.now() - started
  }

  it('a pass stopped partway gives up within its time, says so, and the next one goes', async () => {
    gmail.stall = /^LIST$/
    expect(await quietPass()).toBeLessThan(6000)
    expect(service.accounts()[0]).toMatchObject({ syncing: false, error: "Couldn't reach Gmail." })
    gmail.stall = null
    gmail.add(rawMail({ subject: 'After the quiet' }), { arrived: new Date(clock) })
    await service.syncAll()
    expect(service.accounts()[0]?.error).toBeNull()
    expect(service.list({ kind: 'all' }).map((r) => r.subject)).toContain('After the quiet')
  })

  it('a server that takes the connection and never says hello is given up on too', async () => {
    gmail.silent = true
    expect(await quietPass()).toBeLessThan(6000)
    expect(service.accounts()[0]).toMatchObject({ syncing: false, error: "Couldn't reach Gmail." })
    gmail.silent = false
    await service.syncAll()
    expect(service.accounts()[0]?.error).toBeNull()
  })

  it('a change waiting to go is kept through a quiet server, and goes once it answers', async () => {
    gmail.stall = /^UID STORE$/
    service.act([ref('One')], { kind: 'star' })
    await eventually(() => expect(service.accounts()[0]?.error).toBe("Couldn't reach Gmail."))
    // Not a refusal, which three of would put the change back: it waits to go again.
    expect((store as unknown as { all(sql: string): { attempts: number }[] }).all('SELECT attempts FROM pending').map((p) => p.attempts)).toEqual([0])
    gmail.stall = null
    await later(61_000)
    await eventually(() => expect(gmail.mails.find((m) => m.raw.toString().includes('Subject: One'))?.flags).toContain('\\Flagged'))
  })
})

describe('a search the server turns down', () => {
  beforeEach(signedIn)

  it('forgets nothing, loses no change, and announces nothing old as new', async () => {
    service.saveBatch({ ...service.settings().batch, times: [] })
    gmail.add(rawMail({ subject: 'Fresh' }), { arrived: new Date(at(10, 5)) })
    gmail.add(rawMail({ subject: 'Kept' }), { arrived: past(30) })
    clock = at(10, 6)
    await service.tick()
    await service.syncAll()
    expect(landed).toHaveBeenCalledTimes(1)
    landed.mockClear()
    service.act([ref('Fresh')], { kind: 'archive' })
    gmail.refuseSearch.add(gmail.allMail)
    await service.syncAll()
    expect(service.accounts()[0]?.error).toBe("Couldn't reach Gmail.")
    expect(service.list({ kind: 'all' }).map((r) => r.subject).sort()).toEqual(['Fresh', 'Kept'])
    gmail.refuseSearch.clear()
    await later(UNDO_MS)
    await service.syncAll()
    expect(gmail.mails.find((m) => m.raw.toString().includes('Subject: Fresh'))?.labels).not.toContain('\\Inbox')
    expect(ids()).toEqual(['Kept'])
    expect(landed).not.toHaveBeenCalled()
  })
})

describe('snoozing', () => {
  beforeEach(signedIn)

  beforeEach(async () => {
    gmail.add(rawMail({ subject: 'Later' }), { arrived: past(30) })
    await service.syncAll()
  })

  it('leaves the inbox, then comes back on top and tells', async () => {
    gmail.add(rawMail({ subject: 'Newer' }), { arrived: past(20) })
    await service.syncAll()
    service.snooze([ref('Later')], clock + 3_600_000)
    expect(ids()).toEqual(['Newer'])
    expect(service.list({ kind: 'snoozed' }).map((r) => r.subject)).toEqual(['Later'])
    await later(3_600_000 + 1000)
    expect(landed).toHaveBeenCalledWith(1)
    expect(ids()).toEqual(['Later', 'Newer'])
    expect(service.list({ kind: 'snoozed' })).toEqual([])
  })

  it('a new reply wakes it early', async () => {
    const thread = gmail.mails[0]?.thread
    service.snooze([ref('Later')], clock + 3_600_000 * 48)
    service.saveBatch({ ...service.settings().batch, times: [] })
    gmail.add(rawMail({ subject: 'Later' }), { arrived: new Date(clock + 60_000), thread })
    clock += 120_000
    await service.syncAll()
    expect(ids()).toEqual(['Later'])
  })

  it('archiving ends it', async () => {
    const thread = ref('Later')
    service.snooze([thread], clock + 3_600_000)
    service.act([thread], { kind: 'archive' })
    await later(3_600_000 + 1000)
    expect(ids()).toEqual([])
  })

  it('refuses the past', () => {
    expect(() => service.snooze([ref('Later')], clock - 1)).toThrow('Pick a time in the future.')
  })
})

describe('blocking', () => {
  beforeEach(signedIn)

  it('sends new mail from them to Trash, unseen', async () => {
    service.block('Spammer@Junk.example')
    gmail.add(rawMail({ subject: 'Buy', from: 'S <spammer@junk.example>' }), { arrived: new Date(clock + 60_000) })
    clock += 120_000
    await service.syncAll()
    expect(service.overview().held).toBe(0)
    await eventually(() => expect(gmail.moved.map((m) => m.to)).toEqual(['[Gmail]/Trash']))
    expect(landed).not.toHaveBeenCalled()
  })
})

describe('attachments', () => {
  beforeEach(signedIn)

  it('fetches the bytes when asked, without marking the mail read', async () => {
    gmail.add(rawMail({ subject: 'Notes', attachment: { name: 'notes.txt', type: 'text/plain', body: 'hello file' } }), { arrived: past(30) })
    await service.syncAll()
    const thread = ref('Notes')
    const [message] = store.thread(thread.account, thread.thread, clock)
    const found = await service.attachment(message?.id ?? 0, 0)
    expect(found.name).toBe('notes.txt')
    expect(found.content.toString()).toBe('hello file')
    expect(gmail.commands).not.toContain('TOUCHED-SEEN')
  })

  it('will not hand over one from a held message', async () => {
    gmail.add(rawMail({ subject: 'Held', attachment: { name: 'a.txt', type: 'text/plain', body: 'x' } }), { arrived: new Date(clock + 60_000) })
    clock += 120_000
    await service.syncAll()
    expect(service.overview().held).toBe(1)
    const id = Number(store['one']('SELECT id FROM messages WHERE subject = ?', 'Held')?.['id'])
    await expect(service.attachment(id, 0)).rejects.toThrow("That message isn't here any more.")
  })

  it('fetches a message as the server has it for View original, named for its subject, without reading it', async () => {
    const raw = rawMail({ subject: 'Notes / plans', headers: ['X-Mailer: Made Up 1.0'], attachment: { name: 'notes.txt', type: 'text/plain', body: 'hello file' } })
    gmail.add(raw, { arrived: past(30) })
    await service.syncAll()
    const thread = ref('Notes / plans')
    const [message] = store.thread(thread.account, thread.thread, clock)
    const found = await service.original(message?.id ?? 0)
    expect(found.name).toBe('Notes / plans.eml') // made safe for a file name where it's saved
    expect(found.bytes.toString().replace(/\r\n/g, '\n')).toBe(raw.replace(/\r\n/g, '\n'))
    expect(gmail.commands).not.toContain('TOUCHED-SEEN')
    await expect(service.original(123_456)).rejects.toThrow("That message isn't here any more.")
  })

  it('lists, opens and forwards every file of a message too big to keep whole', async () => {
    const files = ['a', 'b', 'c'].map((c) => ({ name: `${c}.pdf`, type: 'application/pdf', body: c.repeat(2.5 * 1024 * 1024) }))
    gmail.add(rawMail({ subject: 'Scans', attachments: files }), { arrived: past(30) })
    await service.syncAll()
    const thread = ref('Scans')
    const names = (): string[] => service.thread(thread.account, thread.thread)[0]?.attachments.map((a) => a.name) ?? []
    const [cut] = service.thread(thread.account, thread.thread)
    expect(cut?.truncated).toBe(true)
    expect(cut?.attachments.length).toBeLessThan(3) // all the part that was kept could say
    await eventually(() => expect(names()).toEqual(['a.pdf', 'b.pdf', 'c.pdf']))
    expect(service.thread(thread.account, thread.thread)[0]?.attachments.map((a) => a.size)).toEqual(files.map((f) => f.body.length))
    expect((await service.attachment(cut?.id ?? 0, 2)).content.equals(Buffer.from(files[2]?.body ?? ''))).toBe(true)
    const forward = await service.startDraft({ kind: 'forward', message: cut?.id ?? 0 })
    expect(forward.files.map((f) => f.name)).toEqual(['a.pdf', 'b.pdf', 'c.pdf'])
    expect(forward.error).toBeNull()
  })
})

describe('sending', () => {
  beforeEach(signedIn)

  const write = async (over: Partial<Draft> = {}): Promise<Draft> => {
    const draft = await service.startDraft({ kind: 'new' })
    const edit = { account: ME, from: '', to: 'ada@example.com', cc: '', bcc: '', subject: 'Hi', html: '<p>Hello</p>', text: 'Hello', quote: null, ...over }
    service.saveDraft(draft.id, edit)
    return { ...draft, ...edit }
  }

  it('waits out Undo, then sends and lands in Sent', async () => {
    const draft = await write()
    expect(service.send(draft.id)).toBe(clock + 10_000)
    await later(5000)
    expect(smtp.sent).toEqual([])
    await later(5000)
    expect(smtp.sent).toHaveLength(1)
    expect(smtp.sent[0]?.to).toEqual(['ada@example.com'])
    expect(smtp.sent[0]?.raw).toContain('Subject: Hi')
    expect(service.drafts()).toEqual([])
    expect(service.list({ kind: 'sent' }).map((r) => r.subject)).toEqual(['Hi'])
    expect(gmail.writes().filter((c) => /STORE|MOVE|APPEND/.test(c))).toEqual([])
  })

  it('undo sends nothing and gives the draft back', async () => {
    const draft = await write()
    service.send(draft.id)
    service.unsend(draft.id)
    await later(60_000)
    expect(smtp.sent).toEqual([])
    expect(service.drafts()[0]?.state).toBe('draft')
  })

  it('can wait for a time of your choosing, and that survives a restart', async () => {
    const draft = await write()
    service.send(draft.id, clock + 3_600_000)
    service = make()
    await later(3_000_000)
    expect(smtp.sent).toEqual([])
    await later(700_000)
    expect(smtp.sent).toHaveLength(1)
  })

  it('says what is wrong before queueing anything', async () => {
    const empty = await write({ to: '' })
    expect(() => service.send(empty.id)).toThrow('Add someone to send this to.')
    const bad = await write({ to: 'not an address' })
    expect(() => service.send(bad.id)).toThrow('Check this address')
    expect(service.drafts().every((d) => d.state === 'draft')).toBe(true)
  })

  it('tries again when it never reached the server', async () => {
    const draft = await write()
    await smtp.stop()
    service.send(draft.id)
    await later(10_000)
    expect(service.drafts()[0]).toMatchObject({ state: 'queued', error: 'Waiting for a connection.' })
    await smtp.listen(smtp.port)
    await later(61_000)
    expect(smtp.sent).toHaveLength(1)
  })

  it('says plainly that nothing went when an attachment has gone from the profile, not to check Sent', async () => {
    const draft = await write()
    const withFile = service.addFileBytes(draft.id, 'plan.txt', 'text/plain', Buffer.from('the plan'))
    rmSync(join(folder, String(draft.id)), { recursive: true, force: true })
    service.send(draft.id)
    await later(11_000)
    expect(smtp.sent).toEqual([])
    expect(service.drafts()[0]).toMatchObject({ id: draft.id, state: 'failed' })
    expect(service.drafts()[0]?.error).toContain('nothing was sent')
    expect(withFile.files).toHaveLength(1)
  })

  it('never retries once the message may have gone', async () => {
    const draft = await write()
    smtp.dropAfterData = true
    service.send(draft.id)
    await later(10_000)
    await later(120_000)
    expect(smtp.received).toBe(1)
    expect(service.drafts()[0]).toMatchObject({ state: 'failed', error: 'This may not have been sent. Check Sent before trying again.' })
  })

  // A send that failed marked its draft and said nothing else: no word beside the account, so with
  // the composer gone the only sign was a count by Drafts.
  it('a send that fails says so beside the account until its draft is sent or thrown away', async () => {
    const draft = await write()
    smtp.dropAfterData = true
    service.send(draft.id)
    await later(10_000)
    expect(service.drafts()[0]).toMatchObject({ id: draft.id, state: 'failed' })
    expect(service.accounts()[0]?.error).toBe(SEND_FAILED)
    smtp.dropAfterData = false
    service.send(draft.id)
    await later(10_000)
    expect(smtp.sent).toHaveLength(1)
    expect(service.accounts()[0]?.error).toBeNull()

    const other = await write({ subject: 'Plan' })
    service.addFileBytes(other.id, 'plan.txt', 'text/plain', Buffer.from('the plan'))
    rmSync(join(folder, String(other.id)), { recursive: true, force: true })
    service.send(other.id)
    await later(11_000)
    expect(service.accounts()[0]?.error).toBe(SEND_FAILED)
    service.discardDraft(other.id)
    expect(service.accounts()[0]?.error).toBeNull()
  })

  it('sends nothing called back, changed or thrown away while another message was going', async () => {
    const [first, second, third] = [await write({ subject: 'First' }), await write({ subject: 'Second' }), await write({ subject: 'Third' })]
    let release = (): void => undefined
    smtp.hold = new Promise((resolve) => (release = resolve))
    for (const draft of [first, second, third]) {
      service.send(draft.id)
      clock += 1
    }
    clock += 10_000
    const sending = service.tick()
    await eventually(() => expect(smtp.received).toBe(1)) // the first is with the server, and taking its time
    service.unsend(second.id)
    service.saveDraft(second.id, { account: ME, from: '', to: 'ada@example.com', cc: '', bcc: '', subject: 'Second, changed', html: 'x', text: 'x', quote: null })
    service.discardDraft(third.id)
    smtp.hold = null
    release()
    await sending
    expect(smtp.sent.map((m) => /^Subject: ([^\r\n]*)/m.exec(m.raw)?.[1])).toEqual(['First'])
    expect(service.drafts()).toMatchObject([{ id: second.id, state: 'draft', subject: 'Second, changed' }])
  })

  it('a send cut off by the app stopping comes back to be checked, not sent again', async () => {
    const draft = await write()
    store.saveDraft({ ...store.draft(draft.id)!, state: 'sending' })
    service = make()
    await later(60_000)
    expect(smtp.received).toBe(0)
    expect(service.drafts()[0]).toMatchObject({ state: 'failed', error: 'The app stopped while sending this. Check Sent before trying again.' })
  })

  it('waits for a keyring that is not open yet, and gives nothing up', async () => {
    const draft = await write()
    secrets.locked = true
    service.send(draft.id)
    await later(10_000)
    expect(service.drafts()[0]).toMatchObject({ state: 'queued', error: 'Waiting for the system keyring.' })
    await service.syncAll()
    expect(service.accounts()[0]?.error).toBe('Unlock your system keyring, then restart xrnmail.')
    secrets.locked = false
    await later(61_000)
    expect(smtp.sent).toHaveLength(1)
    expect(service.drafts()).toEqual([])
  })

  it('says a wrong password in fixed words', async () => {
    const draft = await write()
    smtp.secret = 'changed'
    service.send(draft.id)
    await later(10_000)
    expect(service.drafts()[0]).toMatchObject({ state: 'failed', error: 'The mail server refused this password.' })
  })

  it('a reply threads with the message it answers', async () => {
    gmail.add(rawMail({ subject: 'Question', from: 'Ada <ada@example.com>', headers: ['Reply-To: Desk <desk@example.com>', 'References: <older@example.com>'] }), { arrived: past(30) })
    await service.syncAll()
    const thread = ref('Question')
    const [message] = store.thread(thread.account, thread.thread, clock)
    const reply = await service.startDraft({ kind: 'reply', message: message?.id ?? 0 })
    expect(reply).toMatchObject({ to: '"Desk" <desk@example.com>', subject: 'Re: Question' })
    service.saveDraft(reply.id, { ...reply, html: 'Answer', text: 'Answer' })
    service.send(reply.id)
    await later(10_000)
    const raw = smtp.sent[0]?.raw ?? ''
    expect(raw).toMatch(/In-Reply-To: <\S+@example\.com>/)
    expect(raw).toMatch(/References: <older@example\.com> <\S+@example\.com>/)
    expect(raw).toContain('> Hi there')
  })

  it('a reply starts without the message it answers when Settings say so, and a forward always has it', async () => {
    gmail.add(rawMail({ subject: 'Lunch', from: 'Ada <ada@example.com>', to: `${ME}, Bao <bao@example.com>`, text: 'Pho or bun cha?' }), { arrived: past(30) })
    await service.syncAll()
    const thread = ref('Lunch')
    const [message] = store.thread(thread.account, thread.thread, clock)
    const id = message?.id ?? 0
    expect(service.settings().quoteReplies).toBe(true) // as it always was
    expect((await service.startDraft({ kind: 'reply', message: id })).quote).toMatchObject({ kind: 'reply', text: expect.stringContaining('Pho or bun cha?') })
    service.saveProfile({ quoteReplies: false })
    const reply = await service.startDraft({ kind: 'reply', message: id })
    expect(reply).toMatchObject({ to: '"Ada" <ada@example.com>', subject: 'Re: Lunch', quote: null })
    expect(reply.inReplyTo).toMatch(/@example\.com>$/) // still an answer to it, threaded with it
    expect((await service.startDraft({ kind: 'replyAll', message: id })).quote).toBeNull()
    expect((await service.startDraft({ kind: 'forward', message: id })).quote).toMatchObject({ kind: 'forward', text: expect.stringContaining('Pho or bun cha?') })
    service.saveDraft(reply.id, { ...reply, html: 'Bun cha', text: 'Bun cha' })
    service.send(reply.id)
    await later(10_000)
    expect(smtp.sent[0]?.raw).toContain('Bun cha')
    expect(smtp.sent[0]?.raw).not.toContain('Pho or bun cha?')
  })

  it('a forward carries the attachments', async () => {
    gmail.add(rawMail({ subject: 'Doc', attachment: { name: 'doc.txt', type: 'text/plain', body: 'contents' } }), { arrived: past(30) })
    await service.syncAll()
    const thread = ref('Doc')
    const [message] = store.thread(thread.account, thread.thread, clock)
    const forward = await service.startDraft({ kind: 'forward', message: message?.id ?? 0 })
    expect(forward.subject).toBe('Fwd: Doc')
    expect(forward.files.map((f) => f.name)).toEqual(['doc.txt'])
    service.saveDraft(forward.id, { ...forward, to: 'b@example.com' })
    service.send(forward.id)
    await later(10_000)
    expect(smtp.sent[0]?.raw).toContain('filename=doc.txt')
    expect(smtp.sent[0]?.raw).toContain(Buffer.from('contents').toString('base64'))
  })

  it('signs with the account identity', async () => {
    service.saveProfile({ identities: { [ME]: { name: 'Sơn', signature: 'Regards', aliases: [], color: '', notify: true } } })
    const draft = await write()
    service.send(draft.id)
    await later(10_000)
    expect(smtp.sent[0]?.raw).toContain('Regards')
    expect(smtp.sent[0]?.raw).toMatch(/From: =\?UTF-8\?.*<me@example\.com>/)
  })

  it('refuses attachments over what Gmail would take', async () => {
    const draft = await write()
    expect(() => service.addFileBytes(draft.id, 'big.bin', 'application/octet-stream', Buffer.alloc(20 * 1024 * 1024))).toThrow('18 MB')
    expect(service.drafts()[0]?.files).toEqual([])
  })

  // It was copied whole into the profile, on the main process, and only then found too big.
  it('measures a picked file before copying it in', async () => {
    const draft = await write()
    const big = join(folder, 'disk.iso')
    writeFileSync(big, '')
    truncateSync(big, 20 * 1024 * 1024)
    const copy = vi.spyOn(DraftFiles.prototype, 'fromDisk')
    expect(() => service.addFilesFromDisk(draft.id, [big])).toThrow('18 MB')
    expect(copy).not.toHaveBeenCalled()
    copy.mockRestore()
    expect(service.drafts()[0]?.files).toEqual([])
  })

  it('removing an account takes its drafts and identity', async () => {
    const draft = await write()
    service.saveProfile({ identities: { [ME]: { name: 'Me', signature: '', aliases: [], color: '', notify: true } } })
    service.addFileBytes(draft.id, 'a.txt', 'text/plain', Buffer.from('x'))
    service.removeAccount(ME)
    expect(service.drafts()).toEqual([])
    expect(service.settings().identities).toEqual({})
  })
})

describe('drafts on the server', () => {
  beforeEach(signedIn)

  const edit = { account: ME, from: '', to: 'ada@example.com', cc: '', bcc: '', subject: 'Plans', html: 'Hello', text: 'Hello', quote: null }
  const write = async (over: Partial<typeof edit> = {}): Promise<number> => {
    const draft = await service.startDraft({ kind: 'new' })
    service.saveDraft(draft.id, { ...edit, ...over })
    return draft.id
  }
  const appends = (): string[] => gmail.commands.filter((c) => c.startsWith('APPEND'))
  const onServer = (): string[] => gmail.drafts().map((raw) => /^Subject: (.*)$/m.exec(raw)?.[1]?.trim() ?? '')
  /** As the phone does: a draft saved there, as its own message. */
  const phone = (subject: string, text: string, headers: string[] = [], attachment?: { name: string; type: string; body: string }): number =>
    gmail.draft(rawMail({ from: ME, to: 'Ada <ada@example.com>', subject, text, headers, attachment }), { arrived: new Date(clock - 60_000) })

  it('goes up once it has been left alone a moment, not at every keystroke, and keeps out of the threads', async () => {
    const id = await write()
    await later(1000)
    service.saveDraft(id, { ...edit, text: 'Hello there', html: 'Hello there' })
    await later(3000) // still being written
    expect(appends()).toEqual([])
    await later(1500)
    expect(appends()).toHaveLength(1)
    expect(onServer()).toEqual(['Plans'])
    expect(gmail.drafts()[0]).toContain('Hello there')
    expect(gmail.draftBox.mails[0]?.flags).toEqual(['\\Draft', '\\Seen'])
    await later(10_000)
    expect(appends()).toHaveLength(1) // nothing changed since
    // Gmail has it in All Mail as well, as a draft, which stays out of every list.
    await service.syncAll()
    expect(service.list({ kind: 'all' }).map((r) => r.subject)).not.toContain('Plans')
    expect(service.drafts().map((d) => d.subject)).toEqual(['Plans'])
  })

  it('replaces its copy when it changes, deleting the old one for good, and goes up within a minute however long the typing lasts', async () => {
    const id = await write()
    await later(5000)
    for (let i = 0; i < 40; i++) {
      service.saveDraft(id, { ...edit, text: `Hello ${i}`, html: `Hello ${i}` })
      await later(2000)
    }
    expect(appends().length).toBeGreaterThanOrEqual(2) // the first, and one while the typing went on
    await later(5000)
    expect(gmail.drafts()).toHaveLength(1)
    expect(gmail.drafts()[0]).toContain('Hello 39')
    expect(gmail.box('[Gmail]/Trash').mails).toEqual([]) // moved there and deleted from there, not left for a month
  })

  it('leaves Drafts when it is sent, comes back with Undo, and is gone once it has gone', async () => {
    const id = await write()
    await later(5000)
    expect(onServer()).toEqual(['Plans'])
    service.send(id)
    await later(1000)
    expect(onServer()).toEqual([]) // on its way, so nothing else can send it too
    service.unsend(id)
    await later(5000)
    expect(onServer()).toEqual(['Plans'])
    service.send(id)
    await later(11_000)
    expect(smtp.sent).toHaveLength(1)
    expect(onServer()).toEqual([])
    expect(service.drafts()).toEqual([])
  })

  it('takes its copy away when it is thrown away, and waits for a connection to do it', async () => {
    const id = await write()
    await later(5000)
    gmail.dropNextConnection = true
    service.discardDraft(id)
    await later(1000)
    expect(onServer()).toEqual(['Plans']) // not reached
    service = make() // and a restart meanwhile
    await later(61_000)
    expect(onServer()).toEqual([])
  })

  // Discard draft took a draft and its copy on the server away at once, with no Undo and no word.
  it('a draft thrown away with Undo leaves Drafts at once, its copy only once Undo has had its time, and Undo gives it back', async () => {
    const id = await write()
    await later(5000)
    expect(onServer()).toEqual(['Plans'])
    service.discardDraft(id, true)
    expect(service.drafts()).toEqual([])
    await later(UNDO_MS - 1000)
    expect(onServer()).toEqual(['Plans'])
    service.undiscardDraft(id)
    expect(service.drafts().map((d) => d.subject)).toEqual(['Plans'])
    await later(UNDO_MS + 5000)
    expect(onServer()).toEqual(['Plans'])
    expect(service.drafts().map((d) => d.subject)).toEqual(['Plans'])

    service.discardDraft(id, true)
    await later(UNDO_MS - 1000)
    expect(onServer()).toEqual(['Plans'])
    await later(1000)
    await eventually(() => expect(onServer()).toEqual([]))
    expect(service.drafts()).toEqual([])
    expect(() => service.undiscardDraft(id)).toThrow('Too late')
  })

  it('a message waiting to go that is thrown away never goes, and Undo has it wait again', async () => {
    const id = await write()
    const when = service.send(id)
    service.discardDraft(id, true)
    await later(UNDO_MS + 5000)
    expect(smtp.sent).toEqual([])
    expect(service.drafts()).toEqual([])

    const other = await write({ subject: 'Later' })
    const at = service.send(other, clock + 3_600_000)
    service.discardDraft(other, true)
    await later(1000)
    service.undiscardDraft(other)
    expect(service.drafts()[0]).toMatchObject({ id: other, state: 'queued', sendAt: at })
    expect(when).toBeLessThan(at)
  })

  it('a draft thrown away while Undo lasts goes for good when the app closes', async () => {
    const id = await write()
    await later(5000)
    service.discardDraft(id, true)
    await service.finishUp()
    expect(onServer()).toEqual([])
    service = make()
    expect(service.drafts()).toEqual([])
  })

  it('works offline, and catches up once the server can be reached', async () => {
    gmail.dropNextConnection = true
    const id = await write()
    await later(5000)
    expect(onServer()).toEqual([])
    service.saveDraft(id, { ...edit, subject: 'Plans, again' })
    await later(61_000)
    expect(onServer()).toEqual(['Plans, again'])
  })

  it('takes nothing up that has nothing in it', async () => {
    await service.startDraft({ kind: 'new' })
    await later(70_000)
    expect(appends()).toEqual([])
  })

  it('carries its attachments, as sending would', async () => {
    const id = await write()
    service.addFileBytes(id, 'plan.txt', 'text/plain', Buffer.from('the plan'))
    await later(5000)
    expect(gmail.drafts()[0]).toContain('filename=plan.txt')
    expect(gmail.drafts()[0]).toContain(Buffer.from('the plan').toString('base64'))
  })

  it('brings in a draft written on the phone, which can be carried on and sent here', async () => {
    phone('From the phone', 'Count me in.\n\nOn Mon, Ada wrote:\n> Coming on Friday?', ['In-Reply-To: <friday@example.com>'], { name: 'map.txt', type: 'text/plain', body: 'turn left' })
    await service.syncAll()
    const [draft] = service.drafts()
    expect(draft).toMatchObject({ subject: 'From the phone', to: '"Ada" <ada@example.com>', text: 'Count me in.', from: '', inReplyTo: '<friday@example.com>', state: 'draft' })
    expect(draft?.quote).toMatchObject({ kind: 'reply', asIs: true, text: 'On Mon, Ada wrote:\n> Coming on Friday?' })
    expect(draft?.files.map((f) => [f.name, f.size])).toEqual([['map.txt', 9]])
    await service.syncAll()
    expect(service.drafts()).toHaveLength(1) // read once
    await later(70_000)
    expect(appends()).toEqual([]) // unchanged here, so nothing goes back up
    // Carried on here, it replaces the phone's copy, and goes as it was quoted.
    service.saveDraft(draft?.id ?? 0, { ...edit, to: draft?.to ?? '', subject: 'From the phone', text: 'Count me in. Bringing cake.', html: 'Count me in. Bringing cake.', quote: draft?.quote ?? null })
    await later(5000)
    expect(gmail.drafts()).toHaveLength(1)
    expect(gmail.drafts()[0]).toContain('Bringing cake')
    service.send(draft?.id ?? 0)
    await later(11_000)
    expect(smtp.sent[0]?.raw).toContain('Bringing cake.')
    expect(smtp.sent[0]?.raw).toContain('> Coming on Friday?')
    expect(smtp.sent[0]?.raw).not.toContain('> > Coming') // quoted once, not twice
    expect(smtp.sent[0]?.raw).toContain('filename=map.txt')
    expect(onServer()).toEqual([])
  })

  it('takes the phone\'s version of a draft that was not changed here, and goes when the phone sends it', async () => {
    const id = await write()
    await later(5000)
    const [ours] = gmail.draftBox.mails
    gmail.remove(ours?.uid ?? 0, gmail.draftBox.path) // the phone saving it again: the old copy goes...
    phone('Plans', 'Hello, from the bus') // ...and a new one comes
    await service.syncAll()
    expect(service.drafts().map((d) => d.text)).toEqual(['Hello, from the bus'])
    expect(service.drafts()[0]?.id).not.toBe(id)
    gmail.remove(gmail.draftBox.mails[0]?.uid ?? 0, gmail.draftBox.path) // sent from the phone
    await service.syncAll()
    expect(service.drafts()).toEqual([])
  })

  it('keeps both when a draft was changed here and on the phone, and keeps what was typed here when the phone threw it away', async () => {
    const id = await write()
    await later(5000)
    service.saveDraft(id, { ...edit, text: 'Hello from the laptop', html: 'Hello from the laptop' })
    gmail.remove(gmail.draftBox.mails[0]?.uid ?? 0, gmail.draftBox.path)
    phone('Plans', 'Hello from the phone')
    await service.syncAll()
    expect(service.drafts().map((d) => d.text).sort()).toEqual(['Hello from the laptop', 'Hello from the phone'])
    await later(5000)
    expect(gmail.drafts().map((raw) => /Hello from the \w+/.exec(raw)?.[0]).sort()).toEqual(['Hello from the laptop', 'Hello from the phone'])
    // Thrown away on the phone while it was being changed here: it stays, and goes up again.
    const laptop = service.drafts().find((d) => d.text === 'Hello from the laptop')
    service.saveDraft(laptop?.id ?? 0, { ...edit, text: 'Hello again', html: 'Hello again' })
    const copy = gmail.draftBox.mails.find((m) => m.raw.toString().includes('Hello from the laptop'))
    gmail.remove(copy?.uid ?? 0, gmail.draftBox.path)
    await service.syncAll()
    expect(service.drafts().map((d) => d.text)).toContain('Hello again')
    await later(5000)
    expect(gmail.drafts().some((raw) => raw.includes('Hello again'))).toBe(true)
  })

  it('leaves a draft that is open in a composer as it is, and settles it once it is let go', async () => {
    const id = await write()
    await later(5000)
    service.holdDraft(id, true)
    gmail.remove(gmail.draftBox.mails[0]?.uid ?? 0, gmail.draftBox.path)
    await service.syncAll()
    expect(service.drafts().map((d) => d.id)).toEqual([id])
    service.holdDraft(id, false)
    await service.syncAll()
    expect(service.drafts()).toEqual([])
  })

  it('finds its copies again by Message-ID when the Drafts folder is renumbered', async () => {
    const id = await write()
    await later(5000)
    gmail.draftBox.uidValidity = 9
    await service.syncAll()
    expect(service.drafts().map((d) => d.id)).toEqual([id]) // not brought in a second time
    service.saveDraft(id, { ...edit, subject: 'Plans, renumbered' })
    await later(5000)
    expect(onServer()).toEqual(['Plans, renumbered'])
  })

  it('reads the Drafts folder without changing anything there', async () => {
    phone('From the phone', 'Hi')
    gmail.commands = []
    await service.syncAll()
    expect(service.drafts()).toHaveLength(1)
    expect(gmail.writes()).toEqual([])
    expect(gmail.commands.some((c) => c.startsWith('EXAMINE') && c.includes('[Gmail]/Drafts'))).toBe(true)
  })

  it('leaves a draft with more attached than could be sent from here on the server, and fetches it once', async () => {
    phone('Huge', 'See attached', [], { name: 'big.bin', type: 'application/octet-stream', body: 'x'.repeat(20 * 1024 * 1024) })
    await service.syncAll()
    expect(service.drafts()).toEqual([])
    const before = gmail.commands.length
    await service.syncAll()
    expect(gmail.commands.slice(before).filter((c) => /BODY\.PEEK\[\]/.test(c))).toEqual([]) // not downloaded again
    expect(onServer()).toEqual(['Huge'])
  })

  it('leaves a draft saved before the keeping window began on the server', async () => {
    gmail.draft(rawMail({ from: ME, subject: 'Ancient', text: 'Old' }), { arrived: new Date(clock - 400 * 86_400_000) })
    await service.syncAll()
    expect(service.drafts()).toEqual([])
    expect(onServer()).toEqual(['Ancient'])
  })

  it('shows a message Gmail no longer has as a draft, as when the phone sends one it saved', async () => {
    const uid = gmail.add(rawMail({ from: ME, to: 'ada@example.com', subject: 'Was a draft' }), { arrived: past(1), labels: ['\\Draft'], flags: ['\\Seen'] })
    await service.syncAll()
    expect(service.list({ kind: 'all' }).map((r) => r.subject)).not.toContain('Was a draft')
    gmail.change(uid, ['\\Sent'], ['\\Seen'])
    await service.syncAll()
    expect(service.list({ kind: 'sent' }).map((r) => r.subject)).toContain('Was a draft')
  })
})

describe('unsubscribing', () => {
  beforeEach(signedIn)

  const arrived = async (headers: string[]): Promise<number> => {
    gmail.add(rawMail({ subject: 'List', headers }), { arrived: past(30) })
    await service.syncAll()
    const thread = ref('List')
    return store.thread(thread.account, thread.thread, clock)[0]?.id ?? 0
  }

  it('one click sends the fixed POST and nothing else', async () => {
    const id = await arrived(['List-Unsubscribe: <https://list.example/u/1>', 'List-Unsubscribe-Post: List-Unsubscribe=One-Click'])
    expect(await service.unsubscribe(id)).toEqual({ kind: 'done' })
    const [url, init] = post.mock.calls[0] ?? []
    expect(url).toBe('https://list.example/u/1')
    expect(init).toMatchObject({ method: 'POST', body: 'List-Unsubscribe=One-Click', redirect: 'error' })
    expect(JSON.stringify(init)).not.toContain('Authorization')
  })

  it('will not aim the request at this machine or its network', async () => {
    const id = await arrived(['List-Unsubscribe: <https://127.0.0.1/admin>', 'List-Unsubscribe-Post: List-Unsubscribe=One-Click'])
    expect(await service.unsubscribe(id)).toEqual({ kind: 'opened', url: 'https://127.0.0.1/admin' })
    expect(post).not.toHaveBeenCalled()
  })

  it('without one-click it opens the sender page', async () => {
    const id = await arrived(['List-Unsubscribe: <https://list.example/u/2>'])
    expect(await service.unsubscribe(id)).toEqual({ kind: 'opened', url: 'https://list.example/u/2' })
  })

  it('a mail-only sender gets a draft to look at, not a mail sent behind your back', async () => {
    const id = await arrived(['List-Unsubscribe: <mailto:off@list.example?subject=stop>'])
    const result = await service.unsubscribe(id)
    expect(result).toMatchObject({ kind: 'draft', draft: { to: 'off@list.example', subject: 'stop' } })
    expect(smtp.received).toBe(0)
  })

  it('ignores addresses it should not trust', () => {
    expect(parseUnsubscribe('<javascript:alert(1)>, <file:///etc/passwd>', '')).toBeNull()
  })
})

describe('finding people', () => {
  beforeEach(signedIn)

  it('offers senders, but never one known only from held mail', async () => {
    gmail.add(rawMail({ from: 'Ada Lovelace <ada@example.com>' }), { arrived: past(30) })
    gmail.add(rawMail({ from: 'Grace Hopper <grace@example.com>' }), { arrived: new Date(clock + 60_000) })
    clock += 120_000
    await service.syncAll()
    expect(service.contacts('ada')).toEqual([{ name: 'Ada Lovelace', address: 'ada@example.com' }])
    expect(service.contacts('grace')).toEqual([])
    expect(service.contacts('100%')).toEqual([])
  })
})

describe('straight-through mail tells you', () => {
  beforeEach(signedIn)

  it('notifies when a sync finds a VIP message that arrived a while ago', async () => {
    service.saveBatch({ ...service.settings().batch, vip: ['ada@example.com'] })
    clock = at(10, 30)
    await service.tick()
    gmail.add(rawMail({ subject: 'Urgent', from: 'Ada <ada@example.com>' }), { arrived: new Date(at(10, 31)) })
    clock = at(10, 33)
    await service.tick()
    await service.syncAll()
    clock += 3000
    await service.tick()
    expect(landed).toHaveBeenCalledWith(1, expect.objectContaining({ from: 'Ada', subject: 'Urgent' }))
    expect(landed).toHaveBeenCalledTimes(1)
  })

  it('says nothing about a muted sender, whose mail arrives all the same', async () => {
    service.saveBatch({ ...service.settings().batch, times: [] })
    service.saveProfile({ muted: [' Ada@Example.com ', '@shop.example', 'not an address'] })
    expect(service.settings().muted).toEqual(['ada@example.com', '@shop.example'])
    clock = at(10, 30)
    await service.tick()
    gmail.add(rawMail({ subject: 'Quiet', from: 'Ada <ada@example.com>' }), { arrived: new Date(at(10, 31)) })
    gmail.add(rawMail({ subject: 'Sale', from: 'Deals <deals@shop.example>' }), { arrived: new Date(at(10, 31)) })
    clock = at(10, 33)
    await service.tick()
    await service.syncAll()
    clock += 3000
    await service.tick()
    expect(landed).not.toHaveBeenCalled()
    expect(service.list({ kind: 'inbox' }).map((row) => [row.subject, row.unread]).sort()).toEqual([['Quiet', 1], ['Sale', 1]])
    gmail.add(rawMail({ subject: 'Loud', from: 'Bob <bob@example.com>' }), { arrived: new Date(at(10, 34)) })
    gmail.add(rawMail({ subject: 'Quiet again', from: 'Ada <ada@example.com>' }), { arrived: new Date(at(10, 34)) })
    clock = at(10, 36)
    await service.tick()
    await service.syncAll()
    expect(landed).toHaveBeenCalledWith(1, expect.objectContaining({ from: 'Bob', subject: 'Loud' })) // one of the two, and it's named
    expect(landed).toHaveBeenCalledTimes(1)
    landed.mockClear()
    service.saveProfile({ muted: [] })
    gmail.add(rawMail({ subject: 'Heard', from: 'Ada <ada@example.com>' }), { arrived: new Date(at(10, 37)) })
    clock = at(10, 39)
    await service.tick()
    await service.syncAll()
    expect(landed).toHaveBeenCalledWith(1, expect.objectContaining({ from: 'Ada', subject: 'Heard' }))
  })

  it('a delivery counts out what muted senders sent, and one of only theirs lands unannounced', async () => {
    service.saveProfile({ muted: ['ada@example.com'] })
    gmail.add(rawMail({ subject: 'Quiet', from: 'Ada <ada@example.com>' }), { arrived: new Date(at(10, 30)) })
    gmail.add(rawMail({ subject: 'News', from: 'Bob <bob@example.com>' }), { arrived: new Date(at(10, 30)) })
    clock = at(10, 31)
    await service.syncAll()
    expect(service.overview().held).toBe(2)
    clock = at(13, 0, 6) + 20_000
    await service.tick()
    expect(landed).toHaveBeenCalledWith(1)
    expect(landed).toHaveBeenCalledTimes(1)
    expect(service.list({ kind: 'inbox' }).map((row) => row.subject).sort()).toEqual(['News', 'Quiet'])
    landed.mockClear()
    changed.mockClear()
    gmail.add(rawMail({ subject: 'Quiet again', from: 'Ada <ada@example.com>' }), { arrived: new Date(at(13, 30)) })
    clock = at(13, 31)
    await service.syncAll()
    expect(service.overview().held).toBe(1)
    changed.mockClear()
    clock = service.overview().nextBatch! + 26_000
    await service.tick()
    expect(landed).not.toHaveBeenCalled()
    expect(changed).toHaveBeenCalled() // the list still has to show it
    expect(service.list({ kind: 'inbox' }).map((row) => row.subject)).toContain('Quiet again')
  })

  it('stays quiet about a message found just as its batch lands, then tells once', async () => {
    clock = at(12, 59) + 59_500
    await service.tick()
    gmail.add(rawMail({ subject: 'Slotted' }), { arrived: new Date(at(12, 59)) })
    clock = at(13) + 1000
    await service.syncAll()
    await service.tick()
    expect(landed).toHaveBeenCalledTimes(1)
  })

  it('stays quiet about old mail, your own and what was read elsewhere', async () => {
    service.saveBatch({ ...service.settings().batch, times: [] })
    gmail.add(rawMail({ subject: 'Mine', from: `Me <${ME}>` }), { arrived: new Date(clock + 1000) })
    gmail.add(rawMail({ subject: 'Read on my phone' }), { arrived: new Date(clock + 1000), flags: ['\\Seen'] })
    clock += 60_000
    await service.tick()
    await service.syncAll()
    expect(landed).not.toHaveBeenCalled()
  })
})

describe('the sidebar', () => {
  beforeEach(signedIn)

  const arrive = async (subject: string, hour: number, minute: number, options: { attachment?: boolean; from?: string } = {}): Promise<void> => {
    const attachment = options.attachment ? { name: 'plan.pdf', type: 'application/pdf', body: 'x' } : undefined
    gmail.add(rawMail({ subject, from: options.from, attachment }), { arrived: new Date(at(hour, minute)) })
    clock = at(hour, minute + 1)
    await service.syncAll()
  }

  const subjects = (kind: 'unread' | 'attachments' | 'today'): string[] => service.list({ kind }).map((row) => row.subject)

  it('Unread, Attachments and Today keep held mail out until it lands', async () => {
    await arrive('Held', 10, 30, { attachment: true })
    for (const kind of ['unread', 'attachments', 'today'] as const) expect(subjects(kind)).toEqual([])
    clock = at(13, 1)
    for (const kind of ['unread', 'attachments', 'today'] as const) expect(subjects(kind)).toEqual(['Held'])
  })

  it('Today counts what of it is unread, as Edison\'s sidebar does, and held mail once it lands', async () => {
    service.saveBatch({ ...service.settings().batch, times: [] })
    gmail.add(rawMail({ subject: 'Yesterday' }), { arrived: new Date(at(9, 0) - 86_400_000) })
    await arrive('Morning', 9, 0)
    await arrive('Later', 9, 5)
    expect(subjects('today')).toEqual(['Later', 'Morning'])
    expect(service.overview().today).toBe(2)
    service.thread(ME, ref('Morning').thread)
    expect(service.overview().today).toBe(1)
    service.saveBatch({ ...service.settings().batch, live: false, times: ['13:00'] })
    await arrive('Held', 10, 30)
    expect(service.overview().today).toBe(1)
    clock = at(13, 1)
    expect(service.overview().today).toBe(2)
  })

  it('Unread keeps the thread it is asked to keep once it has been read, read, and only that one', async () => {
    service.saveBatch({ ...service.settings().batch, times: [] })
    await arrive('First', 9, 0)
    await arrive('Second', 9, 5)
    await arrive('Third', 9, 10)
    const second = ref('Second')
    service.thread(ME, second.thread) // opened, so read
    service.thread(ME, ref('Third').thread)
    expect(subjects('unread')).toEqual(['First'])
    const kept = service.list({ kind: 'unread', keep: second })
    expect(kept.map((row) => [row.subject, row.unread])).toEqual([['Second', 0], ['First', 1]])
    expect(service.list({ kind: 'unread', account: ME, keep: second }).map((row) => row.subject)).toEqual(['Second', 'First'])
    expect(service.list({ kind: 'unread', account: 'someone@else.example', keep: second })).toEqual([])
  })

  it('Archive lists what was put away, and neither the inbox nor what you sent', async () => {
    service.saveBatch({ ...service.settings().batch, times: [] })
    await arrive('Keep in the inbox', 9, 0)
    await arrive('Put away', 9, 5)
    gmail.add(rawMail({ subject: 'Mine', from: `Me <${ME}>` }), { arrived: new Date(at(9, 10)), labels: ['\\Sent'] })
    clock = at(9, 11)
    await service.syncAll()
    await service.act([ref('Put away')], { kind: 'archive' })
    expect(service.list({ kind: 'archive' }).map((row) => row.subject)).toEqual(['Put away'])
    expect(service.list({ kind: 'archive', account: 'someone@else.example' })).toEqual([])
    expect(service.list({ kind: 'all' }).map((row) => row.subject).sort()).toEqual(['Keep in the inbox', 'Mine', 'Put away'])
  })

  it('Pinned gathers pinned threads from wherever they are, and tells the server nothing', async () => {
    service.saveBatch({ ...service.settings().batch, times: [] })
    await arrive('Keep', 9, 0)
    await arrive('Other', 9, 5)
    const before = JSON.stringify(gmail.mails.map((m) => [m.flags, m.labels]))
    service.pin([ref('Keep')], true)
    service.pin([ref('Keep')], true) // twice is once
    await service.syncAll()
    expect(JSON.stringify(gmail.mails.map((m) => [m.flags, m.labels]))).toBe(before)
    expect(service.list({ kind: 'pinned' }).map((row) => row.subject)).toEqual(['Keep'])
    expect(service.list({ kind: 'inbox' }).map((row) => [row.subject, row.pinned])).toEqual([['Other', false], ['Keep', true]]) // it stays in its place
    expect(service.thread(ME, ref('Keep').thread).map((m) => m.pinned)).toEqual([true])
    expect(service.thread(ME, ref('Other').thread).map((m) => m.pinned)).toEqual([false])
    expect(service.list({ kind: 'pinned', account: 'someone@else.example' })).toEqual([])
    const kept = ref('Keep')
    await service.act([kept], { kind: 'archive' })
    expect(service.list({ kind: 'pinned' }).map((row) => row.subject)).toEqual(['Keep']) // archived, still pinned
    await service.act([kept], { kind: 'trash' })
    expect(service.list({ kind: 'pinned' })).toEqual([]) // what's in Trash is in Trash
    await service.act([kept], { kind: 'inbox' })
    expect(service.list({ kind: 'pinned' }).map((row) => row.subject)).toEqual(['Keep'])
    service.pin([kept], false)
    expect(service.list({ kind: 'pinned' })).toEqual([])
    expect(service.list({ kind: 'inbox' }).every((row) => !row.pinned)).toBe(true)
  })

  it('removing an account forgets its pins', async () => {
    service.saveBatch({ ...service.settings().batch, times: [] })
    await arrive('Keep', 9, 0)
    const kept = ref('Keep')
    service.pin([kept], true)
    service.removeAccount(ME)
    await signedIn()
    expect(service.list({ kind: 'inbox' }).map((row) => [row.subject, row.pinned])).toEqual([['Keep', false]])
    expect(service.list({ kind: 'pinned' })).toEqual([])
  })

  it('Recently Seen lists what was opened, the last one first, wherever it is now', async () => {
    service.saveBatch({ ...service.settings().batch, times: [] })
    await arrive('First', 9, 0)
    await arrive('Second', 9, 5)
    await arrive('Third', 9, 10)
    const seen = (): string[] => service.list({ kind: 'recent' }).map((row) => row.subject)
    expect(seen()).toEqual([])
    service.thread(ME, ref('First').thread)
    clock += 1000
    service.thread(ME, ref('Third').thread)
    clock += 1000
    service.thread(ME, ref('Second').thread)
    expect(seen()).toEqual(['Second', 'Third', 'First'])
    service.thread(ME, ref('First').thread) // opened again in the same moment still goes to the top
    expect(seen()).toEqual(['First', 'Second', 'Third'])
    service.thread(ME, ref('Third').thread, false, false) // read from Recently Seen itself: the list keeps still
    expect(seen()).toEqual(['First', 'Second', 'Third'])
    await service.act([ref('Second')], { kind: 'archive' })
    await service.act([ref('First')], { kind: 'unread' })
    expect(service.list({ kind: 'recent' }).map((row) => [row.subject, row.unread])).toEqual([['First', 1], ['Second', 0], ['Third', 0]]) // archived and unread, as anywhere
    const thrown = ref('Third')
    await service.act([thrown], { kind: 'trash' })
    expect(seen()).toEqual(['First', 'Second']) // what's in Trash is in Trash
    await service.act([thrown], { kind: 'inbox' })
    expect(seen()).toEqual(['First', 'Second', 'Third'])
    expect(service.list({ kind: 'recent', account: 'someone@else.example' })).toEqual([])
    service.clearRecent()
    expect(seen()).toEqual([])
  })

  it('Recently Seen keeps the last hundred threads opened, never held mail, and forgets an account that goes', async () => {
    service.saveBatch({ ...service.settings().batch, times: [] })
    for (let i = 0; i < 102; i++) gmail.add(rawMail({ subject: `Thread ${i}` }), { arrived: new Date(at(8, 0) + i * 1000), thread: BigInt(500 + i) })
    clock = at(11)
    await service.syncAll()
    for (let i = 0; i < 102; i++) {
      clock += 1000
      service.thread(ME, String(500 + i))
    }
    const seen = service.list({ kind: 'recent' }, 500).map((row) => row.subject)
    expect(seen).toHaveLength(100)
    expect(seen[0]).toBe('Thread 101')
    expect(seen.at(-1)).toBe('Thread 2') // the two opened first have gone
    service.saveBatch({ ...service.settings().batch, live: false, times: ['13:00'] })
    gmail.add(rawMail({ subject: 'Held' }), { arrived: new Date(clock), thread: 900n })
    clock += 60_000
    await service.syncAll()
    expect(service.thread(ME, '900')).toEqual([]) // nothing to open yet, so nothing is seen
    clock = at(13, 1)
    expect(service.list({ kind: 'recent' }, 500).map((row) => row.subject)).not.toContain('Held')
    service.removeAccount(ME)
    await signedIn()
    expect(service.list({ kind: 'recent' }, 500)).toEqual([])
  })

  it('forgets how an account arranged its own labels once the account goes', () => {
    const other = { order: [], hidden: ['Old'] }
    service.saveProfile({ sidebar: { ...service.settings().sidebar, labels: { [ME]: { order: ['Work'], hidden: ['Work'] }, 'other@example.org': other } } })
    expect(Object.keys(service.settings().sidebar.labels ?? {})).toEqual([ME, 'other@example.org'])
    service.removeAccount(ME)
    expect(service.settings().sidebar.labels).toEqual({ 'other@example.org': other })
  })

  it('keeps which entries the sidebar shows and their order, made whole whatever was saved', () => {
    expect(service.settings().sidebar.hidden).toEqual([])
    expect(service.settings().sidebar.order.slice(0, 4)).toEqual(['today', 'unread', 'starred', 'pinned'])
    service.saveProfile({ sidebar: { order: ['sent', 'today', 'nonsense', 'sent'] as never, hidden: ['spam', 'spam', 'x'] as never } })
    const saved = service.settings().sidebar
    expect(saved.order.slice(0, 4)).toEqual(['sent', 'recent', 'today', 'unread'])
    expect(saved.hidden).toEqual(['spam'])
    expect(new Set(saved.order).size).toBe(18)
    service.saveProfile({ theme: 'dark' }) // another setting leaves it be
    expect(service.settings().sidebar).toEqual(saved)
    // As a version before Pinned would have saved it: Pinned turns up after Flagged, shown.
    const old = { ...service.settings(), sidebar: { order: saved.order.filter((entry) => entry !== 'pinned'), hidden: ['spam'] } }
    store.setMeta('settings', JSON.stringify(old))
    const read = service.settings().sidebar
    expect(read.order[read.order.indexOf('starred') + 1]).toBe('pinned')
    expect(read.hidden).toEqual(['spam'])
  })

  it('a row names its first three files, for the cards under it', async () => {
    service.saveBatch({ ...service.settings().batch, times: [] })
    const file = (name: string): { name: string; type: string; body: string } => ({ name, type: 'application/pdf', body: 'x' })
    gmail.add(rawMail({ subject: 'Four files', attachment: file('a.pdf'), attachments: [file('b.pdf'), file('c.pdf'), file('d.pdf')] }), { arrived: new Date(at(9, 0)) })
    gmail.add(rawMail({ subject: 'No files' }), { arrived: new Date(at(9, 1)) })
    clock = at(9, 5)
    await service.syncAll()
    const rows = service.list({ kind: 'inbox' })
    expect(rows.map((row) => [row.subject, row.cards, row.files])).toEqual([['No files', [], 0], ['Four files', ['a.pdf', 'b.pdf', 'c.pdf'], 4]])
    expect(service.settings().attachmentCards).toBe(true)
    service.saveProfile({ attachmentCards: false })
    expect(service.settings().attachmentCards).toBe(false)
  })

  it('Today starts at midnight', async () => {
    service.saveBatch({ ...service.settings().batch, times: [] })
    gmail.add(rawMail({ subject: 'Yesterday' }), { arrived: new Date(at(23, 0, 5)) })
    await arrive('This morning', 9, 0)
    expect(subjects('today')).toEqual(['This morning'])
  })

  it('a row names who is in the thread and what is attached, never someone held back', async () => {
    gmail.add(rawMail({ subject: 'Trip', from: 'Mai <mai@example.com>' }), { arrived: new Date(at(8)), thread: 5n })
    clock = at(8, 30)
    gmail.add(rawMail({ subject: 'Trip', from: 'Linh <linh@example.com>', attachment: { name: 'map.pdf', type: 'application/pdf', body: 'x' } }), { arrived: new Date(at(8, 10)), thread: 5n })
    service.saveBatch({ ...service.settings().batch, times: [] })
    await service.syncAll()
    service.saveBatch({ ...service.settings().batch, live: false, times: ['13:00'] })
    await arrive('Trip', 10, 30, { from: 'Hidden <hidden@example.com>' })
    const row = service.list({ kind: 'inbox' }).find((one) => one.subject === 'Trip')
    expect(row?.people.map((who) => who.address)).toEqual(expect.arrayContaining(['mai@example.com', 'linh@example.com']))
    expect(JSON.stringify(row)).not.toContain('hidden@example.com')
    expect(row).toMatchObject({ file: 'map.pdf', files: 1 })
  })

  it('counts Spam and what the Assistant found, without held mail', async () => {
    gmail.add(rawMail({ subject: 'Junk' }), { box: '[Gmail]/Spam', arrived: new Date(at(9)) })
    await service.syncAll()
    expect(service.overview().spam).toBe(1)
    await arrive('Your order has shipped', 10, 30)
    gmail.add(rawMail({ subject: 'Your order has shipped', text: 'Number 1Z999AA10123456784' }), { arrived: new Date(at(10, 40)) })
    clock = at(10, 41)
    await service.syncAll()
    expect(service.overview().assistant.packages).toBe(0)
    clock = at(13, 1)
    expect(service.overview().assistant.packages).toBe(1)
  })
})

describe('settings', () => {
  it('ignores what the page has no business setting', () => {
    const before = service.settings()
    service.saveProfile({ swipeLeft: 'explode' as never, swipeRight: 'explode' as never })
    expect(service.settings()).toMatchObject({ swipeLeft: before.swipeLeft, swipeRight: before.swipeRight })
  })

  it('keeps each set\'s own changed keys, made whole, and a set it has never heard of as Edison\'s', () => {
    expect(service.settings()).toMatchObject({ keys: 'edison', keyChanges: {} })
    service.saveProfile({ keys: 'outlook', keyChanges: { outlook: { archive: 'g', reply: 'Ctrl+N', bogus: 'x' } as never, edison: { flag: 'Ctrl+G' } } })
    expect(service.settings()).toMatchObject({ keys: 'outlook', keyChanges: { outlook: { archive: 'g' }, edison: { flag: 'Ctrl+G' } } })
    service.saveProfile({ keys: 'nonsense' as never })
    expect(service.settings().keys).toBe('outlook')
    service.saveProfile({ theme: 'dark' }) // another setting leaves them be
    expect(service.settings().keyChanges).toEqual({ outlook: { archive: 'g' }, edison: { flag: 'Ctrl+G' } })
    store.setMeta('settings', JSON.stringify({ ...service.settings(), keys: 'vim', keyChanges: undefined })) // as an older version would have it
    expect(service.settings()).toMatchObject({ keys: 'edison', keyChanges: {} })
  })

  it('starts a new profile with each inbox in one piece, and keeps the choice a profile has saved', () => {
    expect(service.settings().focused).toBe(false)
    service.saveProfile({ focused: true })
    expect(make().settings().focused).toBe(true)
    service.saveProfile({ focused: false })
    expect(make().settings().focused).toBe(false)
    // Older versions started with the split on and saved it with every other setting.
    store.setMeta('settings', JSON.stringify({ ...service.settings(), focused: true }))
    expect(service.settings().focused).toBe(true)
  })

  it('keeps the order of a thread\'s messages, oldest first to start with, and nothing else', () => {
    expect(service.settings().threadOrder).toBe('oldest')
    service.saveProfile({ threadOrder: 'newest' })
    expect(service.settings().threadOrder).toBe('newest')
    service.saveProfile({ threadOrder: 'sideways' as never })
    expect(service.settings().threadOrder).toBe('newest')
    service.saveProfile({ threadOrder: 'oldest' })
    expect(service.settings().threadOrder).toBe('oldest')
  })

  it('keeps the list\'s choices within what a row can show', () => {
    expect(service.settings()).toMatchObject({
      previewLines: 2, quickOn: true, quickActions: ['archive', 'flag', 'trash', 'read'],
      swipes: true, swipeLeft: 'archive', swipeLeftLong: 'star', swipeRight: 'read', swipeRightLong: 'trash'
    })
    service.saveProfile({ previewLines: 9, quickActions: ['snooze', 'explode' as never, 'spam', 'none', 'archive', 'trash'], swipeLeftLong: 'explode' as never })
    expect(service.settings()).toMatchObject({ previewLines: 4, quickActions: ['snooze', 'none', 'spam', 'none'], swipeLeftLong: 'star' })
    service.saveProfile({ previewLines: -3, quickActions: ['flag'], swipeRightLong: 'snooze', quickOn: false, swipes: false })
    expect(service.settings()).toMatchObject({
      previewLines: 0, quickActions: ['flag', 'none', 'none', 'none'], swipeRightLong: 'snooze', quickOn: false, swipes: false
    })
  })

  it('reads "compact" rows saved by an older version as one line of the message', () => {
    const saved = (settings: object): void => (service as unknown as { store: { setMeta(key: string, value: string): void } }).store.setMeta('settings', JSON.stringify(settings))
    saved({ density: 'compact' })
    expect(service.settings().previewLines).toBe(1)
    saved({ density: 'comfortable' })
    expect(service.settings().previewLines).toBe(2)
    saved({ density: 'compact', previewLines: 3 })
    expect(service.settings().previewLines).toBe(3)
  })

  it('keeps trusted senders tidy and in one case', () => {
    service.saveProfile({ imagesFrom: ['News@Shop.example', 'news@shop.example', 'not an address'] })
    expect(service.settings().imagesFrom).toEqual(['news@shop.example'])
  })

  it('changes only what a save names, so a page that is behind puts nothing back', () => {
    service.saveBatch({ live: false, times: ['09:00'], vip: ['boss@work.example'], earlyPerDay: 2 })
    service.saveBatch({ times: ['09:00', '17:00'] }) // from a page that never heard of the boss
    expect(service.settings().batch).toEqual({ live: false, times: ['09:00', '17:00'], vip: ['boss@work.example'], earlyPerDay: 2 })
    service.saveSummary({ senders: ['news@shop.example'], every: 'weekly', day: 3, time: '18:00', chosen: true })
    service.saveSummary({ time: '07:30' })
    expect(service.settings().summary).toEqual({ senders: ['news@shop.example'], every: 'weekly', day: 3, time: '07:30', chosen: true })
  })

  it('puts senders into a list one at a time, with the rest of it as it is then', () => {
    for (const list of ['muted', 'blocked', 'imagesFrom'] as const) {
      service.editSenders(list, ['Ada@Example.com'], true)
      service.editSenders(list, ['@shop.example', 'not an address'], true)
      service.editSenders(list, ['ada@example.com'], true) // already there
      expect(service.settings()[list]).toEqual(['ada@example.com', '@shop.example'])
      service.editSenders(list, ['ADA@example.com'], false)
      expect(service.settings()[list]).toEqual(['@shop.example'])
    }
    service.editSenders('vip', ['ada@example.com'], true)
    service.editSenders('summary', ['news@shop.example'], true)
    service.editSenders('summary', ['letters@post.example'], true)
    expect(service.settings().summary.senders).toEqual(['news@shop.example', 'letters@post.example'])
    expect(service.settings().batch.vip).toEqual(['ada@example.com'])
    service.editSenders('summary', ['ada@example.com'], true) // the Summary and straight through pull opposite ways
    expect(service.settings().batch.vip).toEqual([])
  })

  it('saves one account\'s identity without touching another\'s, and never one for an account that has gone', async () => {
    await signedIn()
    const mine = { name: 'Me', signature: 'Regards', aliases: [], color: '', notify: true }
    service.saveProfile({ identities: { [ME]: mine } })
    service.saveProfile({ identities: { 'gone@example.com': { ...mine, name: 'Gone' } } })
    expect(service.settings().identities).toEqual({ [ME]: mine })
    service.saveProfile({ theme: 'dark' })
    expect(service.settings().identities).toEqual({ [ME]: mine })
  })
})

describe('the first sync', () => {
  it('says how far it has got when there is a lot to fetch', async () => {
    for (let i = 0; i < 60; i++) gmail.add(rawMail({ subject: `Old ${i}` }), { arrived: new Date(at(8)) })
    const seen: { done: number; total: number }[] = []
    changed.mockImplementation(() => {
      const progress = service.accounts()[0]?.progress
      if (progress) seen.push(progress)
    })
    await signedIn()
    expect(seen.at(-1)?.total).toBe(60)
    expect(seen.at(-1)?.done).toBeLessThan(60)
    expect(service.accounts()[0]?.progress).toBeNull()
  })

  it('says nothing for a handful', async () => {
    gmail.add(rawMail({ subject: 'One' }), { arrived: new Date(at(8)) })
    const seen: unknown[] = []
    changed.mockImplementation(() => {
      const progress = service.accounts()[0]?.progress
      if (progress) seen.push(progress)
    })
    await signedIn()
    expect(seen).toEqual([])
  })
})

describe('new mail as it lands', () => {
  it('shows without waiting for the next pass, and never writes', async () => {
    await signedIn()
    service.saveBatch({ ...service.settings().batch, times: [] })
    service.watchAll()
    await eventually(() => expect(gmail.commands.some((line) => /\bIDLE\b/.test(line))).toBe(true))
    gmail.add(rawMail({ subject: 'Right now' }), { arrived: new Date(clock) })
    await eventually(() => expect(service.list({ kind: 'inbox' }).map((row) => row.subject)).toEqual(['Right now']))
    service.stopWatching()
    expect(gmail.writes()).toEqual([])
  })

  it('shows mail read, flagged, archived or deleted on another device, and keeps watching after each', async () => {
    gmail.add(rawMail({ subject: 'On the phone' }), { arrived: new Date(at(9)), thread: 41n })
    gmail.add(rawMail({ subject: 'Thrown away' }), { arrived: new Date(at(9)), thread: 42n })
    await signedIn()
    service.watchAll()
    await eventually(() => expect(gmail.idling).toBe(1))
    const row = (thread: string): { unread: number; starred: boolean } | undefined => service.list({ kind: 'inbox' }).find((r) => r.thread === thread)
    const [phone, thrown] = gmail.mails
    gmail.change(phone?.uid ?? 0, ['\\Inbox'], ['\\Seen'])
    await eventually(() => expect(row('41')?.unread).toBe(0))
    await eventually(() => expect(gmail.idling).toBe(1))
    gmail.change(phone?.uid ?? 0, ['\\Inbox'], ['\\Seen', '\\Flagged'])
    await eventually(() => expect(row('41')?.starred).toBe(true))
    gmail.change(phone?.uid ?? 0, [], ['\\Seen', '\\Flagged']) // archived: Gmail takes the label away
    await eventually(() => expect(row('41')).toBeUndefined())
    gmail.remove(thrown?.uid ?? 0)
    await eventually(() => expect(service.list({ kind: 'inbox' })).toEqual([]))
    await eventually(() => expect(gmail.idling).toBe(1))
    service.stopWatching()
    expect(gmail.writes()).toEqual([])
  })

  it('a burst of news from the server is one sync', async () => {
    await signedIn()
    let tell: (() => void) | null = null
    service = make({
      openWatcher: () => ({
        watch: (changed) => {
          tell = changed
          return new Promise<void>(() => undefined)
        },
        close: async () => undefined
      })
    })
    service.watchAll()
    await eventually(() => expect(tell).not.toBeNull())
    const told = (): void => tell?.()
    const passes = (): number => gmail.commands.filter((line) => line.startsWith('LIST')).length
    const before = passes()
    for (let i = 0; i < 30; i++) told()
    await new Promise((resolve) => setTimeout(resolve, WATCH_SETTLE_MS + 400))
    await eventually(() => expect(service.accounts()[0]?.syncing).toBe(false))
    expect(passes() - before).toBe(1)
    told()
    await new Promise((resolve) => setTimeout(resolve, WATCH_SETTLE_MS + 400))
    await eventually(() => expect(passes() - before).toBe(2))
    service.stopWatching()
  })

  it('closes a watch that couldn\'t open the inbox, so failed tries don\'t pile up connections', async () => {
    await signedIn()
    gmail.refuseOpen.add('INBOX')
    service.watchAll()
    await eventually(() => expect(gmail.commands.filter((c) => c.startsWith('EXAMINE "INBOX"') || c === 'EXAMINE INBOX')).toHaveLength(1))
    await eventually(() => expect(gmail.connections).toBe(0)) // Gmail allows fifteen, and this tried every minute
    service.stopWatching()
  })

  it('keeps one watch per account however often the laptop wakes, and stopping ends it', async () => {
    await signedIn()
    service.watchAll()
    service.watchAll() // asked twice before the first has signed in
    await eventually(() => expect(gmail.idling).toBe(1))
    for (let wake = 0; wake < 3; wake++) {
      service.stopWatching()
      service.watchAll()
      await eventually(() => expect([gmail.connections, gmail.idling]).toEqual([1, 1]))
      await new Promise((resolve) => setTimeout(resolve, 50)) // the old watch has finished closing
    }
    service.stopWatching()
    await eventually(() => expect(gmail.connections).toBe(0))
  })
})

describe('a message\'s details', () => {
  const TOP = [
    'Delivered-To: me@example.com',
    'Received: from mail.shop.example (mail.shop.example [1.2.3.4]) by mx.google.com with ESMTPS id 1 (version=TLS1_3 cipher=TLS_AES_256_GCM_SHA384)',
    'Authentication-Results: mx.google.com; dkim=pass header.i=@shop.example; spf=pass smtp.mailfrom=bounce@mail.shop.example; dmarc=pass header.from=shop.example'
  ].join('\n')
  const news = (): string => `${TOP}\n${rawMail({ subject: 'Offers', from: 'Shop <news@shop.example>', headers: ['List-Id: "Shop News" <news.shop.example>'] })}`
  /** Found in the store, so nothing is opened, and nothing marked read. */
  const idOf = (subject: string): number => {
    const row = service.list({ kind: 'all' }).find((r) => r.subject === subject)
    return store.thread(ME, row?.thread ?? '', clock).find((m) => m.subject === subject)?.id ?? 0
  }

  it('keeps what a new message\'s headers say, and knows whether you\'ve written to the sender', async () => {
    gmail.add(news(), { arrived: new Date(at(9)) })
    await signedIn()
    const before = gmail.commands.length
    expect(await service.details(idOf('Offers'))).toEqual({
      bcc: [], deliveredTo: 'me@example.com', recorded: true, wroteTo: false,
      checks: { by: 'mx.google.com', spf: 'pass', dkim: 'pass', dmarc: 'pass' }, mailedBy: 'mail.shop.example', signedBy: ['shop.example'],
      tls: 'TLS 1.3', list: { id: 'news.shop.example', name: 'Shop News' }, sent: expect.any(Number)
    })
    expect(gmail.commands.length).toBe(before) // kept when it arrived, so nothing was asked
    gmail.add(rawMail({ subject: 'Re: Offers', from: `Me <${ME}>`, to: 'news@shop.example', headers: ['Bcc: Linh <linh@example.com>'] }), { arrived: new Date(at(9, 30)), labels: ['\\Sent'], flags: ['\\Seen'] })
    await service.syncAll()
    expect((await service.details(idOf('Offers'))).wroteTo).toBe(true)
    expect((await service.details(idOf('Re: Offers'))).bcc).toEqual([{ name: 'Linh', address: 'linh@example.com' }])
  })

  it('reads the headers of mail kept before they were, once, without marking it read', async () => {
    gmail.add(news(), { arrived: new Date(at(9)) })
    await signedIn()
    ;(store as unknown as { db: { exec(sql: string): void } }).db.exec(`UPDATE messages SET details = ''`)
    const id = idOf('Offers')
    const asked = (): string[] => gmail.commands.filter((line) => /BODY\.PEEK\[HEADER\]/.test(line))
    expect(await service.details(id)).toMatchObject({ recorded: true, mailedBy: 'mail.shop.example', tls: 'TLS 1.3' })
    expect(asked()).toHaveLength(1)
    await service.details(id)
    expect(asked()).toHaveLength(1)
    expect(gmail.mails[0]?.flags).not.toContain('\\Seen')
    expect(gmail.writes()).toEqual([])
  })

  it('says what it can when the server can\'t be reached, and tries again next time', async () => {
    gmail.add(news(), { arrived: new Date(at(9)) })
    await signedIn()
    ;(store as unknown as { db: { exec(sql: string): void } }).db.exec(`UPDATE messages SET details = ''`)
    gmail.dropNextConnection = true
    expect(await service.details(idOf('Offers'))).toMatchObject({ recorded: false, checks: null, wroteTo: false })
    expect(await service.details(idOf('Offers'))).toMatchObject({ recorded: true, mailedBy: 'mail.shop.example' })
  })
})

describe('faces', () => {
  it('names the senders of new mail as it arrives, so their faces are looked up then and not when it\'s read', async () => {
    const noticed = vi.fn()
    gmail.add(rawMail({ subject: 'Old', from: 'Old Friend <old@example.com>' }), { arrived: new Date(at(8)) })
    service = make({ noticed })
    await signedIn()
    expect(noticed).not.toHaveBeenCalled() // there before the account was added
    service.block('pest@example.com')
    gmail.add(rawMail({ subject: 'Hello', from: 'Ada <Ada@Example.com>' }), { arrived: new Date(at(10, 1)) })
    gmail.add(rawMail({ subject: 'Again', from: 'Ada <ada@example.com>' }), { arrived: new Date(at(10, 2)) })
    gmail.add(rawMail({ subject: 'Junk', from: 'Pest <pest@example.com>' }), { arrived: new Date(at(10, 3)) })
    clock = at(10, 5)
    await service.syncAll()
    expect(noticed.mock.calls).toEqual([[['ada@example.com']]])
    noticed.mockClear()
    const row = store.list({ kind: 'all' }, clock).find((r) => r.subject === 'Old')
    service.thread(ME, row?.thread ?? '')
    expect(noticed).not.toHaveBeenCalled()
  })

  it('marks a row whose newest message has a sender warning, so it shows initials', async () => {
    gmail.add(rawMail({ subject: 'Locked', from: 'Bank <x@bank-login.example>', headers: ['Authentication-Results: mx.example; dmarc=fail'] }), { arrived: new Date(at(9)) })
    gmail.add(rawMail({ subject: 'Fine', from: 'Ada <ada@example.com>' }), { arrived: new Date(at(9)) })
    await signedIn()
    expect(Object.fromEntries(service.list({ kind: 'inbox' }).map((r) => [r.subject, r.warned]))).toEqual({ Locked: true, Fine: false })
  })

  it('knows which of your accounts an address is, aliases too', async () => {
    await signedIn()
    service.saveProfile({ identities: { [ME]: { name: '', signature: '', aliases: ['Alias@Example.net'], color: '', notify: true } } })
    expect([service.ownerOf('ME@example.com'), service.ownerOf('alias@example.net'), service.ownerOf('ada@example.com')]).toEqual([ME, ME, null])
  })
})

describe('going back over old previews', () => {
  it('remakes them once for each version', async () => {
    gmail.add(rawMail({ subject: 'Reply', text: 'Fresh words.\n\nOn Tue, Mai <mai@example.com> wrote:\n> Older words' }), { arrived: new Date(at(8)) })
    await signedIn()
    const row = service.list({ kind: 'inbox' })[0]
    const id = service.thread(ME, row?.thread ?? '')[0]?.id ?? 0
    store.setSnippet(id, 'Stale')
    await service.refreshSnippets('1.0')
    expect(service.list({ kind: 'inbox' })[0]?.snippet).toBe('Fresh words.')
    store.setSnippet(id, 'Stale')
    await service.refreshSnippets('1.0')
    expect(service.list({ kind: 'inbox' })[0]?.snippet).toBe('Stale')
    await service.refreshSnippets('1.1')
    expect(service.list({ kind: 'inbox' })[0]?.snippet).toBe('Fresh words.')
  })

  it('remakes them when the way they are made changes, in the same version', async () => {
    gmail.add(rawMail({ subject: 'Code', text: '<!doctype html><p>Your code is 4821.</p>' }), { arrived: new Date(at(8)) })
    await signedIn()
    const row = service.list({ kind: 'inbox' })[0]
    store.setSnippet(service.thread(ME, row?.thread ?? '')[0]?.id ?? 0, '<!doctype html><p>Your code is 4821.</p>')
    store.setMeta('snippets', '0.1.0') // as the version before this left it
    await service.refreshSnippets('0.1.0')
    expect(service.list({ kind: 'inbox' })[0]?.snippet).toBe('Your code is 4821.')
  })
})

describe('quitting', () => {
  const queued = async (subject: string, at?: number): Promise<void> => {
    const draft = await service.startDraft({ kind: 'new' })
    service.saveDraft(draft.id, { ...draft, to: 'ada@example.com', subject, text: 'Hi', html: 'Hi' })
    await service.send(draft.id, at)
  }

  it('sends what was only waiting out Undo', async () => {
    await signedIn()
    await queued('Leaving now')
    await service.finishUp()
    expect(smtp.received).toBe(1)
    expect(service.drafts()).toEqual([])
  })

  it('leaves mail set for later to wait for its time', async () => {
    await signedIn()
    await queued('Tomorrow', clock + 86_400_000)
    await service.finishUp()
    expect(smtp.received).toBe(0)
    expect(service.drafts().map((draft) => draft.subject)).toEqual(['Tomorrow'])
  })

  it('takes changes still waiting to go out with it', async () => {
    gmail.add(rawMail({ subject: 'Done with' }), { arrived: new Date(at(8)) })
    await signedIn()
    const row = service.list({ kind: 'inbox' })[0]
    await service.act([{ account: ME, thread: row?.thread ?? '' }], { kind: 'star' })
    await service.finishUp()
    expect(gmail.commands.some((line) => /STORE/i.test(line))).toBe(true)
  })
})
