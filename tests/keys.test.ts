import { describe, expect, it } from 'vitest'
import { KEY_LISTS, KEYS, keyName } from '../src/shared/keys'

describe('keys', () => {
  it('names a press the way the tables do', () => {
    expect(keyName({ key: 'e' })).toBe('e')
    expect(keyName({ key: 'U', shiftKey: true })).toBe('U')
    expect(keyName({ key: '_', shiftKey: true })).toBe('_')
    expect(keyName({ key: 'Backspace', shiftKey: true })).toBe('Shift+Backspace')
    expect(keyName({ key: 'r', ctrlKey: true })).toBe('Ctrl+R')
    expect(keyName({ key: 'R', ctrlKey: true, shiftKey: true })).toBe('Ctrl+Shift+R')
    expect(keyName({ key: 'a', metaKey: true, altKey: true })).toBe('Ctrl+Alt+A')
    expect(keyName({ key: 'Delete' })).toBe('Delete')
  })

  it('has Edison Mail\'s own keys in the Edison set', () => {
    const edison = (press: Parameters<typeof keyName>[0]): string | undefined => KEYS.edison[keyName(press)]
    expect([edison({ key: 'c' }), edison({ key: 'd' })]).toEqual(['compose', 'compose'])
    expect(edison({ key: '/' })).toBe('search')
    expect([edison({ key: 'r' }), edison({ key: 'r', ctrlKey: true })]).toEqual(['reply', 'reply'])
    expect([edison({ key: 'a' }), edison({ key: 'R', ctrlKey: true, shiftKey: true })]).toEqual(['replyAll', 'replyAll'])
    expect([edison({ key: 'f' }), edison({ key: 'F', ctrlKey: true, shiftKey: true })]).toEqual(['forward', 'forward'])
    expect(edison({ key: 'a', ctrlKey: true, altKey: true })).toBe('archive')
    expect(edison({ key: 'Backspace', shiftKey: true })).toBe('trash')
    expect([edison({ key: 'Backspace' }), edison({ key: 'Delete' })]).toEqual(['removeFromView', 'removeFromView'])
    expect(edison({ key: 's', ctrlKey: true })).toBe('flag')
    expect([edison({ key: 'l' }), edison({ key: 'M', ctrlKey: true, shiftKey: true })]).toEqual(['labels', 'labels'])
    expect(edison({ key: 'I', shiftKey: true })).toBe('read')
    expect([edison({ key: 'U', ctrlKey: true, shiftKey: true }), edison({ key: '_', shiftKey: true })]).toEqual(['unread', 'unread'])
  })

  it('keeps the keys xrnmail had in both sets, and Delete deleting in the Gmail one', () => {
    for (const set of ['edison', 'gmail'] as const) {
      expect(KEYS[set]).toMatchObject({ e: 'archive', '#': 'trash', '!': 'spam', s: 'flag', U: 'unread', b: 'snooze', x: 'select', z: 'undo', j: 'next', k: 'previous', '?': 'help', 'Ctrl+A': 'selectAll' })
    }
    expect(KEYS.gmail['Delete']).toBe('trash')
    expect(KEYS.gmail['Backspace']).toBeUndefined()
    expect(KEYS.gmail['d']).toBeUndefined()
  })

  it('lists for reading every key a set answers to', () => {
    const spelt = (name: string): string => name.replace(/^Arrow(Down|Up)$/, '').replace('Escape', 'Esc').replace('Delete', 'Del')
      .replace(/^([A-Z_])$/, (_, letter: string) => (letter === '_' ? '_' : `Shift+${letter}`))
    for (const set of ['edison', 'gmail'] as const) {
      const listed = new Set(KEY_LISTS[set].flatMap(([keys]) => keys.split(/, | \/ /)))
      for (const name of Object.keys(KEYS[set]).map(spelt).filter(Boolean)) expect(listed, `${set}: ${name}`).toContain(name)
    }
  })
})
