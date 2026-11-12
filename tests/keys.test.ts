import { describe, expect, it } from 'vitest'
import { cleanAllChanges, cleanChanges, holder, KEY_SETS, keyList, KEYS, keyName, keysFor, keysOf, rebound, RESERVED, reset, spell, unbindable } from '../src/shared/keys'

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

  it('lists for reading every key a set answers to, and what no set can change', () => {
    for (const [set] of KEY_SETS) {
      const listed = keyList(set).flatMap(([keys]) => keys.split(', '))
      for (const name of Object.keys(KEYS[set])) expect(listed, `${set}: ${name}`).toContain(spell(name))
      expect(listed).toEqual(expect.arrayContaining(['Ctrl+N', 'Ctrl+Enter', 'F5']))
    }
    expect(keyList('edison').find(([, what]) => what === 'Remove from view')?.[0]).toBe('Backspace, Del')
    expect(keyList('gmail').find(([, what]) => what === 'Remove from view')).toBeUndefined()
  })

  const press = (set: Parameters<typeof keysFor>[0], name: string): string | undefined => keysFor(set)[name]

  it('has Apple Mail\'s published keys, Command read as Ctrl and Control with it as Alt', () => {
    expect(['Ctrl+R', 'Ctrl+Shift+R', 'Ctrl+Shift+F', 'Ctrl+Alt+A', 'Ctrl+Shift+J', 'Ctrl+Shift+U', 'Ctrl+Shift+N', 'Ctrl+Z'].map((k) => press('apple', k)))
      .toEqual(['reply', 'replyAll', 'forward', 'archive', 'spam', 'toggleRead', 'sync', 'undo'])
    expect(['Backspace', 'Ctrl+Shift+L', 'Ctrl+Alt+F'].map((k) => press('apple', k))).toEqual(['trash', 'flag', 'search']) // from Mail's menus
    expect(Object.keys(KEYS.apple).filter((k) => /^[a-z#!/]$/.test(k))).toEqual([]) // Mail has no single-letter keys
  })

  it('has Outlook for Mac\'s published keys, Control on its own staying Ctrl', () => {
    expect(['Ctrl+R', 'Ctrl+Shift+R', 'Ctrl+J', 'Ctrl+Shift+M', 'Ctrl+Shift+J', 'Backspace', 'Delete', 'Ctrl+E', 'Ctrl+T', 'Ctrl+Shift+T'].map((k) => press('outlook', k)))
      .toEqual(['reply', 'replyAll', 'forward', 'labels', 'spam', 'trash', 'trash', 'archive', 'read', 'unread'])
    expect(['Ctrl+[', 'Ctrl+]', 'Ctrl+1', 'Ctrl+5', 'Ctrl+Alt+F', 'Ctrl+Alt+K'].map((k) => press('outlook', k))).toEqual(['previous', 'next', 'flag', 'flag', 'search', 'sync'])
    expect(keyName({ key: '[', ctrlKey: true })).toBe('Ctrl+[')
  })

  it('has Inbox\'s keys: Done archives, s snoozes, Shift+P pins, and there are no flags', () => {
    expect(['e', 'y', '[', ']', 's', 'P', 'u', '#', 'c', 'r', 'a', 'f', 'z', '/'].map((k) => press('inbox', k)))
      .toEqual(['archive', 'archive', 'archive', 'archive', 'snooze', 'pin', 'close', 'trash', 'compose', 'reply', 'replyAll', 'forward', 'undo', 'search'])
    expect(Object.values(KEYS.inbox)).not.toContain('flag')
  })

  it('leaves the menu\'s keys to the menu in every set, and finds keys by the arrows, Esc and ? in every set', () => {
    for (const [set] of KEY_SETS) {
      expect(Object.keys(KEYS[set]).filter((k) => k in RESERVED), set).toEqual([])
      expect([press(set, 'ArrowDown'), press(set, 'ArrowUp'), press(set, 'Escape'), press(set, '?')]).toEqual(['next', 'previous', 'close', 'help'])
    }
  })
})

describe('keys of your own choosing', () => {
  it('puts a chosen key in place of the set\'s own for that action', () => {
    const changes = rebound({}, 'archive', 'Ctrl+Shift+E')
    expect(keysOf('edison', changes, 'archive')).toEqual(['Ctrl+Shift+E'])
    expect(keysFor('edison', changes)['e']).toBeUndefined() // e and Ctrl+Alt+A were archive's
    expect(keysFor('edison', changes)['Ctrl+Shift+E']).toBe('archive')
    expect(keysFor('edison')['e']).toBe('archive') // the set itself is as it was
  })

  it('says which action has a key, and takes it from it when told to', () => {
    expect(holder('edison', {}, 'Ctrl+R', 'archive')).toBe('reply')
    expect(holder('edison', {}, 'Ctrl+R', 'reply')).toBeNull()
    const taken = rebound({}, 'archive', 'Ctrl+R')
    expect(keysOf('edison', taken, 'reply')).toEqual(['r']) // keeps the key it had besides
    expect(keysFor('edison', taken)['Ctrl+R']).toBe('archive')
    const again = rebound(rebound({}, 'flag', 'g'), 'pin', 'g') // a key moved from one change to another
    expect(again).toEqual({ pin: 'g' })
    expect(keysOf('edison', again, 'flag')).toEqual(['s', 'Ctrl+S'])
  })

  it('can leave an action with no key, and reset one or all', () => {
    const none = rebound({}, 'spam', '')
    expect(keysOf('gmail', none, 'spam')).toEqual([])
    expect(keyList('gmail', none).some(([, what]) => what === 'Report spam')).toBe(false)
    expect(reset(rebound(none, 'flag', 'g'), 'spam')).toEqual({ flag: 'g' })
    expect(keysOf('gmail', reset(none, 'spam'), 'spam')).toEqual(['!'])
  })

  it('cleans what was saved: known actions, keys the menu doesn\'t have, each key once', () => {
    expect(cleanChanges({ archive: 'g', nonsense: 'q', flag: 7, reply: 'Ctrl+N', pin: 'g', spam: '' })).toEqual({ spam: '', pin: 'g' })
    expect(cleanChanges('x')).toEqual({})
    expect(cleanChanges({ archive: 'x'.repeat(41) })).toEqual({})
    expect(cleanAllChanges({ edison: { archive: 'g' }, gmail: {}, nowhere: { archive: 'g' }, apple: 'x' })).toEqual({ edison: { archive: 'g' } })
  })

  it('takes only a whole press that isn\'t the menu\'s', () => {
    expect(unbindable(keyName({ key: 'Shift', shiftKey: true }), 'Shift')).toBe('Hold it with another key.')
    expect(unbindable('Ctrl+N', 'n')).toBe('Ctrl+N is for New Message in the menu.')
    expect(unbindable('Tab', 'Tab')).toBe('Tab is for moving the focus.')
    expect(unbindable('Ctrl+Shift+E', 'E')).toBeNull()
  })
})
