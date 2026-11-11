import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { canOpenDirectly, isPublicHttps, safeFileName } from '@main/safe-url'
import { MIGRATIONS, searchParts, Store } from '@main/store'
import { forwardSubject, parseMailto, parseRecipients, quoteOf, replySubject, replyTargets } from '@main/compose'
import type { MessageDetail } from '@main/store'
import { secondVersionProfile } from './old-profile'

/** The file the first version of the app wrote, before versioning. */
const FIRST_SCHEMA = `
CREATE TABLE messages(
  id INTEGER PRIMARY KEY,
  account TEXT NOT NULL, uid INTEGER NOT NULL, thread TEXT NOT NULL,
  gmail_id TEXT NOT NULL DEFAULT '', message_id TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '', from_name TEXT NOT NULL DEFAULT '', from_address TEXT NOT NULL DEFAULT '',
  to_json TEXT NOT NULL DEFAULT '[]', cc_json TEXT NOT NULL DEFAULT '[]',
  arrived INTEGER NOT NULL,
  snippet TEXT NOT NULL DEFAULT '', body_text TEXT NOT NULL DEFAULT '', body_html TEXT,
  attachments TEXT NOT NULL DEFAULT '[]', has_attachment INTEGER NOT NULL DEFAULT 0,
  labels TEXT NOT NULL DEFAULT '[]', in_inbox INTEGER NOT NULL DEFAULT 0,
  seen INTEGER NOT NULL DEFAULT 0, flagged INTEGER NOT NULL DEFAULT 0, read_here INTEGER NOT NULL DEFAULT 0,
  truncated INTEGER NOT NULL DEFAULT 0, size INTEGER NOT NULL DEFAULT 0,
  release_at INTEGER NOT NULL,
  UNIQUE(account, uid));
CREATE VIRTUAL TABLE search USING fts5(subject, sender, body, tokenize = "unicode61 remove_diacritics 2");
CREATE TABLE sync_state(account TEXT PRIMARY KEY, uid_validity TEXT NOT NULL, modseq TEXT, hold_from INTEGER NOT NULL);
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO messages(account, uid, thread, subject, arrived, labels, in_inbox, read_here, release_at)
  VALUES('me@example.com', 7, 't', 'Kept', 100, '["\\\\Inbox"]', 1, 1, 100);
INSERT INTO meta(key, value) VALUES('accounts', '["me@example.com"]');
`

describe('an older file', () => {
  const folder = (): string => mkdtempSync(join(tmpdir(), 'xrnmail-store-'))

  it('upgrades in place and keeps everything', () => {
    const dir = folder()
    const path = join(dir, 'mail.sqlite')
    const old = new DatabaseSync(path)
    old.exec(FIRST_SCHEMA)
    old.close()
    const store = new Store(path)
    const [row] = store.list({ kind: 'inbox' }, 1000)
    expect(row?.subject).toBe('Kept')
    expect(row?.unread).toBe(0) // read here before becomes read
    expect(store.meta('accounts')).toBe('["me@example.com"]')
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  describe('from the version before folders', () => {
    const ME = 'me@example.com'
    const upgraded = (messages: Parameters<typeof secondVersionProfile>[1]['messages'], pending: Parameters<typeof secondVersionProfile>[1]['pending'] = []): { store: Store; path: string; done(): void } => {
      const dir = folder()
      const path = join(dir, 'mail.sqlite')
      secondVersionProfile(path, { account: ME, uidValidity: '5', modseq: '120', holdFrom: 50, messages, pending })
      const store = new Store(path)
      return { store, path, done: () => { store.close(); rmSync(dir, { recursive: true, force: true }) } }
    }

    it('keeps every row, its id, and search', () => {
      const { store, done } = upgraded([{ uid: 7, subject: 'Lịch thi' }, { uid: 9, subject: 'Second' }])
      expect(store.list({ kind: 'inbox' }, 1000).map((r) => r.subject).sort()).toEqual(['Lịch thi', 'Second'])
      expect(store.list({ kind: 'search', text: 'lich' }, 1000).map((r) => r.subject)).toEqual(['Lịch thi'])
      expect(store.locate([1, 2])).toEqual([{ id: 1, box: '@all', uid: 7 }, { id: 2, box: '@all', uid: 9 }])
      done()
    })

    it('keeps where sync had got to, under All Mail', () => {
      const { store, done } = upgraded([])
      expect(store.boxState(ME, '@all')).toEqual({ uidValidity: '5', modseq: '120' })
      expect(store.holdFrom(ME)).toBe(50)
      done()
    })

    it('keeps held mail held, and Gmail\'s unsent drafts hidden', () => {
      const { store, done } = upgraded([
        { uid: 7, subject: 'Held', arrived: 900, releaseAt: 5000 },
        { uid: 8, subject: 'Half written', labels: ['\\Draft'], hidden: true }
      ])
      expect(store.list({ kind: 'all' }, 1000)).toEqual([])
      expect(store.list({ kind: 'all' }, 6000).map((r) => r.subject)).toEqual(['Held'])
      done()
    })

    it('sets aside what was already there and sent to everyone', () => {
      const { store, done } = upgraded([{ uid: 7, subject: 'Person' }, { uid: 8, subject: 'List', unsubscribe: 'https://x.example/u' }])
      expect(store.list({ kind: 'inbox', focus: 'focused' }, 1000).map((r) => r.subject)).toEqual(['Person'])
      expect(store.list({ kind: 'inbox', focus: 'other' }, 1000).map((r) => r.subject)).toEqual(['List'])
      done()
    })

    it('turns queued changes from UIDs into rows, as real JSON', () => {
      const { store, done } = upgraded([{ uid: 7, subject: 'One' }, { uid: 9, subject: 'Two' }], [{ action: { kind: 'archive' }, uids: [9, 7] }])
      const [change] = store.dueActions(ME, 1000)
      expect(change?.ids.sort()).toEqual([1, 2])
      expect(change?.before.map((s) => [s.id, s.box, s.labels]).sort()).toEqual([[1, '@all', ['\\Inbox']], [2, '@all', ['\\Inbox']]])
      done()
    })

    it('lets go of a change to a message that has gone', () => {
      const { store, done } = upgraded([{ uid: 7, subject: 'One' }], [{ action: { kind: 'star' }, uids: [999] }])
      expect(store.dueActions(ME, 1000)[0]).toMatchObject({ ids: [], before: [] })
      done()
    })

    // They run on every change, and what they read sits after the bodies in each row: answered from
    // the table, every count walked every message's overflow pages.
    it('answers the counts beside the list from indexes, without reading a message', () => {
      const { store, path, done } = upgraded([
        { uid: 7, subject: 'Held', arrived: 900, releaseAt: 5000 },
        { uid: 8, subject: 'Filed', labels: ['\\Inbox', 'Work'] },
        { uid: 9, subject: 'Unread' }
      ])
      const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare')
      expect([store.heldCount(1000), store.nextRelease(1000), store.spamCount(1000)]).toEqual([1, 5000, 0])
      expect(store.labelCounts(1000)).toEqual([{ account: ME, label: 'Work', count: 1 }])
      expect(store.assistantCounts(1000)).toEqual({ packages: 0, travel: 0, money: 0, events: 0 })
      expect([store.unreadThreads(1000, 'm.account = ?', ME), store.unreadThreads(1000, 'm.focus = 0')]).toEqual([2, 0])
      const statements = prepare.mock.calls.map(([sql]) => sql)
      prepare.mockRestore()
      const db = new DatabaseSync(path)
      for (const sql of statements) {
        const reads = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
          .map((step) => step.detail).filter((detail) => /^(SCAN|SEARCH) (messages|m)\b/.test(detail))
        expect(reads, sql).not.toEqual([])
        for (const read of reads) expect(read, sql).toContain('USING COVERING INDEX')
      }
      db.close()
      done()
    })

    it('puts mail on its way to Trash or Spam there, instead of out of sight', () => {
      const { store, done } = upgraded([
        { uid: 7, subject: 'Binned', labels: ['\\Inbox', 'Work'], hidden: true },
        { uid: 8, subject: 'Junk', hidden: true },
        { uid: 9, subject: 'Half written', labels: ['\\Draft'], hidden: true }
      ], [{ action: { kind: 'trash' }, uids: [7] }, { action: { kind: 'spam' }, uids: [8] }])
      expect(store.list({ kind: 'trash' }, 1000).map((r) => r.subject)).toEqual(['Binned'])
      expect(store.list({ kind: 'spam' }, 1000).map((r) => r.subject)).toEqual(['Junk'])
      expect(store.list({ kind: 'inbox' }, 1000)).toEqual([])
      expect(store.visibleMail({ account: ME, thread: 't7' }, 1000, true)[0]?.labels).toEqual(['Work', '\\Trash'])
      done()
    })
  })

  it('opens again without running anything twice', () => {
    const dir = folder()
    const path = join(dir, 'mail.sqlite')
    new Store(path).close()
    const store = new Store(path)
    expect(store.drafts()).toEqual([])
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('from before pins gains Pinned, and keeps its mail, its snoozes and its settings', () => {
    const dir = folder()
    const path = join(dir, 'mail.sqlite')
    const old = new DatabaseSync(path)
    // What the version before pins left: the entries that had shipped by then, which never change.
    MIGRATIONS.slice(0, 5).forEach((sql) => old.exec(sql))
    old.exec('PRAGMA user_version = 5')
    old.exec("INSERT INTO messages(account, uid, thread, subject, arrived, release_at, in_inbox, flagged) VALUES('me@example.com', 8, 'u', 'Kept', 100, 100, 1, 1)")
    old.exec("INSERT INTO messages(account, uid, thread, subject, arrived, release_at, in_inbox) VALUES('me@example.com', 9, 'v', 'Other', 90, 90, 1)")
    old.exec("INSERT INTO snoozes(account, thread, at, until) VALUES('me@example.com', 'v', 100, 500)")
    old.exec(`INSERT INTO meta(key, value) VALUES('settings', '{"theme":"dark"}')`)
    old.close()
    const ref = { account: 'me@example.com', thread: 'u' }
    let store = new Store(path)
    expect(store.list({ kind: 'inbox' }, 1000).map((r) => [r.subject, r.starred, r.snoozedUntil, r.pinned])).toEqual([['Other', false, 500, false], ['Kept', true, null, false]])
    expect(store.meta('settings')).toBe('{"theme":"dark"}')
    expect(store.list({ kind: 'pinned' }, 1000)).toEqual([])
    store.pin(ref, 1000)
    expect(store.list({ kind: 'pinned' }, 1000).map((r) => r.subject)).toEqual(['Kept'])
    store.close()
    store = new Store(path) // and opening it again changes nothing
    expect(store.list({ kind: 'pinned' }, 1000).map((r) => r.subject)).toEqual(['Kept'])
    expect(store.thread('me@example.com', 'u', 1000)[0]?.pinned).toBe(true)
    expect(store.thread('me@example.com', 'v', 1000)[0]?.pinned).toBe(false)
    store.unpin(ref)
    expect(store.list({ kind: 'pinned' }, 1000)).toEqual([])
    store.close()
    const file = new DatabaseSync(path)
    expect(file.prepare('PRAGMA user_version').get()).toEqual({ user_version: MIGRATIONS.length })
    file.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('the first file of all can pin too', () => {
    const dir = folder()
    const path = join(dir, 'mail.sqlite')
    const old = new DatabaseSync(path)
    old.exec(FIRST_SCHEMA)
    old.close()
    const store = new Store(path)
    const [row] = store.list({ kind: 'inbox' }, 1000)
    expect(row?.pinned).toBe(false)
    store.pin({ account: row?.account ?? '', thread: row?.thread ?? '' }, 1000)
    expect(store.list({ kind: 'pinned' }, 1000).map((r) => [r.subject, r.pinned])).toEqual([['Kept', true]])
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('knows which lists of files came from a message that was cut', () => {
    const dir = folder()
    const path = join(dir, 'mail.sqlite')
    const old = new DatabaseSync(path)
    old.exec(FIRST_SCHEMA)
    old.exec("INSERT INTO messages(account, uid, thread, subject, arrived, truncated, release_at) VALUES('me@example.com', 8, 'u', 'Big', 100, 1, 100)")
    old.close()
    const store = new Store(path)
    expect(store.filesCut([1, 2])).toEqual([2])
    store.wholeFiles(2, [{ name: 'c.pdf', type: 'application/pdf', size: 3 }])
    expect(store.filesCut([1, 2])).toEqual([])
    expect(store.list({ kind: 'attachments' }, 1000).map((r) => [r.subject, r.file])).toEqual([['Big', 'c.pdf']])
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('search', () => {
  it('reads plain words, scoped words and flags', () => {
    expect(searchParts('lich thi')).toEqual({ match: '"lich"* "thi"*', filters: [], params: [] })
    expect(searchParts('from:ada subject:tax')).toEqual({ match: 'sender : "ada"* subject : "tax"*', filters: [], params: [] })
    expect(searchParts('has:attachment is:unread').filters).toEqual(['has_attachment = 1', 'seen = 0'])
    expect(searchParts('is:flagged').filters).toEqual(['flagged = 1']) // what the app calls a star now
    expect(searchParts('is:starred').filters).toEqual(['flagged = 1'])
  })

  it('reads who it went to and when', () => {
    const { filters, params } = searchParts('to:ada after:2026-1-5 before:2026-02')
    expect(filters).toHaveLength(3)
    expect(params).toEqual(['%ada%', Date.parse('2026-01-05'), Date.parse('2026-02-01')])
  })

  it('never lets what is typed become search syntax', () => {
    expect(searchParts('a" OR "b').match).toBe('"a"* "OR"* "b"*')
    expect(searchParts('NEAR(x y)').match).toBe('"NEAR(x"* "y)"*')
    expect(searchParts('from:"').match).toBe('')
  })
})

describe('what a stranger chooses', () => {
  it('one-click only goes to a public https name', () => {
    expect(isPublicHttps('https://list.example.com/u/1')).toBe(true)
    for (const url of [
      'http://list.example.com/u', 'https://127.0.0.1/x', 'https://2130706433/x', 'https://[::1]/x', 'https://localhost/x',
      'https://router.local/x', 'https://intranet/x', 'https://a:b@list.example.com/', 'file:///etc/passwd', 'not a url'
    ]) expect(isPublicHttps(url), url).toBe(false)
  })

  it('anything that runs is saved, never opened directly', () => {
    for (const name of ['report.pdf', 'photo.JPG', 'sheet.xlsx', 'notes.txt']) expect(canOpenDirectly(name), name).toBe(true)
    for (const name of ['evil.desktop', 'run.sh', 'a.AppImage', 'page.html', 'x.svg', 'invoice.pdf.exe', 'noextension', 'b.js ', 'macro.docm', 'odd.xyz']) {
      expect(canOpenDirectly(name), name).toBe(false)
    }
  })

  it('a file name cannot climb out of where it is saved', () => {
    expect(safeFileName('../../.ssh/authorized_keys')).toBe('authorized_keys')
    expect(safeFileName('..\\..\\evil.exe')).toBe('evil.exe')
    expect(safeFileName('.bashrc')).toBe('bashrc')
    expect(safeFileName('')).toBe('attachment')
    expect(safeFileName('a\u0000b\r\n.txt')).toBe('ab.txt')
  })

  // It was cut to 200 characters, and 125 CJK characters are 375 bytes, past the 255 a Linux file
  // name can have, so opening such an attachment failed with ENAMETOOLONG.
  it('a long name is cut to fit a file name, in bytes, keeping its end', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xrnmail-names-'))
    for (const long of [`${'報告書'.repeat(40)}.pdf`, `${'😀'.repeat(60)}.txt`, `${'a'.repeat(300)}.txt`]) {
      const name = safeFileName(long)
      expect(Buffer.byteLength(name), long).toBeLessThanOrEqual(200)
      expect(Buffer.from(name).toString(), long).toBe(name) // whole characters only
      expect(long.endsWith(name), long).toBe(true)
      writeFileSync(join(dir, `12345678-${name}`), 'x') // as opening one names it
    }
    expect(safeFileName(`${'.'.repeat(250)}x.txt`)).toBe('x.txt')
    rmSync(dir, { recursive: true, force: true })
  })

  // U+202E shows the rest of a name backwards, so "photo\u202Egpj.exe" looked like photoexe.jpg.
  it('a name cannot turn itself around to show a false type', () => {
    expect(safeFileName('photo\u202Egpj.exe')).toBe('photogpj.exe')
    expect(safeFileName('\u202A\u202B\u202C\u202D\u2066a\u2067b\u2068c\u2069.pdf')).toBe('abc.pdf')
    expect(safeFileName('\u202E')).toBe('attachment')
  })
})

describe('writing back', () => {
  const message = (over: Partial<MessageDetail> = {}): MessageDetail => ({
    id: 1, box: '@all', uid: 1, account: 'me@example.com', thread: 't', subject: 'Plan', date: 0, text: 'Line one\nLine two', html: null,
    from: { name: 'Ada', address: 'ada@example.com' },
    to: [{ name: '', address: 'me@example.com' }, { name: 'Bo', address: 'bo@example.com' }],
    cc: [{ name: '', address: 'cy@example.com' }],
    attachments: [], truncated: false, labels: [], seen: true, flagged: false, unsubscribe: false,
    focused: true, facts: null, warnings: [], pinned: false,
    messageId: '<m@example.com>', references: '', replyTo: [], unsubscribeTo: null, ...over
  })

  it('reply goes to the sender, or their Reply-To', () => {
    expect(replyTargets(message(), ['me@example.com'], false)).toEqual({ to: '"Ada" <ada@example.com>', cc: '' })
    const desk = message({ replyTo: [{ name: '', address: 'desk@example.com' }] })
    expect(replyTargets(desk, ['me@example.com'], false).to).toBe('desk@example.com')
  })

  it('reply all leaves you out and names nobody twice', () => {
    const copied = message({ cc: [{ name: '', address: 'CY@example.com' }, { name: '', address: 'ada@example.com' }, { name: '', address: 'Me@Example.com' }] })
    expect(replyTargets(copied, ['me@example.com'], true)).toEqual({ to: '"Ada" <ada@example.com>', cc: '"Bo" <bo@example.com>, CY@example.com' })
  })

  it('answering your own message goes to whoever you wrote to', () => {
    const mine = message({ from: { name: 'Me', address: 'me@example.com' }, to: [{ name: '', address: 'bo@example.com' }] })
    expect(replyTargets(mine, ['me@example.com'], false).to).toBe('bo@example.com')
  })

  it('does not stack prefixes', () => {
    expect(replySubject('Re: Plan')).toBe('Re: Plan')
    expect(replySubject('RE: Plan')).toBe('RE: Plan')
    expect(replySubject('Plan')).toBe('Re: Plan')
    expect(forwardSubject('Fw: Plan')).toBe('Fw: Plan')
    expect(forwardSubject('Plan')).toBe('Fwd: Plan')
  })

  it('reads what was typed, and says what it cannot', () => {
    expect(parseRecipients('Ada <ada@example.com>, bo@example.com')).toEqual([
      { name: 'Ada', address: 'ada@example.com' }, { name: '', address: 'bo@example.com' }
    ])
    expect(parseRecipients('"Last, First" <a@example.com>')).toEqual([{ name: 'Last, First', address: 'a@example.com' }])
    expect(parseRecipients('  ')).toEqual([])
    expect(() => parseRecipients('bo@example')).toThrow('Check this address: bo@example')
  })

  it('a header cannot be smuggled in through a name', () => {
    const [who] = parseRecipients('"x\r\nBcc: evil@example.com" <a@example.com>')
    expect(who?.address).toBe('a@example.com')
    expect(who?.name).not.toMatch(/[\r\n]/)
  })

  // A percent sign that isn't an escape made decoding throw, so the link did nothing at all.
  it('fills in a draft from a mail link, stray percent sign and all', () => {
    expect(parseMailto('mailto:a%40b.example?subject=Hi&cc=c@d.example')).toMatchObject({ to: 'a@b.example', subject: 'Hi', cc: 'c@d.example' })
    expect(parseMailto('mailto:50%off@shop.example?subject=Hi')).toMatchObject({ to: '50%off@shop.example', subject: 'Hi' })
  })

  it('quotes the words, not the sender-chosen layout', () => {
    expect(quoteOf(message(), 'reply').intro).toContain('"Ada" <ada@example.com> wrote:')
    expect(quoteOf(message(), 'forward').intro).toContain('Subject: Plan')
  })
})

describe('closing', () => {
  // The app closes the store in before-quit, and a second quit request on the way out (the window
  // closing after the tray's Quit, or a signal) reaches that close again.
  it('can be asked twice on the way out', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xrnmail-store-'))
    const store = new Store(join(dir, 'mail.sqlite'))
    store.close()
    expect(() => store.close()).not.toThrow()
    rmSync(dir, { recursive: true, force: true })
  })
})
