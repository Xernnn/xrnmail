import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DraftFiles } from '@main/draft-files'
import { MemorySecrets } from '@main/secrets'
import { SmtpSender } from '@main/sender'
import { pollDeviceCode, type DeviceCode } from '@main/oauth'
import { MailService, UNDO_MS, type DomainRecords } from '@main/service'
import { ImapSource, threadOf } from '@main/source'
import { Store } from '@main/store'
import { ImapWriter } from '@main/writer'
import { providerFor } from '@shared/providers'
import type { NewAccount } from '@shared/types'
import { FakeGmail, rawMail, type FakeOptions } from './fake-gmail'
import { FakeSmtp } from './fake-smtp'
import { secondVersionProfile } from './old-profile'

/**
 * The reason to use a mail app instead of a website: several accounts, from different services, in
 * one place. Everything here runs real imapflow and nodemailer against servers that differ the way
 * real ones do. None of it has been checked against a real Yahoo, iCloud or Outlook account.
 */

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
let secrets: MemorySecrets
let clock: number
let service: MailService
let post: ReturnType<typeof vi.fn>
let records: DomainRecords | undefined

const make = (): MailService => new MailService({
  store, secrets, records,
  changed: () => undefined,
  post: post as unknown as typeof fetch,
  now: () => clock,
  files: new DraftFiles(folder),
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

const settled = async (email: string): Promise<void> => {
  await vi.waitFor(() => expect(service.accounts().find((a) => a.email === email)?.syncedAt).not.toBeNull(), { timeout: 15_000, interval: 15 })
  await vi.waitFor(() => expect(service.accounts().find((a) => a.email === email)?.syncing).toBe(false), { timeout: 15_000, interval: 15 })
}

async function add(email: string, server: FakeGmail, over: Partial<NewAccount> = {}): Promise<void> {
  await service.addAccount({ email, secret: server.secret, provider: providerFor(email).id, ...over })
  await settled(email)
}

/** Lets everything queued reach the server, past Undo's wait. */
async function flushed(): Promise<void> {
  clock += UNDO_MS + 1
  await service.tick()
  await vi.waitFor(() => expect(store.dueActions(G, clock).concat(store.dueActions(Y, clock))).toEqual([]), { timeout: 15_000, interval: 15 })
  await new Promise((resolve) => setTimeout(resolve, 30))
}

const subjects = (rows: { subject: string }[]): string[] => rows.map((r) => r.subject).sort()

beforeEach(async () => {
  clock = at(10)
  servers = []
  ports = new Map()
  gmail = await serve(G)
  yahoo = await serve(Y, { plain: true, folders: ['Work'] })
  smtp = new FakeSmtp(gmail.secret)
  await smtp.listen()
  folder = mkdtempSync(join(tmpdir(), 'xrnmail-accounts-'))
  store = new Store(':memory:')
  secrets = new MemorySecrets()
  post = vi.fn()
  records = undefined
  service = make()
  service.saveBatch({ ...service.settings().batch, times: [] })
})

afterEach(async () => {
  await vi.waitFor(() => expect(service.accounts().every((a) => !a.syncing)).toBe(true), { timeout: 15_000, interval: 15 })
  await new Promise((resolve) => setTimeout(resolve, 20))
  store.close()
  await Promise.all(servers.map((s) => s.stop()))
  await smtp.stop()
  rmSync(folder, { recursive: true, force: true })
})

describe('accounts on different services', () => {
  it('shows them in one inbox, and each on its own', async () => {
    gmail.add(rawMail({ subject: 'From Gmail' }), { arrived: new Date(at(9)) })
    yahoo.add(rawMail({ subject: 'From Yahoo' }), { arrived: new Date(at(9, 30)) })
    await add(G, gmail)
    await add(Y, yahoo)
    expect(subjects(service.list({ kind: 'inbox' }))).toEqual(['From Gmail', 'From Yahoo'])
    expect(subjects(service.list({ kind: 'inbox', account: Y }))).toEqual(['From Yahoo'])
    expect(service.accounts().map((a) => [a.providerName, a.labels, a.unread])).toEqual([['Gmail', true, 1], ['Yahoo', false, 1]])
  })

  it('tells a server by what it does, not by what it was called', async () => {
    await add('me@company.example', await serve('me@company.example'), {
      provider: 'other', imap: { host: 'imap.gmail.com', port: 993, security: 'tls' }, smtp: { host: 'smtp.gmail.com', port: 465, security: 'tls' }
    })
    expect(service.accounts().find((a) => a.email === 'me@company.example')).toMatchObject({ labels: true, provider: 'other' })
  })

  it('never takes a server without encryption, whatever the page sends', async () => {
    const custom = { email: 'me@company.example', secret: 'x', provider: 'other', smtp: { host: 'mail.company.example', port: 587, security: 'starttls' as const } }
    await expect(service.addAccount({ ...custom, imap: { host: 'mail.company.example', port: 143, security: 'none' as never } })).rejects.toThrow('Check the incoming server')
    await expect(service.addAccount({ ...custom, imap: { host: 'evil host', port: 993, security: 'tls' } })).rejects.toThrow('Check the incoming server')
    await expect(service.addAccount({ ...custom, imap: { host: 'mail.company.example', port: 70000, security: 'tls' } })).rejects.toThrow('Check the incoming server')
  })

  it('says when mail can be read but not sent, and keeps nothing', async () => {
    smtp.secret = 'something else'
    await expect(service.addAccount({ email: Y, secret: yahoo.secret, provider: 'yahoo' })).rejects.toThrow("Yahoo wouldn't sign in to send")
    expect(service.accounts()).toEqual([])
    expect(secrets.get(`account:${Y}`)).toBeNull()
  })

  it('reads every folder, and skips what only collects other mail', async () => {
    yahoo.add(rawMail({ subject: 'Filed' }), { box: 'Work', arrived: new Date(at(8)) })
    yahoo.add(rawMail({ subject: 'Half written' }), { box: 'Drafts', arrived: new Date(at(8)) })
    await add(Y, yahoo)
    expect(service.accounts()[0]?.folders).toEqual(['Work'])
    expect(subjects(service.list({ kind: 'label', account: Y, label: 'Work' }))).toEqual(['Filed'])
    expect(service.list({ kind: 'all' }).map((r) => r.subject)).toEqual(['Filed'])
  })

  it('makes threads where the server has none, across folders', async () => {
    const first = rawMail({ subject: 'Plan' }).replace(/Message-ID: .*/, 'Message-ID: <first@x>')
    const second = rawMail({ subject: 'Re: Plan', from: 'Me <me@yahoo.com>', headers: ['In-Reply-To: <first@x>', 'References: <first@x>'] })
    const third = rawMail({ subject: 'Re: Plan', headers: ['In-Reply-To: <other@x>', 'References: <first@x> <other@x>'] })
    yahoo.add(first, { arrived: new Date(at(8)) })
    yahoo.add(second, { box: 'Sent', flags: ['\\Seen'], arrived: new Date(at(9)) })
    yahoo.add(third, { arrived: new Date(at(9, 30)) })
    await add(Y, yahoo)
    expect(service.list({ kind: 'all' })).toHaveLength(1)
    const [row] = service.list({ kind: 'all' })
    expect(service.thread(Y, row?.thread ?? '').map((m) => m.subject)).toEqual(['Plan', 'Re: Plan', 'Re: Plan'])
  })

  it('shows a copy in two folders once', async () => {
    const raw = rawMail({ subject: 'To myself', from: 'Me <me@yahoo.com>', to: Y })
    yahoo.add(raw, { arrived: new Date(at(8)) })
    yahoo.add(raw, { box: 'Sent', flags: ['\\Seen'], arrived: new Date(at(8)) })
    await add(Y, yahoo)
    const [row] = service.list({ kind: 'inbox' })
    expect(service.thread(Y, row?.thread ?? '')).toHaveLength(1)
  })

  it('never writes while syncing a server with folders', async () => {
    yahoo.add(rawMail({ subject: 'One' }), { arrived: new Date(at(8)) })
    yahoo.add(rawMail({ subject: 'Two' }), { box: 'Work', arrived: new Date(at(8)) })
    await add(Y, yahoo)
    await service.syncAll()
    expect(yahoo.writes()).toEqual([])
    expect(yahoo.commands).not.toContain('TOUCHED-SEEN')
  })

  it('a folder renumbering itself starts only that folder over', async () => {
    yahoo.add(rawMail({ subject: 'Stays' }), { arrived: new Date(at(8)) })
    yahoo.add(rawMail({ subject: 'Comes back' }), { box: 'Work', arrived: new Date(at(8)) })
    await add(Y, yahoo)
    const stays = service.list({ kind: 'inbox' })[0]
    yahoo.box('Work').uidValidity = 9
    await service.syncAll()
    expect(subjects(service.list({ kind: 'all' }))).toEqual(['Comes back', 'Stays'])
    expect(service.list({ kind: 'inbox' })[0]).toEqual(stays)
  })

  it('leaves a folder that will not be searched as it was, and reads the rest', async () => {
    yahoo.add(rawMail({ subject: 'Filed' }), { box: 'Work', arrived: new Date(at(8)) })
    await add(Y, yahoo)
    yahoo.refuseSearch.add('Work')
    yahoo.add(rawMail({ subject: 'New' }), { arrived: new Date(at(10, 1)) })
    clock = at(10, 2)
    await service.syncAll()
    expect(service.accounts()[0]?.error).toBeNull()
    expect(subjects(service.list({ kind: 'all' }))).toEqual(['Filed', 'New'])
  })

  it('forgets a folder the server stopped listing', async () => {
    yahoo.add(rawMail({ subject: 'Old' }), { box: 'Work', arrived: new Date(at(8)) })
    await add(Y, yahoo)
    yahoo.boxes = yahoo.boxes.filter((b) => b.path !== 'Work')
    await service.syncAll()
    expect(service.list({ kind: 'all' })).toEqual([])
    expect(service.accounts()[0]?.folders).toEqual([])
  })

  it('finds out about flags on a server that cannot say what changed', async () => {
    const plain = await serve(Y, { plain: true, condstore: false })
    const uid = plain.add(rawMail({ subject: 'Read elsewhere' }), { arrived: new Date(at(8)) })
    await add(Y, plain)
    expect(service.list({ kind: 'inbox' })[0]?.unread).toBe(1)
    plain.change(uid, [], ['\\Seen', '\\Flagged'])
    await service.syncAll()
    expect(service.list({ kind: 'inbox' })[0]).toMatchObject({ unread: 0, starred: true })
  })

  it('only Gmail says what is important: elsewhere nothing is, not even mail in a folder called Important', async () => {
    gmail.add(rawMail({ subject: 'Gmail thinks so' }), { arrived: new Date(at(9)), labels: ['\\Inbox', '\\Important'] })
    const plain = await serve(Y, { plain: true, folders: ['Important'] })
    plain.add(rawMail({ subject: 'In the inbox' }), { arrived: new Date(at(8)) })
    plain.add(rawMail({ subject: 'Filed as important' }), { box: 'Important', arrived: new Date(at(8)) })
    await add(G, gmail)
    await add(Y, plain)
    const marked = service.list({ kind: 'all' }).map((r) => [r.subject, r.important]).sort()
    expect(marked).toEqual([['Filed as important', false], ['Gmail thinks so', true], ['In the inbox', false]])
    const [yahooThread] = service.list({ kind: 'inbox', account: Y })
    expect(() => service.act(yahooThread ? [yahooThread] : [], { kind: 'label', label: '\\Important', add: true })).toThrow('Only Gmail has labels')
  })
})

describe('changes on a server with folders', () => {
  beforeEach(async () => {
    yahoo.add(rawMail({ subject: 'Letter' }), { arrived: new Date(at(8)) })
    await add(Y, yahoo)
  })

  const thread = (): { account: string; thread: string } => {
    const [row] = service.list({ kind: 'all' })
    return { account: Y, thread: row?.thread ?? '' }
  }

  it('archives by moving, and follows the message to its new UID', async () => {
    const ref = thread()
    service.act([ref], { kind: 'archive' })
    expect(service.list({ kind: 'inbox' })).toEqual([])
    await flushed()
    expect(yahoo.box('INBOX').mails).toEqual([])
    expect(yahoo.box('Archive').mails).toHaveLength(1)
    await service.syncAll()
    expect(subjects(service.list({ kind: 'all' }))).toEqual(['Letter']) // not fetched a second time
    expect(store.uids(Y, '@inbox').size).toBe(0)
    expect(store.uids(Y, '@archive').size).toBe(1)
  })

  it('a star queued behind an archive reaches the moved message', async () => {
    const ref = thread()
    service.act([ref], { kind: 'archive' })
    service.act([ref], { kind: 'star' })
    await flushed()
    await vi.waitFor(() => expect(yahoo.box('Archive').mails[0]?.flags).toContain('\\Flagged'), { timeout: 15_000, interval: 15 })
  })

  it('makes an Archive folder if the service has none', async () => {
    const bare = await serve(Y, { plain: true, noArchiveFolder: true })
    bare.add(rawMail({ subject: 'Letter' }), { arrived: new Date(at(8)) })
    service.removeAccount(Y)
    await add(Y, bare)
    service.act([thread()], { kind: 'archive' })
    await flushed()
    expect(bare.box('Archive').mails).toHaveLength(1)
    await service.syncAll()
    expect(subjects(service.list({ kind: 'all' }))).toEqual(['Letter'])
  })

  it('leaves your own copy in Sent when a thread is archived', async () => {
    const sent = rawMail({ subject: 'Re: Letter', from: 'Me <me@yahoo.com>' })
    const message = yahoo.mails[0]?.raw.toString() ?? ''
    const id = /Message-ID: (<.*?>)/.exec(message)?.[1] ?? ''
    yahoo.add(sent.replace('MIME-Version', `References: ${id}\nMIME-Version`), { box: 'Sent', flags: ['\\Seen'], arrived: new Date(at(9)) })
    await service.syncAll()
    service.act([thread()], { kind: 'archive' })
    await flushed()
    expect(yahoo.box('Sent').mails).toHaveLength(1)
    expect(yahoo.box('Archive').mails).toHaveLength(1)
  })

  it('moves to a folder, and refuses one that is not there', async () => {
    const ref = thread()
    expect(() => service.act([ref], { kind: 'move', to: 'Nowhere' })).toThrow("isn't there")
    service.act([ref], { kind: 'move', to: 'Work' })
    expect(subjects(service.list({ kind: 'label', account: Y, label: 'Work' }))).toEqual(['Letter'])
    await flushed()
    expect(yahoo.box('Work').mails).toHaveLength(1)
    await service.syncAll()
    expect(subjects(service.list({ kind: 'label', account: Y, label: 'Work' }))).toEqual(['Letter'])
  })

  it('has no labels to add, and says so', () => {
    expect(() => service.act([thread()], { kind: 'label', label: 'x', add: true })).toThrow('Only Gmail has labels')
  })

  it('deletes to Trash, shows it there, and brings it back', async () => {
    const ref = thread()
    service.act([ref], { kind: 'trash' })
    expect(service.list({ kind: 'inbox' })).toEqual([])
    expect(subjects(service.list({ kind: 'trash' }))).toEqual(['Letter'])
    await flushed()
    expect(yahoo.box('Trash').mails).toHaveLength(1)
    expect(service.thread(Y, ref.thread)).toEqual([]) // an ordinary view doesn't show Trash
    expect(service.thread(Y, ref.thread, true).map((m) => m.subject)).toEqual(['Letter'])
    service.act([ref], { kind: 'inbox' })
    expect(subjects(service.list({ kind: 'inbox' }))).toEqual(['Letter'])
    await flushed()
    expect(yahoo.box('INBOX').mails).toHaveLength(1)
    expect(yahoo.box('Trash').mails).toEqual([])
  })

  it('undoing before the server hears costs nothing', async () => {
    const token = service.act([thread()], { kind: 'trash' })
    service.undo(token)
    await flushed()
    expect(yahoo.box('INBOX').mails).toHaveLength(1)
    expect(subjects(service.list({ kind: 'inbox' }))).toEqual(['Letter'])
  })

  it('deletes for good only from a bin', async () => {
    const ref = thread()
    service.act([ref], { kind: 'forever' })
    await flushed()
    expect(yahoo.box('INBOX').mails).toHaveLength(1) // not in a bin, so nothing happened
    service.act([ref], { kind: 'trash' })
    await flushed()
    service.act([ref], { kind: 'forever' })
    expect(service.list({ kind: 'trash' })).toEqual([])
    await flushed()
    expect(yahoo.box('Trash').mails).toEqual([])
    await service.syncAll()
    expect(service.list({ kind: 'trash' })).toEqual([])
  })

  it('puts a change back in its old place when the server keeps refusing', async () => {
    yahoo.refuseWrites = true
    service.act([thread()], { kind: 'archive' })
    for (let i = 0; i < 3; i++) await flushedOrRetried()
    expect(subjects(service.list({ kind: 'inbox' }))).toEqual(['Letter'])
    expect(service.accounts()[0]?.error).toContain("wouldn't make a change")
  })

  const flushedOrRetried = async (): Promise<void> => {
    clock += 61_000
    await service.tick()
    await new Promise((resolve) => setTimeout(resolve, 60))
  }
})

describe('making a folder or a label', () => {
  it('makes a folder on a folder server, lists it at once, and reads it from then on', async () => {
    await add(Y, yahoo)
    expect(service.accounts().find((a) => a.email === Y)?.folders).toEqual(['Work'])
    expect(await service.createFolder(Y, ' Receipts ')).toBe('Receipts')
    expect(yahoo.commands.filter((c) => c.startsWith('CREATE'))).toEqual(['CREATE Receipts'])
    expect(service.accounts().find((a) => a.email === Y)?.folders).toEqual(['Work', 'Receipts'])
    yahoo.add(rawMail({ subject: 'Filed there' }), { box: 'Receipts', arrived: new Date(at(9)) })
    await service.syncAll()
    expect(subjects(service.list({ kind: 'label', account: Y, label: 'Receipts' }))).toEqual(['Filed there'])
    expect(await service.createFolder(Y, 'Work/Plans')).toBe('Work/Plans') // inside another, with the server's own separator
    await expect(service.createFolder(Y, 'receipts')).rejects.toThrow("There's a folder called that already.")
  })

  it('makes a Gmail label, empty, and keeps it listed from what Gmail says', async () => {
    gmail.labels = ['Travel']
    await add(G, gmail)
    expect(service.accounts().find((a) => a.email === G)?.folders).toEqual(['Travel']) // the service's own folders aren't labels
    expect(await service.createFolder(G, 'Work/Plans')).toBe('Work/Plans')
    expect(gmail.labels).toEqual(['Travel', 'Work/Plans'])
    expect(service.accounts().find((a) => a.email === G)?.folders).toEqual(['Travel', 'Work/Plans'])
    const ref = { account: G, thread: (gmail.add(rawMail({ subject: 'Plans' }), { arrived: new Date(at(9)) }), '') }
    await service.syncAll()
    const [row] = service.list({ kind: 'inbox', account: G })
    service.act([{ ...ref, thread: row?.thread ?? '' }], { kind: 'label', label: 'Work/Plans', add: true })
    await flushed()
    expect(gmail.mails.at(-1)?.labels).toContain('Work/Plans')
    gmail.labels = ['Work/Plans'] // Travel taken away elsewhere
    await service.syncAll()
    expect(service.accounts().find((a) => a.email === G)?.folders).toEqual(['Work/Plans'])
  })

  it('turns down a name that can\'t be one, or the service\'s own, before asking the server', async () => {
    await add(G, gmail)
    await expect(service.createFolder(G, '  ')).rejects.toThrow('Give the label a name.')
    await expect(service.createFolder(G, 'Work//Plans')).rejects.toThrow('Leave no part of the name empty')
    await expect(service.createFolder(G, 'Deals*')).rejects.toThrow('Leave out')
    await expect(service.createFolder(G, 'INBOX/Mine')).rejects.toThrow("INBOX is the service's own.")
    await expect(service.createFolder(G, '[Gmail]/Mine')).rejects.toThrow("[Gmail] is the service's own.")
    await expect(service.createFolder('nobody@example.com', 'Mine')).rejects.toThrow('That account is gone.')
    expect(gmail.commands.filter((c) => c.startsWith('CREATE'))).toEqual([])
  })

  it('says so when the server refuses, and keeps nothing', async () => {
    await add(Y, yahoo)
    yahoo.refuseWrites = true
    await expect(service.createFolder(Y, 'Receipts')).rejects.toThrow("wouldn't make that folder.")
    expect(service.accounts().find((a) => a.email === Y)?.folders).toEqual(['Work'])
  })
})

describe('servers that lack the convenient parts', () => {
  it('copes without UIDPLUS: the message is found again on the next sync', async () => {
    const plain = await serve(Y, { plain: true, uidplus: false })
    plain.add(rawMail({ subject: 'Letter' }), { arrived: new Date(at(8)) })
    await add(Y, plain)
    const [row] = service.list({ kind: 'all' })
    service.act([{ account: Y, thread: row?.thread ?? '' }], { kind: 'archive' })
    await flushed()
    expect(plain.box('Archive').mails).toHaveLength(1)
    await service.syncAll()
    expect(subjects(service.list({ kind: 'all' }))).toEqual(['Letter'])
    expect(store.uids(Y, '@archive').size).toBe(1)
  })

  it('copes without MOVE: it copies and deletes', async () => {
    const plain = await serve(Y, { plain: true, move: false })
    plain.add(rawMail({ subject: 'Letter' }), { arrived: new Date(at(8)) })
    await add(Y, plain)
    const [row] = service.list({ kind: 'all' })
    service.act([{ account: Y, thread: row?.thread ?? '' }], { kind: 'trash' })
    await flushed()
    expect(plain.box('Trash').mails).toHaveLength(1)
    expect(plain.box('INBOX').mails).toEqual([])
    await service.syncAll()
    expect(subjects(service.list({ kind: 'trash' }))).toEqual(['Letter'])
  })
})

describe('Gmail: Trash and Spam', () => {
  beforeEach(async () => {
    gmail.add(rawMail({ subject: 'Letter', from: 'Ada <ada@example.com>' }), { arrived: new Date(at(8)) })
    gmail.add(rawMail({ subject: 'Junk', from: 'Spammer <bad@spam.example>' }), { box: '[Gmail]/Spam', arrived: new Date(at(8)) })
    gmail.add(rawMail({ subject: 'Thrown out' }), { box: '[Gmail]/Trash', arrived: new Date(at(8)) })
    await add(G, gmail)
  })

  it('reads them, and keeps them out of everything ordinary', () => {
    expect(subjects(service.list({ kind: 'spam' }))).toEqual(['Junk'])
    expect(subjects(service.list({ kind: 'trash' }))).toEqual(['Thrown out'])
    expect(subjects(service.list({ kind: 'all' }))).toEqual(['Letter'])
    expect(service.list({ kind: 'search', text: 'junk' })).toEqual([])
    expect(service.contacts('spammer')).toEqual([])
  })

  it('moves to Trash under a new UID, and restores to the inbox', async () => {
    const [row] = service.list({ kind: 'inbox' })
    const ref = { account: G, thread: row?.thread ?? '' }
    service.act([ref], { kind: 'trash' })
    await flushed()
    expect(gmail.mails).toEqual([])
    expect(gmail.box('[Gmail]/Trash').mails).toHaveLength(2)
    expect(subjects(service.list({ kind: 'trash' }))).toEqual(['Letter', 'Thrown out'])
    await service.syncAll()
    expect(subjects(service.list({ kind: 'trash' }))).toEqual(['Letter', 'Thrown out'])
    service.act([ref], { kind: 'inbox' })
    await flushed()
    await service.syncAll()
    expect(gmail.mails[0]?.labels).toContain('\\Inbox')
    expect(subjects(service.list({ kind: 'inbox' }))).toEqual(['Letter'])
    expect(subjects(service.list({ kind: 'trash' }))).toEqual(['Thrown out'])
  })

  // INBOX isn't read on Gmail, so a thread moved there from Trash lost its row, and was in neither
  // Trash nor the inbox until the next sync found it in All Mail under its new UID.
  it('a thread brought back from Trash or Spam is in the inbox at once, and stays there through the next sync', async () => {
    for (const kind of ['trash', 'spam'] as const) {
      const [row] = service.list({ kind })
      service.act([{ account: G, thread: row?.thread ?? '' }], { kind: 'inbox' })
      await flushed()
      expect(service.list({ kind })).toEqual([])
    }
    expect(subjects(service.list({ kind: 'inbox' }))).toEqual(['Junk', 'Letter', 'Thrown out'])
    expect(gmail.box('[Gmail]/Trash').mails).toEqual([])
    expect(gmail.box('[Gmail]/Spam').mails).toEqual([])
    expect(gmail.mails.filter((m) => m.labels.includes('\\Inbox'))).toHaveLength(3)
    await service.syncAll()
    expect(subjects(service.list({ kind: 'inbox' }))).toEqual(['Junk', 'Letter', 'Thrown out'])
    expect(store.uids(G, '@all').size).toBe(3)
  })

  it('says "not spam" by moving it back', async () => {
    const [row] = service.list({ kind: 'spam' })
    service.act([{ account: G, thread: row?.thread ?? '' }], { kind: 'inbox' })
    await flushed()
    await service.syncAll()
    expect(subjects(service.list({ kind: 'inbox' }))).toEqual(['Junk', 'Letter'])
    expect(service.list({ kind: 'spam' })).toEqual([])
  })

  it('deletes for good from Trash, with an EXPUNGE only there', async () => {
    const [row] = service.list({ kind: 'trash' })
    service.act([{ account: G, thread: row?.thread ?? '' }], { kind: 'forever' })
    await flushed()
    expect(gmail.box('[Gmail]/Trash').mails).toEqual([])
    expect(gmail.mails).toHaveLength(1)
  })

  it('spam does not count as mail waiting', async () => {
    service.saveBatch({ ...service.settings().batch, live: false, times: ['17:00'] })
    gmail.add(rawMail({ subject: 'More junk' }), { box: '[Gmail]/Spam', arrived: new Date(at(10, 1)) })
    clock = at(10, 2)
    await service.syncAll()
    expect(service.overview().held).toBe(0)
  })
})

describe('sending from a service', () => {
  const send = async (email: string): Promise<void> => {
    const draft = await service.startDraft({ kind: 'new', account: email })
    service.saveDraft(draft.id, { account: email, from: '', to: 'ada@example.com', cc: '', bcc: 'hidden@example.com', subject: 'Note', html: '<p>Hi</p>', text: 'Hi', quote: null })
    service.send(draft.id)
    clock += 11_000
    await service.tick()
  }

  it('files a copy in Sent where the service does not, keeping the Bcc there only', async () => {
    await add(Y, yahoo)
    await send(Y)
    await vi.waitFor(() => expect(yahoo.box('Sent').mails).toHaveLength(1), { timeout: 15_000, interval: 15 })
    expect(smtp.sent).toHaveLength(1)
    expect(smtp.sent[0]?.to).toContain('hidden@example.com')
    expect(smtp.sent[0]?.raw).not.toMatch(/^Bcc:/im)
    expect(yahoo.box('Sent').mails[0]?.raw.toString()).toMatch(/^Bcc: hidden@example.com/im)
    await vi.waitFor(() => expect(subjects(service.list({ kind: 'sent' }))).toEqual(['Note']), { timeout: 15_000, interval: 15 })
  })

  it('does not file a second copy when the service already did', async () => {
    await add(Y, yahoo)
    smtp.delivered = (raw) => void yahoo.add(raw, { box: 'Sent', flags: ['\\Seen'], arrived: new Date(clock) })
    await send(Y)
    await vi.waitFor(() => expect(subjects(service.list({ kind: 'sent' }))).toEqual(['Note']), { timeout: 15_000, interval: 15 })
    expect(yahoo.box('Sent').mails).toHaveLength(1)
    expect(yahoo.commands.filter((c) => c.startsWith('APPEND'))).toEqual([])
  })

  it('never touches Sent on Gmail, which files its own', async () => {
    await add(G, gmail)
    await send(G)
    await vi.waitFor(() => expect(smtp.sent).toHaveLength(1), { timeout: 15_000, interval: 15 })
    expect(gmail.commands.filter((c) => c.startsWith('APPEND'))).toEqual([])
  })

  it('a failed copy costs the copy, and never sends again', async () => {
    await add(Y, yahoo)
    yahoo.refuseWrites = true
    await send(Y)
    await vi.waitFor(() => expect(service.accounts()[0]?.error).toContain('no copy could be kept'), { timeout: 15_000, interval: 15 })
    clock += 120_000
    await service.tick()
    expect(smtp.received).toBe(1)
    expect(service.drafts()).toEqual([])
  })
})

describe('aliases', () => {
  const identity = { name: 'Me', signature: '', aliases: ['work@me.example'], color: '', notify: true }

  it('sends from an alias, and from nothing that is not yours', async () => {
    await add(Y, yahoo)
    service.saveProfile({ identities: { [Y]: identity } })
    const draft = await service.startDraft({ kind: 'new', account: Y })
    const edit = { account: Y, to: 'ada@example.com', cc: '', bcc: '', subject: 'x', html: 'y', text: 'y', quote: null }
    service.saveDraft(draft.id, { ...edit, from: 'ceo@bigbank.example' })
    expect(() => service.send(draft.id)).toThrow("isn't on this account")
    service.saveDraft(draft.id, { ...edit, from: 'work@me.example' })
    service.send(draft.id)
    clock += 11_000
    await service.tick()
    expect(smtp.sent[0]?.from).toBe('work@me.example')
  })

  it('answers from the address the mail came to, and leaves your others off a reply all', async () => {
    yahoo.add(rawMail({ subject: 'Hi', to: 'work@me.example, bo@example.com', headers: [`Cc: ${Y}`] }), { arrived: new Date(at(8)) })
    await add(Y, yahoo)
    service.saveProfile({ identities: { [Y]: identity } })
    const [row] = service.list({ kind: 'inbox' })
    const [message] = service.thread(Y, row?.thread ?? '')
    const draft = await service.startDraft({ kind: 'replyAll', message: message?.id ?? 0 })
    expect(draft.from).toBe('work@me.example')
    expect(draft.cc).toBe('bo@example.com')
  })
})

describe('Outlook sign-in', () => {
  const CLIENT = '11111111-2222-3333-4444-555555555555'
  const O = 'me@outlook.com'
  const json = (body: unknown, ok = true, status = ok ? 200 : 400): unknown => ({ ok, status, json: async () => body })
  let outlook: FakeGmail

  /** [refresh] is the answer to a renewal, or makes one from what was sent. */
  const microsoft = (handlers: { poll?: unknown[]; refresh?: unknown } = {}): void => {
    const polls = [...(handlers.poll ?? [json({ access_token: 'token-1', refresh_token: 'renew-1', expires_in: 3600 })])]
    post.mockImplementation(async (url: string, init: { body: string }) => {
      if (url.endsWith('/devicecode')) return json({ device_code: 'dev', user_code: 'ABC-123', verification_uri: 'https://microsoft.com/devicelogin', interval: 0, expires_in: 900 })
      if (init.body.includes('grant_type=refresh_token')) {
        return typeof handlers.refresh === 'function' ? (handlers.refresh as (body: string) => unknown)(init.body) : handlers.refresh
      }
      return polls.shift()
    })
  }

  beforeEach(async () => {
    outlook = await serve(O, { plain: true, token: 'token-1' })
    smtp.token = 'token-1'
  })

  it('signs in with a code on Microsoft\'s page, and never a password', async () => {
    outlook.add(rawMail({ subject: 'From Outlook' }), { arrived: new Date(at(8)) })
    microsoft({ poll: [json({ error: 'authorization_pending' }, false), json({ access_token: 'token-1', refresh_token: 'renew-1', expires_in: 3600 })] })
    const { code, url } = await service.startMicrosoft(O, CLIENT)
    expect({ code, url }).toEqual({ code: 'ABC-123', url: 'https://microsoft.com/devicelogin' })
    await service.finishMicrosoft()
    await settled(O)
    expect(subjects(service.list({ kind: 'inbox' }))).toEqual(['From Outlook'])
    expect(secrets.get(`account:${O}`)).toBe('renew-1')
    expect(outlook.commands.some((c) => c.startsWith('LOGIN'))).toBe(false)
    const [, init] = post.mock.calls.find(([u]) => String(u).endsWith('/devicecode')) ?? []
    expect((init as { redirect: string }).redirect).toBe('error')
    expect((init as { body: string }).body).toContain('IMAP.AccessAsUser.All')
  })

  it('refuses a password for it, and an application ID that is not one', async () => {
    await expect(service.addAccount({ email: O, secret: 'x', provider: 'outlook' })).rejects.toThrow('signs in with Microsoft')
    await expect(service.startMicrosoft(O, 'nonsense')).rejects.toThrow('application ID')
  })

  it('renews a token before it runs out, and keeps the new renewal', async () => {
    microsoft({ refresh: json({ access_token: 'token-2', refresh_token: 'renew-2', expires_in: 3600 }) })
    await service.startMicrosoft(O, CLIENT)
    await service.finishMicrosoft()
    await settled(O)
    outlook.options.token = 'token-2'
    clock += 3_600_000
    await service.syncAll()
    expect(service.accounts()[0]?.error).toBeNull()
    expect(secrets.get(`account:${O}`)).toBe('renew-2')
  })

  /** As Microsoft does: a renewal works only with the application ID the sign-in was given to. */
  const onlyFor = (clientId: string) => (body: string): unknown => body.includes(`client_id=${clientId}&`)
    ? json({ access_token: 'token-2', refresh_token: 'renew-2', expires_in: 3600 })
    : json({ error: 'invalid_grant' }, false)

  it('renews each account with the application ID it signed in with', async () => {
    microsoft({ refresh: onlyFor(CLIENT) })
    await service.startMicrosoft(O, CLIENT)
    await service.finishMicrosoft()
    await settled(O)
    await service.startMicrosoft('you@outlook.com', '99999999-8888-7777-6666-555555555555') // begun, and left
    outlook.options.token = 'token-2'
    clock += 3_600_000
    await service.syncAll()
    expect(service.accounts()[0]?.error).toBeNull()
  })

  it('an account from before each kept its own ID renews with the one in settings', async () => {
    microsoft({ refresh: onlyFor(CLIENT) })
    await service.startMicrosoft(O, CLIENT)
    await service.finishMicrosoft()
    await settled(O)
    const { clientId: _kept, ...before } = JSON.parse(store.meta(`config:${O}`) ?? '{}') as { clientId?: string }
    store.setMeta(`config:${O}`, JSON.stringify(before))
    store.setMeta('settings', JSON.stringify({ ...service.settings(), microsoftClientId: CLIENT }))
    outlook.options.token = 'token-2'
    clock += 3_600_000
    await service.syncAll()
    expect(service.accounts()[0]?.error).toBeNull()
  })

  it('asks to sign in again once Microsoft stops renewing, and keeps mail safe', async () => {
    outlook.add(rawMail({ subject: 'Kept' }), { arrived: new Date(at(8)) })
    microsoft({ refresh: json({ error: 'invalid_grant' }, false) })
    await service.startMicrosoft(O, CLIENT)
    await service.finishMicrosoft()
    await settled(O)
    clock += 3_600_000
    await service.syncAll()
    expect(service.accounts()[0]?.error).toBe('Sign in to this account again.')
    expect(subjects(service.list({ kind: 'inbox' }))).toEqual(['Kept'])
  })

  it('waits out a Microsoft that is busy or rate-limited, with mail due to go still queued', async () => {
    let renewal = json({ error: 'temporarily_unavailable' }, false, 503)
    microsoft({ refresh: () => renewal })
    await service.startMicrosoft(O, CLIENT)
    await service.finishMicrosoft()
    await settled(O)
    const draft = await service.startDraft({ kind: 'new', account: O })
    service.saveDraft(draft.id, { account: O, from: '', to: 'ada@example.com', cc: '', bcc: '', subject: 'Note', html: 'Hi', text: 'Hi', quote: null })
    clock += 3_600_000 // the token has run out
    service.send(draft.id)
    clock += 11_000
    await service.tick()
    expect(service.drafts()[0]).toMatchObject({ state: 'queued', error: 'Waiting for a connection.' })
    renewal = json({}, false, 429)
    await service.syncAll()
    expect(service.accounts()[0]?.error).toBe("Couldn't reach Outlook.")
    renewal = json({ access_token: 'token-2', refresh_token: 'renew-2', expires_in: 3600 })
    outlook.options.token = 'token-2'
    smtp.token = 'token-2'
    clock += 61_000
    await service.tick()
    await vi.waitFor(() => expect(smtp.sent).toHaveLength(1), { timeout: 15_000, interval: 15 })
    expect(service.drafts()).toEqual([])
  })

  it('a declined sign-in keeps nothing', async () => {
    microsoft({ poll: [json({ error: 'authorization_declined' }, false)] })
    await service.startMicrosoft(O, CLIENT)
    await expect(service.finishMicrosoft()).rejects.toThrow('declined')
    expect(service.accounts()).toEqual([])
  })

  // slow_down was taken as "not yet" and the next poll came as soon as ever. RFC 8628 says each one
  // adds 5 seconds to the wait from then on, and a client that keeps on may be refused.
  it('waits 5 seconds longer each time Microsoft asks it to slow down', async () => {
    const code: DeviceCode = { deviceCode: 'dev', userCode: 'ABC-123', url: 'https://microsoft.com/devicelogin', intervalMs: 5000, expiresAt: Infinity }
    const answers = [json({ error: 'slow_down' }, false), json({ error: 'authorization_pending' }, false), json({ error: 'slow_down' }, false)]
    const asked = vi.fn(async () => answers.shift())
    const waits: number[] = []
    for (let i = 0; i < 3; i++) {
      expect(await pollDeviceCode(asked as unknown as typeof fetch, CLIENT, code, 0)).toBeNull()
      waits.push(code.intervalMs)
    }
    expect(waits).toEqual([10_000, 10_000, 15_000])
  })
})

describe('working out the service behind an address', () => {
  const lookup = (mx: string[], srv: Record<string, { name: string; port: number }> = {}): DomainRecords => ({
    mx: async () => mx,
    srv: async (name) => srv[name] ?? null
  })

  it('knows the big names without asking anyone', async () => {
    records = { mx: async () => { throw new Error('not asked') }, srv: async () => null }
    service = make()
    expect(await service.detectProvider('a@hotmail.com')).toEqual({ provider: 'outlook' })
    expect(await service.detectProvider('a@icloud.com')).toEqual({ provider: 'icloud' })
  })

  it('finds a big service behind a domain of its own', async () => {
    records = lookup(['aspmx.l.google.com'])
    service = make()
    expect(await service.detectProvider('me@company.example')).toEqual({ provider: 'gmail' })
    records = lookup(['company-example.mail.protection.outlook.com'])
    service = make()
    expect(await service.detectProvider('me@company.example')).toEqual({ provider: 'outlook' })
  })

  it('uses a domain\'s published mail servers', async () => {
    records = lookup(['mx.company.example'], {
      '_imaps._tcp.company.example': { name: 'imap.company.example', port: 993 },
      '_submission._tcp.company.example': { name: 'smtp.company.example', port: 587 }
    })
    service = make()
    expect(await service.detectProvider('me@company.example')).toEqual({
      provider: 'other',
      imap: { host: 'imap.company.example', port: 993, security: 'tls' },
      smtp: { host: 'smtp.company.example', port: 587, security: 'starttls' }
    })
  })

  it('a failed lookup is only a form left blank', async () => {
    records = { mx: async () => { throw new Error('no network') }, srv: async () => null }
    service = make()
    expect(await service.detectProvider('me@company.example')).toEqual({ provider: 'other' })
  })
})

describe('threads without a server to ask', () => {
  it('follows a chain back to its first message', () => {
    const first = threadOf('', '', '<a@x>', 'f')
    expect(threadOf('<a@x>', '<a@x>', '<b@x>', 'f')).toBe(first)
    expect(threadOf('<a@x> <b@x>', '<b@x>', '<c@x>', 'f')).toBe(first)
    expect(threadOf('', '<a@x>', '<d@x>', 'f')).toBe(first)
  })

  it('keeps messages with no id apart', () => {
    expect(threadOf('', '', '', 'box:1')).not.toBe(threadOf('', '', '', 'box:2'))
  })
})

describe('held mail in everything the Assistant added', () => {
  const held = (over: Parameters<typeof rawMail>[0]): string => rawMail({ from: 'Shop <hi@shop.example>', ...over })
  const list = ['List-Unsubscribe: <https://list.example/u>']

  beforeEach(async () => {
    await add(G, gmail)
    service.saveBatch({ ...service.settings().batch, live: false, times: ['17:00'] })
    gmail.now = () => new Date(at(10, 1))
    clock = at(10, 2)
    gmail.add(held({ subject: 'Your order has shipped', text: '1Z999AA10123456784' }))
    gmail.add(held({ subject: 'Weekly deals', headers: list }))
    gmail.add(held({ subject: 'Junk that came now' }), { box: '[Gmail]/Spam' })
    gmail.add(held({ subject: 'Binned on the phone' }), { box: '[Gmail]/Trash' })
    await service.syncAll()
  })

  it('shows none of it until it lands, and then all of it', async () => {
    const lists = (): number[] => [
      service.list({ kind: 'assistant', section: 'packages' }).length,
      service.list({ kind: 'inbox', focus: 'other' }).length,
      service.subscriptions().length
    ]
    expect(lists()).toEqual([0, 0, 0])
    expect(service.overview()).toMatchObject({ held: 2, otherUnread: 0 })
    expect(service.accounts()[0]?.unread).toBe(0)
    expect(service.list({ kind: 'search', text: 'shipped' })).toEqual([])
    expect(service.list({ kind: 'search', text: 'junk' })).toEqual([])
    clock = at(17, 1)
    expect(lists()).toEqual([1, 1, 1])
    expect(service.overview()).toMatchObject({ held: 0, otherUnread: 1 })
  })

  it('only holds the inbox: Spam and Trash are mail filed away, there at once and never searched', () => {
    expect(subjects(service.list({ kind: 'spam' }))).toEqual(['Junk that came now'])
    expect(subjects(service.list({ kind: 'trash' }))).toEqual(['Binned on the phone'])
    expect(service.list({ kind: 'search', text: 'junk' })).toEqual([])
  })

  it('won\'t answer or clear what hasn\'t landed', async () => {
    const ics = [
      'BEGIN:VCALENDAR', 'METHOD:REQUEST', 'BEGIN:VEVENT', 'UID:a@cal.example', 'DTSTART:20261201T090000Z', 'SUMMARY:Budget',
      'ORGANIZER:mailto:boss@cal.example', `ATTENDEE:mailto:${G}`, 'END:VEVENT', 'END:VCALENDAR'
    ].join('\r\n')
    gmail.add(held({ subject: 'Invitation', attachment: { name: 'invite.ics', type: 'text/calendar', body: ics } }))
    await service.syncAll()
    expect(service.overview().held).toBe(3)
    for (let id = 1; id <= 12; id++) expect(() => service.rsvp(id, 'ACCEPTED')).toThrow('nothing to answer')
    service.clearSender(G, 'hi@shop.example')
    await flushed()
    expect(gmail.mails).toHaveLength(3) // all still where they were
    expect(gmail.box('[Gmail]/Trash').mails).toHaveLength(1)
    clock = at(17, 1)
    const [row] = service.list({ kind: 'assistant', section: 'events' })
    expect(service.rsvp(service.thread(G, row?.thread ?? '')[0]?.id ?? 0, 'ACCEPTED').when).toBeGreaterThan(clock - 1)
  })
})

describe('Focused and Other', () => {
  const news = rawMail({ subject: 'Weekly deals', from: 'Deals <deals@shop.example>', headers: ['List-Unsubscribe: <https://list.example/u>'] })

  beforeEach(async () => {
    gmail.add(news, { arrived: new Date(at(8)) })
    gmail.add(rawMail({ subject: 'Lunch?', from: 'Bo <bo@example.com>' }), { arrived: new Date(at(9)) })
    await add(G, gmail)
  })

  it('splits the inbox, counts Other, and leaves the plain view whole', () => {
    expect(subjects(service.list({ kind: 'inbox', focus: 'focused' }))).toEqual(['Lunch?'])
    expect(subjects(service.list({ kind: 'inbox', focus: 'other' }))).toEqual(['Weekly deals'])
    expect(subjects(service.list({ kind: 'inbox' }))).toEqual(['Lunch?', 'Weekly deals'])
    expect(service.overview().otherUnread).toBe(1)
  })

  it('a sender you move stays moved, for what comes next too', async () => {
    service.setFocus('Deals@shop.example', true)
    expect(subjects(service.list({ kind: 'inbox', focus: 'other' }))).toEqual([])
    gmail.add(rawMail({ subject: 'More deals', from: 'Deals <deals@shop.example>', headers: ['List-Unsubscribe: <https://list.example/u>'] }), { arrived: new Date(at(10, 1)) })
    clock = at(10, 2)
    await service.syncAll()
    expect(subjects(service.list({ kind: 'inbox', focus: 'focused' }))).toEqual(['Lunch?', 'More deals', 'Weekly deals'])
    service.setFocus('bo@example.com', false)
    expect(subjects(service.list({ kind: 'inbox', focus: 'other' }))).toEqual(['Lunch?'])
    expect(service.settings()).toMatchObject({ alwaysFocused: ['deals@shop.example'], alwaysOther: ['bo@example.com'] })
  })

  it('each account counts its own Other, for its own inbox\'s tab', async () => {
    yahoo.add(rawMail({ subject: 'Lunch again', from: 'Bo <bo@example.com>' }), { arrived: new Date(at(9, 30)) })
    await add(Y, yahoo)
    const other = (email: string): number | undefined => service.accounts().find((a) => a.email === email)?.otherUnread
    expect([other(G), other(Y)]).toEqual([1, 0])
    yahoo.add(rawMail({ subject: 'Flash sale', from: 'Sale <sale@shop.example>', headers: ['List-Unsubscribe: <https://list.example/u>'] }), { arrived: new Date(at(9, 40)) })
    gmail.add(rawMail({ subject: 'Daily digest', from: 'Digest <digest@news.example>', headers: ['List-Id: <digest.news.example>'] }), { arrived: new Date(at(9, 45)) })
    await service.syncAll()
    expect([other(G), other(Y)]).toEqual([2, 1])
    expect(subjects(service.list({ kind: 'inbox' }))).toEqual(['Daily digest', 'Flash sale', 'Lunch again', 'Lunch?', 'Weekly deals'])
  })
})

describe('subscriptions', () => {
  const list = ['List-Unsubscribe: <mailto:out@shop.example>']

  beforeEach(async () => {
    gmail.add(rawMail({ subject: 'One', from: 'Shop <hi@shop.example>', headers: list }), { arrived: new Date(at(7)) })
    gmail.add(rawMail({ subject: 'Two', from: 'Shop <HI@shop.example>', headers: list }), { arrived: new Date(at(8)) })
    gmail.add(rawMail({ subject: 'Once', from: 'Blog <me@blog.example>', headers: list }), { arrived: new Date(at(9)) })
    gmail.add(rawMail({ subject: 'Person', from: 'Bo <bo@example.com>' }), { arrived: new Date(at(9)) })
    await add(G, gmail)
  })

  it('lists who mails in bulk, biggest first, across spellings', () => {
    expect(service.subscriptions().map((s) => [s.address, s.count])).toEqual([['hi@shop.example', 2], ['me@blog.example', 1]])
  })

  it('lists apart who was unsubscribed from, with what is still here from them', () => {
    const leave = (address: string): void => (service as unknown as { leftBehind(address: string): void }).leftBehind(address)
    expect(service.unsubscribed()).toEqual([])
    leave('HI@shop.example')
    leave('gone@news.example') // nothing from them is kept any more
    expect(service.subscriptions().map((s) => s.address)).toEqual(['me@blog.example'])
    expect(service.unsubscribed().map((s) => [s.address, s.count, s.account])).toEqual([['hi@shop.example', 2, G], ['gone@news.example', 0, '']])
  })

  it('clears a sender with one Undo, and nobody else', async () => {
    const token = service.clearSender(G, 'hi@shop.example')
    expect(subjects(service.list({ kind: 'inbox' }))).toEqual(['Once', 'Person'])
    service.undo(token)
    expect(subjects(service.list({ kind: 'inbox' }))).toEqual(['Once', 'One', 'Person', 'Two'])
    service.clearSender(G, 'hi@shop.example')
    await flushed()
    expect(gmail.box('[Gmail]/Trash').mails).toHaveLength(2)
    expect(service.subscriptions().map((s) => s.address)).toEqual(['me@blog.example'])
  })
})

describe('answering an invitation', () => {
  const ics = (organizer: string): string => [
    'BEGIN:VCALENDAR', 'METHOD:REQUEST', 'BEGIN:VEVENT', 'UID:abc@cal.example', 'DTSTART:20261201T090000Z',
    'SUMMARY:Budget', `ORGANIZER:mailto:${organizer}`, `ATTENDEE:mailto:${Y}`, 'END:VEVENT', 'END:VCALENDAR'
  ].join('\r\n')
  const invited = async (organizer: string): Promise<number> => {
    yahoo.add(rawMail({ subject: 'Invitation', to: Y, attachment: { name: 'invite.ics', type: 'text/calendar', body: ics(organizer) } }), { arrived: new Date(at(8)) })
    await add(Y, yahoo)
    const [row] = service.list({ kind: 'assistant', section: 'events' })
    return service.thread(Y, row?.thread ?? '')[0]?.id ?? 0
  }

  it('goes to the organizer, as a calendar reply, after the Undo wait', async () => {
    const id = await invited('boss@cal.example')
    service.rsvp(id, 'ACCEPTED')
    expect(smtp.sent).toEqual([])
    clock += 11_000
    await service.tick()
    await vi.waitFor(() => expect(smtp.sent).toHaveLength(1), { timeout: 15_000, interval: 15 })
    expect(smtp.sent[0]?.to).toEqual(['boss@cal.example'])
    expect(smtp.sent[0]?.from).toBe(Y)
    expect(smtp.sent[0]?.raw).toMatch(/method=REPLY/i)
    expect(smtp.sent[0]?.raw).toMatch(/^Date: .* 2026/im)
  })

  it('can be called back', async () => {
    const id = await invited('boss@cal.example')
    const { id: draft } = service.rsvp(id, 'DECLINED')
    service.unsend(draft)
    clock += 11_000
    await service.tick()
    expect(smtp.received).toBe(0)
  })

  it('has nothing to answer on an ordinary message', async () => {
    yahoo.add(rawMail({ subject: 'Plain' }), { arrived: new Date(at(8)) })
    await add(Y, yahoo)
    const [row] = service.list({ kind: 'inbox' })
    expect(() => service.rsvp(service.thread(Y, row?.thread ?? '')[0]?.id ?? 0, 'ACCEPTED')).toThrow('nothing to answer')
  })
})

describe('drafts on folder servers', () => {
  const edit = (account: string, subject: string): Parameters<MailService['saveDraft']>[1] =>
    ({ account, from: '', to: 'ada@example.com', cc: '', bcc: '', subject, html: 'Hi', text: 'Hi', quote: null })
  const saved = (server: FakeGmail): string[] => server.drafts().map((raw) => /^Subject: (.*)$/m.exec(raw)?.[1]?.trim() ?? '')
  const pushed = async (): Promise<void> => {
    clock += 5000
    await service.tick()
  }

  it('keeps them in the account\'s Drafts folder, and deletes a copy where it is, not by way of Trash', async () => {
    await add(Y, yahoo)
    const draft = await service.startDraft({ kind: 'new', account: Y })
    service.saveDraft(draft.id, edit(Y, 'Lunch'))
    await pushed()
    expect(saved(yahoo)).toEqual(['Lunch'])
    service.saveDraft(draft.id, edit(Y, 'Lunch on Friday'))
    await pushed()
    expect(saved(yahoo)).toEqual(['Lunch on Friday'])
    expect(yahoo.box('Trash').mails).toEqual([])
    expect(yahoo.commands.some((c) => c.startsWith('UID EXPUNGE'))).toBe(true)
  })

  it('finds the copy it made on a server that doesn\'t say where it put it', async () => {
    const old = await serve('me@old.example', { plain: true, uidplus: false })
    await add('me@old.example', old, { provider: 'other', imap: { host: 'imap.old.example', port: 993, security: 'tls' }, smtp: { host: 'smtp.old.example', port: 465, security: 'tls' } })
    const draft = await service.startDraft({ kind: 'new', account: 'me@old.example' })
    service.saveDraft(draft.id, edit('me@old.example', 'First'))
    await pushed()
    service.saveDraft(draft.id, edit('me@old.example', 'Second'))
    await pushed()
    expect(saved(old)).toEqual(['Second'])
  })

  it('makes a Drafts folder for a server that has none', async () => {
    yahoo.boxes = yahoo.boxes.filter((box) => box.flag !== '\\Drafts')
    await add(Y, yahoo)
    const draft = await service.startDraft({ kind: 'new', account: Y })
    service.saveDraft(draft.id, edit(Y, 'Somewhere to go'))
    await pushed()
    expect(yahoo.commands.filter((c) => c.startsWith('CREATE'))).toEqual(['CREATE Drafts'])
    expect(saved(yahoo)).toEqual(['Somewhere to go'])
    await service.syncAll()
    expect(service.drafts()).toHaveLength(1) // its own copy, not brought in again
  })

  it('moves a draft\'s copy with it when it\'s moved to another account', async () => {
    await add(G, gmail)
    await add(Y, yahoo)
    const draft = await service.startDraft({ kind: 'new', account: G })
    service.saveDraft(draft.id, edit(G, 'Which one'))
    await pushed()
    expect([saved(gmail), saved(yahoo)]).toEqual([['Which one'], []])
    service.saveDraft(draft.id, edit(Y, 'Which one'))
    await pushed()
    expect([saved(gmail), saved(yahoo)]).toEqual([[], ['Which one']])
  })

  it('leaves the drafts on the server when the account is removed from this laptop', async () => {
    await add(Y, yahoo)
    const draft = await service.startDraft({ kind: 'new', account: Y })
    service.saveDraft(draft.id, edit(Y, 'Stays there'))
    await pushed()
    service.removeAccount(Y)
    await pushed()
    expect(saved(yahoo)).toEqual(['Stays there'])
    expect(store.draftCopies(Y)).toEqual([])
  })
})

describe('upgrading a profile from the Gmail-only version', () => {
  it('carries on where it was: queued changes reach the server and nothing is fetched twice', async () => {
    const archive = gmail.add(rawMail({ subject: 'Archive me' }), { arrived: new Date(at(7)) })
    const trash = gmail.add(rawMail({ subject: 'Bin me' }), { arrived: new Date(at(7)) })
    const stays = gmail.add(rawMail({ subject: 'Stays' }), { arrived: new Date(at(7)) })
    const path = join(folder, 'old.sqlite')
    secondVersionProfile(path, {
      account: G, uidValidity: String(gmail.uidValidity), modseq: String(gmail.modseq), holdFrom: at(6),
      messages: [
        { uid: archive, subject: 'Archive me', labels: [], arrived: at(7) },
        { uid: trash, subject: 'Bin me', hidden: true, arrived: at(7) },
        { uid: stays, subject: 'Stays', arrived: at(7) }
      ],
      pending: [{ action: { kind: 'archive' }, uids: [archive] }, { action: { kind: 'trash' }, uids: [trash] }]
    })
    store.close()
    store = new Store(path)
    secrets.set(`account:${G}`, gmail.secret)
    service = make()
    expect(service.accounts()).toMatchObject([{ email: G, provider: 'gmail', labels: true }]) // no saved settings: it was Gmail
    await flushed()
    expect(gmail.box('[Gmail]/Trash').mails).toHaveLength(1)
    await vi.waitFor(() => expect(gmail.mails.find((m) => m.uid === archive)?.labels).not.toContain('\\Inbox'), { timeout: 15_000, interval: 15 })
    await service.syncAll()
    expect(service.accounts()[0]?.error).toBeNull()
    expect(subjects(service.list({ kind: 'inbox' }))).toEqual(['Stays'])
    expect(subjects(service.list({ kind: 'all' }))).toEqual(['Archive me', 'Stays'])
    expect(subjects(service.list({ kind: 'trash' }))).toEqual(['Bin me'])
    expect(store.uids(G, '@all').size).toBe(2)
    expect(gmail.writes().filter((c) => /MOVE/.test(c))).toHaveLength(1)
  })
})
