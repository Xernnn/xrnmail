import { describe, expect, it } from 'vitest'
import { soloFrom, soloKey, soloQuery, type Solo } from '@shared/solo'

const search = (solo: Solo): string => `?${new URLSearchParams(soloQuery(solo))}`

describe('a window of its own', () => {
  it('is told what it holds in its address, and reads the same back', () => {
    const thread: Solo = { kind: 'thread', account: 'me+tag@example.com', thread: '18f&a=b', bins: false }
    expect(soloFrom(search(thread))).toEqual(thread)
    expect(soloFrom(search({ ...thread, bins: true }))).toEqual({ ...thread, bins: true })
    expect(soloFrom(search({ kind: 'draft', id: 12 }))).toEqual({ kind: 'draft', id: 12 })
  })

  it('is the main window when the address says nothing whole', () => {
    for (const address of ['', '?', '?solo=thread', '?solo=thread&account=me@example.com', '?solo=thread&thread=1', '?solo=draft', '?solo=draft&draft=x',
      '?solo=draft&draft=0', '?solo=draft&draft=-3', '?solo=draft&draft=1.5', '?solo=settings', '?account=me@example.com&thread=1']) {
      expect(soloFrom(address), address).toBeNull()
    }
  })

  it('has one key a thread or a draft, so a second asking finds the first window', () => {
    expect(soloKey({ kind: 'thread', account: 'a@example.com', thread: '1', bins: false })).toBe(soloKey({ kind: 'thread', account: 'a@example.com', thread: '1', bins: true }))
    expect(soloKey({ kind: 'thread', account: 'a@example.com', thread: '1', bins: false })).not.toBe(soloKey({ kind: 'thread', account: 'b@example.com', thread: '1', bins: false }))
    expect(soloKey({ kind: 'draft', id: 1 })).not.toBe(soloKey({ kind: 'draft', id: 11 }))
  })
})
