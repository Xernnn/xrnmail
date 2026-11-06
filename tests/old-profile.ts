import { DatabaseSync } from 'node:sqlite'

/**
 * A profile as the previous version left it. Frozen on purpose: this is what's on people's laptops,
 * so it mustn't follow changes to the schema. Everything in it came from Gmail's All Mail.
 */

const SCHEMA = `
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
  seen INTEGER NOT NULL DEFAULT 0, flagged INTEGER NOT NULL DEFAULT 0,
  truncated INTEGER NOT NULL DEFAULT 0, size INTEGER NOT NULL DEFAULT 0,
  release_at INTEGER NOT NULL,
  reply_to TEXT NOT NULL DEFAULT '[]', refs TEXT NOT NULL DEFAULT '', unsubscribe TEXT NOT NULL DEFAULT '',
  hidden INTEGER NOT NULL DEFAULT 0,
  UNIQUE(account, uid));
CREATE INDEX messages_thread ON messages(account, thread);
CREATE INDEX messages_inbox ON messages(in_inbox, release_at, arrived);
CREATE VIRTUAL TABLE search USING fts5(subject, sender, body, tokenize = "unicode61 remove_diacritics 2");
CREATE TABLE sync_state(account TEXT PRIMARY KEY, uid_validity TEXT NOT NULL, modseq TEXT, hold_from INTEGER NOT NULL);
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
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
PRAGMA user_version = 2;
`

export interface OldMessage {
  uid: number
  subject: string
  thread?: string
  labels?: string[]
  hidden?: boolean
  unsubscribe?: string
  arrived?: number
  releaseAt?: number
}

export interface OldChange {
  action: unknown
  uids: number[]
  due?: number
}

export function secondVersionProfile(path: string, options: {
  account: string
  uidValidity: string
  modseq: string
  holdFrom: number
  messages: OldMessage[]
  pending?: OldChange[]
}): void {
  const db = new DatabaseSync(path)
  db.exec(SCHEMA)
  const { account } = options
  db.prepare("INSERT INTO meta(key, value) VALUES('accounts', ?)").run(JSON.stringify([account]))
  db.prepare('INSERT INTO sync_state VALUES(?, ?, ?, ?)').run(account, options.uidValidity, options.modseq, options.holdFrom)
  const insert = db.prepare(`INSERT INTO messages(account, uid, thread, subject, from_name, from_address, arrived, snippet, body_text,
    labels, in_inbox, release_at, unsubscribe, hidden) VALUES(?, ?, ?, ?, 'Ada', 'ada@example.com', ?, 'Hi', 'Hi there', ?, ?, ?, ?, ?)`)
  const index = db.prepare('INSERT INTO search(rowid, subject, sender, body) VALUES(?, ?, ?, ?)')
  for (const m of options.messages) {
    const labels = m.labels ?? ['\\Inbox']
    const arrived = m.arrived ?? 100
    const row = insert.run(account, m.uid, m.thread ?? `t${m.uid}`, m.subject, arrived, JSON.stringify(labels), labels.includes('\\Inbox') ? 1 : 0,
      m.releaseAt ?? arrived, m.unsubscribe ?? '', m.hidden ? 1 : 0)
    index.run(row.lastInsertRowid, m.subject, 'Ada ada@example.com', 'Hi there')
  }
  const change = db.prepare('INSERT INTO pending(grp, account, action, uids, before, due) VALUES(?, ?, ?, ?, ?, ?)')
  options.pending?.forEach((p, i) => {
    const before = p.uids.map((uid) => ({ uid, labels: ['\\Inbox'], seen: false, flagged: false, hidden: false }))
    change.run(i + 1, account, JSON.stringify(p.action), JSON.stringify(p.uids), JSON.stringify(before), p.due ?? 0)
  })
  db.close()
}
