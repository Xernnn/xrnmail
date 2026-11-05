import { releaseAt, type BatchRules } from './batches'
import { MAX_SOURCE, parseMail, type ParsedMail } from './parse'
import type { MailSource, RemoteMail } from './source'
import type { Store, StoredMail } from './store'

const CHUNK = 40
const DAY_MS = 86_400_000
/** SINCE compares dates in the server's zone, so the window's edge is fuzzy by up to a day either
 *  way. Mail near it is neither fetched again nor taken for deleted. */
const EDGE_MS = 2 * DAY_MS

export interface SyncOptions {
  account: string
  email: string
  backfillDays: number
  rules: BatchRules
  now: number
  /** Told after each chunk, so the list fills as it goes on a first sync. */
  progress?: () => void
}

export interface SyncResult {
  added: number
  changed: number
  removed: number
}

const UNREADABLE: ParsedMail = {
  subject: "(This message couldn't be read here)",
  from: { name: '', address: '' },
  to: [],
  cc: [],
  messageId: '',
  text: 'Open it in Gmail to read it.',
  html: null,
  snippet: 'Open it in Gmail to read it.',
  attachments: []
}

async function toStored(remote: RemoteMail, options: SyncOptions, holdFrom: number): Promise<StoredMail> {
  let mail = UNREADABLE
  try {
    mail = await parseMail(remote.source)
  } catch {
    // A mail that won't parse still arrived, so it stays listed.
  }
  return {
    account: options.account,
    uid: remote.uid,
    thread: remote.thread,
    gmailId: remote.gmailId,
    messageId: mail.messageId,
    subject: mail.subject,
    from: mail.from,
    to: mail.to,
    cc: mail.cc,
    arrived: remote.arrived,
    snippet: mail.snippet,
    text: mail.text,
    html: mail.html,
    attachments: mail.attachments,
    labels: remote.labels,
    seen: remote.seen,
    flagged: remote.flagged,
    truncated: remote.size > MAX_SOURCE,
    size: remote.size,
    releaseAt: releaseAt(
      { arrived: remote.arrived, fromAddress: mail.from.address, labels: remote.labels },
      options.email, holdFrom, options.rules
    )
  }
}

/** One pass: new mail, changed labels, mail that's gone. Safe to stop anywhere: what's stored stays
 *  right, and the next pass carries on from what's still missing. */
export async function syncAccount(source: MailSource, store: Store, options: SyncOptions): Promise<SyncResult> {
  const box = await source.open()
  try {
    let state = store.syncState(options.account)
    if (state && state.uidValidity !== box.uidValidity) {
      // Gmail renumbered the mailbox, so every UID here now points at the wrong message.
      store.wipeAccount(options.account)
      state = { ...state, modseq: null, uidValidity: box.uidValidity }
    }
    const holdFrom = state?.holdFrom ?? options.now
    const since = options.now - options.backfillDays * DAY_MS
    const remoteUids = await source.uidsSince(new Date(since))
    const have = store.uids(options.account)
    // Newest first, so the top of the inbox is there straight away on a first sync.
    const missing = remoteUids.filter((uid) => !have.has(uid)).reverse()
    let added = 0
    for (let i = 0; i < missing.length; i += CHUNK) {
      const wanted = new Set(missing.slice(i, i + CHUNK))
      for await (const remote of source.fetch([...wanted], MAX_SOURCE)) {
        if (!wanted.has(remote.uid)) continue
        store.addMail(await toStored(remote, options, holdFrom))
        added++
      }
      options.progress?.()
    }
    let changed = 0
    if (state?.modseq && box.modseq) {
      for await (const header of source.changesSince(state.modseq)) {
        if (!have.has(header.uid)) continue
        store.applyChange(options.account, header.uid, header.labels, header.seen, header.flagged)
        changed++
      }
    }
    const removed = store.removeMissing(options.account, new Set(remoteUids), since + EDGE_MS)
    store.dropOlderThan(options.account, since - EDGE_MS)
    store.saveSyncState(options.account, { uidValidity: box.uidValidity, modseq: box.modseq, holdFrom })
    return { added, changed, removed }
  } finally {
    source.done()
  }
}
