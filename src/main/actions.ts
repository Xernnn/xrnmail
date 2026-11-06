import type { MailAction } from '@shared/types'
import type { MailboxRef, MailboxRole } from './source'

/** What an action changes about one message. Sync, undo and the writer all agree through this. */
export interface MailState {
  /** The row, which stays the same when a move gives the message a new UID. */
  id: number
  /** The folder the server has it in. It changes only once the server has moved it. */
  box: string
  labels: string[]
  seen: boolean
  flagged: boolean
  /** Out of sight here before the server has heard. */
  hidden: boolean
}

export const INBOX = '\\Inbox'
export const TRASH = '\\Trash'
export const SPAM = '\\Spam'
export const SENT = '\\Sent'
export const DRAFT = '\\Draft'

const without = (labels: string[], ...gone: string[]): string[] => labels.filter((l) => !gone.includes(l))
const withLabel = (labels: string[], label: string): string[] => (labels.includes(label) ? labels : [...labels, label])

/** Which bin a message is in: 0 neither, 1 Trash, 2 Spam. */
export const binOf = (labels: string[]): number => (labels.includes(TRASH) ? 1 : labels.includes(SPAM) ? 2 : 0)

/** The labels mail has from where it sits. On Gmail they're the server's own, and only Trash and Spam
 *  need saying. Elsewhere a message is in one folder, and the folder is its only label. */
export function labelsOf(box: MailboxRef, remote: string[], gmail: boolean): string[] {
  if (gmail) return box.role === 'trash' ? withLabel(remote, TRASH) : box.role === 'junk' ? withLabel(remote, SPAM) : remote
  const byRole: Partial<Record<MailboxRole, string[]>> = {
    inbox: [INBOX], sent: [SENT], trash: [TRASH], junk: [SPAM], archive: []
  }
  return byRole[box.role] ?? [box.path]
}

/** How a message looks here once [action] is done. Undo before the server hears only changes this. */
export function applied(state: MailState, action: MailAction): MailState {
  const placed = (labels: string[]): MailState => ({ ...state, labels })
  switch (action.kind) {
    case 'archive':
      return placed(without(state.labels, INBOX))
    case 'inbox':
      return placed(withLabel(without(state.labels, TRASH, SPAM), INBOX))
    case 'trash':
      return placed(withLabel(without(state.labels, INBOX, SPAM), TRASH))
    case 'spam':
      return placed(withLabel(without(state.labels, INBOX, TRASH), SPAM))
    case 'forever':
      return { ...state, hidden: true }
    case 'read':
      return { ...state, seen: true }
    case 'unread':
      return { ...state, seen: false }
    case 'star':
      return { ...state, flagged: true }
    case 'unstar':
      return { ...state, flagged: false }
    case 'label':
      return placed(action.add ? withLabel(state.labels, action.label) : without(state.labels, action.label))
    case 'move':
      return placed([action.to])
  }
}

/** Which of a thread's messages an action is about. A Gmail label costs a message nothing, so every
 *  message takes part. A folder is where a message lives, so archiving a thread must leave your own
 *  copy in Sent where it is, unless Sent is all there is. */
export function touched(action: MailAction, states: MailState[], gmail: boolean): MailState[] {
  if (action.kind === 'forever') return states.filter((s) => binOf(s.labels) > 0)
  if (gmail || !['archive', 'inbox', 'trash', 'spam', 'move'].includes(action.kind)) return states
  if (action.kind === 'archive') {
    const inbox = states.filter((s) => s.labels.includes(INBOX))
    if (inbox.length > 0) return inbox
  }
  const others = states.filter((s) => !s.labels.includes(SENT))
  return others.length > 0 ? others : states
}

/** Thread-wide moves stop a snooze: a snoozed thread that's been dealt with shouldn't come back. */
export const endsSnooze = (action: MailAction): boolean =>
  ['archive', 'trash', 'spam', 'forever', 'move'].includes(action.kind)

/** The ones that take mail out of the list, so Undo gets a moment before they set off. */
export const takesAway = (action: MailAction): boolean =>
  ['archive', 'trash', 'spam', 'forever', 'move'].includes(action.kind)

/** The ones that work on mail in Trash and Spam as well. */
export const reachesBins = (action: MailAction): boolean =>
  !['archive', 'trash', 'spam', 'label', 'move'].includes(action.kind)
