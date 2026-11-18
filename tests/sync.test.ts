import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ImapSource, type ImapConfig } from '@main/source'
import { Store } from '@main/store'
import { ImapWriter } from '@main/writer'
import { syncAccount, type SyncOptions } from '@main/sync'
import { FakeGmail, rawMail } from './fake-gmail'

const DAY = 86_400_000
const ACCOUNT = 'acct'

let gmail: FakeGmail
let store: Store
let config: ImapConfig
let source: ImapSource | null
let now: number

const options = (over: Partial<SyncOptions> = {}): SyncOptions => ({
  account: ACCOUNT, email: 'me@example.com', backfillDays: 30,
  rules: { times: [], vip: [] }, now, ...over
})

async function sync(over: Partial<SyncOptions> = {}): Promise<ReturnType<typeof syncAccount>> {
  source = new ImapSource(config)
  await source.connect()
  try {
    return await syncAccount(source, store, options(over))
  } finally {
    await source.close()
    source = null
  }
}

beforeEach(async () => {
  gmail = new FakeGmail()
  const port = await gmail.listen()
  store = new Store(':memory:')
  config = { host: '127.0.0.1', port, security: 'none', user: 'me@example.com', secret: gmail.secret }
  now = Date.now()
})

afterEach(async () => {
  store.close()
  await gmail.stop()
})

describe('a first sync', () => {
  it('fetches mail and lists it', async () => {
    gmail.add(rawMail({ subject: 'First', text: 'Hello there' }))
    gmail.add(rawMail({ subject: 'Second', from: 'Grace Hopper <grace@example.com>' }))
    expect((await sync()).added).toBe(2)
    const rows = store.list({ kind: 'inbox' }, now + 1000)
    expect(rows.map((r) => r.subject).sort()).toEqual(['First', 'Second'])
    expect(rows.find((r) => r.subject === 'Second')?.fromName).toBe('Grace Hopper')
  })

  it('keeps Gmail threads together', async () => {
    gmail.add(rawMail({ subject: 'Plan' }), { thread: 42n, arrived: new Date(now - 2000) })
    gmail.add(rawMail({ subject: 'Re: Plan' }), { thread: 42n, arrived: new Date(now - 1000) })
    await sync()
    const rows = store.list({ kind: 'inbox' }, now + 1000)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ subject: 'Re: Plan', count: 2, thread: '42' })
    expect(store.thread(ACCOUNT, '42', now + 1000).map((m) => m.subject)).toEqual(['Plan', 'Re: Plan'])
  })

  it('leaves out mail older than the window', async () => {
    gmail.add(rawMail({ subject: 'Old' }), { arrived: new Date(now - 90 * DAY) })
    gmail.add(rawMail({ subject: 'New' }))
    await sync()
    expect(store.list({ kind: 'inbox' }, now + 1000).map((r) => r.subject)).toEqual(['New'])
  })

  it('reads labels and flags', async () => {
    gmail.add(rawMail({ subject: 'Bill' }), { labels: ['\\Inbox', 'Receipts'], flags: ['\\Seen', '\\Flagged'] })
    await sync()
    expect(store.list({ kind: 'label', account: ACCOUNT, label: 'Receipts' }, now + 1000)).toHaveLength(1)
    expect(store.list({ kind: 'inbox' }, now + 1000)[0]?.unread).toBe(0)
    expect(store.labelCounts(now + 1000)).toEqual([{ account: ACCOUNT, label: 'Receipts', count: 1 }])
  })

  it('reads system labels however Gmail writes them', async () => {
    gmail.bareLabels = true
    gmail.add(rawMail({ subject: 'Bare' }), { labels: ['\\Inbox', 'Muy Importante'] })
    await sync()
    expect(store.list({ kind: 'inbox' }, now + 1000)).toHaveLength(1)
    expect(store.labelCounts(now + 1000)).toEqual([{ account: ACCOUNT, label: 'Muy Importante', count: 1 }])
  })

  it('reads Vietnamese subjects and finds them without their marks', async () => {
    gmail.add(rawMail({ subject: '=?UTF-8?B?' + Buffer.from('Lịch thi cuối kỳ').toString('base64') + '?=', text: 'Đọc kỹ' }))
    await sync()
    expect(store.list({ kind: 'search', text: 'lich thi' }, now + 1000)[0]?.subject).toBe('Lịch thi cuối kỳ')
    expect(store.list({ kind: 'search', text: 'doc ky' }, now + 1000)).toHaveLength(1)
  })

  it('lists attachments by name without keeping them', async () => {
    gmail.add(rawMail({ subject: 'Files', text: 'See attached', attachment: { name: 'plan.pdf', type: 'application/pdf', body: 'x'.repeat(500) } }))
    await sync()
    const row = store.list({ kind: 'inbox' }, now + 1000)[0]
    expect(row?.attachment).toBe(true)
    const message = store.thread(ACCOUNT, row?.thread ?? '', now + 1000)[0]
    expect(message?.attachments[0]).toMatchObject({ name: 'plan.pdf', type: 'application/pdf' })
    expect(JSON.stringify(message)).not.toContain('xxxxxxxx')
  })

  it('keeps a message that will not parse', async () => {
    gmail.add(Buffer.from([0, 255, 254, 13, 10, 13, 10, 0]))
    expect((await sync()).added).toBe(1)
    expect(store.list({ kind: 'inbox' }, now + 1000)).toHaveLength(1)
  })

  it('cuts a huge message and says so', async () => {
    const big = rawMail({ subject: 'Huge', text: 'start', attachment: { name: 'big.bin', type: 'application/octet-stream', body: 'y'.repeat(6 * 1024 * 1024) } })
    gmail.add(big)
    await sync()
    const row = store.list({ kind: 'inbox' }, now + 1000)[0]
    expect(row?.subject).toBe('Huge')
    expect(store.thread(ACCOUNT, row?.thread ?? '', now + 1000)[0]?.truncated).toBe(true)
  })

  it('says so when only its HTML had to be cut', async () => {
    gmail.add(rawMail({ subject: 'Long', html: `<p>start</p>${'<p>word word word</p>'.repeat(120_000)}` }))
    gmail.add(rawMail({ subject: 'Short', html: '<p>start</p>' }))
    await sync()
    const cut = (subject: string): boolean | undefined => {
      const row = store.list({ kind: 'inbox' }, now + 1000).find((r) => r.subject === subject)
      return store.thread(ACCOUNT, row?.thread ?? '', now + 1000)[0]?.truncated
    }
    expect(cut('Long')).toBe(true)
    expect(cut('Short')).toBe(false)
  })
})

describe('later syncs', () => {
  it('fetches only what is new', async () => {
    gmail.add(rawMail({ subject: 'One' }))
    await sync()
    gmail.add(rawMail({ subject: 'Two' }))
    expect((await sync()).added).toBe(1)
  })

  it('follows label and flag changes from Gmail', async () => {
    const uid = gmail.add(rawMail({ subject: 'Moved' }), { labels: ['\\Inbox'] })
    await sync()
    expect(store.list({ kind: 'inbox' }, now + 1000)).toHaveLength(1)
    gmail.change(uid, ['Archive'], ['\\Seen'])
    expect((await sync()).changed).toBe(1)
    expect(store.list({ kind: 'inbox' }, now + 1000)).toHaveLength(0)
    expect(store.list({ kind: 'label', account: ACCOUNT, label: 'Archive' }, now + 1000)[0]?.unread).toBe(0)
  })

  it('forgets mail deleted in Gmail, and its search entry', async () => {
    const uid = gmail.add(rawMail({ subject: 'Goodbye', text: 'uniqueword' }))
    await sync()
    expect(store.list({ kind: 'search', text: 'uniqueword' }, now + 1000)).toHaveLength(1)
    gmail.remove(uid)
    expect((await sync()).removed).toBe(1)
    expect(store.list({ kind: 'inbox' }, now + 1000)).toHaveLength(0)
    expect(store.list({ kind: 'search', text: 'uniqueword' }, now + 1000)).toHaveLength(0)
  })

  it('does not take mail at the edge of the window for deleted', async () => {
    const edge = new Date(now - 30 * DAY + 3_600_000)
    gmail.add(rawMail({ subject: 'Edge' }), { arrived: edge })
    await sync()
    expect(store.list({ kind: 'inbox' }, now + 1000)).toHaveLength(1)
    gmail.mails[0]!.arrived = new Date(now - 32 * DAY) // SINCE in another zone stops finding it
    expect((await sync()).removed).toBe(0)
    expect(store.list({ kind: 'inbox' }, now + 1000)).toHaveLength(1)
  })

  it('starts over when Gmail renumbers the mailbox', async () => {
    gmail.add(rawMail({ subject: 'Before' }))
    await sync()
    gmail.uidValidity = 2
    expect((await sync()).added).toBe(1)
    expect(store.list({ kind: 'inbox' }, now + 1000)).toHaveLength(1)
  })

  it('keeps when holding started, even after a renumbering', async () => {
    gmail.add(rawMail({ subject: 'Before' }))
    await sync()
    const first = store.holdFrom(ACCOUNT)
    gmail.uidValidity = 2
    await sync({ now: now + 5000 })
    expect(store.holdFrom(ACCOUNT)).toBe(first)
  })
})

describe('a very large folder', () => {
  // The lowest and highest UID were found by handing every one to Math.min and Math.max at once,
  // which overflows the stack past about 125,000 of them and ended every pass on that account.
  it('has its flags read however many messages it holds', async () => {
    const big = new ImapSource(config)
    let asked = ''
    const nothing = async function* (): AsyncGenerator<never> {}
    Object.assign(big, { client: { fetch: (range: string) => { asked = range; return nothing() } } })
    const uids = Array.from({ length: 200_000 }, (_, i) => i + 5)
    for await (const header of big.flagsOf(uids)) expect(header).toBeUndefined()
    expect(asked).toBe('5:200004')
  })
})

describe('a change to a great many messages', () => {
  // Every UID went into one command line, and "Delete all" from a busy sender names thousands, which
  // a server that limits its lines refused: the change was tried three times and then put back.
  it('reaches a server that limits how long a command can be', async () => {
    await gmail.stop()
    gmail = new FakeGmail({ maxLine: 8192 })
    config = { ...config, port: await gmail.listen() }
    const uids = Array.from({ length: 3000 }, (_, i) => gmail.add(rawMail({ subject: `Deal ${i}` })))
    const writer = new ImapWriter(config)
    await writer.connect()
    try {
      await writer.apply('@all', uids, { kind: 'star' })
      expect(gmail.mails.filter((m) => m.flags.includes('\\Flagged'))).toHaveLength(3000)
      const moved = await writer.apply('@all', uids, { kind: 'trash' })
      expect(moved?.to?.role).toBe('trash')
      expect([...(moved?.map?.keys() ?? [])].sort((a, b) => a - b)).toEqual(uids)
      expect(gmail.mails).toEqual([])
    } finally {
      await writer.close()
    }
  })
})

describe('batches', () => {
  it('holds new mail and shows it only at its moment', async () => {
    await sync() // the account exists from here; what comes next is new
    const arrived = new Date(now + 60_000)
    gmail.add(rawMail({ subject: 'Secret plans', text: 'hidden words' }), { arrived, thread: 5n })
    await sync({ now: now + 120_000, rules: { times: ['09:00', '13:00', '17:00'], vip: [] } })
    const moment = store.nextRelease(now + 120_000)
    expect(moment).toBeGreaterThan(now + 60_000)
    const before = (moment ?? 0) - 1
    expect(store.heldCount(before)).toBe(1)
    expect(store.list({ kind: 'inbox' }, before)).toEqual([])
    expect(store.thread(ACCOUNT, '5', before)).toEqual([])
    expect(store.list({ kind: 'search', text: 'hidden' }, before)).toEqual([])
    expect(store.list({ kind: 'label', account: ACCOUNT, label: '\\Inbox' }, before)).toEqual([])
    expect(store.heldCount(moment ?? 0)).toBe(0)
    expect(store.list({ kind: 'inbox' }, moment ?? 0).map((r) => r.subject)).toEqual(['Secret plans'])
  })

  it('a held reply stays out of a thread already showing', async () => {
    gmail.add(rawMail({ subject: 'Start' }), { thread: 9n, arrived: new Date(now - 5000) })
    await sync()
    gmail.add(rawMail({ subject: 'Re: Start', text: 'not yet' }), { thread: 9n, arrived: new Date(now + 60_000) })
    await sync({ now: now + 120_000, rules: { times: ['09:00', '13:00', '17:00'], vip: [] } })
    const moment = store.nextRelease(now + 120_000) ?? 0
    expect(store.thread(ACCOUNT, '9', moment - 1).map((m) => m.subject)).toEqual(['Start'])
    expect(store.list({ kind: 'inbox' }, moment - 1)[0]).toMatchObject({ subject: 'Start', count: 1 })
    expect(store.thread(ACCOUNT, '9', moment)).toHaveLength(2)
  })

  it('tells how many a batch brought, and early release empties the queue', async () => {
    await sync()
    gmail.add(rawMail({ subject: 'A' }), { arrived: new Date(now + 60_000) })
    gmail.add(rawMail({ subject: 'B' }), { arrived: new Date(now + 61_000) })
    await sync({ now: now + 120_000, rules: { times: ['09:00', '13:00', '17:00'], vip: [] } })
    const moment = store.nextRelease(now + 120_000) ?? 0
    expect(store.landedBetween(moment - 1, moment)).toBe(2)
    expect(store.releaseAll(now + 130_000)).toBe(2)
    expect(store.heldCount(now + 130_000)).toBe(0)
  })
})

describe('it never touches the mailbox', () => {
  it('opens read-only and asks for no change, through every kind of sync', async () => {
    const uid = gmail.add(rawMail({ subject: 'One' }))
    await sync()
    gmail.add(rawMail({ subject: 'Two' }))
    gmail.change(uid, ['Other'], ['\\Seen'])
    await sync()
    gmail.remove(uid)
    await sync()
    expect(gmail.commands.some((c) => c.startsWith('EXAMINE'))).toBe(true)
    expect(gmail.writes()).toEqual([])
    expect(gmail.commands).not.toContain('TOUCHED-SEEN') // a plain BODY[] would mark mail as read
  })

  it('refuses to work if the server opens the mailbox for writing', async () => {
    const original = (gmail as unknown as { line: (s: unknown, l: string) => void }).line.bind(gmail)
    ;(gmail as unknown as { line: (s: { write(t: string): void }, l: string) => void }).line = (socket, text) => {
      if (/EXAMINE/i.test(text)) {
        const tag = text.split(' ')[0]
        socket.write('* FLAGS ()\r\n* OK [UIDVALIDITY 1] v\r\n* 0 EXISTS\r\n* OK [UIDNEXT 1] n\r\n')
        socket.write(`${tag} OK [READ-WRITE] opened\r\n`)
        return
      }
      original(socket, text)
    }
    await expect(sync()).rejects.toThrow(/read-only/)
  })
})

describe('signing in', () => {
  it('fails cleanly with a wrong app password', async () => {
    const bad = new ImapSource({ ...config, secret: 'wrong' })
    await expect(bad.connect()).rejects.toThrow()
  })

  it('says so when All Mail is hidden from IMAP', async () => {
    gmail.hasAllMail = false
    const hidden = new ImapSource(config)
    await expect(hidden.connect()).rejects.toThrow(/All Mail/)
    await hidden.close()
  })
})
