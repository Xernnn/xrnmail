import type { ImapFlow } from 'imapflow'
import type { MailAction } from '@shared/types'
import { draftsOf, imapClient, mailboxesOf, type ImapConfig, type MailboxRef, type MailboxRole } from './source'
import type { DraftCopy } from './store'

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
  /** Makes a folder, or on Gmail a label, from the parts of its path. Answers with the path the server
   *  gave it, which joins the parts with its own separator. One that's there already is answered too. */
  createFolder(parts: string[]): Promise<string>
  /** Puts a draft in the Drafts folder, made if there's none, and says where it went. */
  saveDraft(raw: Buffer, messageId: string): Promise<DraftCopy>
  /** Deletes a draft's copy for good, found by its Message-ID when the folder has been renumbered.
   *  One that's gone already is fine. */
  deleteDraft(copy: DraftCopy): Promise<void>
  close(): Promise<void>
}

/** The server said no. Unlike a lost connection, trying the same thing later won't help. */
export class Refused extends Error {}

const FOLDER_NAMES: Partial<Record<MailboxRole, string>> = { archive: 'Archive', trash: 'Trash', junk: 'Junk', sent: 'Sent', drafts: 'Drafts' }

/** Servers cap how long a command line can be (RFC 7162 asks clients to stay under 8192 octets), and
 *  "Delete all" from a busy sender names thousands of messages. 500 UIDs fit in about 5.5 KB. */
const UIDS_PER_COMMAND = 500

/** Where several moves to the same folder left things, as one. */
function together(a: Moved | null, b: Moved | null): Moved | null {
  if (!a || !b) return a ?? b
  return { to: b.to, map: a.map || b.map ? new Map([...(a.map ?? []), ...(b.map ?? [])]) : null }
}

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
    const listed = await this.client.list()
    this.boxes = mailboxesOf(listed, this.gmail)
    const drafts = draftsOf(listed)
    if (drafts) this.boxes.push(drafts)
  }

  private byRole(role: MailboxRole): MailboxRef | undefined {
    return this.boxes.find((box) => box.role === role)
  }

  /** imapflow answers false both when the server says no and when the connection went before it
   *  answered (a server gone quiet, timed out). Only the first is a refusal, which a change gets
   *  three of before it's put back; the second is being offline, and the change waits to go again. */
  private refused(what: string): Error {
    return this.client.usable ? new Refused(what) : new Error(`The connection went before the server answered: ${what}`)
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
      let moved: Moved | null = null
      for (let at = 0; at < uids.length; at += UIDS_PER_COMMAND) {
        const range = uids.slice(at, at + UIDS_PER_COMMAND).join(',')
        if (target) moved = together(moved, await this.move(from, range, target))
        // imapflow answers false, not an error, when a command fails, so every answer is checked.
        else if (!(await this.store(from, range, action))) throw this.refused(action.kind)
      }
      return moved
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
    if (!result) throw this.refused('move')
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

  /** The copies of a message in the folder open now with this Message-ID. */
  private async withId(messageId: string): Promise<number[]> {
    if (!messageId) return []
    const found = await this.client.search({ header: { 'Message-ID': messageId } }, { uid: true })
    if (found === false) throw new Refused('search')
    return Array.isArray(found) ? found : []
  }

  /** [uid], if the folder open now still has it: a copy another device deleted is no one's business. */
  private async present(uid: number): Promise<number[]> {
    const found = await this.client.search({ uid: String(uid) }, { uid: true })
    if (found === false) throw new Refused('search')
    return Array.isArray(found) ? found.filter((each) => each === uid) : []
  }

  /** \\Draft says what it is, and \\Seen keeps it from counting as unread anywhere. */
  async saveDraft(raw: Buffer, messageId: string): Promise<DraftCopy> {
    const drafts = await this.ensure('drafts')
    const added = await this.client.append(drafts.path, raw, ['\\Draft', '\\Seen'])
    if (!added) throw new Refused('append')
    if (added.uid && added.uidValidity) return { uid: added.uid, validity: String(added.uidValidity), messageId }
    // Without UIDPLUS the server doesn't say, so it's looked for: the newest copy with this Message-ID.
    const lock = await this.client.getMailboxLock(drafts.path)
    try {
      const uid = Math.max(0, ...(await this.withId(messageId)))
      const validity = String(this.client.mailbox ? this.client.mailbox.uidValidity : '')
      if (!uid || !validity) throw new Refused('append')
      return { uid, validity, messageId }
    } finally {
      lock.release()
    }
  }

  /** Gmail moves what's deleted from Drafts into Trash, where it would sit for a month, so there it's
   *  moved to Trash and deleted from Trash, which is for good. Elsewhere it's deleted where it is. */
  async deleteDraft(copy: DraftCopy): Promise<void> {
    const drafts = this.boxes.find((box) => box.role === 'drafts')
    if (!drafts) return // no Drafts folder: nothing of it is there
    const lock = await this.client.getMailboxLock(drafts.path)
    let moved: { to: string; uids: number[] } | null = null
    try {
      const same = this.client.mailbox && String(this.client.mailbox.uidValidity) === copy.validity
      const uids = same ? await this.present(copy.uid) : await this.withId(copy.messageId)
      if (uids.length === 0) return
      const range = uids.join(',')
      const trash = this.gmail ? this.byRole('trash') : undefined
      if (!trash) {
        if (!(await this.client.messageDelete(range, { uid: true }))) throw new Refused('delete')
        return
      }
      const result = await this.client.messageMove(range, trash.path, { uid: true })
      if (!result) throw new Refused('move')
      moved = { to: trash.path, uids: [...(result.uidMap?.values() ?? [])] }
    } finally {
      lock.release()
    }
    const bin = await this.client.getMailboxLock(moved.to)
    try {
      const uids = moved.uids.length > 0 ? moved.uids : await this.withId(copy.messageId)
      if (uids.length > 0 && !(await this.client.messageDelete(uids.join(','), { uid: true }))) throw new Refused('delete')
    } finally {
      bin.release()
    }
  }

  async createFolder(parts: string[]): Promise<string> {
    const made = await this.client.mailboxCreate(parts.length === 1 ? (parts[0] ?? '') : parts)
    if (!made?.path) throw new Refused('create')
    return made.path
  }

  async close(): Promise<void> {
    try {
      await this.client.logout()
    } catch {
      this.client.close()
    }
  }
}
