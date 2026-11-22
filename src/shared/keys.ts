/** The keyboard, apart from the page: which keys there are in each set, what each one asks for, and
 *  the keys a person has changed. */

export type KeySet = 'edison' | 'gmail' | 'apple' | 'outlook' | 'inbox'

export type KeyCommand =
  | 'compose' | 'search' | 'next' | 'previous' | 'close' | 'reply' | 'replyAll' | 'forward' | 'archive' | 'trash' | 'removeFromView'
  | 'flag' | 'pin' | 'labels' | 'read' | 'unread' | 'toggleRead' | 'spam' | 'snooze' | 'select' | 'selectAll' | 'undo' | 'sync' | 'help'

/** Every command, in the order Settings and the list of keys show them, with what it does in words. */
export const COMMANDS: [KeyCommand, string][] = [
  ['compose', 'New message'], ['search', 'Search'], ['next', 'Next thread'], ['previous', 'Previous thread'], ['close', 'Close'],
  ['reply', 'Reply'], ['replyAll', 'Reply all'], ['forward', 'Forward'], ['archive', 'Archive'], ['removeFromView', 'Remove from view'],
  ['trash', 'Delete'], ['spam', 'Report spam'], ['flag', 'Flag'], ['pin', 'Pin'], ['labels', 'Labels or Move to'],
  ['read', 'Mark read'], ['unread', 'Mark unread'], ['toggleRead', 'Mark read or unread'], ['snooze', 'Snooze'],
  ['select', 'Select'], ['selectAll', 'Select all'], ['undo', 'Undo'], ['sync', 'Check for mail'], ['help', 'These keys']
]

const isCommand = (value: unknown): value is KeyCommand => COMMANDS.some(([command]) => command === value)

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

/** Keys that are only half a press, which a key can't be set to. */
const MODIFIERS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'OS', 'Dead', 'Unidentified', 'Process'])

/** What the app's menu answers to, or a page needs for itself, whatever a set says. */
export const RESERVED: Record<string, string> = {
  'Ctrl+N': 'New Message in the menu', 'Ctrl+,': 'Settings in the menu', 'Ctrl+P': 'Print in the menu', 'Ctrl+W': 'Close Window in the menu',
  'Ctrl+Q': 'Quit in the menu', 'Ctrl+F': 'Search in the menu', F5: 'Check for Mail in the menu', F1: 'Keyboard Shortcuts in the menu',
  'Ctrl+Enter': 'sending', Enter: 'pressing what has the focus', ' ': 'pressing what has the focus', Tab: 'moving the focus', 'Shift+Tab': 'moving the focus'
}

/** Why a press can't be a key of its own, if it can't: half a press, or the menu's or a page's own. */
export function unbindable(name: string, key: string): string | null {
  if (MODIFIERS.has(key)) return 'Hold it with another key.'
  if (name in RESERVED) return `${spell(name)} is for ${RESERVED[name]}.`
  return name.length > 40 ? 'That press has no name.' : null
}

/** Every set has these: moving with the arrows, Esc, and ? for the keys, which is how anyone finds them. */
const BASE: Record<string, KeyCommand> = { ArrowDown: 'next', ArrowUp: 'previous', Escape: 'close', '?': 'help' }

/** What Edison's and Gmail's sets share: xrnmail's own keys, most of them Gmail's. */
const SHARED: Record<string, KeyCommand> = {
  ...BASE, '/': 'search', j: 'next', k: 'previous',
  c: 'compose', r: 'reply', a: 'replyAll', f: 'forward', e: 'archive', '#': 'trash', '!': 'spam',
  s: 'flag', U: 'unread', b: 'snooze', l: 'labels', x: 'select', 'Ctrl+A': 'selectAll', z: 'undo'
}

/**
 * Each product's own keys, from its published list. Command is read as Ctrl, Option as Alt, and
 * Control held with Command as Alt too, since Ctrl is taken by then; Control on its own stays Ctrl.
 */
export const KEYS: Record<KeySet, Record<string, KeyCommand>> = {
  /** Edison Mail's own set, with the shared keys it doesn't use left working. */
  edison: {
    ...SHARED,
    d: 'compose', 'Ctrl+R': 'reply', 'Ctrl+Shift+R': 'replyAll', 'Ctrl+Shift+F': 'forward', 'Ctrl+Alt+A': 'archive',
    'Shift+Backspace': 'trash', Backspace: 'removeFromView', Delete: 'removeFromView', 'Ctrl+S': 'flag', 'Ctrl+Shift+M': 'labels',
    I: 'read', 'Ctrl+Shift+U': 'unread', _: 'unread'
  },
  gmail: { ...SHARED, Delete: 'trash' },
  /** Apple's "Keyboard shortcuts in Mail on Mac". It leaves out what Mail's menus show: Delete deletes,
   *  Shift-Command-L flags, and Option-Command-F searches the mailbox. Command-N is the menu's here too. */
  apple: {
    ...BASE,
    'Ctrl+R': 'reply', 'Ctrl+Shift+R': 'replyAll', 'Ctrl+Shift+F': 'forward', 'Ctrl+Alt+A': 'archive', 'Ctrl+Shift+J': 'spam',
    'Ctrl+Shift+U': 'toggleRead', 'Ctrl+Shift+N': 'sync', 'Ctrl+Z': 'undo', Backspace: 'trash', Delete: 'trash',
    'Ctrl+Shift+L': 'flag', 'Ctrl+Alt+F': 'search', 'Ctrl+A': 'selectAll'
  },
  /** Microsoft's "Keyboard shortcuts in Outlook for Mac". Its Delete is the Mac's, which is Backspace
   *  here, and both its flags (for today, and with no date) are a flag. Command-N is the menu's. */
  outlook: {
    ...BASE,
    'Ctrl+R': 'reply', 'Ctrl+Shift+R': 'replyAll', 'Ctrl+J': 'forward', 'Ctrl+Shift+M': 'labels', 'Ctrl+Shift+J': 'spam',
    Backspace: 'trash', Delete: 'trash', 'Ctrl+E': 'archive', 'Ctrl+T': 'read', 'Ctrl+Shift+T': 'unread',
    'Ctrl+[': 'previous', 'Ctrl+]': 'next', 'Ctrl+1': 'flag', 'Ctrl+5': 'flag', 'Ctrl+Alt+F': 'search', 'Ctrl+Shift+F': 'search',
    'Ctrl+Alt+K': 'sync', 'Ctrl+A': 'selectAll', 'Ctrl+Z': 'undo'
  },
  /** Inbox by Gmail's, as its own Shift+? list had them. Done is archiving here, and a pin was Inbox's
   *  mark where Gmail has a star. */
  inbox: {
    ...BASE,
    c: 'compose', '/': 'search', j: 'next', k: 'previous', u: 'close', r: 'reply', a: 'replyAll', f: 'forward',
    e: 'archive', y: 'archive', '[': 'archive', ']': 'archive', '#': 'trash', s: 'snooze', P: 'pin', z: 'undo'
  }
}

export const KEY_SETS: [KeySet, string][] = [['edison', 'Edison'], ['gmail', 'Gmail'], ['apple', 'Apple Mail'], ['outlook', 'Outlook'], ['inbox', 'Inbox']]

export const isKeySet = (value: unknown): value is KeySet => KEY_SETS.some(([set]) => set === value)

/** The keys a person set for a set, by command. A command named here has that key in place of the
 *  set's own; an empty one has no key at all. */
export type KeyChanges = Partial<Record<KeyCommand, string>>

/** A set with its changes. A changed key wins: a command that had it in the set loses it. */
export function keysFor(set: KeySet, changes: KeyChanges = {}): Record<string, KeyCommand> {
  const table: Record<string, KeyCommand> = {}
  const taken = new Set(Object.values(changes).filter(Boolean))
  for (const [key, command] of Object.entries(KEYS[set] ?? KEYS.edison)) {
    if (command in changes || taken.has(key)) continue
    table[key] = command
  }
  for (const [command, key] of Object.entries(changes)) if (key) table[key] = command as KeyCommand
  return table
}

/** The keys [command] answers to. */
export const keysOf = (set: KeySet, changes: KeyChanges, command: KeyCommand): string[] =>
  Object.entries(keysFor(set, changes)).filter(([, found]) => found === command).map(([key]) => key)

/** Which command has [key] now, other than [command]. */
export function holder(set: KeySet, changes: KeyChanges, key: string, command: KeyCommand): KeyCommand | null {
  const found = keysFor(set, changes)[key]
  return found && found !== command ? found : null
}

/** [command] set to [key], or to no key. Another command that had the key loses it, and a change of
 *  its own that named it goes. */
export function rebound(changes: KeyChanges, command: KeyCommand, key: string): KeyChanges {
  const kept = Object.entries(changes).filter(([other, held]) => other !== command && !(key && held === key))
  return cleanChanges(Object.fromEntries([...kept, [command, key]]))
}

/** [command] back to what its set has. */
export function reset(changes: KeyChanges, command: KeyCommand): KeyChanges {
  const { [command]: _gone, ...rest } = changes
  return rest
}

/** Changes as saved, made whole: known commands only, a key no longer than a name can be, none the
 *  menu has, and no key twice (the later wins). */
export function cleanChanges(value: unknown): KeyChanges {
  const clean: KeyChanges = {}
  const used = new Set<string>()
  const entries = value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value as Record<string, unknown>) : []
  for (const [command, key] of entries.reverse()) {
    if (!isCommand(command) || command in clean || typeof key !== 'string' || key.length > 40) continue
    if (key && (key in RESERVED || used.has(key))) continue
    used.add(key)
    clean[command] = key
  }
  return Object.fromEntries(COMMANDS.filter(([command]) => command in clean).map(([command]) => [command, clean[command]])) as KeyChanges
}

/** Every set's changes, made whole. */
export function cleanAllChanges(value: unknown): Partial<Record<KeySet, KeyChanges>> {
  const saved = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  return Object.fromEntries(KEY_SETS.filter(([set]) => set in saved).map(([set]) => [set, cleanChanges(saved[set])] as const)
    .filter(([, changes]) => Object.keys(changes).length > 0))
}

/** A key's name for reading: "Esc", "Del", "Shift+U", "Down". */
export function spell(name: string): string {
  if (/^[A-Z]$/.test(name)) return `Shift+${name}`
  if (name === ' ') return 'Space'
  return name.replace('Escape', 'Esc').replace(/^Delete$|(\+)Delete$/, '$1Del').replace(/Arrow(Down|Up|Left|Right)/, '$1')
}

/** The key a tooltip names beside an action: the first of the first command given that has one in
 *  the set as changed, spelt for reading. None when none of them has a key. */
export function hintFor(set: KeySet, changes: KeyChanges = {}, ...commands: KeyCommand[]): string | undefined {
  for (const command of commands) {
    const [key] = keysOf(set, changes, command)
    if (key) return spell(key)
  }
  return undefined
}

/** What can't be changed, at the end of every list. */
export const FIXED: [string, string][] = [
  ['Ctrl+N', 'New message'], ['Ctrl+F', 'Search'], ['Ctrl+Enter', 'Send'], ['F5', 'Check for mail'], ['F1', 'These keys']
]

/** A set with its changes, for reading: each command that has a key, its keys, then what's fixed. */
export function keyList(set: KeySet, changes: KeyChanges = {}): [string, string][] {
  const listed = COMMANDS.flatMap(([command, what]): [string, string][] => {
    const keys = keysOf(set, changes, command)
    return keys.length > 0 ? [[keys.map(spell).join(', '), what]] : []
  })
  return [...listed, ...FIXED]
}
