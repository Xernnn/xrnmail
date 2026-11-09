import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type {
  Address, AssistantSection, AttachmentInfo, Draft, DraftState, Facts, LabelCount, ListQuery, MailAction, MessageView, SenderWarning,
  Subscription, ThreadRef, ThreadRow
} from '@shared/types'
import { binOf, DRAFT, INBOX, type MailState } from './actions'
import type { Unsubscribe } from './parse'

/**
 * Everything on this laptop: one SQLite file. A message waiting for its batch is in here, but no
 * query the page can reach returns one until its moment: every read takes `now`.
 */

export interface StoredMail {
  account: string
  /** Which folder [uid] means something in. */
  box: string
  uid: number
  thread: string
  gmailId: string
  messageId: string
  subject: string
  from: Address
  to: Address[]
  cc: Address[]
  replyTo: Address[]
  references: string
  unsubscribe: Unsubscribe | null
  /** When Gmail got it. The Date header isn't used: a sender can write anything there. */
  arrived: number
  snippet: string
  text: string
  html: string | null
  attachments: AttachmentInfo[]
  labels: string[]
  seen: boolean
  flagged: boolean
  truncated: boolean
  size: number
  releaseAt: number
  focused: boolean
  facts: Facts | null
  warnings: SenderWarning[]
}

export interface HeldMail {
  account: string
  arrived: number
  fromAddress: string
  labels: string[]
}

/** How far a folder has been read. */
export interface BoxState {
  uidValidity: string
  modseq: string | null
}

/** A message's place on the server: what a command has to name. */
export interface Located {
  id: number
  box: string
  uid: number
}

/** A change waiting to reach the server. It holds rows, not UIDs, because an earlier move in the
 *  queue gives a message a new UID, and a star queued behind an archive must still find it. */
export interface PendingAction {
  id: number
  group: number
  account: string
  action: MailAction
  ids: number[]
  /** How these messages looked before, to put them back if it's undone or refused. */
  before: MailState[]
  due: number
  attempts: number
}

/** A visible message, with what's needed to answer it. */
export interface MessageDetail extends MessageView {
  box: string
  uid: number
  messageId: string
  references: string
  replyTo: Address[]
  unsubscribeTo: Unsubscribe | null
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages(
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
CREATE INDEX IF NOT EXISTS messages_thread ON messages(account, thread);
CREATE INDEX IF NOT EXISTS messages_inbox ON messages(in_inbox, release_at, arrived);
CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(
  subject, sender, body, tokenize = "unicode61 remove_diacritics 2");
CREATE TABLE IF NOT EXISTS sync_state(
  account TEXT PRIMARY KEY, uid_validity TEXT NOT NULL, modseq TEXT, hold_from INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
`

/** Each entry runs once, in order, and `PRAGMA user_version` records how far a file has come. The
 *  first is safe on a file made before versioning: everything in it is IF NOT EXISTS. Never edit an
 *  entry that has shipped; add one. */
const MIGRATIONS = [
  SCHEMA,
  `
  ALTER TABLE messages ADD COLUMN reply_to TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE messages ADD COLUMN refs TEXT NOT NULL DEFAULT '';
  ALTER TABLE messages ADD COLUMN unsubscribe TEXT NOT NULL DEFAULT '';
  ALTER TABLE messages ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
  UPDATE messages SET seen = 1 WHERE read_here = 1;
  ALTER TABLE messages DROP COLUMN read_here;
  CREATE TABLE pending(
    id INTEGER PRIMARY KEY, grp INTEGER NOT NULL, account TEXT NOT NULL, action TEXT NOT NULL,
    uids TEXT NOT NULL, before TEXT NOT NULL, due INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
  CREATE INDEX pending_due ON pending(account, due);
  CREATE TABLE snoozes(
    account TEXT NOT NULL, thread TEXT NOT NULL, at INTEGER NOT NULL, until INTEGER NOT NULL,
    PRIMARY KEY(account, thread));
  CREATE TABLE drafts(
    id INTEGER PRIMARY KEY, account TEXT NOT NULL, data TEXT NOT NULL, updated INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'draft', send_at INTEGER, error TEXT);
  `,
  // A UID only means something inside its folder, so a row needs its folder too, which takes a new
  // table to change the UNIQUE. Everything so far came from Gmail's All Mail. Row ids stay, which
  // keeps the search index right. Mail on its way to Trash or Spam used to be hidden until it got
  // there; those folders are read now, so it goes straight into them, or it'd stay out of sight.
  `
  ALTER TABLE pending RENAME COLUMN uids TO ids;
  UPDATE pending SET
    before = COALESCE((
      SELECT json_group_array(json_patch(b.value, json_object('id', m.id, 'box', '@all')))
      FROM json_each(pending.before) b
      JOIN messages m ON m.account = pending.account AND m.uid = json_extract(b.value, '$.uid')), '[]'),
    ids = COALESCE((
      SELECT json_group_array(m.id) FROM messages m
      WHERE m.account = pending.account AND m.uid IN (SELECT value FROM json_each(pending.ids))), '[]');
  CREATE TABLE messages_next(
    id INTEGER PRIMARY KEY,
    account TEXT NOT NULL, box TEXT NOT NULL DEFAULT '@all', uid INTEGER NOT NULL, thread TEXT NOT NULL,
    gmail_id TEXT NOT NULL DEFAULT '', message_id TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL DEFAULT '', from_name TEXT NOT NULL DEFAULT '', from_address TEXT NOT NULL DEFAULT '',
    to_json TEXT NOT NULL DEFAULT '[]', cc_json TEXT NOT NULL DEFAULT '[]',
    reply_to TEXT NOT NULL DEFAULT '[]', refs TEXT NOT NULL DEFAULT '', unsubscribe TEXT NOT NULL DEFAULT '',
    arrived INTEGER NOT NULL,
    snippet TEXT NOT NULL DEFAULT '', body_text TEXT NOT NULL DEFAULT '', body_html TEXT,
    attachments TEXT NOT NULL DEFAULT '[]', has_attachment INTEGER NOT NULL DEFAULT 0,
    labels TEXT NOT NULL DEFAULT '[]', in_inbox INTEGER NOT NULL DEFAULT 0,
    seen INTEGER NOT NULL DEFAULT 0, flagged INTEGER NOT NULL DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0, bin INTEGER NOT NULL DEFAULT 0,
    truncated INTEGER NOT NULL DEFAULT 0, size INTEGER NOT NULL DEFAULT 0,
    release_at INTEGER NOT NULL,
    focus INTEGER NOT NULL DEFAULT 1, kind TEXT NOT NULL DEFAULT '', facts TEXT NOT NULL DEFAULT '',
    warnings TEXT NOT NULL DEFAULT '[]',
    UNIQUE(account, box, uid));
  INSERT INTO messages_next(id, account, uid, thread, gmail_id, message_id, subject, from_name, from_address,
      to_json, cc_json, reply_to, refs, unsubscribe, arrived, snippet, body_text, body_html, attachments,
      has_attachment, labels, in_inbox, seen, flagged, hidden, truncated, size, release_at, focus)
    SELECT id, account, uid, thread, gmail_id, message_id, subject, from_name, from_address,
      to_json, cc_json, reply_to, refs, unsubscribe, arrived, snippet, body_text, body_html, attachments,
      has_attachment, labels, in_inbox, seen, flagged, hidden, truncated, size, release_at, unsubscribe = ''
    FROM messages;
  DROP TABLE messages;
  ALTER TABLE messages_next RENAME TO messages;
  UPDATE messages SET hidden = 0, in_inbox = 0, bin = 1,
    labels = json_insert((SELECT json_group_array(value) FROM json_each(messages.labels) WHERE value != '\\Inbox'), '$[#]', '\\Trash')
    WHERE hidden = 1 AND id IN (SELECT i.value FROM pending p, json_each(p.ids) i WHERE json_extract(p.action, '$.kind') = 'trash');
  UPDATE messages SET hidden = 0, in_inbox = 0, bin = 2,
    labels = json_insert((SELECT json_group_array(value) FROM json_each(messages.labels) WHERE value != '\\Inbox'), '$[#]', '\\Spam')
    WHERE hidden = 1 AND id IN (SELECT i.value FROM pending p, json_each(p.ids) i WHERE json_extract(p.action, '$.kind') = 'spam');
  CREATE INDEX messages_thread ON messages(account, thread);
  CREATE INDEX messages_inbox ON messages(in_inbox, release_at, arrived);
  CREATE INDEX messages_kind ON messages(kind, release_at);
  CREATE INDEX messages_sender ON messages(from_address);
  CREATE TABLE box_state(
    account TEXT NOT NULL, box TEXT NOT NULL, uid_validity TEXT NOT NULL, modseq TEXT,
    PRIMARY KEY(account, box));
  INSERT INTO box_state SELECT account, '@all', uid_validity, modseq FROM sync_state;
  ALTER TABLE sync_state DROP COLUMN uid_validity;
  ALTER TABLE sync_state DROP COLUMN modseq;
  `
]

type Row = Record<string, SQLInputValue>

interface ThreadOptions {
  outer?: string
  outerParams?: SQLInputValue[]
  order?: string
  /** 0 for ordinary mail, 1 for Trash, 2 for Spam. */
  bin?: number
}

const SECTIONS: Record<AssistantSection, string[]> = {
  packages: ['package'], travel: ['travel'], money: ['money'], events: ['event']
}

function factsFrom(value: unknown): Facts | null {
  if (!value) return null
  try {
    return JSON.parse(String(value)) as Facts
  } catch {
    return null
  }
}

const parseList = <T>(text: unknown): T[] => {
  try {
    const parsed = JSON.parse(String(text))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** FTS5 strips marks that decompose, and Vietnamese đ doesn't, so "doc" would miss "Đọc". Applied
 *  to the index and to what's typed. */
export const foldForSearch = (text: string): string => text.replace(/[đĐ]/g, 'd')

const SEARCH_FLAGS: Record<string, string> = {
  'has:attachment': 'has_attachment = 1',
  'is:unread': 'seen = 0',
  'is:read': 'seen = 1',
  'is:starred': 'flagged = 1',
  'in:inbox': 'in_inbox = 1'
}

const likeEscape = (text: string): string => text.replace(/[\\%_]/g, (c) => `\\${c}`)

export interface SearchParts {
  /** For FTS5. Quoted terms, each matching as a prefix: what's typed is never read as its syntax. */
  match: string
  filters: string[]
  /** For the `?` in [filters], in order. */
  params: SQLInputValue[]
}

/** Plain words, `from:`, `subject:`, `to:`, `after:` and `before:`, and the handful of flags above. */
export function searchParts(text: string): SearchParts {
  const terms: string[] = []
  const filters: string[] = []
  const params: SQLInputValue[] = []
  for (const raw of foldForSearch(text).split(/\s+/).filter(Boolean).slice(0, 12)) {
    const flag = SEARCH_FLAGS[raw.toLowerCase()]
    if (flag) {
      filters.push(flag)
      continue
    }
    const person = /^to:(.+)$/i.exec(raw)
    if (person) {
      filters.push("lower(to_json || cc_json) LIKE ? ESCAPE '\\'")
      params.push(`%${likeEscape(person[1]?.toLowerCase() ?? '')}%`)
      continue
    }
    const dated = /^(after|before):(\d{4}-\d{1,2}(?:-\d{1,2})?)$/i.exec(raw)
    const day = dated ? Date.parse(`${dated[2]}${dated[2]?.split('-').length === 2 ? '-01' : ''}`.replace(/-(\d)(?=-|$)/g, '-0$1')) : NaN
    if (!Number.isNaN(day)) {
      filters.push(dated?.[1]?.toLowerCase() === 'after' ? 'arrived >= ?' : 'arrived < ?')
      params.push(day)
      continue
    }
    const scoped = /^(from|subject):(.+)$/i.exec(raw)
    const column = scoped ? (scoped[1]?.toLowerCase() === 'from' ? 'sender' : 'subject') : ''
    const word = (scoped?.[2] ?? raw).replace(/"/g, '')
    if (word) terms.push(column ? `${column} : "${word}"*` : `"${word}"*`)
  }
  return { match: terms.join(' '), filters, params }
}

export class Store {
  private db: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    if (path !== ':memory:') {
      chmodSync(path, 0o600)
      this.db.exec('PRAGMA journal_mode = WAL')
    }
    this.migrate()
  }

  private migrate(): void {
    const version = Number(this.one('PRAGMA user_version')?.['user_version'] ?? 0)
    MIGRATIONS.slice(version).forEach((sql, i) => {
      this.inTransaction(() => {
        this.db.exec(sql)
        this.db.exec(`PRAGMA user_version = ${version + i + 1}`)
      })
    })
  }

  close(): void {
    this.db.close()
  }

  private all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[]
  }

  private one(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined
  }

  private inTransaction<T>(work: () => T): T {
    this.db.exec('BEGIN')
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  /** The moment an account was first read: mail from before it is never held back. */
  holdFrom(account: string): number | null {
    const value = this.one('SELECT hold_from FROM sync_state WHERE account = ?', account)?.['hold_from']
    return value == null ? null : Number(value)
  }

  saveHoldFrom(account: string, at: number): void {
    this.db.prepare('INSERT OR REPLACE INTO sync_state(account, hold_from) VALUES(?,?)').run(account, at)
  }

  boxState(account: string, box: string): BoxState | null {
    const row = this.one('SELECT uid_validity, modseq FROM box_state WHERE account = ? AND box = ?', account, box)
    if (!row) return null
    return { uidValidity: String(row['uid_validity']), modseq: row['modseq'] == null ? null : String(row['modseq']) }
  }

  saveBoxState(account: string, box: string, state: BoxState): void {
    this.db
      .prepare('INSERT OR REPLACE INTO box_state(account, box, uid_validity, modseq) VALUES(?,?,?,?)')
      .run(account, box, state.uidValidity, state.modseq)
  }

  uids(account: string, box: string): Set<number> {
    return new Set(this.all('SELECT uid FROM messages WHERE account = ? AND box = ?', account, box).map((r) => Number(r['uid'])))
  }

  /** The new row's id, or null if it was already here. */
  addMail(mail: StoredMail): number | null {
    return this.inTransaction(() => {
      const result = this.db
        .prepare(
          `INSERT OR IGNORE INTO messages(account, box, uid, thread, gmail_id, message_id, subject, from_name, from_address,
             to_json, cc_json, reply_to, refs, unsubscribe, arrived, snippet, body_text, body_html, attachments,
             has_attachment, labels, in_inbox, bin, seen, flagged, hidden, truncated, size, release_at,
             focus, kind, facts, warnings)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          mail.account, mail.box, mail.uid, mail.thread, mail.gmailId, mail.messageId, mail.subject, mail.from.name, mail.from.address,
          JSON.stringify(mail.to), JSON.stringify(mail.cc), JSON.stringify(mail.replyTo), mail.references,
          mail.unsubscribe ? JSON.stringify(mail.unsubscribe) : '',
          mail.arrived, mail.snippet, mail.text, mail.html,
          JSON.stringify(mail.attachments), mail.attachments.length > 0 ? 1 : 0,
          JSON.stringify(mail.labels), mail.labels.includes(INBOX) ? 1 : 0, binOf(mail.labels),
          // Gmail's own unsent drafts live in All Mail too; a thread shouldn't show them as sent.
          mail.seen ? 1 : 0, mail.flagged ? 1 : 0, mail.labels.includes(DRAFT) ? 1 : 0,
          mail.truncated ? 1 : 0, mail.size, mail.releaseAt,
          mail.focused ? 1 : 0, mail.facts?.type ?? '', mail.facts ? JSON.stringify(mail.facts) : '', JSON.stringify(mail.warnings)
        )
      if (Number(result.changes) === 0) return null
      this.db
        .prepare('INSERT INTO search(rowid, subject, sender, body) VALUES(?,?,?,?)')
        .run(
          result.lastInsertRowid,
          foldForSearch(mail.subject),
          foldForSearch(`${mail.from.name} ${mail.from.address}`),
          foldForSearch(mail.text)
        )
      return Number(result.lastInsertRowid)
    })
  }

  /** What the server says about a message now. [labels] is null where only flags can change. */
  applyChange(account: string, box: string, uid: number, labels: string[] | null, seen: boolean, flagged: boolean): boolean {
    const result = labels
      ? this.db
          .prepare('UPDATE messages SET labels = ?, in_inbox = ?, bin = ?, seen = ?, flagged = ? WHERE account = ? AND box = ? AND uid = ?')
          .run(JSON.stringify(labels), labels.includes(INBOX) ? 1 : 0, binOf(labels), seen ? 1 : 0, flagged ? 1 : 0, account, box, uid)
      : this.db
          .prepare('UPDATE messages SET seen = ?, flagged = ? WHERE account = ? AND box = ? AND uid = ? AND (seen != ? OR flagged != ?)')
          .run(seen ? 1 : 0, flagged ? 1 : 0, account, box, uid, seen ? 1 : 0, flagged ? 1 : 0)
    return Number(result.changes) > 0
  }

  /** Forgets mail gone from a folder: everything here from [since] on that isn't in [keep]. */
  removeMissing(account: string, box: string, keep: Set<number>, since: number): number {
    const gone = this.all('SELECT id, uid FROM messages WHERE account = ? AND box = ? AND arrived >= ?', account, box, since).filter(
      (r) => !keep.has(Number(r['uid']))
    )
    this.inTransaction(() => {
      for (const row of gone) this.dropMessage(Number(row['id']))
    })
    return gone.length
  }

  private dropMessage(id: number): void {
    this.db.prepare('DELETE FROM search WHERE rowid = ?').run(id)
    this.db.prepare('DELETE FROM messages WHERE id = ?').run(id)
  }

  wipeAccount(account: string): void {
    this.inTransaction(() => {
      this.db
        .prepare('DELETE FROM search WHERE rowid IN (SELECT id FROM messages WHERE account = ?)')
        .run(account)
      this.db.prepare('DELETE FROM messages WHERE account = ?').run(account)
      this.db.prepare('DELETE FROM sync_state WHERE account = ?').run(account)
      this.db.prepare('DELETE FROM box_state WHERE account = ?').run(account)
      this.db.prepare('DELETE FROM pending WHERE account = ?').run(account)
    })
  }

  /** A folder renumbered itself, so every UID kept for it now points at the wrong message. */
  wipeBox(account: string, box: string): void {
    this.inTransaction(() => {
      for (const row of this.all('SELECT id FROM messages WHERE account = ? AND box = ?', account, box)) this.dropMessage(Number(row['id']))
      this.db.prepare('DELETE FROM box_state WHERE account = ? AND box = ?').run(account, box)
    })
  }

  /** Folders the server no longer lists. */
  keepBoxes(account: string, boxes: string[]): void {
    const kept = new Set(boxes)
    const known = this.all('SELECT DISTINCT box FROM messages WHERE account = ?', account).map((r) => String(r['box']))
    for (const box of known) if (!kept.has(box)) this.wipeBox(account, box)
  }

  /** Everything else kept for an account, once it's removed. Returns the drafts that went. */
  forgetAccount(account: string): number[] {
    const drafts = this.all('SELECT id FROM drafts WHERE account = ?', account).map((r) => Number(r['id']))
    this.db.prepare('DELETE FROM drafts WHERE account = ?').run(account)
    this.db.prepare('DELETE FROM snoozes WHERE account = ?').run(account)
    return drafts
  }

  /** Mail past the keeping window, once the setting's been shortened. */
  dropOlderThan(account: string, before: number): number {
    const old = this.all('SELECT id FROM messages WHERE account = ? AND arrived < ?', account, before)
    this.inTransaction(() => {
      for (const row of old) this.dropMessage(Number(row['id']))
    })
    return old.length
  }

  /** [where] picks messages; `outer` picks whole threads, by `t` and the snooze `s`. Held mail isn't
   *  there at all and hidden mail is on its way out, so both stay out of every clause; [bin] says
   *  which of Trash, Spam or neither is being looked at. */
  private threadRows(where: string, params: SQLInputValue[], now: number, limit: number, options: ThreadOptions = {}): ThreadRow[] {
    const { outer = '1', outerParams = [], order = 'MAX(t.latest, CASE WHEN s.until <= ? THEN s.until ELSE 0 END) DESC', bin = 0 } = options
    const rows = this.all(
      `SELECT m.account, m.thread, m.subject, m.from_name, m.from_address, m.snippet, m.facts, t.latest AS date,
              t.n, t.unread, t.attachment, t.starred, s.until AS snoozed
       FROM (SELECT account, thread, MAX(arrived) AS latest, COUNT(*) AS n,
                    SUM(seen = 0) AS unread, MAX(has_attachment) AS attachment, MAX(flagged) AS starred
             FROM messages WHERE release_at <= ? AND hidden = 0 AND bin = ? AND ${where} GROUP BY account, thread) t
       JOIN messages m ON m.account = t.account AND m.thread = t.thread AND m.arrived = t.latest
                      AND m.release_at <= ? AND m.hidden = 0 AND m.bin = ?
       LEFT JOIN snoozes s ON s.account = t.account AND s.thread = t.thread
       WHERE ${outer}
       GROUP BY m.account, m.thread
       ORDER BY ${order} LIMIT ?`,
      now, bin, ...params, now, bin, ...outerParams, ...(order.includes('?') ? [now] : []), limit
    )
    return rows.map((r) => ({
      ...this.whoAndWhat(String(r['account']), String(r['thread']), now, bin),
      account: String(r['account']),
      thread: String(r['thread']),
      subject: String(r['subject']),
      fromName: String(r['from_name']),
      fromAddress: String(r['from_address']),
      snippet: String(r['snippet']),
      date: Number(r['date']),
      count: Number(r['n']),
      unread: Number(r['unread']),
      attachment: Number(r['attachment']) > 0,
      starred: Number(r['starred']) > 0,
      snoozedUntil: r['snoozed'] == null ? null : Number(r['snoozed']),
      facts: factsFrom(r['facts'])
    }))
  }

  /** Who's in a thread and what's attached. Held and hidden mail stays out of this too. */
  private whoAndWhat(account: string, thread: string, now: number, bin: number): Pick<ThreadRow, 'people' | 'file' | 'files'> {
    const rows = this.all(
      `SELECT from_name, from_address, attachments FROM messages
       WHERE account = ? AND thread = ? AND release_at <= ? AND hidden = 0 AND bin = ? ORDER BY arrived ASC`,
      account, thread, now, bin
    )
    const people = new Map<string, Address>()
    const files: AttachmentInfo[] = []
    for (const row of rows) {
      const address = String(row['from_address'])
      if (!people.has(address.toLowerCase())) people.set(address.toLowerCase(), { name: String(row['from_name']), address })
      files.push(...parseList<AttachmentInfo>(row['attachments']))
    }
    return { people: [...people.values()], file: files[0]?.name ?? null, files: files.length }
  }

  list(query: ListQuery, now: number, limit = 200): ThreadRow[] {
    if (query.kind === 'label') {
      return this.threadRows(
        `account = ? AND EXISTS (SELECT 1 FROM json_each(labels) WHERE json_each.value = ?)`,
        [query.account, query.label], now, limit
      )
    }
    if (query.kind === 'search') {
      const { match, filters, params } = searchParts(query.text)
      if (!match && filters.length === 0) return []
      const where = [...filters, ...(match ? ['id IN (SELECT rowid FROM search WHERE search MATCH ?)'] : [])].join(' AND ')
      try {
        return this.threadRows(where, [...params, ...(match ? [match] : [])], now, limit)
      } catch {
        return [] // half-typed input FTS5 can't read isn't an error worth showing
      }
    }
    if (query.kind === 'assistant') {
      const kinds = SECTIONS[query.section].map(() => '?').join(',')
      return this.threadRows(`kind IN (${kinds})`, SECTIONS[query.section], now, limit)
    }
    const scope = query.account ? ['account = ?'] : []
    const params = query.account ? [query.account] : []
    const by = (clause: string): string => [clause, ...scope].join(' AND ')
    const away = 's.until > ? AND s.at >= t.latest'
    switch (query.kind) {
      case 'inbox': {
        const side = query.focus ? ` AND focus = ${query.focus === 'focused' ? 1 : 0}` : ''
        return this.threadRows(by(`in_inbox = 1${side}`), params, now, limit, { outer: `NOT (s.until IS NOT NULL AND ${away})`, outerParams: [now] })
      }
      case 'snoozed':
        return this.threadRows(by('in_inbox = 1'), params, now, limit, { outer: away, outerParams: [now], order: 's.until ASC' })
      case 'starred':
        return this.threadRows(by('flagged = 1'), params, now, limit)
      case 'sent':
        return this.threadRows(by(`EXISTS (SELECT 1 FROM json_each(labels) WHERE json_each.value = '\\Sent')`), params, now, limit)
      case 'all':
        return this.threadRows(by('1'), params, now, limit)
      case 'trash':
        return this.threadRows(by('1'), params, now, limit, { bin: 1 })
      case 'spam':
        return this.threadRows(by('1'), params, now, limit, { bin: 2 })
      case 'unread':
        return this.threadRows(by('in_inbox = 1 AND seen = 0'), params, now, limit, { outer: `NOT (s.until IS NOT NULL AND ${away})`, outerParams: [now] })
      case 'attachments':
        return this.threadRows(by('has_attachment = 1'), params, now, limit)
      case 'today':
        return this.threadRows(by('in_inbox = 1 AND arrived >= ?'), [new Date(now).setHours(0, 0, 0, 0), ...params], now, limit, { outer: `NOT (s.until IS NOT NULL AND ${away})`, outerParams: [now] })
    }
  }

  /** Threads in Spam with something unread. */
  spamCount(now: number): number {
    return Number(this.one('SELECT COUNT(DISTINCT account || thread) AS n FROM messages WHERE release_at <= ? AND hidden = 0 AND bin = 2 AND seen = 0', now)?.['n'] ?? 0)
  }

  /** Unread mail the Assistant recognised, by section. */
  assistantCounts(now: number): Record<AssistantSection, number> {
    const rows = this.all(
      `SELECT kind, COUNT(DISTINCT account || thread) AS n FROM messages
       WHERE release_at <= ? AND hidden = 0 AND bin = 0 AND seen = 0 AND kind != '' GROUP BY kind`,
      now
    )
    const count = (kind: string): number => Number(rows.find((r) => r['kind'] === kind)?.['n'] ?? 0)
    return { packages: count('package'), travel: count('travel'), money: count('money'), events: count('event') }
  }

  /** Messages whose preview hasn't been made by this version of the app yet, a few at a time. */
  staleSnippets(after: number, limit: number): { id: number; text: string; html: string | null }[] {
    return this.all('SELECT id, body_text, body_html FROM messages WHERE id > ? ORDER BY id LIMIT ?', after, limit).map((r) => ({
      id: Number(r['id']),
      text: String(r['body_text']),
      html: r['body_html'] == null ? null : String(r['body_html'])
    }))
  }

  setSnippet(id: number, snippet: string): void {
    this.db.prepare('UPDATE messages SET snippet = ? WHERE id = ?').run(snippet, id)
  }

  /** Changes waiting out their Undo go at once: the app is closing, so nobody can take them back. */
  hurryActions(now: number): void {
    this.db.prepare('UPDATE pending SET due = ? WHERE due > ?').run(now, now)
  }

  /** One thread, as one list of messages. A copy in two folders is still one message. */
  thread(account: string, thread: string, now: number, bins = false): MessageView[] {
    const rows = this.all(
      `SELECT * FROM messages WHERE account = ? AND thread = ? AND release_at <= ? AND hidden = 0 AND ${bins ? 'bin > 0' : 'bin = 0'} ORDER BY arrived ASC`,
      account, thread, now
    )
    const seen = new Set<string>()
    return rows
      .filter((r) => {
        const id = String(r['message_id'])
        if (id && seen.has(id)) return false
        seen.add(id)
        return true
      })
      .map((r) => this.view(r))
  }

  private view(r: Row): MessageView {
    return {
      id: Number(r['id']),
      account: String(r['account']),
      thread: String(r['thread']),
      subject: String(r['subject']),
      from: { name: String(r['from_name']), address: String(r['from_address']) },
      to: parseList<Address>(r['to_json']),
      cc: parseList<Address>(r['cc_json']),
      date: Number(r['arrived']),
      text: String(r['body_text']),
      html: r['body_html'] == null ? null : String(r['body_html']),
      attachments: parseList<AttachmentInfo>(r['attachments']),
      truncated: Number(r['truncated']) > 0,
      labels: parseList<string>(r['labels']),
      seen: Number(r['seen']) > 0,
      flagged: Number(r['flagged']) > 0,
      unsubscribe: String(r['unsubscribe']) !== '',
      focused: Number(r['focus']) > 0,
      facts: factsFrom(r['facts']),
      warnings: parseList<SenderWarning>(r['warnings']),
      replyTo: parseList<Address>(r['reply_to'])
    }
  }

  /** One message, only if it may be seen now. */
  message(id: number, now: number): MessageDetail | null {
    const r = this.one('SELECT * FROM messages WHERE id = ? AND release_at <= ? AND hidden = 0', id, now)
    if (!r) return null
    const unsubscribe = String(r['unsubscribe'])
    return {
      ...this.view(r),
      box: String(r['box']),
      uid: Number(r['uid']),
      messageId: String(r['message_id']),
      references: String(r['refs']),
      unsubscribeTo: unsubscribe ? (JSON.parse(unsubscribe) as Unsubscribe) : null
    }
  }

  private stateFrom(r: Row): MailState {
    return {
      id: Number(r['id']),
      box: String(r['box']),
      labels: parseList<string>(r['labels']),
      seen: Number(r['seen']) > 0,
      flagged: Number(r['flagged']) > 0,
      hidden: Number(r['hidden']) > 0
    }
  }

  /** The messages of a thread that an action may touch: never one still waiting for its batch. */
  visibleMail(ref: ThreadRef, now: number, bins: boolean): MailState[] {
    return this.all(
      `SELECT id, box, labels, seen, flagged, hidden FROM messages
       WHERE account = ? AND thread = ? AND release_at <= ? AND hidden = 0 ${bins ? '' : 'AND bin = 0'}`,
      ref.account, ref.thread, now
    ).map((r) => this.stateFrom(r))
  }

  visibleState(id: number): MailState | null {
    const row = this.one('SELECT id, box, labels, seen, flagged, hidden FROM messages WHERE id = ?', id)
    return row ? this.stateFrom(row) : null
  }

  /** What opening a thread reads. */
  unreadMail(ref: ThreadRef, now: number, bins: boolean): MailState[] {
    return this.visibleMail(ref, now, true).filter((s) => !s.seen && (bins ? binOf(s.labels) > 0 : binOf(s.labels) === 0))
  }

  setMailStates(states: MailState[]): void {
    this.inTransaction(() => {
      for (const s of states) {
        this.db
          .prepare('UPDATE messages SET labels = ?, in_inbox = ?, bin = ?, seen = ?, flagged = ?, hidden = ? WHERE id = ?')
          .run(JSON.stringify(s.labels), s.labels.includes(INBOX) ? 1 : 0, binOf(s.labels), s.seen ? 1 : 0, s.flagged ? 1 : 0, s.hidden ? 1 : 0, s.id)
      }
    })
  }

  /** Puts messages back how they were, except any the server has already moved: for those, where
   *  they are now is the truth. */
  restoreMail(states: MailState[]): void {
    const here = new Map(this.locate(states.map((s) => s.id)).map((row) => [row.id, row.box]))
    this.setMailStates(states.filter((s) => here.get(s.id) === s.box))
  }

  locate(ids: number[]): Located[] {
    return this.all('SELECT id, box, uid FROM messages WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(ids)).map((r) => ({
      id: Number(r['id']),
      box: String(r['box']),
      uid: Number(r['uid'])
    }))
  }

  /** The server moved it, so its folder, UID and labels here change to match. */
  rehome(id: number, box: string, uid: number, labels: string[] | null): void {
    const moved = this.db.prepare('UPDATE OR IGNORE messages SET box = ?, uid = ? WHERE id = ?').run(box, uid, id)
    if (Number(moved.changes) === 0) return this.dropIds([id]) // a sync got there first
    if (!labels) return
    this.db.prepare('UPDATE messages SET labels = ?, in_inbox = ?, bin = ? WHERE id = ?').run(JSON.stringify(labels), labels.includes(INBOX) ? 1 : 0, binOf(labels), id)
  }

  /** Gone from where this app reads, on purpose, so there's no waiting for a sync to notice. */
  dropIds(ids: number[]): void {
    this.inTransaction(() => {
      for (const id of ids) this.dropMessage(id)
    })
  }

  enqueue(item: Omit<PendingAction, 'id' | 'attempts'>): void {
    this.db
      .prepare('INSERT INTO pending(grp, account, action, ids, before, due) VALUES(?,?,?,?,?,?)')
      .run(item.group, item.account, JSON.stringify(item.action), JSON.stringify(item.ids), JSON.stringify(item.before), item.due)
  }

  private pendingFrom(r: Row): PendingAction {
    return {
      id: Number(r['id']),
      group: Number(r['grp']),
      account: String(r['account']),
      action: JSON.parse(String(r['action'])) as MailAction,
      ids: parseList<number>(r['ids']),
      before: parseList<MailState>(r['before']),
      due: Number(r['due']),
      attempts: Number(r['attempts'])
    }
  }

  dueActions(account: string, now: number): PendingAction[] {
    return this.all('SELECT * FROM pending WHERE account = ? AND due <= ? ORDER BY id', account, now).map((r) => this.pendingFrom(r))
  }

  actionsInGroup(group: number): PendingAction[] {
    return this.all('SELECT * FROM pending WHERE grp = ? ORDER BY id DESC', group).map((r) => this.pendingFrom(r))
  }

  lastActionGroup(): number {
    return Number(this.one('SELECT MAX(grp) AS g FROM pending')?.['g'] ?? 0)
  }

  /** UIDs in a folder with a change still on its way. */
  busyUids(account: string, box: string): Set<number> {
    const rows = this.all(
      `SELECT uid FROM messages WHERE account = ? AND box = ? AND id IN (
         SELECT j.value FROM pending p, json_each(p.ids) j WHERE p.account = ?)`,
      account, box, account
    )
    return new Set(rows.map((r) => Number(r['uid'])))
  }

  finishAction(id: number): void {
    this.db.prepare('DELETE FROM pending WHERE id = ?').run(id)
  }

  retryAction(id: number, due: number, attempts: number): void {
    this.db.prepare('UPDATE pending SET due = ?, attempts = ? WHERE id = ?').run(due, attempts, id)
  }

  snooze(ref: ThreadRef, at: number, until: number): void {
    this.db
      .prepare('INSERT OR REPLACE INTO snoozes(account, thread, at, until) VALUES(?,?,?,?)')
      .run(ref.account, ref.thread, at, until)
  }

  unsnooze(ref: ThreadRef): void {
    this.db.prepare('DELETE FROM snoozes WHERE account = ? AND thread = ?').run(ref.account, ref.thread)
  }

  /** How many snoozed threads came back in (after, upto]. */
  wokenBetween(after: number, upto: number): number {
    return Number(this.one('SELECT COUNT(*) AS n FROM snoozes WHERE until > ? AND until <= ?', after, upto)?.['n'] ?? 0)
  }

  addDraft(draft: Omit<Draft, 'id' | 'state' | 'sendAt' | 'error'>): number {
    const { account, updated, ...data } = draft
    return Number(
      this.db.prepare('INSERT INTO drafts(account, data, updated) VALUES(?,?,?)').run(account, JSON.stringify(data), updated).lastInsertRowid
    )
  }

  private draftFrom(r: Row): Draft {
    return {
      ...(JSON.parse(String(r['data'])) as Omit<Draft, 'id' | 'account' | 'state' | 'sendAt' | 'error' | 'updated' | 'from'> & { from?: string }),
      from: String((JSON.parse(String(r['data'])) as { from?: string }).from ?? ''),
      id: Number(r['id']),
      account: String(r['account']),
      state: String(r['state']) as DraftState,
      sendAt: r['send_at'] == null ? null : Number(r['send_at']),
      error: r['error'] == null ? null : String(r['error']),
      updated: Number(r['updated'])
    }
  }

  draft(id: number): Draft | null {
    const row = this.one('SELECT * FROM drafts WHERE id = ?', id)
    return row ? this.draftFrom(row) : null
  }

  drafts(): Draft[] {
    return this.all('SELECT * FROM drafts ORDER BY updated DESC').map((r) => this.draftFrom(r))
  }

  saveDraft(draft: Draft): void {
    const { id, account, state, sendAt, error, updated, ...data } = draft
    this.db
      .prepare('UPDATE drafts SET account = ?, data = ?, updated = ?, state = ?, send_at = ?, error = ? WHERE id = ?')
      .run(account, JSON.stringify(data), updated, state, sendAt, error, id)
  }

  deleteDraft(id: number): void {
    this.db.prepare('DELETE FROM drafts WHERE id = ?').run(id)
  }

  dueDrafts(now: number): Draft[] {
    return this.all("SELECT * FROM drafts WHERE state = 'queued' AND send_at <= ? ORDER BY send_at", now).map((r) => this.draftFrom(r))
  }

  /** Marks a draft as on its way, only if it's still queued from [account] and its time has come, and
   *  returns it as it is now. After this the page can neither change it nor throw it away. */
  claimDraft(id: number, account: string, now: number): Draft | null {
    const taken = this.db
      .prepare("UPDATE drafts SET state = 'sending' WHERE id = ? AND account = ? AND state = 'queued' AND send_at <= ?")
      .run(id, account, now)
    return Number(taken.changes) === 1 ? this.draft(id) : null
  }

  /** Whatever was mid-send when the app stopped may or may not have gone. It's never sent twice on a
   *  guess, so it's handed back to be looked at. */
  failInterrupted(message: string): void {
    this.db.prepare("UPDATE drafts SET state = 'failed', error = ?, send_at = NULL WHERE state = 'sending'").run(message)
  }

  /** People seen in mail you can see, the ones you've written to first. */
  contacts(text: string, now: number, limit = 8): Address[] {
    const like = `%${likeEscape(text.trim().toLowerCase())}%`
    const rows = this.all(
      `SELECT name, address, SUM(weight) AS score FROM (
         SELECT from_name AS name, lower(from_address) AS address, 1 AS weight
           FROM messages WHERE release_at <= ? AND hidden = 0 AND bin = 0 AND from_address != ''
         UNION ALL
         SELECT json_extract(j.value, '$.name'), lower(json_extract(j.value, '$.address')), 5
           FROM messages m, json_each(m.to_json) j
           WHERE m.release_at <= ? AND m.hidden = 0 AND m.bin = 0
             AND EXISTS (SELECT 1 FROM json_each(m.labels) l WHERE l.value = '\\Sent'))
       WHERE lower(address) LIKE ? ESCAPE '\\' OR lower(name) LIKE ? ESCAPE '\\'
       GROUP BY address ORDER BY score DESC, address LIMIT ?`,
      now, now, like, like, limit
    )
    return rows.map((r) => ({ name: String(r['name'] ?? ''), address: String(r['address']) }))
  }

  /** Whether this account has written to an address, which marks someone as a person you know. */
  wroteTo(account: string, address: string): boolean {
    const row = this.one(
      `SELECT 1 FROM messages m, json_each(m.to_json) j
       WHERE m.account = ? AND EXISTS (SELECT 1 FROM json_each(m.labels) l WHERE l.value = '\\Sent')
         AND lower(json_extract(j.value, '$.address')) = ? LIMIT 1`,
      account, address.toLowerCase()
    )
    return row !== undefined
  }

  /** Moves what a sender has already sent to one side of the inbox. */
  setFocus(address: string, focused: boolean): void {
    this.db.prepare('UPDATE messages SET focus = ? WHERE lower(from_address) = ?').run(focused ? 1 : 0, address.toLowerCase())
  }

  /** Threads with something unread in an inbox. A snoozed thread isn't waiting for anyone. */
  unreadThreads(now: number, where: string, ...params: SQLInputValue[]): number {
    const row = this.one(
      `SELECT COUNT(*) AS n FROM (SELECT DISTINCT m.account, m.thread FROM messages m
         LEFT JOIN snoozes s ON s.account = m.account AND s.thread = m.thread
         WHERE m.release_at <= ? AND m.hidden = 0 AND m.bin = 0 AND m.in_inbox = 1 AND m.seen = 0
           AND NOT (s.until IS NOT NULL AND s.until > ? AND s.at >= m.arrived) AND ${where})`,
      now, now, ...params
    )
    return Number(row?.['n'] ?? 0)
  }

  /** Who's mailing you in bulk, by how much. */
  subscriptions(now: number): Subscription[] {
    const rows = this.all(
      `SELECT account, lower(from_address) AS address, MAX(from_name) AS name, COUNT(*) AS n, MAX(arrived) AS latest, MAX(id) AS newest
       FROM messages WHERE release_at <= ? AND hidden = 0 AND bin = 0 AND unsubscribe != '' AND from_address != ''
       GROUP BY account, lower(from_address) ORDER BY n DESC, latest DESC LIMIT 300`,
      now
    )
    return rows.map((r) => ({
      account: String(r['account']),
      name: String(r['name'] ?? ''),
      address: String(r['address']),
      count: Number(r['n']),
      latest: Number(r['latest']),
      message: Number(r['newest'])
    }))
  }

  /** Every thread a sender has mail in, that could be seen now. */
  threadsFrom(account: string, address: string, now: number): ThreadRef[] {
    return this.all(
      'SELECT DISTINCT thread FROM messages WHERE account = ? AND lower(from_address) = ? AND release_at <= ? AND hidden = 0 AND bin = 0',
      account, address.toLowerCase(), now
    ).map((r) => ({ account, thread: String(r['thread']) }))
  }

  heldCount(now: number): number {
    return Number(this.one('SELECT COUNT(*) AS n FROM messages WHERE release_at > ? AND hidden = 0 AND bin = 0', now)?.['n'] ?? 0)
  }

  nextRelease(now: number): number | null {
    const value = this.one('SELECT MIN(release_at) AS t FROM messages WHERE release_at > ? AND hidden = 0 AND bin = 0', now)?.['t']
    return value == null ? null : Number(value)
  }

  /** How many held messages landed in (after, upto]: what a batch brought. */
  landedBetween(after: number, upto: number): number {
    return Number(
      this.one(
        'SELECT COUNT(*) AS n FROM messages WHERE release_at > ? AND release_at <= ? AND release_at > arrived AND in_inbox = 1 AND hidden = 0',
        after, upto
      )?.['n'] ?? 0
    )
  }

  releaseAll(now: number): number {
    return Number(this.db.prepare('UPDATE messages SET release_at = ? WHERE release_at > ?').run(now, now).changes)
  }

  /** Moves waiting mail onto a new timetable, after the batch settings change. */
  retime(compute: (mail: HeldMail) => number, now: number): void {
    const rows = this.all('SELECT id, account, arrived, from_address, labels FROM messages WHERE release_at > ?', now)
    this.inTransaction(() => {
      for (const row of rows) {
        const moment = compute({
          account: String(row['account']),
          arrived: Number(row['arrived']),
          fromAddress: String(row['from_address']),
          labels: parseList<string>(row['labels'])
        })
        this.db.prepare('UPDATE messages SET release_at = ? WHERE id = ?').run(moment, Number(row['id']))
      }
    })
  }

  labelCounts(now: number): LabelCount[] {
    const rows = this.all(
      `SELECT m.account AS account, j.value AS label, COUNT(*) AS n
       FROM messages m, json_each(m.labels) j
       WHERE m.release_at <= ? AND m.hidden = 0 AND m.bin = 0 AND j.value NOT LIKE '\\%' ESCAPE '|'
       GROUP BY m.account, j.value ORDER BY m.account, j.value`,
      now
    )
    return rows.map((r) => ({ account: String(r['account']), label: String(r['label']), count: Number(r['n']) }))
  }

  meta(key: string): string | null {
    const row = this.one('SELECT value FROM meta WHERE key = ?', key)
    return row ? String(row['value']) : null
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES(?,?)').run(key, value)
  }

  deleteMeta(key: string): void {
    this.db.prepare('DELETE FROM meta WHERE key = ?').run(key)
  }
}
