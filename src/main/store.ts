import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type {
  Address, AssistantSection, AttachmentInfo, Draft, DraftState, Facts, HeaderDetails, LabelCount, ListQuery, MailAction, MessageView, SenderWarning,
  Subscription, ThreadRef, ThreadRow
} from '@shared/types'
import { authenticated } from '@shared/images'
import { ageStart, firstTerms, parseQuery, type Field, type Term } from '@shared/query'
import { binOf, DRAFT, INBOX, type MailState } from './actions'
import type { Hold } from './batches'
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
  /** Held for the Summary, and once it lands, part of the Summary it came with. */
  summary: boolean
  focused: boolean
  facts: Facts | null
  warnings: SenderWarning[]
  /** What its headers say about where it came from, for its details. Null when they couldn't be read. */
  details?: HeaderDetails | null
}

export interface HeldMail {
  account: string
  arrived: number
  fromAddress: string
  labels: string[]
}

/** The Summary that landed last: when, and what of it is still waiting to be read in the inbox. */
export interface LatestSummary {
  at: number
  /** Threads in it still unread in the inbox. */
  unread: number
  /** Who sent those, by name, each once. */
  senders: string[]
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

/** A draft's copy in its account's Drafts folder. The UID only means something while the folder's
 *  UIDVALIDITY is [validity]; the Message-ID finds it again when that changes. */
export interface DraftCopy {
  uid: number
  validity: string
  messageId: string
}

/** How a draft here stands with its copy on the server. */
export interface DraftLink {
  id: number
  account: string
  state: DraftState
  updated: number
  /** The copy that matches it, if one has been made or read. */
  copy: DraftCopy | null
  /** The Message-ID of the last copy, kept when its UID no longer means anything. */
  messageId: string
  /** The `updated` the copy was made from: older than `updated`, and the draft has changed since. */
  pushed: number
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
export const MIGRATIONS = [
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
  `,
  // A message cut short lists only the files in the part that was kept, so its list waits to be made
  // again from the whole message.
  `
  ALTER TABLE messages ADD COLUMN files_cut INTEGER NOT NULL DEFAULT 0;
  UPDATE messages SET files_cut = 1 WHERE truncated = 1;
  `,
  // The counts beside the list read columns that sit after the bodies, so answering them from the
  // table walked every message's overflow pages. These hold all that a count reads. They're partial
  // and start with a column the counts read a range of: one that started with bin and hidden was the
  // planner's choice for every list as well, and made the lists twenty times slower.
  `
  CREATE INDEX messages_visible ON messages(release_at, account, labels) WHERE hidden = 0 AND bin = 0;
  CREATE INDEX messages_unread ON messages(in_inbox, release_at, bin, focus, arrived, account, thread) WHERE seen = 0 AND hidden = 0;
  DROP INDEX messages_kind;
  CREATE INDEX messages_kind ON messages(kind, release_at, bin, hidden, seen, account, thread);
  `,
  // Pinned threads. A mail server has no mark for it, so like a snooze it's kept here by thread.
  `
  CREATE TABLE pins(
    account TEXT NOT NULL, thread TEXT NOT NULL, at INTEGER NOT NULL,
    PRIMARY KEY(account, thread));
  `,
  // Recently Seen: the threads opened here, when each was last opened. Nothing on a server knows.
  `
  CREATE TABLE recent(
    account TEXT NOT NULL, thread TEXT NOT NULL, at INTEGER NOT NULL,
    PRIMARY KEY(account, thread));
  CREATE INDEX recent_at ON recent(at);
  `,
  // The Subscription Summary. A message held for it is marked, and stays marked once it lands, which
  // is how it's kept out of the inbox and gathered by the Summary it came with. The counts beside the
  // list now ask about it too, so the indexes that answer them carry it, starting as before; and the
  // Summary's own few rows have an index that holds all its counts read.
  `
  ALTER TABLE messages ADD COLUMN summary INTEGER NOT NULL DEFAULT 0;
  DROP INDEX messages_visible;
  CREATE INDEX messages_visible ON messages(release_at, account, labels, summary) WHERE hidden = 0 AND bin = 0;
  DROP INDEX messages_unread;
  CREATE INDEX messages_unread ON messages(in_inbox, release_at, bin, focus, arrived, account, thread, summary) WHERE seen = 0 AND hidden = 0;
  CREATE INDEX messages_summary ON messages(release_at, account, thread, hidden, bin, in_inbox, seen, from_name, from_address, arrived) WHERE summary = 1;
  `,
  // What the headers say about where a message came from, for its details panel. Mail stored before
  // this has none, and has its headers read from the server the first time its details are opened.
  `
  ALTER TABLE messages ADD COLUMN details TEXT NOT NULL DEFAULT '';
  `,
  // Drafts are kept in the account's Drafts folder too. A draft knows the copy there that matches it
  // (its UID, the folder's UIDVALIDITY when it was had, and the copy's Message-ID), and which of its
  // own versions that copy is (`pushed`, the `updated` it was made from; 0 for none, so every draft
  // already here goes up). A copy that has to go, because the draft was sent, thrown away or
  // replaced, waits in `draft_copies` until the server has said yes, as a change to mail does.
  // Drafts now come and go behind the page's back, so an id is never given out twice: the newest
  // draft thrown away used to leave its id for the next, and a page still holding it meant the other.
  `
  CREATE TABLE drafts_next(
    id INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT NOT NULL, data TEXT NOT NULL, updated INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'draft', send_at INTEGER, error TEXT,
    remote_uid INTEGER, remote_validity TEXT NOT NULL DEFAULT '', remote_id TEXT NOT NULL DEFAULT '', pushed INTEGER NOT NULL DEFAULT 0);
  INSERT INTO drafts_next(id, account, data, updated, state, send_at, error) SELECT id, account, data, updated, state, send_at, error FROM drafts;
  DROP TABLE drafts;
  ALTER TABLE drafts_next RENAME TO drafts;
  CREATE TABLE draft_copies(
    id INTEGER PRIMARY KEY, account TEXT NOT NULL, uid INTEGER NOT NULL, validity TEXT NOT NULL, message_id TEXT NOT NULL DEFAULT '');
  `,
  // Mail from before the keeping window, fetched because a search found it on the server and it was
  // opened. It's an ordinary row, so reading and changing it work as for any other, and it's listed
  // here as well, with when it was last opened: no list or count but its thread, Pinned and
  // Recently Seen sees it, and a week unopened it goes.
  `
  CREATE TABLE outside(id INTEGER PRIMARY KEY, used INTEGER NOT NULL);
  `,
  // Reminders: a thread comes back to the inbox at `until` if nobody else has written in it since
  // `at`. One set as a message is sent knows only its Message-ID until the copy in Sent is here, and
  // then its thread. `fired` once it has come back, and `seen` once it has been opened since. Kept
  // here only, as snoozes are. Finding the thread is by Message-ID, which has an index for it.
  `
  CREATE TABLE reminders(
    id INTEGER PRIMARY KEY, account TEXT NOT NULL, thread TEXT NOT NULL DEFAULT '', message_id TEXT NOT NULL DEFAULT '',
    at INTEGER NOT NULL, until INTEGER NOT NULL, fired INTEGER NOT NULL DEFAULT 0, seen INTEGER NOT NULL DEFAULT 0);
  CREATE INDEX reminders_thread ON reminders(account, thread);
  CREATE INDEX messages_message_id ON messages(account, message_id);
  `
]

type Row = Record<string, SQLInputValue>

interface ThreadOptions {
  outer?: string
  outerParams?: SQLInputValue[]
  order?: string
  /** 0 for ordinary mail, 1 for Trash, 2 for Spam. */
  bin?: number
  /** Mail from before the window that was fetched for a search counts too. */
  outside?: boolean
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

/** What a message's headers said, as kept with it; nothing for mail kept before they were. */
function detailsFrom(value: unknown): HeaderDetails | null {
  if (!value) return null
  try {
    return JSON.parse(String(value)) as HeaderDetails
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

/** Leaves out mail from before the window that was fetched for a search. Only the row id is read, so
 *  a count answered from an index still is. */
const INSIDE = 'id NOT IN (SELECT id FROM outside)'

/** A thread a reminder has brought back to the inbox here, for a query over `messages`, and one of
 *  those not opened since. */
const REMINDED = '(account, thread) IN (SELECT account, thread FROM reminders WHERE fired = 1)'
const REMINDED_UNSEEN = '(account, thread) IN (SELECT account, thread FROM reminders WHERE fired = 1 AND seen = 0)'
/** When a thread came back from a reminder, for ordering a list: it's on top from then. */
const CAME_BACK = 'CASE WHEN r.fired = 1 THEN r.until ELSE 0 END'

/** Whether a message's thread is pinned, for a query over `messages`. */
const PINNED = 'EXISTS (SELECT 1 FROM pins p WHERE p.account = messages.account AND p.thread = messages.thread) AS pinned'

const WEEK_MS = 7 * 86_400_000

const subscriptionFrom = (r: Row): Subscription => ({
  account: String(r['account']),
  name: String(r['name'] ?? ''),
  address: String(r['address']),
  count: Number(r['n']),
  latest: Number(r['latest']),
  message: Number(r['newest']),
  read: Number(r['opened'] ?? 0),
  week: Number(r['week'] ?? 0)
})

/** How many of a thread's files a row of the list names. */
export const ROW_CARDS = 3

/** How many threads Recently Seen remembers. Opening another lets the oldest go. */
export const RECENT_KEPT = 100

/** Recently Seen's order: last opened first. Opened within the same millisecond, the later write wins. */
const RECENT_ORDER = `(SELECT r.at FROM recent r WHERE r.account = t.account AND r.thread = t.thread) DESC,
  (SELECT r.rowid FROM recent r WHERE r.account = t.account AND r.thread = t.thread) DESC`

const likeEscape = (text: string): string => text.replace(/[\\%_]/g, (c) => `\\${c}`)

export interface SearchParts {
  /** For FTS5. Quoted terms, each matching as a prefix, or as written for a quoted phrase: what's
   *  typed is never read as its syntax. */
  match: string
  filters: string[]
  /** For the `?` in [filters], in order. */
  params: SQLInputValue[]
}

const FTS_COLUMNS: Partial<Record<Field, string>> = { any: '', from: 'sender', subject: 'subject' }

/** A word for FTS5, in quotes so nothing in it is syntax. */
const ftsOf = (term: Extract<Term, { kind: 'word' }>): string => {
  const column = FTS_COLUMNS[term.field]
  return `${column ? `${column} : ` : ''}"${term.text}"${term.exact ? '' : '*'}`
}

/** Whether any of a message's labels, or on other services its folder, is [place]: as typed, or as
 *  Gmail writes a label in a search, with dashes for spaces and slashes. */
const LABELLED = `EXISTS (SELECT 1 FROM json_each(labels) WHERE lower(json_each.value) = ? OR replace(replace(lower(json_each.value), ' ', '-'), '/', '-') = ?)`
const SENT_LABEL = "EXISTS (SELECT 1 FROM json_each(labels) WHERE json_each.value = '\\Sent')"
const SNOOZED = 'EXISTS (SELECT 1 FROM snoozes z WHERE z.account = messages.account AND z.thread = messages.thread AND z.until > ?)'
const PINNED_THREAD = 'EXISTS (SELECT 1 FROM pins q WHERE q.account = messages.account AND q.thread = messages.thread)'

/** One term as SQL over `messages`, with what its `?` stand for. */
function sqlOf(term: Term, now: number): { sql: string; params: SQLInputValue[] } {
  const like = (value: string): string => `%${likeEscape(value.toLowerCase())}%`
  switch (term.kind) {
    case 'word':
      if (term.field === 'to') return { sql: "lower(to_json || cc_json) LIKE ? ESCAPE '\\'", params: [like(term.text)] }
      if (term.field === 'filename') {
        return { sql: "EXISTS (SELECT 1 FROM json_each(attachments) WHERE lower(json_extract(json_each.value, '$.name')) LIKE ? ESCAPE '\\')", params: [like(term.text)] }
      }
      return { sql: 'id IN (SELECT rowid FROM search WHERE search MATCH ?)', params: [ftsOf(term)] }
    case 'is':
      switch (term.what) {
        case 'unread': return { sql: 'seen = 0', params: [] }
        case 'read': return { sql: 'seen = 1', params: [] }
        case 'starred': return { sql: 'flagged = 1', params: [] }
        case 'important': return { sql: "EXISTS (SELECT 1 FROM json_each(labels) WHERE json_each.value = '\\Important')", params: [] }
        case 'snoozed': return { sql: SNOOZED, params: [now] }
        case 'pinned': return { sql: PINNED_THREAD, params: [] }
      }
      break
    case 'has':
      return { sql: 'has_attachment = 1', params: [] }
    case 'in': {
      const place = term.place.toLowerCase()
      if (place === 'inbox') return { sql: 'in_inbox = 1', params: [] }
      if (place === 'sent') return { sql: SENT_LABEL, params: [] }
      if (place === 'archive') return { sql: `(in_inbox = 0 AND NOT ${SENT_LABEL})`, params: [] }
      if (place === 'starred' || place === 'flagged') return { sql: 'flagged = 1', params: [] }
      if (place === 'snoozed') return { sql: SNOOZED, params: [now] }
      if (place === 'anywhere' || place === 'all') return { sql: '1', params: [] }
      return { sql: LABELLED, params: [place, place.replace(/[\s/]+/g, '-')] }
    }
    case 'after':
      return { sql: 'arrived >= ?', params: [term.at] }
    case 'before':
      return { sql: 'arrived < ?', params: [term.at] }
    case 'newer':
      return { sql: 'arrived >= ?', params: [ageStart(term, now)] }
    case 'older':
      return { sql: 'arrived < ?', params: [ageStart(term, now)] }
    case 'larger':
      return { sql: 'size > ?', params: [term.bytes] }
    case 'smaller':
      return { sql: 'size < ?', params: [term.bytes] }
  }
  return { sql: '1', params: [] }
}

/** A search as Gmail reads one (`shared/query.ts`): words and "phrases", OR, -word and NOT word,
 *  from:, to:, subject:, filename:, in: and label:, is:, has:attachment, after: and before:,
 *  newer_than: and older_than:, larger: and smaller:, the first twelve terms of it. Plain words that
 *  must all be there go to FTS5 together, each once; the rest are filters. */
export function searchParts(text: string, now = Date.now()): SearchParts {
  const terms: string[] = []
  const filters: string[] = []
  const params: SQLInputValue[] = []
  for (const { not, any } of firstTerms(parseQuery(foldForSearch(text)))) {
    const [only] = any
    if (any.length === 1 && !not && only?.kind === 'word' && FTS_COLUMNS[only.field] !== undefined) {
      if (!terms.includes(ftsOf(only))) terms.push(ftsOf(only))
      continue
    }
    const parts = any.map((term) => sqlOf(term, now))
    const sql = parts.length === 1 ? (parts[0]?.sql ?? '1') : `(${parts.map((part) => part.sql).join(' OR ')})`
    filters.push(not ? `NOT (${sql})` : sql)
    params.push(...parts.flatMap((part) => part.params))
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

  private closed = false

  /** Safe to call twice: a second quit request on the way out (the window closing after the tray's
   *  Quit, or a signal) reaches the close again, and closing a closed database throws in the main
   *  process, which left the app hanging on an error box. */
  close(): void {
    if (this.closed) return
    this.closed = true
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

  /** Of these UIDs in a folder, the ones kept here as mail of the window, or with [outside], the ones
   *  kept here at all. */
  kept(account: string, box: string, uids: number[], outside = false): Set<number> {
    const rows = this.all(
      `SELECT uid FROM messages WHERE account = ? AND box = ? AND uid IN (SELECT value FROM json_each(?))${outside ? '' : ` AND ${INSIDE}`}`,
      account, box, JSON.stringify(uids)
    )
    return new Set(rows.map((r) => Number(r['uid'])))
  }

  /** A message from before the window, fetched for a search and opened now. */
  addOutside(mail: StoredMail, now: number): number | null {
    const id = this.addMail(mail)
    if (id !== null) this.db.prepare('INSERT OR REPLACE INTO outside(id, used) VALUES(?,?)').run(id, now)
    return id
  }

  /** A thread opened again: what it has from before the window stays another week. */
  useOutside(ref: ThreadRef, now: number): void {
    this.db
      .prepare('UPDATE outside SET used = ? WHERE id IN (SELECT id FROM messages WHERE account = ? AND thread = ?)')
      .run(now, ref.account, ref.thread)
  }

  /** Rows for these threads, with what they have from before the window, as a search shows them. A
   *  thread with nothing left out of Trash and Spam has none. */
  olderRows(refs: ThreadRef[], now: number): ThreadRow[] {
    if (refs.length === 0) return []
    return this.threadRows(
      "(account, thread) IN (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?))",
      [JSON.stringify(refs.map((ref) => [ref.account, ref.thread]))], now, refs.length, { outside: true }
    )
  }

  /** The new row's id, or null if it was already here. */
  addMail(mail: StoredMail): number | null {
    return this.inTransaction(() => {
      const result = this.db
        .prepare(
          `INSERT OR IGNORE INTO messages(account, box, uid, thread, gmail_id, message_id, subject, from_name, from_address,
             to_json, cc_json, reply_to, refs, unsubscribe, arrived, snippet, body_text, body_html, attachments,
             has_attachment, labels, in_inbox, bin, seen, flagged, hidden, truncated, files_cut, size, release_at,
             summary, focus, kind, facts, warnings, details)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
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
          mail.truncated ? 1 : 0, mail.truncated ? 1 : 0, mail.size, mail.releaseAt, mail.summary ? 1 : 0,
          mail.focused ? 1 : 0, mail.facts?.type ?? '', mail.facts ? JSON.stringify(mail.facts) : '', JSON.stringify(mail.warnings),
          mail.details ? JSON.stringify(mail.details) : ''
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

  /** What the server says about a message now. [labels] is null where only flags can change. On
   *  Gmail a message that stops being a draft shows from then on: the phone sending one it saved
   *  takes the label off, and the message would otherwise stay hidden as the draft it was. Mail with
   *  a change on its way is never passed here, so this can't show what's being deleted for good. */
  applyChange(account: string, box: string, uid: number, labels: string[] | null, seen: boolean, flagged: boolean): boolean {
    const result = labels
      ? this.db
          .prepare('UPDATE messages SET labels = ?, in_inbox = ?, bin = ?, seen = ?, flagged = ?, hidden = ? WHERE account = ? AND box = ? AND uid = ?')
          .run(JSON.stringify(labels), labels.includes(INBOX) ? 1 : 0, binOf(labels), seen ? 1 : 0, flagged ? 1 : 0, labels.includes(DRAFT) ? 1 : 0, account, box, uid)
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
    this.db.prepare('DELETE FROM outside WHERE id = ?').run(id)
    this.db.prepare('DELETE FROM messages WHERE id = ?').run(id)
  }

  wipeAccount(account: string): void {
    this.inTransaction(() => {
      this.db
        .prepare('DELETE FROM search WHERE rowid IN (SELECT id FROM messages WHERE account = ?)')
        .run(account)
      this.db.prepare('DELETE FROM outside WHERE id IN (SELECT id FROM messages WHERE account = ?)').run(account)
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

  /** Everything else kept for an account, once it's removed. Returns the drafts that went. Their
   *  copies on the server stay, as the mail does. */
  forgetAccount(account: string): number[] {
    const drafts = this.all('SELECT id FROM drafts WHERE account = ?', account).map((r) => Number(r['id']))
    this.db.prepare('DELETE FROM drafts WHERE account = ?').run(account)
    this.db.prepare('DELETE FROM draft_copies WHERE account = ?').run(account)
    this.db.prepare('DELETE FROM snoozes WHERE account = ?').run(account)
    this.db.prepare('DELETE FROM reminders WHERE account = ?').run(account)
    this.db.prepare('DELETE FROM pins WHERE account = ?').run(account)
    this.db.prepare('DELETE FROM recent WHERE account = ?').run(account)
    return drafts
  }

  /** Mail past the keeping window, once the setting's been shortened. What was fetched from before it
   *  for a search stays while it's opened within a week, or pinned; and once the window has grown to
   *  take it in, it's ordinary mail. */
  dropOlderThan(account: string, before: number, now: number): number {
    this.db.prepare('DELETE FROM outside WHERE id IN (SELECT id FROM messages WHERE account = ? AND arrived >= ?)').run(account, before)
    const old = this.all(
      `SELECT id FROM messages m WHERE account = ? AND arrived < ?
         AND NOT (id IN (SELECT id FROM outside WHERE used >= ?)
                  OR (id IN (SELECT id FROM outside) AND EXISTS (SELECT 1 FROM pins p WHERE p.account = m.account AND p.thread = m.thread)))`,
      account, before, now - WEEK_MS
    )
    this.inTransaction(() => {
      for (const row of old) this.dropMessage(Number(row['id']))
    })
    return old.length
  }

  /** [where] picks messages; `outer` picks whole threads, by `t`, the snooze `s` and the pin `p`. Held mail isn't
   *  there at all and hidden mail is on its way out, so both stay out of every clause; [bin] says
   *  which of Trash, Spam or neither is being looked at. */
  private threadRows(where: string, params: SQLInputValue[], now: number, limit: number, options: ThreadOptions = {}): ThreadRow[] {
    const { outer = '1', outerParams = [], order = `MAX(t.latest, CASE WHEN s.until <= ? THEN s.until ELSE 0 END, ${CAME_BACK}) DESC`, bin = 0, outside = false } = options
    const inside = outside ? '' : `AND ${INSIDE}`
    const rows = this.all(
      `SELECT m.account, m.thread, m.subject, m.from_name, m.from_address, m.snippet, m.facts, m.warnings, t.latest AS date,
              t.n, t.unread, t.attachment, t.starred, t.important, t.delivered, s.until AS snoozed, p.at AS pinned,
              r.until AS remind, r.fired AS reminded, r.seen AS remind_seen
       FROM (SELECT account, thread, MAX(arrived) AS latest, COUNT(*) AS n,
                    SUM(seen = 0) AS unread, MAX(has_attachment) AS attachment, MAX(flagged) AS starred,
                    MAX(EXISTS (SELECT 1 FROM json_each(labels) WHERE json_each.value = '\\Important')) AS important,
                    MAX(CASE WHEN summary = 1 THEN release_at END) AS delivered
             FROM messages WHERE release_at <= ? AND hidden = 0 AND bin = ? ${inside} AND ${where} GROUP BY account, thread) t
       JOIN messages m ON m.account = t.account AND m.thread = t.thread AND m.arrived = t.latest
                      AND m.release_at <= ? AND m.hidden = 0 AND m.bin = ? ${outside ? '' : 'AND m.id NOT IN (SELECT id FROM outside)'}
       LEFT JOIN snoozes s ON s.account = t.account AND s.thread = t.thread
       LEFT JOIN pins p ON p.account = t.account AND p.thread = t.thread
       LEFT JOIN reminders r ON r.account = t.account AND r.thread = t.thread
       WHERE ${outer}
       GROUP BY m.account, m.thread
       ORDER BY ${order} LIMIT ?`,
      now, bin, ...params, now, bin, ...outerParams, ...(order.includes('?') ? [now] : []), limit
    )
    return rows.map((r) => ({
      ...this.whoAndWhat(String(r['account']), String(r['thread']), now, bin, outside),
      account: String(r['account']),
      thread: String(r['thread']),
      subject: String(r['subject']),
      fromName: String(r['from_name']),
      fromAddress: String(r['from_address']),
      snippet: String(r['snippet']),
      date: Number(r['date']),
      count: Number(r['n']),
      // Back from a reminder and not opened since, it reads as unread, though nothing new came.
      unread: Number(r['unread']) + (Number(r['reminded']) === 1 && Number(r['remind_seen']) === 0 ? 1 : 0),
      attachment: Number(r['attachment']) > 0,
      starred: Number(r['starred']) > 0,
      important: Number(r['important']) > 0,
      snoozedUntil: r['snoozed'] == null ? null : Number(r['snoozed']),
      remind: r['remind'] == null ? null : { at: Number(r['remind']), fired: Number(r['reminded']) === 1 },
      facts: factsFrom(r['facts']),
      pinned: r['pinned'] != null,
      summaryAt: r['delivered'] == null ? null : Number(r['delivered']),
      warned: parseList<SenderWarning>(r['warnings']).length > 0
    }))
  }

  /** Who's in a thread and what's attached. Held and hidden mail stays out of this too. */
  private whoAndWhat(account: string, thread: string, now: number, bin: number, outside: boolean): Pick<ThreadRow, 'people' | 'file' | 'files' | 'cards'> {
    const rows = this.all(
      `SELECT from_name, from_address, attachments FROM messages
       WHERE account = ? AND thread = ? AND release_at <= ? AND hidden = 0 AND bin = ? ${outside ? '' : `AND ${INSIDE}`} ORDER BY arrived ASC`,
      account, thread, now, bin
    )
    const people = new Map<string, Address>()
    const files: AttachmentInfo[] = []
    for (const row of rows) {
      const address = String(row['from_address'])
      if (!people.has(address.toLowerCase())) people.set(address.toLowerCase(), { name: String(row['from_name']), address })
      files.push(...parseList<AttachmentInfo>(row['attachments']))
    }
    return { people: [...people.values()], file: files[0]?.name ?? null, files: files.length, cards: files.slice(0, ROW_CARDS).map((f) => f.name) }
  }

  list(query: ListQuery, now: number, limit = 200): ThreadRow[] {
    if (query.kind === 'label') {
      return this.threadRows(
        `account = ? AND EXISTS (SELECT 1 FROM json_each(labels) WHERE json_each.value = ?)`,
        [query.account, query.label], now, limit
      )
    }
    if (query.kind === 'search') {
      const { match, filters, params } = searchParts(query.text, now)
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
    if (query.kind === 'from') {
      // One sender's page: every thread they have mail in, wherever it is but Trash and Spam.
      return this.threadRows('account = ? AND lower(from_address) = ?', [query.account, query.address.toLowerCase()], now, limit)
    }
    const scope = query.account ? ['account = ?'] : []
    const params = query.account ? [query.account] : []
    const by = (clause: string): string => [clause, ...scope].join(' AND ')
    const away = 's.until > ? AND s.at >= t.latest'
    // Asked only while a reminder has brought one back, so the inbox's own query is as it always was.
    const back = this.one('SELECT 1 AS yes FROM reminders WHERE fired = 1 LIMIT 1') !== undefined
    const inbox = back ? `(in_inbox = 1 OR ${REMINDED})` : 'in_inbox = 1'
    switch (query.kind) {
      case 'inbox': {
        // What a Summary brought is kept apart from the rest of the inbox, under Summary.
        const side = query.focus ? ` AND focus = ${query.focus === 'focused' ? 1 : 0}` : ''
        return this.threadRows(by(`${inbox} AND summary = 0${side}`), params, now, limit, { outer: `NOT (s.until IS NOT NULL AND ${away})`, outerParams: [now] })
      }
      case 'summary':
        // Each Summary together, the last to land first.
        return this.threadRows(by('in_inbox = 1 AND summary = 1'), params, now, limit, {
          outer: `NOT (s.until IS NOT NULL AND ${away})`, outerParams: [now], order: 't.delivered DESC, t.latest DESC'
        })
      case 'snoozed':
        return this.threadRows(by('in_inbox = 1'), params, now, limit, { outer: away, outerParams: [now], order: 's.until ASC' })
      case 'reminders':
        // Waiting to come back, the soonest first.
        return this.threadRows(by('(account, thread) IN (SELECT account, thread FROM reminders WHERE fired = 0)'), params, now, limit, { order: 'r.until ASC', outside: true })
      case 'starred':
        return this.threadRows(by('flagged = 1'), params, now, limit)
      case 'pinned':
        return this.threadRows(by('(account, thread) IN (SELECT account, thread FROM pins)'), params, now, limit, { outside: true })
      case 'recent':
        return this.threadRows(by('(account, thread) IN (SELECT account, thread FROM recent)'), params, now, limit, { order: RECENT_ORDER, outside: true })
      case 'sent':
        return this.threadRows(by(`EXISTS (SELECT 1 FROM json_each(labels) WHERE json_each.value = '\\Sent')`), params, now, limit)
      case 'all':
        return this.threadRows(by('1'), params, now, limit)
      case 'archive':
        // What was put away: out of the inbox, and not something you sent yourself.
        return this.threadRows(by(`in_inbox = 0 AND NOT EXISTS (SELECT 1 FROM json_each(labels) WHERE json_each.value = '\\Sent')`), params, now, limit)
      case 'trash':
        return this.threadRows(by('1'), params, now, limit, { bin: 1 })
      case 'spam':
        return this.threadRows(by('1'), params, now, limit, { bin: 2 })
      case 'unread': {
        // The open thread stays while it's read, in its place, until another is opened.
        const keep = query.keep ? [query.keep.account, query.keep.thread] : []
        const unread = query.keep ? '(seen = 0 OR (account = ? AND thread = ?))' : 'seen = 0'
        const fresh = back ? `((in_inbox = 1 AND ${unread}) OR ${REMINDED_UNSEEN})` : `in_inbox = 1 AND ${unread}`
        return this.threadRows(by(fresh), [...keep, ...params], now, limit, { outer: `NOT (s.until IS NOT NULL AND ${away})`, outerParams: [now] })
      }
      case 'attachments':
        return this.threadRows(by('has_attachment = 1'), params, now, limit)
      case 'today':
        return this.threadRows(by('in_inbox = 1 AND arrived >= ?'), [new Date(now).setHours(0, 0, 0, 0), ...params], now, limit, { outer: `NOT (s.until IS NOT NULL AND ${away})`, outerParams: [now] })
    }
  }

  /** Threads in Spam with something unread. */
  spamCount(now: number): number {
    return Number(this.one(`SELECT COUNT(DISTINCT account || thread) AS n FROM messages WHERE release_at <= ? AND hidden = 0 AND bin = 2 AND seen = 0 AND ${INSIDE}`, now)?.['n'] ?? 0)
  }

  /** Unread mail the Assistant recognised, by section. */
  assistantCounts(now: number): Record<AssistantSection, number> {
    const rows = this.all(
      `SELECT kind, COUNT(DISTINCT account || thread) AS n FROM messages
       WHERE release_at <= ? AND hidden = 0 AND bin = 0 AND seen = 0 AND kind > '' AND ${INSIDE} GROUP BY kind`,
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
      `SELECT *, ${PINNED}
       FROM messages WHERE account = ? AND thread = ? AND release_at <= ? AND hidden = 0 AND ${bins ? 'bin > 0' : 'bin = 0'} ORDER BY arrived ASC`,
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
      snippet: String(r['snippet']),
      attachments: parseList<AttachmentInfo>(r['attachments']),
      truncated: Number(r['truncated']) > 0,
      labels: parseList<string>(r['labels']),
      seen: Number(r['seen']) > 0,
      flagged: Number(r['flagged']) > 0,
      unsubscribe: String(r['unsubscribe']) !== '',
      focused: Number(r['focus']) > 0,
      facts: factsFrom(r['facts']),
      warnings: parseList<SenderWarning>(r['warnings']),
      authenticated: authenticated(detailsFrom(r['details']), String(r['from_address'])),
      replyTo: parseList<Address>(r['reply_to']),
      pinned: Number(r['pinned']) > 0
    }
  }

  /** One message, only if it may be seen now. */
  message(id: number, now: number): MessageDetail | null {
    const r = this.one(`SELECT *, ${PINNED} FROM messages WHERE id = ? AND release_at <= ? AND hidden = 0`, id, now)
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

  /** What a message's headers said, if it was kept when it arrived or read since. */
  details(id: number): HeaderDetails | null {
    const value = String(this.one('SELECT details FROM messages WHERE id = ?', id)?.['details'] ?? '')
    if (!value) return null
    try {
      return JSON.parse(value) as HeaderDetails
    } catch {
      return null
    }
  }

  saveDetails(id: number, details: HeaderDetails): void {
    this.db.prepare('UPDATE messages SET details = ? WHERE id = ?').run(JSON.stringify(details), id)
  }

  /** Of these messages, the ones whose list of files came from a cut copy and may be short. */
  filesCut(ids: number[]): number[] {
    return this.all('SELECT id FROM messages WHERE files_cut = 1 AND id IN (SELECT value FROM json_each(?))', JSON.stringify(ids))
      .map((r) => Number(r['id']))
  }

  /** The list of files as the whole message has it, in place of one made from a cut copy. */
  wholeFiles(id: number, files: AttachmentInfo[]): void {
    this.db
      .prepare('UPDATE messages SET attachments = ?, has_attachment = ?, files_cut = 0 WHERE id = ? AND files_cut = 1')
      .run(JSON.stringify(files), files.length > 0 ? 1 : 0, id)
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

  /** Pinning again keeps the first time. */
  pin(ref: ThreadRef, at: number): void {
    this.db.prepare('INSERT OR IGNORE INTO pins(account, thread, at) VALUES(?,?,?)').run(ref.account, ref.thread, at)
  }

  unpin(ref: ThreadRef): void {
    this.db.prepare('DELETE FROM pins WHERE account = ? AND thread = ?').run(ref.account, ref.thread)
  }

  /** A thread was opened: it goes to the top of Recently Seen, and only the newest [RECENT_KEPT] stay. */
  saw(ref: ThreadRef, at: number): void {
    this.inTransaction(() => {
      // Replacing gives the row a new rowid, which is what orders two opened within one millisecond.
      this.db.prepare('INSERT OR REPLACE INTO recent(account, thread, at) VALUES(?,?,?)').run(ref.account, ref.thread, at)
      this.db.prepare('DELETE FROM recent WHERE rowid NOT IN (SELECT rowid FROM recent ORDER BY at DESC, rowid DESC LIMIT ?)').run(RECENT_KEPT)
    })
  }

  /** Recently Seen starts again, empty. */
  forgetSeen(): void {
    this.db.exec('DELETE FROM recent')
  }

  /** A reminder for a thread, or for the message with [messageId] until its thread is here. One
   *  for a thread takes the place of any it had. */
  remind(where: { account: string; thread: string; messageId: string }, at: number, until: number): void {
    this.inTransaction(() => {
      if (where.thread) this.db.prepare('DELETE FROM reminders WHERE account = ? AND thread = ?').run(where.account, where.thread)
      this.db.prepare('INSERT INTO reminders(account, thread, message_id, at, until) VALUES(?,?,?,?,?)')
        .run(where.account, where.thread, where.messageId, at, until)
    })
  }

  unremind(ref: ThreadRef): void {
    this.db.prepare('DELETE FROM reminders WHERE account = ? AND thread = ?').run(ref.account, ref.thread)
  }

  /** The thread's reminder, waiting or come back. */
  reminder(ref: ThreadRef): { at: number; fired: boolean } | null {
    const row = this.one('SELECT until, fired FROM reminders WHERE account = ? AND thread = ? ORDER BY id DESC LIMIT 1', ref.account, ref.thread)
    return row ? { at: Number(row['until']), fired: Number(row['fired']) === 1 } : null
  }

  /** Opened since it came back, it isn't unread any more. */
  seeReminder(ref: ThreadRef): void {
    this.db.prepare('UPDATE reminders SET seen = 1 WHERE account = ? AND thread = ? AND fired = 1').run(ref.account, ref.thread)
  }

  /** Reminders put right as time passes: each finds its thread once the message it was set on is
   *  here, one that someone else has written in since goes, and those whose time has come with
   *  nobody having written come back. [own] is an account's own addresses, whose mail is no answer.
   *  Returns how many came back. */
  settleReminders(now: number, own: (account: string) => string[]): number {
    return this.inTransaction(() => {
      this.db.exec(`UPDATE reminders SET thread = (SELECT m.thread FROM messages m WHERE m.account = reminders.account AND m.message_id = reminders.message_id LIMIT 1)
        WHERE thread = '' AND message_id != '' AND EXISTS (SELECT 1 FROM messages m WHERE m.account = reminders.account AND m.message_id = reminders.message_id)`)
      this.db.exec(`DELETE FROM reminders WHERE thread != '' AND id NOT IN (SELECT MAX(id) FROM reminders WHERE thread != '' GROUP BY account, thread)`)
      for (const row of this.all("SELECT DISTINCT account FROM reminders WHERE thread != ''")) {
        const account = String(row['account'])
        this.db.prepare(`DELETE FROM reminders WHERE account = ? AND thread != '' AND EXISTS (
            SELECT 1 FROM messages m WHERE m.account = reminders.account AND m.thread = reminders.thread AND m.arrived > reminders.at
              AND m.hidden = 0 AND m.bin = 0 AND lower(m.from_address) NOT IN (SELECT value FROM json_each(?)))`)
          .run(account, JSON.stringify(own(account).map((a) => a.toLowerCase())))
      }
      return Number(this.db.prepare("UPDATE reminders SET fired = 1, seen = 0 WHERE fired = 0 AND thread != '' AND until <= ?").run(now).changes)
    })
  }

  /** Back from a reminder and not opened since, in an account, with no unread mail in its inbox
   *  besides, which counts it already. */
  remindedUnseen(account: string): number {
    return Number(this.one(
      `SELECT COUNT(*) AS n FROM reminders q WHERE q.account = ? AND q.fired = 1 AND q.seen = 0
         AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.account = q.account AND m.thread = q.thread AND m.in_inbox = 1 AND m.seen = 0 AND m.hidden = 0 AND m.bin = 0)`,
      account
    )?.['n'] ?? 0)
  }

  /** Whether any of a thread's mail is in the inbox, for anyone to see. */
  inInbox(ref: ThreadRef, now: number): boolean {
    return this.one(
      'SELECT 1 AS yes FROM messages WHERE account = ? AND thread = ? AND in_inbox = 1 AND hidden = 0 AND bin = 0 AND release_at <= ? LIMIT 1',
      ref.account, ref.thread, now
    ) !== undefined
  }

  /** How many snoozed threads came back in (after, upto]. */
  wokenBetween(after: number, upto: number): number {
    return Number(this.one('SELECT COUNT(*) AS n FROM snoozes WHERE until > ? AND until <= ?', after, upto)?.['n'] ?? 0)
  }

  /** With [copy], it's a draft read from the server, which that copy matches as it is. */
  addDraft(draft: Omit<Draft, 'id' | 'state' | 'sendAt' | 'error'>, copy?: DraftCopy): number {
    const { account, updated, ...data } = draft
    return Number(
      this.db
        .prepare('INSERT INTO drafts(account, data, updated, remote_uid, remote_validity, remote_id, pushed) VALUES(?,?,?,?,?,?,?)')
        .run(account, JSON.stringify(data), updated, copy?.uid ?? null, copy?.validity ?? '', copy?.messageId ?? '', copy ? updated : 0).lastInsertRowid
    )
  }

  private linkFrom(r: Row): DraftLink {
    const uid = r['remote_uid']
    return {
      id: Number(r['id']),
      account: String(r['account']),
      state: String(r['state']) as DraftState,
      updated: Number(r['updated']),
      copy: uid == null ? null : { uid: Number(uid), validity: String(r['remote_validity']), messageId: String(r['remote_id']) },
      messageId: String(r['remote_id']),
      pushed: Number(r['pushed'])
    }
  }

  draftLink(id: number): DraftLink | null {
    const row = this.one('SELECT id, account, state, updated, remote_uid, remote_validity, remote_id, pushed FROM drafts WHERE id = ?', id)
    return row ? this.linkFrom(row) : null
  }

  /** How each of an account's drafts stands with the server. */
  draftLinks(account: string): DraftLink[] {
    return this.all('SELECT id, account, state, updated, remote_uid, remote_validity, remote_id, pushed FROM drafts WHERE account = ? ORDER BY id', account)
      .map((r) => this.linkFrom(r))
  }

  /** [copy] is on the server now, made from the draft as it was at [pushed], or matching it. Null
   *  lets go of the copy: the draft goes up afresh when it's next due. */
  linkDraft(id: number, copy: DraftCopy | null, pushed: number): void {
    if (copy) {
      this.db.prepare('UPDATE drafts SET remote_uid = ?, remote_validity = ?, remote_id = ?, pushed = ? WHERE id = ?')
        .run(copy.uid, copy.validity, copy.messageId, pushed, id)
    } else {
      this.db.prepare("UPDATE drafts SET remote_uid = NULL, remote_validity = '', pushed = ? WHERE id = ?").run(pushed, id)
    }
  }

  /** The folder was renumbered: the UID means nothing now, and the Message-ID is kept to find it by. */
  loseDraftUid(id: number): void {
    this.db.prepare("UPDATE drafts SET remote_uid = NULL, remote_validity = '' WHERE id = ?").run(id)
  }

  /** A copy on the server that has to go, until it has. */
  queueDraftCopy(account: string, copy: DraftCopy): void {
    this.db.prepare('INSERT INTO draft_copies(account, uid, validity, message_id) VALUES(?,?,?,?)').run(account, copy.uid, copy.validity, copy.messageId)
  }

  draftCopies(account: string): (DraftCopy & { id: number })[] {
    return this.all('SELECT * FROM draft_copies WHERE account = ? ORDER BY id', account).map((r) => ({
      id: Number(r['id']), uid: Number(r['uid']), validity: String(r['validity']), messageId: String(r['message_id'])
    }))
  }

  dropDraftCopy(id: number): void {
    this.db.prepare('DELETE FROM draft_copies WHERE id = ?').run(id)
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
    const { id, account, state, sendAt, error, updated, archivable: _now, ...data } = draft
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
           FROM messages WHERE release_at <= ? AND hidden = 0 AND bin = 0 AND from_address != '' AND ${INSIDE}
         UNION ALL
         SELECT json_extract(j.value, '$.name'), lower(json_extract(j.value, '$.address')), 5
           FROM messages m, json_each(m.to_json) j
           WHERE m.release_at <= ? AND m.hidden = 0 AND m.bin = 0 AND m.${INSIDE}
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

  /** Of these addresses, the ones whose newest mail here passed DMARC, by the account's own server:
   *  a company's logo is shown only for mail its domain is proved to have sent. */
  passedDmarc(addresses: string[]): Set<string> {
    const wanted = [...new Set(addresses.map((a) => a.trim().toLowerCase()).filter(Boolean))].slice(0, 500)
    const passed = new Set<string>()
    if (wanted.length === 0) return passed
    const rows = this.all(
      `SELECT lower(from_address) AS address, details FROM messages
       WHERE lower(from_address) IN (${wanted.map(() => '?').join(', ')}) ORDER BY arrived DESC`,
      ...wanted
    )
    const seen = new Set<string>()
    for (const row of rows) {
      const address = String(row['address'])
      if (seen.has(address)) continue
      seen.add(address)
      if (detailsFrom(row['details'])?.checks?.dmarc === 'pass') passed.add(address)
    }
    return passed
  }

  /** Moves what a sender has already sent to one side of the inbox. */
  setFocus(address: string, focused: boolean): void {
    this.db.prepare('UPDATE messages SET focus = ? WHERE lower(from_address) = ?').run(focused ? 1 : 0, address.toLowerCase())
  }

  /** Threads with something unread in an inbox. A snoozed thread isn't waiting for anyone, and what a
   *  Summary brought is counted under Summary. */
  unreadThreads(now: number, where: string, ...params: SQLInputValue[]): number {
    const row = this.one(
      `SELECT COUNT(*) AS n FROM (SELECT DISTINCT m.account, m.thread FROM messages m
         LEFT JOIN snoozes s ON s.account = m.account AND s.thread = m.thread
         WHERE m.release_at <= ? AND m.hidden = 0 AND m.bin = 0 AND m.in_inbox = 1 AND m.seen = 0 AND m.summary = 0 AND m.${INSIDE}
           AND NOT (s.until IS NOT NULL AND s.until > ? AND s.at >= m.arrived) AND ${where})`,
      now, now, ...params
    )
    return Number(row?.['n'] ?? 0)
  }

  /** Who's mailing you in bulk, by how much. */
  subscriptions(now: number): Subscription[] {
    return this.all(
      `SELECT account, lower(from_address) AS address, MAX(from_name) AS name, COUNT(*) AS n, MAX(arrived) AS latest, MAX(id) AS newest,
              SUM(seen) AS opened, SUM(arrived >= ?) AS week
       FROM messages WHERE release_at <= ? AND hidden = 0 AND bin = 0 AND unsubscribe != '' AND from_address != '' AND ${INSIDE}
       GROUP BY account, lower(from_address) ORDER BY n DESC, latest DESC LIMIT 300`,
      now - WEEK_MS, now
    ).map(subscriptionFrom)
  }

  /** What's here from each of these addresses, most first. */
  sendersOf(addresses: string[], now: number): Subscription[] {
    return this.all(
      `SELECT account, lower(from_address) AS address, MAX(from_name) AS name, COUNT(*) AS n, MAX(arrived) AS latest, MAX(id) AS newest,
              SUM(seen) AS opened, SUM(arrived >= ?) AS week
       FROM messages WHERE release_at <= ? AND hidden = 0 AND bin = 0 AND lower(from_address) IN (SELECT value FROM json_each(?)) AND ${INSIDE}
       GROUP BY account, lower(from_address) ORDER BY n DESC, latest DESC`,
      now - WEEK_MS, now, JSON.stringify(addresses.map((a) => a.toLowerCase()))
    ).map(subscriptionFrom)
  }

  /** One sender on one account, for their page: how much they send and how much of it is read. The
   *  message it names is their newest with a way out, if any has one. */
  sender(account: string, address: string, now: number): Subscription | null {
    const row = this.one(
      `SELECT account, lower(from_address) AS address, MAX(from_name) AS name, COUNT(*) AS n, MAX(arrived) AS latest,
              COALESCE(MAX(CASE WHEN unsubscribe != '' THEN id END), MAX(id)) AS newest, SUM(seen) AS opened, SUM(arrived >= ?) AS week
       FROM messages WHERE account = ? AND lower(from_address) = ? AND release_at <= ? AND hidden = 0 AND bin = 0 AND ${INSIDE}`,
      now - WEEK_MS, account, address.toLowerCase(), now
    )
    return row && Number(row['n']) > 0 ? subscriptionFrom(row) : null
  }

  /** Every thread a sender has mail in, that could be seen now. */
  threadsFrom(account: string, address: string, now: number): ThreadRef[] {
    return this.all(
      `SELECT DISTINCT thread FROM messages WHERE account = ? AND lower(from_address) = ? AND release_at <= ? AND hidden = 0 AND bin = 0 AND ${INSIDE}`,
      account, address.toLowerCase(), now
    ).map((r) => ({ account, thread: String(r['thread']) }))
  }

  /** Mail waiting for the next batch. What waits for the Summary is counted apart. */
  heldCount(now: number): number {
    return Number(this.one('SELECT COUNT(*) AS n FROM messages WHERE release_at > ? AND hidden = 0 AND bin = 0 AND summary = 0', now)?.['n'] ?? 0)
  }

  /** When the next batch brings something. */
  nextRelease(now: number): number | null {
    const value = this.one('SELECT MIN(release_at) AS t FROM messages WHERE release_at > ? AND hidden = 0 AND bin = 0 AND summary = 0', now)?.['t']
    return value == null ? null : Number(value)
  }

  /** Mail waiting for the next Summary. */
  summaryHeld(now: number): number {
    return Number(this.one('SELECT COUNT(*) AS n FROM messages WHERE summary = 1 AND release_at > ? AND hidden = 0 AND bin = 0', now)?.['n'] ?? 0)
  }

  /** Threads in Summary with something unread. */
  summaryUnread(now: number): number {
    // Counted as pairs: run together, two accounts' thread names could spell the same thing.
    return Number(this.one(
      `SELECT COUNT(*) AS n FROM (SELECT DISTINCT account, thread FROM messages
       WHERE summary = 1 AND release_at <= ? AND hidden = 0 AND bin = 0 AND in_inbox = 1 AND seen = 0)`,
      now
    )?.['n'] ?? 0)
  }

  /** The Summary that landed last, with what of it is still unread in the inbox. */
  latestSummary(now: number): LatestSummary | null {
    const at = this.one('SELECT MAX(release_at) AS t FROM messages WHERE summary = 1 AND release_at <= ? AND hidden = 0', now)?.['t']
    if (at == null) return null
    const rows = this.all(
      `SELECT account, thread, from_name, from_address FROM messages
       WHERE summary = 1 AND release_at = ? AND hidden = 0 AND bin = 0 AND in_inbox = 1 AND seen = 0 ORDER BY arrived DESC`,
      Number(at)
    )
    const senders = [...new Set(rows.map((r) => String(r['from_name'] || r['from_address'])))]
    const threads = new Set(rows.map((r) => JSON.stringify([String(r['account']), String(r['thread'])])))
    return { at: Number(at), unread: threads.size, senders }
  }

  /** Who sent each message a delivery brought in (after, upto], one entry a message, whether it
   *  came with a Summary, and whether it's in Focused. */
  landedFrom(after: number, upto: number): { from: string; name: string; summary: boolean; focused: boolean }[] {
    return this.all(
      'SELECT from_address, from_name, summary, focus FROM messages WHERE release_at > ? AND release_at <= ? AND release_at > arrived AND in_inbox = 1 AND hidden = 0',
      after, upto
    ).map((r) => ({ from: String(r['from_address']), name: String(r['from_name']), summary: Number(r['summary']) > 0, focused: Number(r['focus']) > 0 }))
  }

  landedBetween(after: number, upto: number): number {
    return Number(
      this.one(
        'SELECT COUNT(*) AS n FROM messages WHERE release_at > ? AND release_at <= ? AND release_at > arrived AND in_inbox = 1 AND hidden = 0',
        after, upto
      )?.['n'] ?? 0
    )
  }

  /** Delivering early is for the batch: what waits for the Summary keeps waiting for it. */
  releaseAll(now: number): number {
    return Number(this.db.prepare('UPDATE messages SET release_at = ? WHERE release_at > ? AND summary = 0').run(now, now).changes)
  }

  /** Moves waiting mail onto a new timetable, after the batch or Summary settings change, and into or
   *  out of the Summary. */
  retime(compute: (mail: HeldMail) => Hold, now: number): void {
    const rows = this.all('SELECT id, account, arrived, from_address, labels FROM messages WHERE release_at > ?', now)
    this.inTransaction(() => {
      for (const row of rows) {
        const hold = compute({
          account: String(row['account']),
          arrived: Number(row['arrived']),
          fromAddress: String(row['from_address']),
          labels: parseList<string>(row['labels'])
        })
        this.db.prepare('UPDATE messages SET release_at = ?, summary = ? WHERE id = ?').run(hold.at, hold.summary ? 1 : 0, Number(row['id']))
      }
    })
  }

  /** The index is named because, left to itself, the planner walks messages_thread for the grouping
   *  and reads every message for its labels. */
  labelCounts(now: number): LabelCount[] {
    const rows = this.all(
      `SELECT m.account AS account, j.value AS label, COUNT(*) AS n
       FROM messages m INDEXED BY messages_visible, json_each(m.labels) j
       WHERE m.release_at <= ? AND m.hidden = 0 AND m.bin = 0 AND m.${INSIDE} AND j.value NOT LIKE '\\%' ESCAPE '|'
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
