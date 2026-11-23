import { describe, expect, it } from 'vitest'
import { arranged, arrangedLabels, cleanLabels, cleanSidebar, movedLabel, moved, shownLabel, siblingsOf, SIDEBAR_ASSISTANT, SIDEBAR_FOLDERS } from '@shared/sidebar'

describe('the sidebar\'s own order', () => {
  it('starts as Edison has it, with everything shown', () => {
    const start = cleanSidebar(undefined)
    expect(arranged(SIDEBAR_FOLDERS, start)).toEqual(['today', 'unread', 'starred', 'pinned', 'summary', 'snoozed', 'reminders', 'attachments', 'drafts', 'spam', 'trash', 'archive', 'sent', 'recent'])
    expect(arranged(SIDEBAR_ASSISTANT, start)).toEqual(['subscriptions', 'travel', 'packages', 'money', 'events'])
    expect(start.hidden).toEqual([])
  })

  it('keeps a chosen order and what was hidden', () => {
    const choice = cleanSidebar({ order: ['sent', 'today', 'events', 'subscriptions'], hidden: ['spam', 'travel'] })
    expect(arranged(SIDEBAR_FOLDERS, choice).slice(0, 4)).toEqual(['sent', 'recent', 'today', 'unread']) // Recently Seen follows Sent, as it starts out
    expect(arranged(SIDEBAR_ASSISTANT, choice)).toEqual(['events', 'subscriptions', 'travel', 'packages', 'money'])
    expect(choice.hidden).toEqual(['spam', 'travel'])
    expect(cleanSidebar(choice)).toEqual(choice) // made whole once is whole
  })

  it('puts an entry a saved choice has never heard of after the one it follows, and shows it', () => {
    // As saved before Pinned existed, with Flagged moved to the end.
    const old = { order: ['today', 'unread', 'snoozed', 'attachments', 'drafts', 'spam', 'trash', 'archive', 'sent', 'starred'], hidden: ['today'] }
    // Reminders, newer still, goes after Snoozed.
    expect(arranged(SIDEBAR_FOLDERS, cleanSidebar(old))).toEqual(['today', 'unread', 'snoozed', 'reminders', 'attachments', 'drafts', 'spam', 'trash', 'archive', 'sent', 'recent', 'starred', 'pinned', 'summary'])
    expect(cleanSidebar(old).hidden).toEqual(['today'])
    expect(arranged(SIDEBAR_FOLDERS, cleanSidebar({ order: ['unread'] })).slice(0, 2)).toEqual(['today', 'unread'])
  })

  it('throws out what isn\'t an entry, and repeats', () => {
    expect(cleanSidebar({ order: ['sent', 'sent', 'nonsense', 7, null], hidden: ['spam', 'spam', '__proto__', {}] }).hidden).toEqual(['spam'])
    expect(cleanSidebar({ order: 'sent', hidden: 'spam' })).toEqual(cleanSidebar(null))
    expect(cleanSidebar('x')).toEqual(cleanSidebar(null))
    expect(new Set(cleanSidebar({ order: ['sent', 'sent'] }).order).size).toBe(SIDEBAR_FOLDERS.length + SIDEBAR_ASSISTANT.length)
  })

  it('moves an entry to where another is, within its own list', () => {
    const start = cleanSidebar(null)
    expect(arranged(SIDEBAR_FOLDERS, moved(start, 'sent', 'today')).slice(0, 3)).toEqual(['sent', 'today', 'unread']) // up: it takes the place, the rest go down
    expect(arranged(SIDEBAR_FOLDERS, moved(start, 'recent', 'pinned')).slice(3, 6)).toEqual(['recent', 'pinned', 'summary'])
    expect(arranged(SIDEBAR_FOLDERS, moved(start, 'today', 'starred')).slice(0, 4)).toEqual(['unread', 'starred', 'today', 'pinned']) // down: past it
    expect(arranged(SIDEBAR_ASSISTANT, moved(start, 'events', 'subscriptions'))).toEqual(['events', 'subscriptions', 'travel', 'packages', 'money'])
    expect(moved(start, 'events', 'today')).toEqual(start) // not into the other list
    expect(moved(start, 'today', 'today')).toEqual(start)
  })
})

describe('an account\'s own labels in the sidebar', () => {
  const NAMES = ['Work', 'Receipts', 'Work/Plans', 'Work/Archive', 'Projects/Garden', 'Travel']
  const rows = (choice?: Parameters<typeof arrangedLabels>[1]): [string, string, number, boolean][] =>
    arrangedLabels(NAMES, choice).map((row) => [row.path, row.name, row.depth, row.hidden])

  it('start by name, each followed by what is inside it', () => {
    expect(rows()).toEqual([
      ['Projects/Garden', 'Projects/Garden', 0, false], // what it's inside isn't a label, so it's named whole
      ['Receipts', 'Receipts', 0, false],
      ['Travel', 'Travel', 0, false],
      ['Work', 'Work', 0, false],
      ['Work/Archive', 'Archive', 1, false],
      ['Work/Plans', 'Plans', 1, false]
    ])
  })

  it('move among their own siblings, carrying what is inside them, and never into another label', () => {
    const choice = movedLabel(NAMES, undefined, 'Work', 'Projects/Garden')
    expect(rows(choice).map(([path]) => path)).toEqual(['Work', 'Work/Archive', 'Work/Plans', 'Projects/Garden', 'Receipts', 'Travel'])
    const inside = movedLabel(NAMES, choice, 'Work/Plans', 'Work/Archive')
    expect(rows(inside).map(([path]) => path)).toEqual(['Work', 'Work/Plans', 'Work/Archive', 'Projects/Garden', 'Receipts', 'Travel'])
    expect(movedLabel(NAMES, inside, 'Work/Plans', 'Travel')).toEqual(inside)
    expect(siblingsOf(NAMES, inside, 'Work/Archive')).toEqual(['Work/Plans', 'Work/Archive'])
  })

  it('hide one and what is inside it, keep a new one at the end, and forget one that has gone', () => {
    const hidden = shownLabel(movedLabel(NAMES, undefined, 'Travel', 'Projects/Garden'), 'Work', false)
    expect(rows(hidden).filter(([, , , gone]) => gone).map(([path]) => path)).toEqual(['Work', 'Work/Archive', 'Work/Plans'])
    expect(arrangedLabels(NAMES, hidden).find((row) => row.path === 'Work/Plans')?.shown).toBe(true) // its own switch is still on
    expect(arrangedLabels([...NAMES, 'Bills'], hidden).map((row) => row.path).slice(0, 3)).toEqual(['Travel', 'Projects/Garden', 'Receipts'])
    expect(arrangedLabels([...NAMES, 'Bills'], hidden).map((row) => row.path)).toContain('Bills')
    expect(arrangedLabels(['Receipts'], hidden).map((row) => row.path)).toEqual(['Receipts'])
    expect(shownLabel(hidden, 'Work', true).hidden).toEqual([])
  })

  it('keep each account\'s choice through cleaning, and throw out what is not one', () => {
    const choice = { order: ['Work', 'Work', 7], hidden: ['Travel', ''] }
    expect(cleanLabels({ 'me@example.com': choice, nobody: choice, 'x@y.z': 'nonsense' })).toEqual({
      'me@example.com': { order: ['Work'], hidden: ['Travel'] }, 'x@y.z': { order: [], hidden: [] }
    })
    expect(cleanSidebar({ labels: { 'me@example.com': choice } }).labels).toEqual({ 'me@example.com': { order: ['Work'], hidden: ['Travel'] } })
    expect(cleanSidebar(null).labels).toEqual({})
  })
})
