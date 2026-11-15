import type { Subscription } from './types'

/** How Subscriptions are shown, apart from the page so it can be tested without one. */

/** Edison's open rate: how much of what a sender sent has been read, here or anywhere else. */
export const openRate = (item: Pick<Subscription, 'count' | 'read'>): number => (item.count > 0 ? Math.round((item.read / item.count) * 100) : 0)

/** Edison's orders for Subscriptions: by how much they send, by open rate, or by name. */
export type SenderOrder = 'most' | 'read' | 'name'

export function sortSenders(items: Subscription[], order: SenderOrder): Subscription[] {
  const name = (item: Subscription): string => (item.name || item.address).toLowerCase()
  const by: Record<SenderOrder, (a: Subscription, b: Subscription) => number> = {
    most: (a, b) => b.count - a.count || b.latest - a.latest,
    read: (a, b) => openRate(b) - openRate(a) || b.count - a.count,
    name: (a, b) => name(a).localeCompare(name(b))
  }
  return items.slice().sort(by[order])
}
