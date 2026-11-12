/** The sidebar's two lists that can be edited: which of their entries show, and in what order.
 *  The inbox, the accounts and their labels above them stay as they are. */

/** The gathered folders, as they start out. */
export const SIDEBAR_FOLDERS = ['today', 'unread', 'starred', 'pinned', 'summary', 'snoozed', 'attachments', 'drafts', 'spam', 'trash', 'archive', 'sent', 'recent'] as const
/** What the Assistant found, as it starts out. */
export const SIDEBAR_ASSISTANT = ['subscriptions', 'travel', 'packages', 'money', 'events'] as const
export const SIDEBAR_GROUPS = [SIDEBAR_FOLDERS, SIDEBAR_ASSISTANT] as const

export type SidebarEntry = (typeof SIDEBAR_FOLDERS)[number] | (typeof SIDEBAR_ASSISTANT)[number]

const EVERY: readonly SidebarEntry[] = [...SIDEBAR_FOLDERS, ...SIDEBAR_ASSISTANT]
const isEntry = (value: unknown): value is SidebarEntry => EVERY.includes(value as SidebarEntry)

export interface SidebarChoice {
  /** Every entry once: the folders in the order they're shown, then the Assistant's lists in theirs. */
  order: SidebarEntry[]
  /** The entries left out. */
  hidden: SidebarEntry[]
  /** Each account's own labels or folders, by account. */
  labels?: Record<string, LabelChoice>
}

const entries = (value: unknown): SidebarEntry[] => [...new Set(Array.isArray(value) ? value.filter(isEntry) : [])]

/** A saved choice made whole: only entries there are, each once, and one the choice doesn't name (a
 *  version from before it existed) goes after the entry it follows as things start out, shown. */
export function cleanSidebar(choice: unknown): SidebarChoice {
  const saved = (choice && typeof choice === 'object' ? choice : {}) as { order?: unknown; hidden?: unknown; labels?: unknown }
  const named = entries(saved.order)
  const order = SIDEBAR_GROUPS.flatMap((group: readonly SidebarEntry[]) => {
    const list = named.filter((entry) => group.includes(entry))
    group.forEach((entry, at) => {
      if (list.includes(entry)) return
      const before = group.slice(0, at).reverse().find((earlier) => list.includes(earlier))
      list.splice(before === undefined ? 0 : list.indexOf(before) + 1, 0, entry)
    })
    return list
  })
  return { order, hidden: entries(saved.hidden), labels: cleanLabels(saved.labels) }
}

/** One of the two lists in the order chosen, hidden entries and all. */
export function arranged(group: readonly SidebarEntry[], choice: SidebarChoice): SidebarEntry[] {
  return cleanSidebar(choice).order.filter((entry) => group.includes(entry))
}

/** [entry] moved to where [target] is, in the same list. Across lists nothing moves. */
export function moved(choice: SidebarChoice, entry: SidebarEntry, target: SidebarEntry): SidebarChoice {
  const whole = cleanSidebar(choice)
  const group = SIDEBAR_GROUPS.find((list) => list.includes(entry as never))
  if (!group || !group.includes(target as never) || entry === target) return whole
  const order = whole.order.filter((e) => e !== entry)
  const at = whole.order.indexOf(target)
  order.splice(at, 0, entry)
  return { ...whole, order }
}

/** An account's own labels or folders, as Edit Menu leaves them: an order among each label's
 *  siblings, and the ones hidden. A label inside another moves with it. */
export interface LabelChoice {
  order: string[]
  hidden: string[]
}

/** One label as the sidebar lists it. */
export interface LabelRow {
  path: string
  /** What's shown: the last part, or the whole path when what it's inside isn't a label itself. */
  name: string
  depth: number
  /** Hidden itself, or inside one that is. */
  hidden: boolean
  /** Its own switch. */
  shown: boolean
}

const parentOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')

const strings = (value: unknown, most: number): string[] =>
  [...new Set(Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 1000) : [])].slice(0, most)

/** Each account's choice made whole: lists of names, each once, and no more of them than anyone has. */
export function cleanLabels(value: unknown): Record<string, LabelChoice> {
  const saved = value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value as Record<string, unknown>) : []
  return Object.fromEntries(saved.filter(([account]) => account.includes('@') && account.length <= 320).slice(0, 50).map(([account, choice]) => {
    const c = (choice && typeof choice === 'object' ? choice : {}) as { order?: unknown; hidden?: unknown }
    return [account, { order: strings(c.order, 2000), hidden: strings(c.hidden, 2000) }]
  }))
}

/** The labels there are, in the order chosen: siblings by the choice, then by name, each followed by
 *  what's inside it. One the choice has never heard of, made elsewhere, goes after the ones it has. */
export function arrangedLabels(names: string[], choice?: LabelChoice): LabelRow[] {
  const all = [...new Set(names)]
  const rank = new Map((choice?.order ?? []).map((path, at) => [path, at]))
  const hidden = new Set(choice?.hidden ?? [])
  const bySiblings = (a: string, b: string): number => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity) || a.localeCompare(b)
  const within = (path: string): string => (all.includes(parentOf(path)) ? parentOf(path) : '')
  const rows: LabelRow[] = []
  const walk = (path: string, depth: number, above: boolean): void => {
    const parent = within(path)
    rows.push({ path, name: parent ? path.slice(parent.length + 1) : path, depth, hidden: above || hidden.has(path), shown: !hidden.has(path) })
    all.filter((other) => other !== path && within(other) === path).sort(bySiblings).forEach((child) => walk(child, depth + 1, above || hidden.has(path)))
  }
  all.filter((path) => within(path) === '').sort(bySiblings).forEach((root) => walk(root, 0, false))
  return rows
}

/** The labels sharing [path]'s place: inside the same label, or at the top. */
export function siblingsOf(names: string[], choice: LabelChoice | undefined, path: string): string[] {
  const rows = arrangedLabels(names, choice)
  const parent = (p: string): string => (names.includes(parentOf(p)) ? parentOf(p) : '')
  return rows.map((row) => row.path).filter((p) => parent(p) === parent(path))
}

/** [path] moved to where [target] is among its siblings. Into another label, nothing moves. */
export function movedLabel(names: string[], choice: LabelChoice | undefined, path: string, target: string): LabelChoice {
  const kept = { order: choice?.order ?? [], hidden: choice?.hidden ?? [] }
  const siblings = siblingsOf(names, choice, path)
  if (path === target || !siblings.includes(target)) return kept
  const order = siblings.filter((p) => p !== path)
  order.splice(siblings.indexOf(target), 0, path)
  const rest = arrangedLabels(names, choice).map((row) => row.path).filter((p) => !siblings.includes(p))
  return { ...kept, order: [...order, ...rest] }
}

/** [path] shown, or hidden. */
export function shownLabel(choice: LabelChoice | undefined, path: string, show: boolean): LabelChoice {
  const hidden = (choice?.hidden ?? []).filter((p) => p !== path)
  return { order: choice?.order ?? [], hidden: show ? hidden : [...hidden, path] }
}
