import { ImapFlow, type ListResponse } from 'imapflow'
import { createHash } from 'node:crypto'
import type { Security } from '@shared/providers'

/**
 * The mailbox, as syncing sees it. This interface has no way to change anything, and `ImapSource`
 * opens the mailbox read-only, so no bug in sync can touch a real inbox. Changes the person asks for
 * go through `MailWriter` instead, on a connection of their own.
 */

export interface RemoteHeader {
  uid: number
  labels: string[]
  seen: boolean
  flagged: boolean
}

export interface RemoteMail extends RemoteHeader {
  thread: string
  gmailId: string
  arrived: number
  size: number
  source: Buffer
}

export interface MailboxInfo {
  uidValidity: string
  modseq: string | null
}

export type MailboxRole = 'all' | 'inbox' | 'sent' | 'archive' | 'trash' | 'junk' | 'folder'

/** A folder on the server, and what it's for. */
export interface MailboxRef {
  /** Stays the same if the folder is renamed or translated: `@role` for special ones. */
  id: string
  path: string
  role: MailboxRole
}

const ROLES: Record<string, MailboxRole> = {
  '\\All': 'all', '\\Inbox': 'inbox', '\\Sent': 'sent', '\\Archive': 'archive', '\\Trash': 'trash', '\\Junk': 'junk'
}

/** Folders that only collect what's elsewhere, or that hold nothing worth listing. */
const SKIPPED = new Set(['\\Drafts', '\\Flagged', '\\Important'])
/** Outlook and others show these over IMAP, and they aren't mail. */
const NOT_MAIL = /^(notes|outbox|calendar|contacts|tasks|journal|sync issues)(\/|$)/i

/** Gmail keeps everything but Trash and Spam in All Mail, with labels saying where it shows. Anywhere
 *  else a message lives in one folder, so every folder is read. */
export function mailboxesOf(list: ListResponse[], gmail: boolean): MailboxRef[] {
  const boxes: MailboxRef[] = []
  for (const box of list) {
    if (box.flags.has('\\Noselect') || (box.specialUse && SKIPPED.has(box.specialUse)) || NOT_MAIL.test(box.path)) continue
    const role = (box.specialUse && ROLES[box.specialUse]) || 'folder'
    if (gmail ? !['all', 'trash', 'junk'].includes(role) : role === 'all') continue
    boxes.push({ id: role === 'folder' ? box.path : `@${role}`, path: box.path, role })
  }
  // The inbox first, so a first sync shows what matters before it reads old folders.
  return boxes.sort((a, b) => Number(b.role === 'inbox' || b.role === 'all') - Number(a.role === 'inbox' || a.role === 'all'))
}

export interface MailSource {
  connect(): Promise<void>
  /** Gmail, or something with Gmail's labels and threads. */
  readonly gmail: boolean
  mailboxes(): MailboxRef[]
  open(box: MailboxRef): Promise<MailboxInfo>
  /** Every UID that arrived on or after [since], lowest first. Throws if the server won't say:
   *  sync forgets whatever isn't in the answer. */
  uidsSince(since: Date): Promise<number[]>
  fetch(uids: number[], maxBytes: number): AsyncIterable<RemoteMail>
  /** Labels and flags changed since [modseq]. */
  changesSince(modseq: string): AsyncIterable<RemoteHeader>
  /** Flags as they are now, for servers that can't say what changed. */
  flagsOf(uids: number[]): AsyncIterable<RemoteHeader>
  /** One message with nothing cut, for its attachments. */
  whole(uid: number): Promise<Buffer | null>
  done(): void
  close(): Promise<void>
}

/** `none` exists only for the fake servers in tests: no account can be set up to use it. */
export type ConnectionSecurity = Security | 'none'

export interface ImapConfig {
  host: string
  port: number
  security: ConnectionSecurity
  user: string
  secret: string
  /** Signs in with this instead of [secret], for services that have dropped passwords. */
  accessToken?: string
}

/** Providers show app passwords in groups with spaces, which aren't part of them. */
export const cleanSecret = (secret: string): string => secret.replace(/\s+/g, '')

/** STARTTLS is required, not merely tried: a server that stops offering it mustn't get the password. */
export function imapClient(config: ImapConfig, extra: { maxIdleTime?: number } = {}): ImapFlow {
  const client = new ImapFlow({
    ...extra,
    host: config.host,
    port: config.port,
    secure: config.security === 'tls',
    auth: config.accessToken ? { user: config.user, accessToken: config.accessToken } : { user: config.user, pass: config.secret },
    logger: false,
    doSTARTTLS: config.security === 'tls' ? undefined : config.security === 'starttls'
  })
  client.on('error', () => undefined) // the work in progress fails on its own; unhandled this ends the app
  return client
}

/** Waits on the inbox for something to arrive. It reads nothing and can change nothing. */
export interface MailWatcher {
  /** Calls [arrived] for each thing that lands, and resolves when the connection ends. */
  watch(arrived: () => void): Promise<void>
  close(): Promise<void>
}

/** Servers drop a quiet connection after half an hour or so, so it's refreshed well before that. */
const IDLE_REFRESH_MS = 5 * 60_000

export class ImapWatcher implements MailWatcher {
  private client: ImapFlow

  constructor(config: ImapConfig) {
    this.client = imapClient(config, { maxIdleTime: IDLE_REFRESH_MS })
  }

  async watch(arrived: () => void): Promise<void> {
    const ended = new Promise<void>((resolve) => this.client.once('close', () => resolve()))
    await this.client.connect()
    const opened = await this.client.mailboxOpen('INBOX', { readOnly: true })
    if (!opened.readOnly) throw new Error('The mailbox did not open read-only, so nothing was fetched.')
    this.client.on('exists', arrived)
    void this.client.idle().catch(() => undefined)
    await ended
  }

  async close(): Promise<void> {
    try {
      await this.client.logout()
    } catch {
      this.client.close()
    }
  }
}

/** Threads for servers that don't have them: messages that trace back to the same first message. */
export function threadOf(references: string, inReplyTo: string, messageId: string, fallback: string): string {
  const root = /<[^<>]+>/.exec(references)?.[0] ?? /<[^<>]+>/.exec(inReplyTo)?.[0] ?? (messageId || fallback)
  return createHash('sha1').update(root).digest('hex').slice(0, 24)
}

const labelsOf = (labels: Set<string> | undefined): string[] => [...(labels ?? [])]

/** The server said NO or BAD to a search. It carries the status imapflow's own refusals do, so an
 *  ordinary folder that won't be searched is skipped like one that won't open. */
class SearchRefused extends Error {
  readonly responseStatus = 'NO'
}

export class ImapSource implements MailSource {
  private client: ImapFlow
  private lock: { release(): void } | null = null
  private boxes: MailboxRef[] = []
  gmail = false

  constructor(config: ImapConfig) {
    this.client = imapClient(config)
  }

  async connect(): Promise<void> {
    await this.client.connect()
    this.gmail = this.client.capabilities.has('X-GM-EXT-1')
    this.boxes = mailboxesOf(await this.client.list(), this.gmail)
    if (this.gmail && !this.boxes.some((box) => box.role === 'all')) {
      throw new Error('This account has no All Mail folder. In Gmail settings, turn on showing All Mail in IMAP.')
    }
    if (this.boxes.length === 0) throw new Error('This account has no folders to read.')
  }

  mailboxes(): MailboxRef[] {
    return this.boxes
  }

  async open(box: MailboxRef): Promise<MailboxInfo> {
    this.done()
    this.lock = await this.client.getMailboxLock(box.path, { readOnly: true })
    const opened = this.client.mailbox
    if (!opened || !opened.readOnly) {
      this.done()
      throw new Error('The mailbox did not open read-only, so nothing was fetched.')
    }
    return { uidValidity: String(opened.uidValidity), modseq: opened.highestModseq ? String(opened.highestModseq) : null }
  }

  /** imapflow answers false when the server turns a search down, and nothing at all once the
   *  connection has gone. Neither means the folder is empty. */
  async uidsSince(since: Date): Promise<number[]> {
    const found = await this.client.search({ since }, { uid: true })
    if (found === false) throw new SearchRefused()
    if (!Array.isArray(found)) throw new Error('The connection went during a search.')
    return found.slice().sort((a, b) => a - b)
  }

  async *fetch(uids: number[], maxBytes: number): AsyncIterable<RemoteMail> {
    if (uids.length === 0) return
    const query = {
      uid: true, flags: true, internalDate: true, size: true, threadId: true, labels: true, emailId: true,
      source: { maxLength: maxBytes }
    }
    for await (const m of this.client.fetch(uids.join(','), query, { uid: true })) {
      yield {
        uid: m.uid,
        labels: labelsOf(m.labels),
        seen: m.flags?.has('\\Seen') ?? false,
        flagged: m.flags?.has('\\Flagged') ?? false,
        thread: m.threadId ?? '',
        gmailId: m.emailId ?? '',
        arrived: new Date(m.internalDate ?? Date.now()).getTime(),
        size: m.size ?? 0,
        source: m.source ?? Buffer.alloc(0)
      }
    }
  }

  async *changesSince(modseq: string): AsyncIterable<RemoteHeader> {
    const query = { uid: true, flags: true, labels: true }
    for await (const m of this.client.fetch('1:*', query, { uid: true, changedSince: BigInt(modseq) })) {
      yield {
        uid: m.uid,
        labels: labelsOf(m.labels),
        seen: m.flags?.has('\\Seen') ?? false,
        flagged: m.flags?.has('\\Flagged') ?? false
      }
    }
  }

  async *flagsOf(uids: number[]): AsyncIterable<RemoteHeader> {
    if (uids.length === 0) return
    // One at a time: handing a large folder's UIDs to Math.min all at once overflows the stack.
    const range = `${uids.reduce((a, b) => Math.min(a, b))}:${uids.reduce((a, b) => Math.max(a, b))}`
    for await (const m of this.client.fetch(range, { uid: true, flags: true }, { uid: true })) {
      yield {
        uid: m.uid,
        labels: [],
        seen: m.flags?.has('\\Seen') ?? false,
        flagged: m.flags?.has('\\Flagged') ?? false
      }
    }
  }

  async whole(uid: number): Promise<Buffer | null> {
    const found = await this.client.fetchOne(String(uid), { uid: true, source: true }, { uid: true })
    return found ? (found.source ?? null) : null
  }

  done(): void {
    this.lock?.release()
    this.lock = null
  }

  async close(): Promise<void> {
    this.done()
    try {
      await this.client.logout()
    } catch {
      this.client.close()
    }
  }
}
