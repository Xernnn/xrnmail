import { describe, expect, it } from 'vitest'
import { chosen, keepUnknown, merge, type Json, type JsonObject } from '@main/shared-state'

/** Three-way merges of the document shared with the phone (docs/design.md, "Shared with the phone"),
 *  the same cases the phone's own merge is held to, so the two settle on the same copy. */

const json = (text: string): JsonObject => JSON.parse(text) as JsonObject
const doc = (settings = '{}', threads = '{}', early?: string): JsonObject =>
  json(`{"schema": 1, "settings": ${settings}, "threads": ${threads}${early ? `, "early": ${early}` : ''}}`)
const settingsOf = (merged: JsonObject): JsonObject => merged['settings'] as JsonObject

describe('merging the shared settings', () => {
  it('takes the side that changed a field, and the local side when both did', () => {
    const base = doc('{"undoSeconds": 10, "faces": true}')
    expect(settingsOf(merge(base, doc('{"undoSeconds": 20, "faces": true}'), doc('{"undoSeconds": 10, "faces": false}')))).toEqual({ undoSeconds: 20, faces: false })
    expect(settingsOf(merge(doc('{"undoSeconds": 10}'), doc('{"undoSeconds": 20}'), doc('{"undoSeconds": 30}')))).toEqual({ undoSeconds: 20 })
  })

  it('merges lists of addresses as sets, so an add and a removal on two devices both stand', () => {
    const base = doc('{"blocked": ["a@x.example", "b@x.example"], "batch": {"live": true, "vip": ["@boss.example"]}}')
    const local = doc('{"blocked": ["a@x.example", "b@x.example", "c@x.example"], "batch": {"live": true, "vip": []}}')
    const remote = doc('{"blocked": ["b@x.example"], "batch": {"live": false, "vip": ["@boss.example", "kim@x.example"]}}')
    const merged = settingsOf(merge(base, local, remote))
    expect(merged['blocked']).toEqual(['b@x.example', 'c@x.example'])
    expect(merged['batch']).toEqual({ live: false, vip: ['kim@x.example'] })
    expect(settingsOf(merge(doc('{"muted": []}'), doc('{"muted": ["Ada@X.example"]}'), doc('{"muted": ["ada@x.example"]}')))['muted']).toHaveLength(1)
  })

  it('merges identities by account, their aliases as sets', () => {
    const base = doc('{"identities": {"alex@example.com": {"name": "Alex", "aliases": ["a@example.com"], "color": "#111111"}}}')
    const local = doc('{"identities": {"alex@example.com": {"name": "Alex K", "aliases": ["a@example.com", "b@example.com"], "color": "#111111"}}}')
    const remote = doc('{"identities": {"alex@example.com": {"name": "Alex", "aliases": [], "color": "#222222"}, "kim@example.org": {"name": "Kim"}}}')
    expect(settingsOf(merge(base, local, remote))['identities']).toEqual({
      'alex@example.com': { name: 'Alex K', aliases: ['b@example.com'], color: '#222222' },
      'kim@example.org': { name: 'Kim' }
    })
  })

  // The phone makes up an identity for each account it adds: no name, no aliases, a colour of its
  // own. Merged as any other change, the laptop's first sync gave every account a blank From name
  // and dropped its aliases, so replies from an alias went out from the account.
  it('never lets an identity a device made up wipe one the person filled in', () => {
    const filled = '{"name": "Alex", "aliases": ["a@example.com"], "color": "#111111"}'
    const madeUp = '{"name": "", "aliases": [], "color": "#3B82F6"}'
    const ids = (who: string | null): JsonObject => doc(who === null ? '{}' : `{"identities": {"alex@example.com": ${who}}}`)
    const want = json(`{"alex@example.com": ${filled}}`)
    expect(settingsOf(merge(ids(filled), ids(madeUp), ids(filled)))['identities']).toEqual(want)
    expect(settingsOf(merge(null, ids(madeUp), ids(filled)))['identities']).toEqual(want)
    expect(settingsOf(merge(ids(null), ids(filled), ids(madeUp)))['identities']).toEqual(want)
    // A named identity whose last alias is taken out on purpose loses it, as any change.
    const named = '{"name": "Alex", "aliases": [], "color": "#111111"}'
    expect(settingsOf(merge(ids(filled), ids(named), ids(filled)))['identities']).toEqual(json(`{"alex@example.com": ${named}}`))
  })

  it('merges signatures by id and templates by name', () => {
    const base = doc('{"signatures": [{"id": "s1", "name": "Work", "html": "A", "text": "A"}], "templates": [{"name": "Thanks", "text": "Thanks!"}]}')
    const local = doc('{"signatures": [{"id": "s1", "name": "Work", "html": "B", "text": "B"}, {"id": "s2", "name": "Home", "html": "H", "text": "H"}], "templates": []}')
    const remote = doc('{"signatures": [{"id": "s1", "name": "Work", "html": "A", "text": "A"}, {"id": "s3", "name": "Uni", "html": "U", "text": "U"}], "templates": [{"name": "Thanks", "text": "Thanks!"}, {"name": "Later", "text": "Later"}]}')
    const merged = settingsOf(merge(base, local, remote))
    expect(merged['signatures']).toEqual([
      { id: 's1', name: 'Work', html: 'B', text: 'B' }, { id: 's2', name: 'Home', html: 'H', text: 'H' }, { id: 's3', name: 'Uni', html: 'U', text: 'U' }
    ])
    // Thanks was taken out here and left alone there: gone. Later was added there: kept.
    expect(merged['templates']).toEqual([{ name: 'Later', text: 'Later' }])
  })

  it('keeps what it has no name for as it came, and merges with no base as if everything were new', () => {
    const base = doc('{"faces": true}')
    const merged = merge(base, base, json('{"schema": 1, "settings": {"faces": true, "somethingNewer": {"x": 1}}, "threads": {}, "elsewhere": [1, 2]}'))
    expect(settingsOf(merged)['somethingNewer']).toEqual({ x: 1 })
    expect(merged['elsewhere']).toEqual([1, 2])
    expect(settingsOf(merge(null, doc('{"blocked": ["a@x.example"]}'), doc('{"blocked": ["b@x.example"]}')))['blocked']).toEqual(['a@x.example', 'b@x.example'])
  })

  it('reads a key named after something every object has as a key, not as what it inherits', () => {
    const merged = settingsOf(merge(doc('{}'), doc('{"constructor": 1}'), doc('{"__proto__": {"polluted": true}}')))
    expect(Object.keys(merged).sort()).toEqual(['__proto__', 'constructor'])
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })
})

describe("merging a thread's entry", () => {
  const key = 'alex@example.com\n1790000000000000001'
  const threads = (entry: string): JsonObject => doc('{}', `{${JSON.stringify(key)}: ${entry}}`)
  const threadsOf = (merged: JsonObject): Json => merged['threads'] ?? null

  it('merges its snooze, reminder and pin each on its own, and changed on both sides the newer at wins', () => {
    const base = threads('{"snooze": {"until": 100, "at": 10}}')
    const local = threads('{"snooze": {"until": 200, "at": 20}}')
    expect(threadsOf(merge(base, local, threads('{"snooze": {"until": 300, "at": 30}, "pin": 25}')))).toEqual({ [key]: { snooze: { until: 300, at: 30 }, pin: 25 } })
    // The local side on a tie.
    expect(threadsOf(merge(base, local, threads('{"snooze": {"until": 400, "at": 20}}')))).toEqual({ [key]: { snooze: { until: 200, at: 20 } } })
  })

  // Merged as one value, the entry with the newer time won whole: a thread snoozed on the phone and
  // pinned here a moment later lost its snooze, and came back into the phone's inbox.
  it('keeps a snooze set on one device when the thread is pinned on the other', () => {
    const phone = threads('{"snooze": {"until": 900, "at": 40}}')
    const laptop = threads('{"pin": 50, "reminder": {"until": 700, "at": 45, "fired": false}}')
    const want = { [key]: { snooze: { until: 900, at: 40 }, pin: 50, reminder: { until: 700, at: 45, fired: false } } }
    expect(threadsOf(merge(doc(), phone, laptop))).toEqual(want)
    expect(threadsOf(merge(null, laptop, phone))).toEqual(want)
    // A snooze ended on one side (the thread archived there) and set again on the other: set.
    const agreed = threads('{"snooze": {"until": 900, "at": 40}, "pin": 50}')
    const archived = threads('{"pin": 50}')
    expect(threadsOf(merge(agreed, archived, threads('{"snooze": {"until": 1200, "at": 60}, "pin": 50}')))).toEqual({ [key]: { snooze: { until: 1200, at: 60 }, pin: 50 } })
    // Ended there and left alone here: ended, and the pin stays.
    expect(threadsOf(merge(agreed, agreed, archived))).toEqual({ [key]: { pin: 50 } })
  })

  it('ends one ended on one device and left alone on the other, and drops an entry with nothing left in it', () => {
    const base = threads('{"snooze": {"until": 100, "at": 10}}')
    expect(threadsOf(merge(base, doc(), base))).toEqual({})
    expect(threadsOf(merge(base, threads('{}'), base))).toEqual({})
  })
})

describe("merging the day's Deliver now", () => {
  it('is one count on the same day, however either device writes it, and the newer day otherwise', () => {
    const same = merge(
      doc('{}', '{}', '{"day": "2026-11-6", "used": 0, "releases": []}'),
      doc('{}', '{}', '{"day": "2026-11-6", "used": 1, "releases": [1000]}'),
      doc('{}', '{}', '{"day": "2026-11-06", "used": 1, "releases": [2000]}')
    )
    expect(same['early']).toEqual({ day: '2026-11-6', used: 1, releases: [1000, 2000] })
    expect(merge(null, doc('{}', '{}', '{"day": "2026-11-6", "used": 1}'), doc('{}', '{}', '{"day": "2026-11-10", "used": 0}'))['early']).toEqual({ day: '2026-11-10', used: 0 })
  })
})

describe('a first merge', () => {
  const first = json('{"undoSeconds": 10, "faces": true, "identities": {}}')

  it('keeps only what was chosen here, and the identities the person filled in', () => {
    const part = json(`{"undoSeconds": 10, "faces": false, "identities": {
      "alex@example.com": {"name": "Alex", "aliases": [], "color": "#111111"},
      "kim@example.org": {"name": "", "aliases": [], "color": "#222222"}}}`)
    expect(chosen(part, first)).toEqual({ faces: false, identities: { 'alex@example.com': { name: 'Alex', aliases: [], color: '#111111' } } })
    expect(chosen(json('{"undoSeconds": 10, "identities": {"kim@example.org": {"name": " ", "aliases": []}}}'), first)).toEqual({})
  })
})

describe('what this version has no name for', () => {
  it('goes back as it came, in the settings and inside what it knows', () => {
    const shared = json(`{"faces": true, "newer": 1, "batch": {"live": true, "pace": "fast"}, "later": {"today": 1, "dusk": 2},
      "identities": {"alex@example.com": {"name": "Alex", "aliases": [], "color": "#111111", "photo": "p"}, "gone@example.com": {"name": "Gone"}},
      "signatures": [{"id": "s1", "name": "Work", "html": "A", "text": "A", "font": "serif"}],
      "templates": [{"name": "Thanks", "text": "Thanks!", "tags": ["x"]}]}`)
    const mine = json(`{"faces": false, "batch": {"live": false}, "later": {"today": 3},
      "identities": {"alex@example.com": {"name": "Alex K", "aliases": [], "color": "#111111"}},
      "signatures": [{"id": "s1", "name": "Work", "html": "B", "text": "B"}],
      "templates": [{"name": "Thanks", "text": "Ta"}]}`)
    expect(keepUnknown(mine, shared)).toEqual(json(`{"faces": false, "batch": {"live": false, "pace": "fast"}, "later": {"today": 3, "dusk": 2},
      "identities": {"alex@example.com": {"name": "Alex K", "aliases": [], "color": "#111111", "photo": "p"}},
      "signatures": [{"id": "s1", "name": "Work", "html": "B", "text": "B", "font": "serif"}],
      "templates": [{"name": "Thanks", "text": "Ta", "tags": ["x"]}], "newer": 1}`))
  })
})
