import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type { Address, AttachmentInfo, LabelCount, ListQuery, MessageView, ThreadRow } from '@shared/types'

/**
 * Everything on this laptop: one SQLite file. A message waiting for its batch is in here, but no
 * query the page can reach returns one until its moment: every read takes `now`.
 */

export interface StoredMail {
  account: string
  uid: number
  thread: string
  gmailId: string
  messageId: string
  subject: string
  from: Address
  to: Address[]
  cc: Address[]
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
}

export interface HeldMail {
  account: string
  arrived: number
  fromAddress: string
  labels: string[]
}

export interface SyncState {
  uidValidity: string
  modseq: string | null
  holdFrom: number
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

type Row = Record<string, SQLInputValue>

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

/** Quoted terms, each matching as a prefix: what's typed is never read as search syntax. */
export function searchTerms(text: string): string {
  return foldForSearch(text)
    .split(/\s+/)
    .map((word) => word.replace(/"/g, ''))
    .filter(Boolean)
    .slice(0, 12)
    .map((word) => `"${word}"*`)
    .join(' ')
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
    this.db.exec(SCHEMA)
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

  syncState(account: string): SyncState | null {
    const row = this.one('SELECT uid_validity, modseq, hold_from FROM sync_state WHERE account = ?', account)
    if (!row) return null
    return {
      uidValidity: String(row['uid_validity']),
      modseq: row['modseq'] == null ? null : String(row['modseq']),
      holdFrom: Number(row['hold_from'])
    }
  }

  saveSyncState(account: string, state: SyncState): void {
    this.db
      .prepare('INSERT OR REPLACE INTO sync_state(account, uid_validity, modseq, hold_from) VALUES(?,?,?,?)')
      .run(account, state.uidValidity, state.modseq, state.holdFrom)
  }

  uids(account: string): Set<number> {
    return new Set(this.all('SELECT uid FROM messages WHERE account = ?', account).map((r) => Number(r['uid'])))
  }

  addMail(mail: StoredMail): void {
    this.inTransaction(() => {
      const result = this.db
        .prepare(
          `INSERT OR IGNORE INTO messages(account, uid, thread, gmail_id, message_id, subject, from_name, from_address,
             to_json, cc_json, arrived, snippet, body_text, body_html, attachments, has_attachment,
             labels, in_inbox, seen, flagged, truncated, size, release_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          mail.account, mail.uid, mail.thread, mail.gmailId, mail.messageId, mail.subject, mail.from.name, mail.from.address,
          JSON.stringify(mail.to), JSON.stringify(mail.cc), mail.arrived, mail.snippet, mail.text, mail.html,
          JSON.stringify(mail.attachments), mail.attachments.length > 0 ? 1 : 0,
          JSON.stringify(mail.labels), mail.labels.includes('\\Inbox') ? 1 : 0,
          mail.seen ? 1 : 0, mail.flagged ? 1 : 0, mail.truncated ? 1 : 0, mail.size, mail.releaseAt
        )
      if (Number(result.changes) > 0) {
        this.db
          .prepare('INSERT INTO search(rowid, subject, sender, body) VALUES(?,?,?,?)')
          .run(
            result.lastInsertRowid,
            foldForSearch(mail.subject),
            foldForSearch(`${mail.from.name} ${mail.from.address}`),
            foldForSearch(mail.text)
          )
      }
    })
  }

  applyChange(account: string, uid: number, labels: string[], seen: boolean, flagged: boolean): void {
    this.db
      .prepare('UPDATE messages SET labels = ?, in_inbox = ?, seen = ?, flagged = ? WHERE account = ? AND uid = ?')
      .run(JSON.stringify(labels), labels.includes('\\Inbox') ? 1 : 0, seen ? 1 : 0, flagged ? 1 : 0, account, uid)
  }

  /** Forgets mail gone from Gmail: everything here from [since] on that isn't in [keep]. */
  removeMissing(account: string, keep: Set<number>, since: number): number {
    const gone = this.all('SELECT id, uid FROM messages WHERE account = ? AND arrived >= ?', account, since).filter(
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
    })
  }

  /** Mail past the keeping window, once the setting's been shortened. */
  dropOlderThan(account: string, before: number): number {
    const old = this.all('SELECT id FROM messages WHERE account = ? AND arrived < ?', account, before)
    this.inTransaction(() => {
      for (const row of old) this.dropMessage(Number(row['id']))
    })
    return old.length
  }

  private threadRows(where: string, params: SQLInputValue[], now: number, limit: number): ThreadRow[] {
    const rows = this.all(
      `SELECT m.account, m.thread, m.subject, m.from_name, m.from_address, m.snippet, t.latest AS date,
              t.n, t.unread, t.attachment
       FROM (SELECT account, thread, MAX(arrived) AS latest, COUNT(*) AS n,
                    SUM(seen = 0 AND read_here = 0) AS unread, MAX(has_attachment) AS attachment
             FROM messages WHERE release_at <= ? AND ${where} GROUP BY account, thread) t
       JOIN messages m ON m.account = t.account AND m.thread = t.thread AND m.arrived = t.latest AND m.release_at <= ?
       GROUP BY m.account, m.thread
       ORDER BY t.latest DESC LIMIT ?`,
      now, ...params, now, limit
    )
    return rows.map((r) => ({
      account: String(r['account']),
      thread: String(r['thread']),
      subject: String(r['subject']),
      fromName: String(r['from_name']),
      fromAddress: String(r['from_address']),
      snippet: String(r['snippet']),
      date: Number(r['date']),
      count: Number(r['n']),
      unread: Number(r['unread']),
      attachment: Number(r['attachment']) > 0
    }))
  }

  list(query: ListQuery, now: number, limit = 200): ThreadRow[] {
    if (query.kind === 'inbox') {
      return query.account
        ? this.threadRows('in_inbox = 1 AND account = ?', [query.account], now, limit)
        : this.threadRows('in_inbox = 1', [], now, limit)
    }
    if (query.kind === 'label') {
      return this.threadRows(
        `account = ? AND EXISTS (SELECT 1 FROM json_each(labels) WHERE json_each.value = ?)`,
        [query.account, query.label], now, limit
      )
    }
    const terms = searchTerms(query.text)
    if (!terms) return []
    return this.threadRows('id IN (SELECT rowid FROM search WHERE search MATCH ?)', [terms], now, limit)
  }

  thread(account: string, thread: string, now: number): MessageView[] {
    const rows = this.all(
      'SELECT * FROM messages WHERE account = ? AND thread = ? AND release_at <= ? ORDER BY arrived ASC',
      account, thread, now
    )
    return rows.map((r) => ({
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
      truncated: Number(r['truncated']) > 0
    }))
  }

  /** Read on this laptop. Gmail itself is left alone. */
  markRead(account: string, thread: string, now: number): void {
    this.db
      .prepare('UPDATE messages SET read_here = 1 WHERE account = ? AND thread = ? AND release_at <= ?')
      .run(account, thread, now)
  }

  heldCount(now: number): number {
    return Number(this.one('SELECT COUNT(*) AS n FROM messages WHERE release_at > ?', now)?.['n'] ?? 0)
  }

  nextRelease(now: number): number | null {
    const value = this.one('SELECT MIN(release_at) AS t FROM messages WHERE release_at > ?', now)?.['t']
    return value == null ? null : Number(value)
  }

  /** How many messages landed in (after, upto]: what a batch brought. */
  landedBetween(after: number, upto: number): number {
    return Number(
      this.one(
        'SELECT COUNT(*) AS n FROM messages WHERE release_at > ? AND release_at <= ? AND in_inbox = 1',
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
       WHERE m.release_at <= ? AND j.value NOT LIKE '\\%' ESCAPE '|'
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
