/** The keyboard, apart from the page: which keys there are in each set, and what each one asks for. */

export type KeySet = 'edison' | 'gmail'

export type KeyCommand =
  | 'compose' | 'search' | 'next' | 'previous' | 'close' | 'reply' | 'replyAll' | 'forward' | 'archive' | 'trash' | 'removeFromView'
  | 'flag' | 'labels' | 'read' | 'unread' | 'spam' | 'snooze' | 'select' | 'selectAll' | 'undo' | 'help'

/** As much of a key press as naming it needs. */
export interface Pressed { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean }

/** A press by the name the tables below use: "e", "#", "Shift+Backspace", "Ctrl+Shift+R". A character
 *  typed with Shift is named by what it types ("U", "_", "?"), since that's what a keyboard layout
 *  decides; with Ctrl or Alt held it's the letter, and Shift is spelt out. */
export function keyName(event: Pressed): string {
  const held = `${event.ctrlKey || event.metaKey ? 'Ctrl+' : ''}${event.altKey ? 'Alt+' : ''}`
  const single = event.key.length === 1
  if (held) return `${held}${event.shiftKey ? 'Shift+' : ''}${single ? event.key.toUpperCase() : event.key}`
  return event.shiftKey && !single ? `Shift+${event.key}` : event.key
}

/** What both sets share: xrnmail's own keys, most of them Gmail's. */
const SHARED: Record<string, KeyCommand> = {
  '/': 'search', j: 'next', k: 'previous', ArrowDown: 'next', ArrowUp: 'previous', Escape: 'close',
  c: 'compose', r: 'reply', a: 'replyAll', f: 'forward', e: 'archive', '#': 'trash', '!': 'spam',
  s: 'flag', U: 'unread', b: 'snooze', l: 'labels', x: 'select', 'Ctrl+A': 'selectAll', z: 'undo', '?': 'help'
}

export const KEYS: Record<KeySet, Record<string, KeyCommand>> = {
  /** Edison Mail's own set, Command read as Ctrl, with the shared keys it doesn't use left working. */
  edison: {
    ...SHARED,
    d: 'compose', 'Ctrl+R': 'reply', 'Ctrl+Shift+R': 'replyAll', 'Ctrl+Shift+F': 'forward', 'Ctrl+Alt+A': 'archive',
    'Shift+Backspace': 'trash', Backspace: 'removeFromView', Delete: 'removeFromView', 'Ctrl+S': 'flag', 'Ctrl+Shift+M': 'labels',
    I: 'read', 'Ctrl+Shift+U': 'unread', _: 'unread'
  },
  gmail: { ...SHARED, Delete: 'trash' }
}

export const KEY_SETS: [KeySet, string][] = [['edison', 'Edison'], ['gmail', 'Gmail']]

/** The same, for reading: the keys, then what they do. */
export const KEY_LISTS: Record<KeySet, [string, string][]> = {
  edison: [
    ['c, d', 'New message'], ['/', 'Search'], ['j / k', 'Next and previous'], ['Esc', 'Close'],
    ['r, Ctrl+R', 'Reply'], ['a, Ctrl+Shift+R', 'Reply all'], ['f, Ctrl+Shift+F', 'Forward'], ['e, Ctrl+Alt+A', 'Archive'],
    ['#, Shift+Backspace', 'Delete'], ['Backspace, Del', 'Remove from view'], ['s, Ctrl+S', 'Flag'], ['l, Ctrl+Shift+M', 'Labels or Move to'],
    ['Shift+I', 'Mark read'], ['Shift+U, Ctrl+Shift+U, _', 'Mark unread'], ['!', 'Report spam'], ['b', 'Snooze'], ['x', 'Select'], ['Ctrl+A', 'Select all'],
    ['z', 'Undo'], ['Ctrl+Enter', 'Send'], ['F5', 'Check for mail'], ['?', 'These keys']
  ],
  gmail: [
    ['c', 'New message'], ['/', 'Search'], ['j / k', 'Next and previous'], ['Esc', 'Close'],
    ['r', 'Reply'], ['a', 'Reply all'], ['f', 'Forward'], ['e', 'Archive'], ['#, Del', 'Delete'], ['!', 'Report spam'],
    ['s', 'Flag'], ['Shift+U', 'Mark unread'], ['b', 'Snooze'], ['l', 'Labels or Move to'], ['x', 'Select'], ['Ctrl+A', 'Select all'],
    ['z', 'Undo'], ['Ctrl+Enter', 'Send'], ['F5', 'Check for mail'], ['?', 'These keys']
  ]
}
