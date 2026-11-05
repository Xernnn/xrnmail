import { ImapFlow } from 'imapflow'

/**
 * The mailbox, seen from here. This interface has no way to change anything, and `ImapSource` opens
 * the mailbox read-only, so no bug further up can touch a real inbox.
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

export interface MailSource {
  connect(): Promise<void>
  open(): Promise<MailboxInfo>
  /** Every UID that arrived on or after [since], lowest first. */
  uidsSince(since: Date): Promise<number[]>
  fetch(uids: number[], maxBytes: number): AsyncIterable<RemoteMail>
  /** Labels and flags changed since [modseq]. */
  changesSince(modseq: string): AsyncIterable<RemoteHeader>
  done(): void
  close(): Promise<void>
}

export interface ImapConfig {
  host: string
  port: number
  secure: boolean
  user: string
  secret: string
}

export const gmailConfig = (user: string, secret: string): ImapConfig => ({
  host: 'imap.gmail.com',
  port: 993,
  secure: true,
  user,
  // Google shows app passwords in groups of four with spaces; those aren't part of it.
  secret: secret.replace(/\s+/g, '')
})

const labelsOf = (labels: Set<string> | undefined): string[] => [...(labels ?? [])]

export class ImapSource implements MailSource {
  private client: ImapFlow
  private lock: { release(): void } | null = null
  private path = ''

  constructor(config: ImapConfig) {
    this.client = new ImapFlow({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: { user: config.user, pass: config.secret },
      logger: false,
      doSTARTTLS: config.secure ? undefined : false
    })
    this.client.on('error', () => undefined) // the sync in progress fails on its own; unhandled this ends the app
  }

  async connect(): Promise<void> {
    await this.client.connect()
    const boxes = await this.client.list()
    const all = boxes.find((box) => box.specialUse === '\\All')
    if (!all) throw new Error('This account has no All Mail folder. In Gmail settings, turn on showing All Mail in IMAP.')
    this.path = all.path
  }

  async open(): Promise<MailboxInfo> {
    this.lock = await this.client.getMailboxLock(this.path, { readOnly: true })
    const box = this.client.mailbox
    if (!box || !box.readOnly) {
      this.done()
      throw new Error('The mailbox did not open read-only, so nothing was fetched.')
    }
    return { uidValidity: String(box.uidValidity), modseq: box.highestModseq ? String(box.highestModseq) : null }
  }

  async uidsSince(since: Date): Promise<number[]> {
    const found = await this.client.search({ since }, { uid: true })
    return (found || []).slice().sort((a, b) => a - b)
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
        thread: m.threadId ?? String(m.uid),
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
