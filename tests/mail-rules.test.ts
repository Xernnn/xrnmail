import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DraftFiles } from '@main/draft-files'
import { MemorySecrets } from '@main/secrets'
import { SmtpSender } from '@main/sender'
import { MailService, UNDO_MS } from '@main/service'
import { ImapSource } from '@main/source'
import { Store } from '@main/store'
import { ImapWriter } from '@main/writer'
import { providerFor } from '@shared/providers'
import type { RuleEdit } from '@shared/rules'
import type { ThreadRow } from '@shared/types'
import { FakeGmail, rawMail, type FakeMail, type FakeOptions } from './fake-gmail'
import { FakeSmtp } from './fake-smtp'

/**
 * Mail rules run as a sync stores each new message, before its batch or Summary is worked out and
 * before anything announces it, and what they ask of the server goes through the queue of changes.
 * Apply now runs one over the inbox kept here.
 */

const DAY = 86_400_000
const at = (hour: number, minute = 0, day = 6): number => new Date(2026, 10, day, hour, minute).getTime()
const G = 'alex@gmail.com'
const Y = 'alex@yahoo.com'

let servers: FakeGmail[]
let ports: Map<string, number>
let gmail: FakeGmail
let smtp: FakeSmtp
let folder: string
let store: Store
let secrets: MemorySecrets
let clock: number
let landed: Mock<(count: number, preview?: { from: string; subject: string }) => void>
let summarized: Mock<(count: number, senders: string[]) => void>
let service: MailService

const eventually = (check: () => void): Promise<void> => vi.waitFor(check, { timeout: 15_000, interval: 15 })

const make = (): MailService => new MailService({
  store, secrets, landed, summarized,
  changed: () => undefined,
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

/** Lets everything queued reach the server, past Undo's wait. */
async function flushed(): Promise<void> {
  clock += UNDO_MS + 1
  await service.tick()
  await eventually(() => expect(store.dueActions(G, clock).concat(store.dueActions(Y, clock))).toEqual([]))
  await new Promise((resolve) => setTimeout(resolve, 30))
}

/** Mail that comes a second from now, and the sync that finds it a minute later. */
async function arrives(server: FakeGmail, ...mails: string[]): Promise<void> {
  for (const raw of mails) server.add(raw, { arrived: new Date(clock + 1000) })
  clock += 60_000
  await service.tick()
  await service.syncAll()
}

const rule = (over: Partial<RuleEdit>): RuleEdit => ({
  name: '', account: '', on: true, match: 'all',
  conditions: [{ field: 'subject', op: 'contains', value: 'receipt' }],
  actions: [{ kind: 'archive' }],
  ...over
})

const subjects = (rows: ThreadRow[]): string[] => rows.map((r) => r.subject).sort()
const found = (server: FakeGmail, subject: string, box?: string): FakeMail | undefined =>
  (box ? server.box(box).mails : server.mails).find((m) => m.raw.toString().includes(`Subject: ${subject}`))

beforeEach(async () => {
  clock = at(10)
  servers = []
  ports = new Map()
  gmail = await serve(G)
  smtp = new FakeSmtp(gmail.secret)
  await smtp.listen()
  folder = mkdtempSync(join(tmpdir(), 'xrnmail-rules-'))
  store = new Store(':memory:')
  secrets = new MemorySecrets()
  landed = vi.fn()
  summarized = vi.fn()
  service = make()
  service.saveBatch({ ...service.settings().batch, times: [] })
})

afterEach(async () => {
  service.list({ kind: 'inbox' })
  await eventually(() => expect(service.accounts().every((a) => !a.syncing)).toBe(true))
  await new Promise((resolve) => setTimeout(resolve, 20))
  store.close()
  await Promise.all(servers.map((s) => s.stop()))
  await smtp.stop()
  rmSync(folder, { recursive: true, force: true })
})

describe('rules', () => {
  it('are kept in their order, changed one at a time, and there after a restart', () => {
    const first = service.saveRule(rule({ name: 'Receipts' }))
    const second = service.saveRule(rule({ conditions: [{ field: 'from', op: 'ends', value: '@shop.example' }] }))
    expect(second.name).toBe('Rule 2')
    service.moveRule(second.id, 0)
    expect(service.mailRules().map((r) => r.name)).toEqual(['Rule 2', 'Receipts'])
    service.saveRule({ ...first, on: false })
    expect(make().mailRules().map((r) => [r.name, r.on])).toEqual([['Rule 2', true], ['Receipts', false]])
    service.deleteRule(second.id)
    expect(service.mailRules().map((r) => r.id)).toEqual([first.id])
    expect(() => service.saveRule({ ...second })).toThrow('That rule is gone.')
    expect(() => service.saveRule(rule({ account: 'someone@example.net' }))).toThrow('That account is gone.')
    const third = service.saveRule(rule({}))
    expect(third.id).toBeGreaterThan(second.id) // an id is never given out twice
  })
})

describe('what the rules have looked at', () => {
  it('is remembered while it is kept, and mail the window has let go of counts as looked at', () => {
    store.markRuled(G, 'm:<one@example.com>', at(9))
    expect(store.ruledAlready(G, 'm:<one@example.com>', at(9))).toBe(true)
    expect(store.ruledAlready(Y, 'm:<one@example.com>', at(9))).toBe(false)
    expect(store.ruledAlready(G, 'm:<two@example.com>', at(9))).toBe(false)
    store.dropOlderThan(G, at(9, 30), at(10))
    expect(store.ruledAlready(G, 'm:<one@example.com>', at(9))).toBe(true) // the window grew back over it
    expect(store.ruledAlready(G, 'm:<two@example.com>', at(9))).toBe(true)
    expect(store.ruledAlready(G, 'm:<three@example.com>', at(9, 31))).toBe(false)
    store.dropOlderThan(G, at(8), at(10)) // a longer window doesn't bring them back
    expect(store.ruledAlready(G, 'm:<two@example.com>', at(9))).toBe(true)
    store.wipeAccount(G)
    expect(store.ruledAlready(G, 'm:<two@example.com>', at(9))).toBe(false)
  })
})

describe('rules on new mail', () => {
  it('label, archive and read a new message on Gmail as it is stored, and the server hears', async () => {
    gmail.labels = ['Receipts']
    gmail.add(rawMail({ subject: 'Old receipt' }), { arrived: new Date(at(9)) })
    await add(G, gmail)
    service.saveRule(rule({ actions: [{ kind: 'file', to: 'Receipts' }, { kind: 'archive' }, { kind: 'read' }] }))
    await arrives(gmail, rawMail({ subject: 'Your receipt' }), rawMail({ subject: 'Hello' }))
    // Mail that was here before the account was added is left as it was.
    expect(subjects(service.list({ kind: 'inbox' }))).toEqual(['Hello', 'Old receipt'])
    const [filed] = service.list({ kind: 'label', account: G, label: 'Receipts' })
    expect(filed).toMatchObject({ subject: 'Your receipt', unread: 0 })
    expect(landed).toHaveBeenCalledTimes(1)
    expect(landed).toHaveBeenCalledWith(1, expect.objectContaining({ subject: 'Hello' }))
    await flushed()
    const there = found(gmail, 'Your receipt')
    expect(there?.labels).toContain('Receipts')
    expect(there?.labels).not.toContain('\\Inbox')
    expect(there?.flags).toContain('\\Seen')
    expect(found(gmail, 'Hello')?.labels).toEqual(['\\Inbox'])
    expect(found(gmail, 'Old receipt')?.labels).toEqual(['\\Inbox'])
  })

  it('on a server with folders, move a new message once: put back in the inbox, it stays there', async () => {
    const yahoo = await serve(Y, { plain: true, folders: ['Receipts'], uidplus: false })
    await add(Y, yahoo)
    service.saveRule(rule({ account: Y, actions: [{ kind: 'file', to: 'Receipts' }, { kind: 'flag' }] }))
    await arrives(yahoo, rawMail({ subject: 'Your receipt' }))
    await flushed()
    expect(yahoo.box('INBOX').mails).toEqual([])
    const moved = found(yahoo, 'Your receipt', 'Receipts') as FakeMail
    expect(moved.flags).toContain('\\Flagged')
    // On the phone it goes back to the inbox, as a new message there, since the server can't say
    // where a move took it. The rules have had their say already.
    yahoo.remove(moved.uid, 'Receipts')
    yahoo.add(moved.raw, { arrived: moved.arrived, flags: moved.flags })
    await service.syncAll()
    await flushed()
    await service.syncAll()
    expect(subjects(service.list({ kind: 'inbox', account: Y }))).toEqual(['Your receipt'])
    expect(yahoo.box('Receipts').mails).toEqual([])
    expect(yahoo.writes().filter((c) => /MOVE|COPY/.test(c))).toHaveLength(1)
  })

  it('decide before the batch: let straight through lands at once, Add to Summary waits for it, Mute lands unannounced', async () => {
    service.saveBatch({ live: false, times: ['09:00', '13:00', '17:00'] })
    await add(G, gmail)
    service.saveRule(rule({ conditions: [{ field: 'from', op: 'is', value: 'boss@work.example' }], actions: [{ kind: 'straight' }] }))
    service.saveRule(rule({ conditions: [{ field: 'list', op: 'contains', value: 'deals' }], actions: [{ kind: 'summary' }] }))
    service.saveRule(rule({ conditions: [{ field: 'from', op: 'contains', value: 'robot' }], actions: [{ kind: 'mute' }] }))
    expect(service.overview().summary.next).toBe(at(8, 0, 7)) // a rule fills it, though no sender is in it
    await arrives(gmail,
      rawMail({ subject: 'Now please', from: 'Boss <boss@work.example>' }),
      rawMail({ subject: 'Big sale', from: 'Shop <news@shop.example>', headers: ['List-Id: Shop deals <deals.shop.example>'] }),
      rawMail({ subject: 'Build passed', from: 'CI <robot@ci.example>' }),
      rawMail({ subject: 'Lunch?', from: 'Mai <mai@example.com>' }))
    expect(subjects(service.list({ kind: 'inbox' }))).toEqual(['Now please'])
    expect(landed).toHaveBeenCalledTimes(1)
    expect(landed).toHaveBeenCalledWith(1, expect.objectContaining({ subject: 'Now please' }))
    expect(service.overview()).toMatchObject({ held: 2, summary: { held: 1 } })
    // New times move what waits for a batch, and leave what a rule put in the Summary where it is.
    service.saveBatch({ times: ['12:00', '17:00'] })
    expect(service.overview()).toMatchObject({ held: 2, summary: { held: 1 } })
    clock = at(12) + 1000
    await service.tick()
    expect(landed).toHaveBeenCalledTimes(2)
    expect(landed).toHaveBeenLastCalledWith(1) // Lunch, and not the build
    expect(subjects(service.list({ kind: 'inbox' }))).toEqual(['Build passed', 'Lunch?', 'Now please'])
    clock = at(8, 0, 7) + 1000
    await service.tick()
    expect(summarized).toHaveBeenCalledWith(1, ['Shop'])
    expect(subjects(service.list({ kind: 'summary' }))).toEqual(['Big sale'])
  })

  it('are only the ones that are on, for that account, and stop where one says to', async () => {
    const yahoo = await serve(Y, { plain: true })
    await add(G, gmail)
    await add(Y, yahoo)
    service.saveRule(rule({ on: false, actions: [{ kind: 'trash' }] }))
    service.saveRule(rule({ account: Y, actions: [{ kind: 'read' }, { kind: 'stop' }] }))
    service.saveRule(rule({ actions: [{ kind: 'flag' }] }))
    await arrives(gmail, rawMail({ subject: 'Gmail receipt' }))
    await arrives(yahoo, rawMail({ subject: 'Yahoo receipt' }))
    const rows = service.list({ kind: 'inbox' }).map((r) => [r.subject, r.unread, r.starred]).sort()
    expect(rows).toEqual([['Gmail receipt', 1, true], ['Yahoo receipt', 0, false]])
  })

  it('leave alone mail from before the window that a search brings', async () => {
    await add(G, gmail)
    service.saveRule(rule({ actions: [{ kind: 'archive' }] }))
    clock += 120 * DAY // the account's been here a while, and kept 90 days of it
    gmail.add(rawMail({ subject: 'Ancient receipt' }), { arrived: new Date(clock - 100 * DAY) })
    await service.syncAll()
    await eventually(() => expect(service.list({ kind: 'search', text: 'ancient' }).filter((row) => row.older)).toHaveLength(1))
    const [row] = service.list({ kind: 'search', text: 'ancient' })
    await service.reach([{ account: G, thread: row?.thread ?? '' }])
    await service.syncAll()
    await flushed()
    expect(found(gmail, 'Ancient receipt')?.labels).toEqual(['\\Inbox'])
    expect(gmail.writes().filter((c) => /STORE/.test(c))).toEqual([])
  })
})

describe('Apply now', () => {
  beforeEach(async () => {
    gmail.labels = ['Receipts']
    gmail.add(rawMail({ subject: 'Receipt one' }), { arrived: new Date(at(8)) })
    gmail.add(rawMail({ subject: 'Receipt two' }), { arrived: new Date(at(8)), flags: ['\\Seen'] })
    gmail.add(rawMail({ subject: 'Hello' }), { arrived: new Date(at(8)) })
    gmail.add(rawMail({ subject: 'Archived receipt' }), { arrived: new Date(at(8)), labels: [] })
    await add(G, gmail)
  })

  it('runs a rule over the inbox here, says how many it changed, and Undo puts them back before the server hears', async () => {
    const made = service.saveRule(rule({ on: false, actions: [{ kind: 'file', to: 'Receipts' }, { kind: 'archive' }] }))
    const first = service.applyRule(made.id)
    expect(first).toMatchObject({ count: 2, did: 'label' })
    expect(subjects(service.list({ kind: 'inbox' }))).toEqual(['Hello'])
    service.undo(first.undo as number)
    expect(subjects(service.list({ kind: 'inbox' }))).toEqual(['Hello', 'Receipt one', 'Receipt two'])
    await flushed()
    expect(gmail.writes().filter((c) => /STORE/.test(c))).toEqual([])
    const again = service.applyRule(made.id)
    expect(again.count).toBe(2)
    await flushed()
    expect(found(gmail, 'Receipt one')?.labels).toEqual(['Receipts'])
    expect(found(gmail, 'Receipt two')?.labels).toEqual(['Receipts'])
    expect(found(gmail, 'Archived receipt')?.labels).toEqual([]) // only what's in the inbox
    expect(service.applyRule(made.id)).toEqual({ count: 0, undo: null, did: null })
  })

  it('counts only what it changes, and does nothing that matters only as mail arrives', () => {
    const read = service.saveRule(rule({ actions: [{ kind: 'read' }, { kind: 'mute' }, { kind: 'summary' }] }))
    expect(service.applyRule(read.id)).toMatchObject({ count: 1, did: 'read' }) // the other was read already
    expect(service.overview().summary.held).toBe(0)
    expect(subjects(service.list({ kind: 'inbox' }))).toEqual(['Hello', 'Receipt one', 'Receipt two'])
    const off = service.saveRule(rule({ conditions: [{ field: 'from', op: 'contains', value: 'nobody' }], actions: [{ kind: 'trash' }] }))
    expect(service.applyRule(off.id)).toEqual({ count: 0, undo: null, did: null })
    expect(() => service.applyRule(9999)).toThrow('That rule is gone.')
  })
})
