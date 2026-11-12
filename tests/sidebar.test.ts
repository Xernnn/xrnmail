import { describe, expect, it } from 'vitest'
import { arranged, cleanSidebar, moved, SIDEBAR_ASSISTANT, SIDEBAR_FOLDERS } from '@shared/sidebar'

describe('the sidebar\'s own order', () => {
  it('starts as Edison has it, with everything shown', () => {
    const start = cleanSidebar(undefined)
    expect(arranged(SIDEBAR_FOLDERS, start)).toEqual(['today', 'unread', 'starred', 'pinned', 'snoozed', 'attachments', 'drafts', 'spam', 'trash', 'archive', 'sent', 'recent'])
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
    expect(arranged(SIDEBAR_FOLDERS, cleanSidebar(old))).toEqual(['today', 'unread', 'snoozed', 'attachments', 'drafts', 'spam', 'trash', 'archive', 'sent', 'recent', 'starred', 'pinned'])
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
    expect(arranged(SIDEBAR_FOLDERS, moved(start, 'recent', 'pinned')).slice(3, 6)).toEqual(['recent', 'pinned', 'snoozed'])
    expect(arranged(SIDEBAR_FOLDERS, moved(start, 'today', 'starred')).slice(0, 4)).toEqual(['unread', 'starred', 'today', 'pinned']) // down: past it
    expect(arranged(SIDEBAR_ASSISTANT, moved(start, 'events', 'subscriptions'))).toEqual(['events', 'subscriptions', 'travel', 'packages', 'money'])
    expect(moved(start, 'events', 'today')).toEqual(start) // not into the other list
    expect(moved(start, 'today', 'today')).toEqual(start)
  })
})
