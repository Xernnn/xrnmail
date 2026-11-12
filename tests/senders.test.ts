import { describe, expect, it } from 'vitest'
import { openRate, sortSenders } from '@shared/senders'
import type { Subscription } from '@shared/types'

const sender = (name: string, count: number, read: number, latest = 0): Subscription =>
  ({ account: 'me@example.com', name, address: `${name.toLowerCase()}@x.example`, count, read, latest, message: 1, week: 0 })

describe('Subscriptions', () => {
  it('says how much of a sender is read, as Edison\'s open rate', () => {
    expect(openRate(sender('A', 3, 1))).toBe(33)
    expect(openRate(sender('A', 0, 0))).toBe(0) // nothing left here
  })

  it('sorts by how much they send, by open rate, or by name', () => {
    const items = [sender('Bee', 2, 2, 5), sender('ant', 9, 0), sender('Cat', 2, 1, 7)]
    expect(sortSenders(items, 'most').map((s) => s.name)).toEqual(['ant', 'Cat', 'Bee'])
    expect(sortSenders(items, 'read').map((s) => s.name)).toEqual(['Bee', 'Cat', 'ant'])
    expect(sortSenders(items, 'name').map((s) => s.name)).toEqual(['ant', 'Bee', 'Cat'])
    expect(items.map((s) => s.name)).toEqual(['Bee', 'ant', 'Cat']) // left as it was
  })
})
