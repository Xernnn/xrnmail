import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { MemorySecrets } from '@main/secrets'
import { cleanBatch, describeFailure, MailService } from '@main/service'
import { ImapSource } from '@main/source'
import { Store } from '@main/store'
import { gmailThreadUrl, isSafeExternalUrl, isSafeHubUrl } from '@main/safe-url'
import { FakeGmail, rawMail } from './fake-gmail'

const at = (hour: number, minute = 0, day = 6): number => new Date(2026, 10, day, hour, minute).getTime()
const ME = 'me@example.com'

let gmail: FakeGmail
let port: number
let store: Store
let secrets: MemorySecrets
let clock: number
let changed: Mock<() => void>
let landed: Mock<(count: number) => void>
let post: Mock<(url: string, init: { body: string; redirect: string }) => Promise<{ ok: boolean }>>
let service: MailService

const make = (): MailService =>
  new MailService({
    store, secrets, changed, landed,
    post: post as unknown as typeof fetch,
    now: () => clock,
    openSource: (email, secret) => new ImapSource({ host: '127.0.0.1', port, secure: false, user: email, secret })
  })

/** Adds the account and waits for its first sync. */
async function signedIn(): Promise<void> {
  await service.addAccount(ME, gmail.secret)
  await vi.waitFor(() => expect(service.accounts()[0]?.syncedAt).not.toBeNull())
  await vi.waitFor(() => expect(service.accounts()[0]?.syncing).toBe(false))
}

beforeEach(async () => {
  gmail = new FakeGmail()
  port = await gmail.listen()
  store = new Store(':memory:')
  secrets = new MemorySecrets()
  clock = at(10)
  changed = vi.fn()
  landed = vi.fn()
  post = vi.fn(async (_url: string, _init: { body: string; redirect: string }) => ({ ok: true }))
  service = make()
})

afterEach(async () => {
  store.close()
  await gmail.stop()
})

describe('accounts', () => {
  it('signs in before keeping anything', async () => {
    await expect(service.addAccount(ME, 'wrong')).rejects.toThrow('Gmail refused this app password.')
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
    await expect(service.addAccount('nope', 'x')).rejects.toThrow("isn't an email")
    await expect(service.addAccount(ME, '  ')).rejects.toThrow('app password')
    await signedIn()
    await expect(service.addAccount('ME@example.com', gmail.secret)).rejects.toThrow('already here')
  })

  it('removing one forgets its mail and password', async () => {
    gmail.add(rawMail({ subject: 'Hi' }), { arrived: new Date(at(9)) })
    await signedIn()
    service.removeAccount(ME)
    expect(service.accounts()).toEqual([])
    expect(service.list({ kind: 'inbox' })).toEqual([])
    expect(secrets.get(`account:${ME}`)).toBeNull()
  })

  it('says what went wrong without showing what a server said', () => {
    expect(describeFailure({ authenticationFailed: true })).toContain('refused')
    expect(describeFailure(new Error('<b>server text</b>'))).toBe("Couldn't reach Gmail.")
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
