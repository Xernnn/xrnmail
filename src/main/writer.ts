import type { ImapFlow } from 'imapflow'
import type { MailAction } from '@shared/types'
import { imapClient, mailboxesOf, type ImapConfig, type MailboxRef, type MailboxRole } from './source'

/** Where a move left things. Without [map] the server didn't say what the new UIDs are. */
export interface Moved {
  to: MailboxRef | null
  map: Map<number, number> | null
}

/**
 * The only code that changes a mailbox, and it runs only for something the person did. Syncing still
 * goes through `MailSource`, which has no way to change anything. Keeping the two apart is what lets
 * the tests say sync never writes, however the rest of the app changes.
 */
export interface MailWriter {
  connect(): Promise<void>
  /** Throws unless the server accepted it. Answers with where mail went, if it moved. */
  apply(box: string, uids: number[], action: MailAction): Promise<Moved | null>
  /** Files a sent message, unless the server already did. */
  fileSent(raw: Buffer, messageId: string): Promise<void>
  close(): Promise<void>
}

/** The server said no. Unlike a lost connection, trying the same thing later won't help. */
export class Refused extends Error {}

const FOLDER_NAMES: Partial<Record<MailboxRole, string>> = { archive: 'Archive', trash: 'Trash', junk: 'Junk', sent: 'Sent' }

export class ImapWriter implements MailWriter {
  private client: ImapFlow
  private boxes: MailboxRef[] = []
  private gmail = false

  constructor(config: ImapConfig) {
    this.client = imapClient(config)
  }

  async connect(): Promise<void> {
    await this.client.connect()
    this.gmail = this.client.capabilities.has('X-GM-EXT-1')
    this.boxes = mailboxesOf(await this.client.list(), this.gmail)
  }

  private byRole(role: MailboxRole): MailboxRef | undefined {
    return this.boxes.find((box) => box.role === role)
  }

  /** A special folder, made if the server doesn't have one yet. */
  private async ensure(role: MailboxRole): Promise<MailboxRef> {
    const found = this.byRole(role)
    if (found) return found
    const name = FOLDER_NAMES[role]
    if (!name || this.gmail) throw new Refused(role)
    const made = await this.client.mailboxCreate(name)
    const box: MailboxRef = { id: `@${role}`, path: made.path, role }
    this.boxes.push(box)
    return box
  }

  async apply(box: string, uids: number[], action: MailAction): Promise<Moved | null> {
    const from = this.boxes.find((b) => b.id === box)
    if (!from) throw new Refused('no such folder')
    if (uids.length === 0) return null
    const target = await this.destination(from, action)
    const lock = await this.client.getMailboxLock(from.path)
    try {
      const range = uids.join(',')
      if (target) return await this.move(from, range, target)
      // imapflow answers false, not an error, when a command fails, so every answer is checked.
      if (!(await this.store(from, range, action))) throw new Refused(action.kind)
      return null
    } finally {
      lock.release()
    }
  }

  /** Where [action] sends mail, if it has to go anywhere. INBOX is a path on every server, though on
   *  Gmail it isn't read: mail moved there shows up in All Mail, with a new UID, on the next sync. */
  private async destination(from: MailboxRef, action: MailAction): Promise<MailboxRef | null> {
    const inbox: MailboxRef = this.byRole('inbox') ?? { id: '@inbox', path: 'INBOX', role: 'inbox' }
    const away = from.role === 'trash' || from.role === 'junk'
    switch (action.kind) {
      case 'trash':
        return this.ensure('trash')
      case 'spam':
        return this.ensure('junk')
      case 'archive':
        if (this.gmail) return away ? this.ensure('all') : null
        return this.ensure('archive')
      case 'inbox':
        return !this.gmail || away ? inbox : null
      case 'move': {
        const found = this.boxes.find((b) => b.path === action.to)
        if (!found) throw new Refused('no such folder')
        return found
      }
      default:
        return null
    }
  }

  private async move(from: MailboxRef, range: string, target: MailboxRef): Promise<Moved | null> {
    if (from.id === target.id) return null
    const result = await this.client.messageMove(range, target.path, { uid: true })
    if (!result) throw new Refused('move')
    const read = this.boxes.some((b) => b.id === target.id)
    return { to: read ? target : null, map: result.uidMap ?? null }
  }

  private async store(from: MailboxRef, range: string, action: MailAction): Promise<boolean> {
    const uid = { uid: true }
    const labels = { uid: true, useLabels: true }
    switch (action.kind) {
      case 'archive':
        return this.client.messageFlagsRemove(range, ['\\Inbox'], labels)
      case 'inbox':
        return this.client.messageFlagsAdd(range, ['\\Inbox'], labels)
      case 'read':
        return this.client.messageFlagsAdd(range, ['\\Seen'], uid)
      case 'unread':
        return this.client.messageFlagsRemove(range, ['\\Seen'], uid)
      case 'star':
        return this.client.messageFlagsAdd(range, ['\\Flagged'], uid)
      case 'unstar':
        return this.client.messageFlagsRemove(range, ['\\Flagged'], uid)
      case 'forever':
        // On Gmail, deleting from any other folder only takes a label off. Nothing else asks for this.
        return from.role === 'trash' || from.role === 'junk' ? this.client.messageDelete(range, uid) : false
      case 'label':
        if (!this.gmail) return false
        return action.add
          ? this.client.messageFlagsAdd(range, [action.label], labels)
          : this.client.messageFlagsRemove(range, [action.label], labels)
      default:
        return false
    }
  }

  /** Whether the server filed it can only be told by looking, and services differ, so this looks. */
  async fileSent(raw: Buffer, messageId: string): Promise<void> {
    const sent = await this.ensure('sent')
    const lock = await this.client.getMailboxLock(sent.path)
    try {
      const found = await this.client.search({ header: { 'Message-ID': messageId } }, { uid: true })
      if (found && found.length > 0) return
    } finally {
      lock.release()
    }
    if (!(await this.client.append(sent.path, raw, ['\\Seen']))) throw new Refused('append')
  }

  async close(): Promise<void> {
    try {
      await this.client.logout()
    } catch {
      this.client.close()
    }
  }
}
