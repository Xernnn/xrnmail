import { ImapFlow, type ListResponse, type SearchObject } from 'imapflow'
import { createHash } from 'node:crypto'
import type { TcpNetConnectOpts } from 'node:net'
import type { ConnectionOptions } from 'node:tls'
import type { Security } from '@shared/providers'
import { noteAttempts } from './sync-log'

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

/** What a row of the list needs about a message, without its body. */
export interface RemoteHeaders extends RemoteHeader {
  thread: string
  arrived: number
  size: number
  header: Buffer
}

export interface MailboxInfo {
  uidValidity: string
  modseq: string | null
}

export type MailboxRole = 'all' | 'inbox' | 'sent' | 'archive' | 'trash' | 'junk' | 'drafts' | 'folder'

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

/** Where the account keeps its drafts: the folder marked \Drafts (on Gmail, [Gmail]/Drafts), which
 *  imapflow also finds by its usual names on a server that marks nothing. It isn't read with the
 *  rest, since a draft isn't mail that came; drafts are read from it on their own. */
export function draftsOf(list: ListResponse[]): MailboxRef | null {
  const found = list.find((box) => box.specialUse === '\\Drafts' && !box.flags.has('\\Noselect'))
  return found ? { id: '@drafts', path: found.path, role: 'drafts' } : null
}

/** The person's own folders, or on Gmail their own labels, which IMAP lists as folders too: what mail
 *  can be filed under, including ones with nothing in them. A service's own folders aren't. */
export function ownFolders(list: ListResponse[], gmail: boolean): string[] {
  if (!gmail) return mailboxesOf(list, false).filter((box) => box.role === 'folder').map((box) => box.path)
  return list
    .filter((box) => !box.specialUse && !box.flags.has('\\Noselect') && box.path.toUpperCase() !== 'INBOX' && !/^\[(Gmail|Google Mail)\]\//.test(box.path))
    .map((box) => box.path)
}

export interface MailSource {
  connect(): Promise<void>
  /** Gmail, or something with Gmail's labels and threads. */
  readonly gmail: boolean
  mailboxes(): MailboxRef[]
  /** What mail can be filed under: [ownFolders]. */
  folders(): string[]
  /** The account's Drafts folder, if it has one: [draftsOf]. */
  drafts(): MailboxRef | null
  open(box: MailboxRef): Promise<MailboxInfo>
  /** Every UID that arrived on or after [since], lowest first. Throws if the server won't say:
   *  sync forgets whatever isn't in the answer. */
  uidsSince(since: Date): Promise<number[]>
  fetch(uids: number[], maxBytes: number): AsyncIterable<RemoteMail>
  /** Labels and flags changed since [modseq]. */
  changesSince(modseq: string): AsyncIterable<RemoteHeader>
  /** Flags as they are now, for servers that can't say what changed. */
  flagsOf(uids: number[]): AsyncIterable<RemoteHeader>
  /** One message with nothing cut, for its attachments: [TooBig] past [maxBytes], of which no more
   *  is read. */
  whole(uid: number, maxBytes: number): Promise<Buffer | null>
  /** One message's header alone, for its details. */
  header(uid: number): Promise<Buffer | null>
  /** The UIDs a search finds in the folder open now. Throws if the server won't say. */
  search(query: SearchObject): Promise<number[]>
  /** The headers of these messages, read with BODY.PEEK so nothing is marked read. */
  headers(uids: number[]): AsyncIterable<RemoteHeaders>
  done(): void
  close(): Promise<void>
  /** Lets go of the connection at once, whatever it's waiting for: a search nobody wants any more. */
  drop(): void
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
  /** Shorter for tests; otherwise [IMAP_TIMEOUTS]. */
  timeouts?: Partial<ImapTimeouts>
}

/** How long a connection waits before it gives up, in ms: to be open, to be greeted, and with a
 *  command out and nothing heard. */
export interface ImapTimeouts {
  connect: number
  greeting: number
  quiet: number
}

/** Connecting to Gmail takes a few seconds (3 to 16 here). imapflow's own limits are 90 seconds to
 *  connect and 5 minutes of silence, so a pass the server stopped answering held its account for
 *  minutes, with every sync turned away meanwhile. A server that's there answers a command in far
 *  less than a minute; a big message coming in is never quiet that long. */
export const IMAP_TIMEOUTS: ImapTimeouts = { connect: 30_000, greeting: 20_000, quiet: 60_000 }

/** How long each of a server's addresses is given to answer before the next is tried, in ms.
 *  Node tries them one at a time and drops each after 250 ms, except the last, which waits out the
 *  whole connect time. Through a VPN to a far exit, Gmail takes 400 ms or more to answer, so every
 *  IPv4 try was dropped and the connection ended on an IPv6 address the VPN's kill switch swallows,
 *  waiting until the 30 seconds ran out: "Couldn't reach Gmail." This is long enough for a slow
 *  route and one lost packet, and an address that's truly gone still hands over in seconds. */
export const ADDRESS_ATTEMPT_MS = 2_500

/** Handed to the socket as it's opened, alongside the certificate checks Node does by default. A
 *  socket takes it, though the TLS options' type doesn't list it. */
const SOCKET: ConnectionOptions & Pick<TcpNetConnectOpts, 'autoSelectFamilyAttemptTimeout'> = { autoSelectFamilyAttemptTimeout: ADDRESS_ATTEMPT_MS }

/** Providers show app passwords in groups with spaces, which aren't part of them. */
export const cleanSecret = (secret: string): string => secret.replace(/\s+/g, '')

/** STARTTLS is required, not merely tried: a server that stops offering it mustn't get the password. */
export function imapClient(config: ImapConfig, extra: { maxIdleTime?: number; socketTimeout?: number } = {}): ImapFlow {
  const timeouts = { ...IMAP_TIMEOUTS, ...config.timeouts }
  const client = new ImapFlow({
    connectionTimeout: timeouts.connect,
    greetingTimeout: timeouts.greeting,
    socketTimeout: timeouts.quiet,
    ...extra,
    host: config.host,
    port: config.port,
    secure: config.security === 'tls',
    auth: config.accessToken ? { user: config.user, accessToken: config.accessToken } : { user: config.user, pass: config.secret },
    logger: false,
    doSTARTTLS: config.security === 'tls' ? undefined : config.security === 'starttls',
    tls: SOCKET
  })
  client.on('error', () => undefined) // the work in progress fails on its own; unhandled this ends the app
  // Each address the connection tries is noted, for the log of failures.
  const connect = client.connect.bind(client)
  client.connect = () => noteAttempts(connect)
  return client
}

/** Waits on the inbox for something to happen there. It reads nothing and can change nothing. */
export interface MailWatcher {
  /** Calls [changed] whenever the server says mail landed in the inbox, left it, or had its flags
   *  changed (read or flagged elsewhere), and resolves when the connection ends. [opened] is told
   *  once the inbox is open and being watched. */
  watch(changed: () => void, opened?: () => void): Promise<void>
  close(): Promise<void>
}

/** Servers drop a quiet connection after half an hour or so, so it's refreshed well before that. */
const IDLE_REFRESH_MS = 5 * 60_000

export class ImapWatcher implements MailWatcher {
  private client: ImapFlow

  constructor(config: ImapConfig) {
    // Waiting in IDLE is quiet by design, so the silence allowed is longer than IDLE lasts before
    // it's started again; past that, imapflow asks the server whether it's still there.
    this.client = imapClient(config, { maxIdleTime: IDLE_REFRESH_MS, socketTimeout: IDLE_REFRESH_MS + (config.timeouts?.quiet ?? IMAP_TIMEOUTS.quiet) })
  }

  /** imapflow tells of three things while IDLE: `exists` when the count goes up, `expunge` for each
   *  message that left (archived or deleted elsewhere), and `flags` when one was read, unread,
   *  flagged or unflagged. Each only says to look; the sync does the reading. IDLE is broken and
   *  started again every few minutes (`maxIdleTime`), and imapflow starts it again by itself after
   *  anything else on this connection, so it's asked for once. */
  async watch(changed: () => void, opened?: () => void): Promise<void> {
    let failed: unknown = null
    this.client.on('error', (e: unknown) => (failed = e))
    const ended = new Promise<void>((resolve) => this.client.once('close', () => resolve()))
    try {
      await this.client.connect()
      const opened = await this.client.mailboxOpen('INBOX', { readOnly: true })
      if (!opened.readOnly) throw new Error('The mailbox did not open read-only, so nothing was fetched.')
    } catch (e) {
      await this.close() // signed in by now, perhaps: not left holding a connection
      throw e
    }
    for (const event of ['exists', 'expunge', 'flags']) this.client.on(event, () => changed())
    void this.client.idle().catch(() => undefined)
    opened?.()
    await ended
    if (failed) throw failed // what ended it, for the log
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

/** What a row of the list is made from, and what finds the rest of a thread on a server without
 *  threads. Authentication-Results and Reply-To say whether the sender gets a warning. */
const HEADERS_FOR_ROWS = [
  'from', 'to', 'cc', 'reply-to', 'subject', 'date', 'message-id', 'in-reply-to', 'references', 'content-type',
  'authentication-results', 'list-id', 'list-unsubscribe', 'precedence', 'auto-submitted'
]

/** The server said NO or BAD to a search. It carries the status imapflow's own refusals do, so an
 *  ordinary folder that won't be searched is skipped like one that won't open. */
class SearchRefused extends Error {
  readonly responseStatus = 'NO'
}

/** A message bigger than a mail service takes, which isn't fetched whole. */
export class TooBig extends Error {
  constructor() {
    super('Too big to open here.')
  }
}

export class ImapSource implements MailSource {
  private client: ImapFlow
  private lock: { release(): void } | null = null
  private boxes: MailboxRef[] = []
  private own: string[] = []
  private draftBox: MailboxRef | null = null
  gmail = false

  constructor(config: ImapConfig) {
    this.client = imapClient(config)
  }

  async connect(): Promise<void> {
    await this.client.connect()
    this.gmail = this.client.capabilities.has('X-GM-EXT-1')
    const listed = await this.client.list()
    this.boxes = mailboxesOf(listed, this.gmail)
    this.own = ownFolders(listed, this.gmail)
    this.draftBox = draftsOf(listed)
    if (this.gmail && !this.boxes.some((box) => box.role === 'all')) {
      throw new Error('This account has no All Mail folder. In Gmail settings, turn on showing All Mail in IMAP.')
    }
    if (this.boxes.length === 0) throw new Error('This account has no folders to read.')
  }

  mailboxes(): MailboxRef[] {
    return this.boxes
  }

  folders(): string[] {
    return this.own
  }

  drafts(): MailboxRef | null {
    return this.draftBox
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

  async whole(uid: number, maxBytes: number): Promise<Buffer | null> {
    const found = await this.client.fetchOne(String(uid), { uid: true, size: true, source: { maxLength: maxBytes } }, { uid: true })
    if (!found) return null
    if ((found.size ?? 0) > maxBytes || (found.source?.length ?? 0) > maxBytes) throw new TooBig()
    return found.source ?? null
  }

  /** BODY.PEEK[HEADER]: reading it leaves the message unread. */
  async header(uid: number): Promise<Buffer | null> {
    const found = await this.client.fetchOne(String(uid), { uid: true, headers: true }, { uid: true })
    return found ? (found.headers ?? null) : null
  }

  async search(query: SearchObject): Promise<number[]> {
    const found = await this.client.search(query, { uid: true })
    if (found === false) throw new SearchRefused()
    if (!Array.isArray(found)) throw new Error('The connection went during a search.')
    return found
  }

  async *headers(uids: number[]): AsyncIterable<RemoteHeaders> {
    if (uids.length === 0) return
    const query = { uid: true, flags: true, internalDate: true, size: true, threadId: true, labels: true, headers: HEADERS_FOR_ROWS }
    for await (const m of this.client.fetch(uids.join(','), query, { uid: true })) {
      yield {
        uid: m.uid,
        labels: labelsOf(m.labels),
        seen: m.flags?.has('\\Seen') ?? false,
        flagged: m.flags?.has('\\Flagged') ?? false,
        thread: m.threadId ?? '',
        arrived: new Date(m.internalDate ?? Date.now()).getTime(),
        size: m.size ?? 0,
        header: m.headers ?? Buffer.alloc(0)
      }
    }
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

  drop(): void {
    this.done()
    this.client.close()
  }
}
