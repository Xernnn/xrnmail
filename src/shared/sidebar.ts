/** The sidebar's two lists that can be edited: which of their entries show, and in what order.
 *  The inbox, the accounts and their labels above them stay as they are. */

/** The gathered folders, as they start out. */
export const SIDEBAR_FOLDERS = ['today', 'unread', 'starred', 'pinned', 'snoozed', 'attachments', 'drafts', 'spam', 'trash', 'archive', 'sent', 'recent'] as const
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
}

const entries = (value: unknown): SidebarEntry[] => [...new Set(Array.isArray(value) ? value.filter(isEntry) : [])]

/** A saved choice made whole: only entries there are, each once, and one the choice doesn't name (a
 *  version from before it existed) goes after the entry it follows as things start out, shown. */
export function cleanSidebar(choice: unknown): SidebarChoice {
  const saved = (choice && typeof choice === 'object' ? choice : {}) as { order?: unknown; hidden?: unknown }
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
  return { order, hidden: entries(saved.hidden) }
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
