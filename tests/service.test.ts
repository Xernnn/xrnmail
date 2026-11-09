import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DraftFiles } from '@main/draft-files'
import { MemorySecrets } from '@main/secrets'
import { SmtpSender } from '@main/sender'
import { parseUnsubscribe } from '@main/parse'
import { cleanBatch, describeFailure, MailService, UNDO_MS } from '@main/service'
import type { Draft } from '@shared/types'
import { ImapSource, ImapWatcher } from '@main/source'
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
let landed: Mock<(count: number, preview?: { from: string; subject: string }) => void>
let post: Mock<(url: string, init: { body: string; redirect: string }) => Promise<{ ok: boolean }>>
let service: MailService

const make = (): MailService =>
  new MailService({
    store, secrets, changed, landed,
    post: post as unknown as typeof fetch,
    now: () => clock,
    files: new DraftFiles(folder),
    openSource: (account, login) => new ImapSource({ host: '127.0.0.1', port, security: 'none', user: account.user, ...login }),
    openWriter: (account, login) => new ImapWriter({ host: '127.0.0.1', port, security: 'none', user: account.user, ...login }),
    openWatcher: (account, login) => new ImapWatcher({ host: '127.0.0.1', port, security: 'none', user: account.user, ...login }),
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
  changed = vi.fn()
  landed = vi.fn()
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
    service.saveBatch({ ...service.settings().batch, times: ['10:45', '15:00'] }) // 10:45 has passed
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

describe('xrnhub', () => {
  const sent = (): Array<{ app: string; kind: string; value: number; detail: { held: number; nextBatch: number } }> =>
    post.mock.calls.flatMap((call) => JSON.parse(call[1].body).events)

  beforeEach(async () => {
    await signedIn()
    await service.connectHub('https://hub.example/xrnhub/', 'sonn', 'hub-secret')
    post.mockClear()
  })

  it('checks the login first and never over plain http', async () => {
    await expect(service.connectHub('http://hub.example', 'sonn', 'x')).rejects.toThrow('https')
    post.mockResolvedValueOnce({ ok: false })
    await expect(service.connectHub('https://hub.example', 'sonn', 'bad')).rejects.toThrow("didn't accept")
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
    expect(cleanBatch({ times: ['17:00', '09:00', '09:00', 'noon'], vip: [' Boss@Work.com ', 'nonsense', ''], earlyPerDay: 99 }))
      .toEqual({ times: ['09:00', '17:00'], vip: ['boss@work.com'], earlyPerDay: 5 })
  })

  it('survives a restart', () => {
    service.saveBatch({ times: ['08:00'], vip: [], earlyPerDay: 2 })
    expect(make().settings().batch).toEqual({ times: ['08:00'], vip: [], earlyPerDay: 2 })
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

  it('undo puts it back and Gmail never hears about it', async () => {
    const token = service.act([ref('One')], { kind: 'archive' })
    service.undo(token)
    expect(ids().sort()).toEqual(['One', 'Two'])
    await later(UNDO_MS + 1000)
    expect(fakeMail('One').labels).toContain('\\Inbox')
    expect(gmail.writes().filter((c) => c.includes('STORE'))).toEqual([])
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

  it('never retries once the message may have gone', async () => {
    const draft = await write()
    smtp.dropAfterData = true
    service.send(draft.id)
    await later(10_000)
    await later(120_000)
    expect(smtp.received).toBe(1)
    expect(service.drafts()[0]).toMatchObject({ state: 'failed', error: 'This may not have been sent. Check Sent before trying again.' })
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

  it('removing an account takes its drafts and identity', async () => {
    const draft = await write()
    service.saveProfile({ identities: { [ME]: { name: 'Me', signature: '', aliases: [], color: '', notify: true } } })
    service.addFileBytes(draft.id, 'a.txt', 'text/plain', Buffer.from('x'))
    service.removeAccount(ME)
    expect(service.drafts()).toEqual([])
    expect(service.settings().identities).toEqual({})
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
    expect(landed).toHaveBeenCalledWith(1, { from: 'Ada', subject: 'Urgent' })
    expect(landed).toHaveBeenCalledTimes(1)
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
    service.saveBatch({ ...service.settings().batch, times: ['13:00'] })
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

  it('keeps trusted senders tidy and in one case', () => {
    service.saveProfile({ imagesFrom: ['News@Shop.example', 'news@shop.example', 'not an address'] })
    expect(service.settings().imagesFrom).toEqual(['news@shop.example'])
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
