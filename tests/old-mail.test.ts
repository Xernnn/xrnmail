import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DraftFiles } from '@main/draft-files'
import { MemorySecrets } from '@main/secrets'
import { SmtpSender } from '@main/sender'
import { MailService, UNDO_MS } from '@main/service'
import { gmailQuery, imapPlan } from '@main/server-search'
import { ImapSource } from '@main/source'
import { Store } from '@main/store'
import { ImapWriter } from '@main/writer'
import { providerFor } from '@shared/providers'
import type { ThreadRef, ThreadRow } from '@shared/types'
import { FakeGmail, rawMail, type FakeOptions } from './fake-gmail'
import { FakeSmtp } from './fake-smtp'

/**
 * Mail from before the keeping window (90 days to start with) isn't kept here. A search asks each
 * account's server about it too, and what's found is listed below what's kept.
 */

const DAY = 86_400_000
const at = (hour: number, minute = 0): number => new Date(2026, 10, 6, hour, minute).getTime()
const G = 'me@gmail.com'
const Y = 'me@yahoo.com'

let servers: FakeGmail[]
let ports: Map<string, number>
let gmail: FakeGmail
let yahoo: FakeGmail
let smtp: FakeSmtp
let folder: string
let store: Store
let clock: number
let changed: Mock<() => void>
let secrets: MemorySecrets
let service: MailService

const eventually = (check: () => void): Promise<void> => vi.waitFor(check, { timeout: 15_000, interval: 15 })

const make = (): MailService => new MailService({
  store, secrets, changed,
  now: () => clock,
  files: new DraftFiles(folder),
  searchSettleMs: 0,
  openSource: (account, login) => new ImapSource({ host: '127.0.0.1', port: ports.get(account.email) ?? 0, security: 'none', user: account.user, ...login }),
  openWriter: (account, login) => new ImapWriter({ host: '127.0.0.1', port: ports.get(account.email) ?? 0, security: 'none', user: account.user, ...login }),
  openSender: (account, login) => new SmtpSender({ host: '127.0.0.1', port: smtp.port, security: 'none', user: account.user, ...login })
})

async function serve(email: string, options: FakeOptions = {}): Promise<FakeGmail> {
  const server = new FakeGmail(options)
  server.now = () => new Date(clock)
  ports.set(email, await server.listen())
  servers.push(server)
  return server
}

async function add(email: string, server: FakeGmail): Promise<void> {
  await service.addAccount({ email, secret: server.secret, provider: providerFor(email).id })
  await eventually(() => expect(service.accounts().find((a) => a.email === email)?.syncedAt).not.toBeNull())
  await eventually(() => expect(service.accounts().find((a) => a.email === email)?.syncing).toBe(false))
}

const ago = (days: number): Date => new Date(clock - days * DAY)
const search = (text: string): ThreadRow[] => service.list({ kind: 'search', text })
const shown = (rows: ThreadRow[]): [string, boolean][] => rows.map((row) => [row.subject, row.older === true])
const subjects = (rows: ThreadRow[]): string[] => rows.map((row) => row.subject)

/** What a search for [word] found on the server, fetched as opening it from its row does. */
async function opened(word: string): Promise<ThreadRef> {
  await eventually(() => expect(search(word).filter((row) => row.older)).toHaveLength(1))
  const row = search(word).find((each) => each.older) as ThreadRow
  const ref = { account: row.account, thread: row.thread }
  await service.reach([ref])
  return ref
}

/** Lets everything queued reach the server, past Undo's wait. */
async function flushed(): Promise<void> {
  clock += UNDO_MS + 1
  await service.tick()
  await eventually(() => expect(store.dueActions(G, clock).concat(store.dueActions(Y, clock))).toEqual([]))
  await new Promise((resolve) => setTimeout(resolve, 30))
}

beforeEach(async () => {
  clock = at(10)
  servers = []
  ports = new Map()
  gmail = await serve(G)
  yahoo = await serve(Y, { plain: true, folders: ['Work'] })
  smtp = new FakeSmtp(gmail.secret)
  await smtp.listen()
  folder = mkdtempSync(join(tmpdir(), 'xrnmail-old-'))
  store = new Store(':memory:')
  changed = vi.fn()
  secrets = new MemorySecrets()
  service = make()
  service.saveBatch({ ...service.settings().batch, times: [] })
})

afterEach(async () => {
  service.list({ kind: 'inbox' }) // leaves any search, which closes what it had open
  await eventually(() => expect(service.accounts().every((a) => !a.syncing)).toBe(true))
  await new Promise((resolve) => setTimeout(resolve, 20))
  store.close()
  await Promise.all(servers.map((s) => s.stop()))
  await smtp.stop()
  rmSync(folder, { recursive: true, force: true })
})

describe('searching the server', () => {
  it('finds mail from before the window on the server, and lists it below what is kept here', async () => {
    gmail.add(rawMail({ subject: 'Ledger for 2025', from: 'Mai Tran <mai@example.com>', text: 'Totals' }), { arrived: ago(400), flags: ['\\Seen'] })
    gmail.add(rawMail({ subject: 'Ledger this week', text: 'New totals' }), { arrived: ago(1) })
    gmail.add(rawMail({ subject: 'Picnic', text: 'Nothing to do with it' }), { arrived: ago(300) })
    await add(G, gmail)
    expect(store.list({ kind: 'search', text: 'ledger' }, clock).map((row) => row.subject)).toEqual(['Ledger this week']) // only the new one is kept
    expect(shown(search('ledger'))).toEqual([['Ledger this week', false]])
    await eventually(() => expect(shown(search('ledger'))).toEqual([['Ledger this week', false], ['Ledger for 2025', true]]))
    const old = search('ledger')[1]
    expect(old).toMatchObject({ account: G, fromName: 'Mai Tran', fromAddress: 'mai@example.com', unread: 0, date: ago(400).getTime() })
    expect(changed).toHaveBeenCalled()
    // Gmail is asked in its own words, only about what's older than the window, and nothing is changed.
    expect(gmail.commands.filter((c) => c.includes('X-GM-RAW'))).toEqual([expect.stringMatching(/^UID SEARCH X-GM-RAW "before:2026\/8\/9 ledger"$/)])
    expect(gmail.writes()).toEqual([])
    expect(store.list({ kind: 'search', text: 'ledger' }, clock)).toHaveLength(1) // and nothing of it is kept
  })

  it('asks every account, Gmail with X-GM-RAW and anything else with IMAP SEARCH in each folder', async () => {
    gmail.add(rawMail({ subject: 'Tax return 2024' }), { arrived: ago(500) })
    yahoo.add(rawMail({ subject: 'Tax papers' }), { arrived: ago(200) })
    yahoo.add(rawMail({ subject: 'Tax receipts' }), { arrived: ago(250), box: 'Work' })
    yahoo.add(rawMail({ subject: 'Tax, binned' }), { arrived: ago(260), box: 'Trash' })
    await add(G, gmail)
    await add(Y, yahoo)
    await eventually(() => expect(shown(search('tax'))).toEqual([['Tax papers', true], ['Tax receipts', true], ['Tax return 2024', true]]))
    expect(search('tax').map((row) => row.account)).toEqual([Y, Y, G])
    const asked = yahoo.commands.filter((c) => /^UID SEARCH .*TEXT/.test(c))
    expect(asked.length).toBeGreaterThanOrEqual(3) // the inbox, Sent, Archive and Work, never Trash or Junk
    expect(asked.every((c) => /TEXT tax/.test(c) && /BEFORE \d+-Aug-2026/.test(c))).toBe(true)
    expect(yahoo.writes()).toEqual([])
  })

  it('leaves out anything the window holds: kept here, or held for a batch', async () => {
    service.saveBatch({ ...service.settings().batch, live: false, times: ['13:00'] })
    gmail.add(rawMail({ subject: 'Invoice from spring' }), { arrived: ago(150) })
    await add(G, gmail)
    clock += 60_000
    gmail.add(rawMail({ subject: 'Invoice, new' }), { arrived: new Date(clock) })
    await service.syncAll()
    expect(service.overview().held).toBe(1)
    await eventually(() => expect(shown(search('invoice'))).toEqual([['Invoice from spring', true]]))
  })

  it('a new search stops the one before it', async () => {
    gmail.add(rawMail({ subject: 'Alpha from long ago' }), { arrived: ago(400) })
    gmail.add(rawMail({ subject: 'Beta from long ago' }), { arrived: ago(400) })
    await add(G, gmail)
    gmail.hold = /^UID SEARCH$/
    expect(search('alpha')).toEqual([])
    await eventually(() => expect(gmail.holding).toHaveLength(1))
    expect(search('beta')).toEqual([])
    await eventually(() => expect(gmail.holding).toHaveLength(2))
    gmail.release()
    await eventually(() => expect(shown(search('beta'))).toEqual([['Beta from long ago', true]]))
    // Alpha's connection was let go mid-search, so it never read a header, and none is left open.
    await eventually(() => expect(gmail.connections).toBe(0))
    expect(gmail.commands.filter((c) => c.startsWith('UID FETCH') && c.includes('HEADER.FIELDS'))).toHaveLength(1)
    expect(search('alpha')).toEqual([]) // asked afresh, and not answered yet
  })

  it('a server that cannot be reached, or will not search, leaves what is kept here', async () => {
    gmail.add(rawMail({ subject: 'Report, new' }), { arrived: ago(2) })
    gmail.add(rawMail({ subject: 'Report from before' }), { arrived: ago(400) })
    await add(G, gmail)
    gmail.refuseSearch.add(gmail.allMail)
    expect(shown(search('report'))).toEqual([['Report, new', false]])
    await eventually(() => expect(gmail.commands.some((c) => c.includes('X-GM-RAW'))).toBe(true))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(shown(search('report'))).toEqual([['Report, new', false]])
    expect(service.accounts()[0]?.error).toBeNull()
  })
})

describe('opening what a search found', () => {
  it('fetches the whole thread, shows it like any other, and keeps it out of every other list and count', async () => {
    const thread = 7_000_000_000_000_000_900n
    gmail.add(rawMail({ subject: 'Harbour lease', from: 'Mai Tran <mai@example.com>', text: 'Draft lease attached' }), { arrived: ago(400), thread })
    gmail.add(rawMail({ subject: 'Re: Harbour lease', from: 'Alex <alex@example.com>', text: 'Signed and sent back' }), { arrived: ago(399), thread })
    gmail.add(rawMail({ subject: 'Today' }), { arrived: ago(1) })
    await add(G, gmail)
    const counts = { unread: service.accounts()[0]?.unread, overview: service.overview() }
    await eventually(() => expect(search('harbour')).toMatchObject([{ subject: 'Re: Harbour lease', older: true, count: 2, unread: 2 }]))
    const ref = await opened('harbour')
    expect(gmail.commands).toContain(`UID SEARCH X-GM-THRID ${thread}`)
    const messages = service.thread(G, ref.thread, false, true, false)
    expect(messages.map((m) => [m.subject, m.text.trim(), m.from.address])).toEqual([
      ['Harbour lease', 'Draft lease attached', 'mai@example.com'],
      ['Re: Harbour lease', 'Signed and sent back', 'alex@example.com']
    ])
    // Both are unread and in the inbox on the server, and still count for nothing here.
    expect(subjects(service.list({ kind: 'inbox' }))).toEqual(['Today'])
    expect(subjects(service.list({ kind: 'all' }))).toEqual(['Today'])
    expect(service.accounts()[0]?.unread).toBe(counts.unread)
    expect(service.overview()).toEqual(counts.overview)
    expect(service.contacts('mai')).toEqual([])
    expect(store.list({ kind: 'search', text: 'harbour' }, clock)).toEqual([]) // it's found by asking, under Older
    expect(subjects(service.list({ kind: 'recent' }))).toEqual(['Re: Harbour lease'])
    // Opened again, and after a sync pass, it's what's kept here: nothing is fetched again.
    const fetched = gmail.commands.filter((c) => /BODY\.PEEK\[\]/.test(c)).length
    await service.reach([ref])
    expect(service.thread(G, ref.thread)).toHaveLength(2)
    await flushed()
    expect(gmail.mails.filter((m) => m.flags.includes('\\Seen')).map((m) => m.uid)).toEqual([1, 2]) // opening read it, there too
    // The other lists left the search, so it's asked again, and shows the thread as it is here now.
    await eventually(() => expect(search('harbour')).toMatchObject([{ subject: 'Re: Harbour lease', older: true, unread: 0 }]))
    await service.syncAll()
    expect(service.thread(G, ref.thread)).toHaveLength(2)
    expect(gmail.commands.filter((c) => /BODY\.PEEK\[\]/.test(c)).length).toBe(fetched)
  })

  it('archive, a label, a flag and Trash reach the server by its UIDs, opened or straight from its row', async () => {
    const uid = gmail.add(rawMail({ subject: 'Old receipt' }), { arrived: ago(300) })
    await add(G, gmail)
    const ref = await opened('receipt') // as acting on the row does, before anything is sent
    service.act([ref], { kind: 'label', label: 'Receipts', add: true })
    service.act([ref], { kind: 'star' })
    await flushed()
    expect(gmail.mails.find((m) => m.uid === uid)).toMatchObject({ labels: ['\\Inbox', 'Receipts'], flags: ['\\Flagged'] })
    service.act([ref], { kind: 'archive' })
    await flushed()
    expect(gmail.mails.find((m) => m.uid === uid)?.labels).toEqual(['Receipts'])
    expect(search('receipt')).toMatchObject([{ subject: 'Old receipt', older: true, starred: true }]) // as it is now
    expect(subjects(service.list({ kind: 'label', account: G, label: 'Receipts' }))).toEqual([])
    service.act([ref], { kind: 'trash' })
    await flushed()
    expect(gmail.moved).toEqual([{ uid, to: '[Gmail]/Trash' }])
    expect(search('receipt')).toEqual([]) // gone to Trash, as a search here would leave it out
  })

  it('on a server without threads, brings the replies that name it from every folder, and archives what was in the inbox', async () => {
    const first = rawMail({ subject: 'Boat club dues', from: 'Mai Tran <mai@example.com>', text: 'Dues are due' })
    const id = /Message-ID: (<[^>]+>)/.exec(first)?.[1] ?? ''
    yahoo.add(first, { arrived: ago(300) })
    yahoo.add(rawMail({ subject: 'Paid it', from: Y, text: 'Done', headers: [`In-Reply-To: ${id}`, `References: ${id}`] }), { arrived: ago(299), box: 'Sent' })
    yahoo.add(rawMail({ subject: 'Another club', text: 'Not this one' }), { arrived: ago(298) })
    await add(Y, yahoo)
    const ref = await opened('boat')
    expect(service.thread(Y, ref.thread).map((m) => m.text.trim())).toEqual(['Dues are due', 'Done']) // and reads both
    expect(yahoo.commands.some((c) => c.startsWith('UID SEARCH OR') && c.includes(id))).toBe(true)
    service.act([ref], { kind: 'archive' })
    await flushed()
    expect(yahoo.box('Archive').mails.map((m) => m.raw.toString())).toEqual([expect.stringContaining('Boat club dues')])
    expect(yahoo.box('Sent').mails).toHaveLength(1) // your own reply stays where it is
    expect(yahoo.writes().filter((c) => /MOVE|COPY/.test(c))).toEqual([expect.stringMatching(/^UID MOVE 1 "?Archive"?$/)])
  })

  it('a thread kept from an earlier day opens without asking the server for it again', async () => {
    gmail.add(rawMail({ subject: 'Maple notes', text: 'Kept' }), { arrived: ago(400) })
    await add(G, gmail)
    const ref = await opened('maple')
    service.list({ kind: 'inbox' })
    service = make() // the app started again, on the same profile
    await eventually(() => expect(search('maple')).toMatchObject([{ subject: 'Maple notes', older: true }]))
    const asked = gmail.commands.length
    await service.reach([ref])
    expect(service.thread(G, ref.thread).map((m) => m.text.trim())).toEqual(['Kept'])
    expect(gmail.commands.slice(asked).filter((c) => /X-GM-THRID|BODY\.PEEK\[\]/.test(c))).toEqual([])
  })

  it('a week unopened, what was fetched goes; opened since, or pinned, it stays', async () => {
    for (const word of ['Alder', 'Birch', 'Cedar']) gmail.add(rawMail({ subject: `${word} notes` }), { arrived: ago(400) })
    await add(G, gmail)
    const [alder, birch, cedar] = [await opened('alder'), await opened('birch'), await opened('cedar')]
    for (const ref of [alder, birch, cedar]) expect(service.thread(G, ref.thread)).toHaveLength(1)
    clock += 5 * DAY
    service.thread(G, birch.thread)
    service.pin([cedar], true)
    clock += 3 * DAY
    await service.syncAll()
    expect([alder, birch, cedar].map((ref) => store.thread(G, ref.thread, clock).length)).toEqual([0, 1, 1])
    expect(subjects(service.list({ kind: 'pinned' }))).toEqual(['Cedar notes'])
  })

  it('once the window grows to take it in, it is ordinary mail', async () => {
    gmail.add(rawMail({ subject: 'Spruce notes' }), { arrived: ago(120) })
    await add(G, gmail)
    const ref = await opened('spruce')
    expect(service.thread(G, ref.thread, false, true, false)).toHaveLength(1)
    expect(subjects(service.list({ kind: 'inbox' }))).toEqual([])
    service.saveBackfill(180)
    await eventually(() => expect(subjects(service.list({ kind: 'inbox' }))).toEqual(['Spruce notes']))
    expect(shown(search('spruce'))).toEqual([['Spruce notes', false]])
    expect(gmail.commands.filter((c) => /BODY\.PEEK\[\]/.test(c))).toHaveLength(1) // the window's sync found it here already
  })
})

describe('what a server is asked', () => {
  const keepFrom = new Date(2026, 7, 8, 10).getTime()

  it('gives Gmail what was typed, with its own days, days for weeks and stars for flags', () => {
    expect(gmailQuery('ledger', keepFrom)).toBe('before:2026/8/9 ledger')
    expect(gmailQuery('from:mai "tax return" -draft', keepFrom)).toBe('before:2026/8/9 from:mai "tax return" -draft')
    expect(gmailQuery('after:2024-01-05 before:2024/2/1 is:flagged', keepFrom)).toBe('before:2026/8/9 after:2024/1/5 before:2024/2/1 is:starred')
    expect(gmailQuery('newer_than:2w label:"Family trips"', keepFrom)).toBe('before:2026/8/9 newer_than:14d label:"Family trips"')
    expect(gmailQuery('a OR b', keepFrom)).toBe('before:2026/8/9 (a OR b)')
    // Snoozes and pins are this laptop's: nothing from before the window has them.
    expect(gmailQuery('is:pinned', keepFrom)).toBeNull()
    expect(gmailQuery('report OR is:snoozed', keepFrom)).toBe('before:2026/8/9 report')
    expect(gmailQuery('report -is:pinned', keepFrom)).toBe('before:2026/8/9 report')
  })

  it('puts the rest to IMAP SEARCH, as few searches as its keys allow', () => {
    const plan = imapPlan('tax from:mai is:unread larger:2M', keepFrom, keepFrom)
    expect(plan?.searches).toEqual([{ text: 'tax', from: 'mai', seen: false, larger: 2 * 1024 * 1024, before: new Date(keepFrom + DAY) }])
    expect(imapPlan('tax return', keepFrom, keepFrom)?.searches).toEqual([{ text: 'tax', before: new Date(keepFrom + DAY) }, { text: 'return' }])
    expect(imapPlan('a OR b -c', keepFrom, keepFrom)?.searches).toEqual([{ or: [{ text: 'a' }, { text: 'b' }], not: { text: 'c' }, before: new Date(keepFrom + DAY) }])
    expect(imapPlan('is:important', keepFrom, keepFrom)).toBeNull() // only Gmail marks it
    expect(imapPlan(Array.from({ length: 40 }, (_, i) => `w${i}`).join(' '), keepFrom, keepFrom)?.searches).toHaveLength(12) // a search each
    const filed = imapPlan('has:attachment in:work', keepFrom, keepFrom)
    expect(filed?.searches).toEqual([{ before: new Date(keepFrom + DAY) }])
    expect(filed?.wants({ id: 'Work', path: 'Work', role: 'folder' })).toBe(true)
    expect(filed?.wants({ id: '@inbox', path: 'INBOX', role: 'inbox' })).toBe(false)
    expect(imapPlan('report', keepFrom, keepFrom)?.wants({ id: '@trash', path: 'Trash', role: 'trash' })).toBe(false)
  })
})
