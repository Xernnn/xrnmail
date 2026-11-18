import { labelsOf } from './actions'
import type { Sorted } from './assistant'
import { holdOf, type BatchRules } from './batches'
import { NO_DETAILS } from './details'
import { MAX_SOURCE, parseMail, type ParsedMail } from './parse'
import { threadOf, type MailboxRef, type MailSource, type RemoteMail } from './source'
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
  /** When mail lands. As a function, it's asked again for each message, so a change made while the
   *  pass is under way holds what the pass stores after it. */
  rules: BatchRules | (() => BatchRules)
  now: number
  /** Told after each chunk, so the list fills as it goes on a first sync. */
  progress?: (done: number, total: number) => void
  /** Told about each new message, except when a folder is starting over. */
  added?: (mail: StoredMail, id: number, holdFrom: number) => void
  /** Messages in a folder with a change on its way. What the server says about them is out of date. */
  busy?: (box: string) => Set<number>
  /** Which side of the inbox it goes, and what the Assistant makes of it. */
  sort?: (mail: ParsedMail) => Sorted
  /** How a message is read; parseMail, here, unless it's given somewhere better (parser.ts). */
  parse?: (source: Buffer) => Promise<ParsedMail>
  /** True once the account has been removed. Asked before every folder, batch and message, so a
   *  pass that's under way stops instead of putting the mail back. */
  stopped?: () => boolean
}

/** The account was removed while its pass was running. */
class SyncStopped extends Error {}

function goOn(options: SyncOptions): void {
  if (options.stopped?.()) throw new SyncStopped('The account was removed.')
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
  replyTo: [],
  messageId: '',
  inReplyTo: '',
  references: '',
  unsubscribe: null,
  text: 'Open it in your mail service to read it.',
  html: null,
  cut: false,
  snippet: 'Open it in your mail service to read it.',
  attachments: [],
  bulk: false,
  warnings: [],
  invite: null,
  details: NO_DETAILS
}

async function toStored(remote: RemoteMail, box: MailboxRef, gmail: boolean, options: SyncOptions, holdFrom: number): Promise<StoredMail> {
  let mail = UNREADABLE
  try {
    mail = await (options.parse ?? parseMail)(remote.source)
  } catch {
    // A mail that won't parse still arrived, so it stays listed.
  }
  const labels = labelsOf(box, remote.labels, gmail)
  const sorted = options.sort?.(mail) ?? { focused: true, facts: null }
  const rules = typeof options.rules === 'function' ? options.rules() : options.rules
  const hold = holdOf({ arrived: remote.arrived, fromAddress: mail.from.address, labels }, options.email, holdFrom, rules)
  return {
    account: options.account,
    box: box.id,
    uid: remote.uid,
    thread: remote.thread || threadOf(mail.references, mail.inReplyTo, mail.messageId, `${box.id}:${remote.uid}`),
    gmailId: remote.gmailId,
    messageId: mail.messageId,
    subject: mail.subject,
    from: mail.from,
    to: mail.to,
    cc: mail.cc,
    replyTo: mail.replyTo,
    references: mail.references,
    unsubscribe: mail.unsubscribe,
    arrived: remote.arrived,
    snippet: mail.snippet,
    text: mail.text,
    html: mail.html,
    attachments: mail.attachments,
    labels,
    seen: remote.seen,
    flagged: remote.flagged,
    // Its HTML cut short is as much not here as a source that was.
    truncated: remote.size > MAX_SOURCE || mail.cut,
    size: remote.size,
    releaseAt: hold.at,
    summary: hold.summary,
    focused: sorted.focused,
    facts: sorted.facts,
    warnings: mail.warnings,
    details: mail === UNREADABLE ? null : mail.details
  }
}

async function syncBox(source: MailSource, store: Store, options: SyncOptions, box: MailboxRef, holdFrom: number): Promise<SyncResult> {
  const info = await source.open(box)
  const { account } = options
  try {
    let state = store.boxState(account, box.id)
    const startingOver = state !== null && state.uidValidity !== info.uidValidity
    if (startingOver) {
      store.wipeBox(account, box.id)
      state = null
    }
    const since = options.now - options.backfillDays * DAY_MS
    const remoteUids = await source.uidsSince(new Date(since))
    const have = store.uids(account, box.id)
    // Newest first, so the top of the inbox is there straight away on a first sync.
    const missing = remoteUids.filter((uid) => !have.has(uid)).reverse()
    let added = 0
    for (let i = 0; i < missing.length; i += CHUNK) {
      goOn(options)
      const wanted = new Set(missing.slice(i, i + CHUNK))
      for await (const remote of source.fetch([...wanted], MAX_SOURCE)) {
        if (!wanted.has(remote.uid)) continue
        const stored = await toStored(remote, box, source.gmail, options, holdFrom)
        goOn(options)
        const id = store.addMail(stored)
        added++
        if (id !== null && !startingOver) options.added?.(stored, id, holdFrom)
      }
      options.progress?.(Math.min(i + CHUNK, missing.length), missing.length)
    }
    let changed = 0
    const busy = options.busy?.(box.id)
    if (state?.modseq && info.modseq) {
      for await (const header of source.changesSince(state.modseq)) {
        if (!have.has(header.uid) || busy?.has(header.uid)) continue
        const labels = source.gmail ? labelsOf(box, header.labels, true) : null
        if (store.applyChange(account, box.id, header.uid, labels, header.seen, header.flagged)) changed++
      }
    } else if (state) {
      // No way to ask what changed, so look at the flags of everything held.
      for await (const header of source.flagsOf(remoteUids.filter((uid) => have.has(uid)))) {
        if (!have.has(header.uid) || busy?.has(header.uid)) continue
        if (store.applyChange(account, box.id, header.uid, null, header.seen, header.flagged)) changed++
      }
    }
    const removed = store.removeMissing(account, box.id, new Set(remoteUids), since + EDGE_MS)
    store.saveBoxState(account, box.id, { uidValidity: info.uidValidity, modseq: info.modseq })
    return { added, changed, removed }
  } finally {
    source.done()
  }
}

/** A folder an account lists but won't open or search shouldn't stop the rest being read, and is
 *  left as it was. Anything else ends the pass, including one that didn't open read-only. */
const refusedFolder = (e: unknown, box: MailboxRef): boolean =>
  box.role === 'folder' && (e as { responseStatus?: string })?.responseStatus === 'NO'

/** One pass over every folder: new mail, changed flags, mail that's gone. Safe to stop anywhere:
 *  what's stored stays right, and the next pass carries on from what's still missing. */
export async function syncAccount(source: MailSource, store: Store, options: SyncOptions): Promise<SyncResult> {
  const holdFrom = store.holdFrom(options.account) ?? options.now
  const total: SyncResult = { added: 0, changed: 0, removed: 0 }
  const boxes = source.mailboxes()
  for (const box of boxes) {
    goOn(options)
    try {
      const result = await syncBox(source, store, options, box, holdFrom)
      total.added += result.added
      total.changed += result.changed
      total.removed += result.removed
    } catch (e) {
      if (!refusedFolder(e, box)) throw e
    }
  }
  goOn(options)
  store.keepBoxes(options.account, boxes.map((box) => box.id))
  store.dropOlderThan(options.account, options.now - options.backfillDays * DAY_MS - EDGE_MS)
  store.saveHoldFrom(options.account, holdFrom)
  return total
}
