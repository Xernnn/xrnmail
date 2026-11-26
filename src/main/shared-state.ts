/**
 * The document the laptop and the phone share through xrnmail-sync (docs/design.md, "Shared with
 * the phone"), schema 1:
 *
 *     {"schema": 1, "settings": {…}, "threads": {"<account>\n<thread>": {…}}, "early": {"day", "used", "releases"}}
 *
 * It's handled as JSON, so a field this version doesn't know is kept as it came and an older device
 * never drops what a newer one wrote. The merge is the phone's own (xrnmail-android, `SharedState`),
 * rule for rule, so the two devices settle on the same copy whichever merges first.
 */

export type Json = null | boolean | number | string | Json[] | JsonObject
export interface JsonObject {
  [key: string]: Json
}

export const SCHEMA = 1

/** The fields of `settings` that are shared. Everything else in the settings is the device's own. */
export const SHARED_FIELDS = [
  'batch', 'summary', 'identities', 'signatures', 'signatureFor', 'templates', 'blocked', 'muted', 'unsubscribed',
  'imagesFrom', 'undoSeconds', 'undoActionSeconds', 'defaultReply', 'quoteReplies', 'darkMail', 'images', 'readAfter',
  'threadOrder', 'afterRemove', 'later', 'swipes', 'swipeLeft', 'swipeLeftLong', 'swipeRight', 'swipeRightLong',
  'clock24', 'faces'
] as const
export type SharedField = (typeof SHARED_FIELDS)[number]

/** What of an identity is shared: its notices and old plain signature are the device's own. */
export const IDENTITY_FIELDS = ['name', 'aliases', 'color'] as const

/** Fields of `settings` that are lists of addresses or @domains, merged as sets. */
const ADDRESS_LISTS = new Set(['blocked', 'muted', 'unsubscribed', 'imagesFrom'])

export const isObject = (value: Json | undefined): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value)

/** A key's value, if the object has it as its own: a name a stranger chose, `__proto__` or
 *  `constructor`, is never read off the prototype. */
export const get = (o: JsonObject | null | undefined, key: string): Json | undefined => (o && Object.hasOwn(o, key) ? o[key] : undefined)

const objectOr = (value: Json | undefined): JsonObject | undefined => (isObject(value) ? value : undefined)

/** Whether two values are the same JSON, whatever order an object's keys come in. */
export function same(a: Json | undefined, b: Json | undefined): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined || a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((item, i) => same(item, b[i]))
  if (Array.isArray(b)) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && same(a[key], b[key]))
}

/** Every key of the objects, in the order met. */
function keys(...objects: (JsonObject | undefined)[]): string[] {
  const out = new Set<string>()
  for (const o of objects) if (o) for (const key of Object.keys(o)) out.add(key)
  return [...out]
}

/** An object built from what's kept, `undefined` meaning gone. Built as own properties, so a key
 *  named `__proto__` stays a key. */
function objectOf(entries: [string, Json | undefined][]): JsonObject {
  return Object.fromEntries(entries.filter((entry): entry is [string, Json] => entry[1] !== undefined))
}

const integer = (value: Json | undefined): number | null => (typeof value === 'number' && Number.isInteger(value) ? value : null)

/** One value, three ways: the side that changed it, or the local side when both did. `undefined` is
 *  "not there", so a field taken out on one side and left alone on the other goes. */
export function pick(base: Json | undefined, local: Json | undefined, remote: Json | undefined): Json | undefined {
  if (same(local, remote)) return local
  if (same(local, base)) return remote
  if (same(remote, base)) return local
  return local
}

/**
 * Three-way merge of [local] and [remote] against [base], the document as this device last merged
 * it. Field by field: a field changed on one side takes that side's value, and changed on both,
 * [local] wins. Lists of addresses merge as sets, so an address added on one device and another
 * taken out on the other both stand; signatures merge by `id` and templates by `name`. An identity
 * a device made up (no name, no aliases) never beats one with either filled in. A thread's snooze,
 * reminder and pin merge each on its own: changed on both sides, the newer `at` wins. The day's
 * Deliver now: the same day is the most used and every release, another day is the newer day.
 */
export function merge(base: JsonObject | null, local: JsonObject, remote: JsonObject): JsonObject {
  const b = base ?? {}
  return objectOf(keys(b, local, remote).map((key) => {
    const [bb, ll, rr] = [get(b, key), get(local, key), get(remote, key)]
    switch (key) {
      case 'settings': return [key, mergeSettings(objectOr(bb), objectOr(ll), objectOr(rr))]
      case 'threads': return [key, mergeThreads(objectOr(bb), objectOr(ll), objectOr(rr))]
      case 'early': return [key, mergeEarly(bb, ll, rr)]
      case 'schema': return [key, Math.max(integer(ll) ?? 0, integer(rr) ?? 0, SCHEMA)]
      default: return [key, pick(bb, ll, rr)]
    }
  }))
}

function mergeSettings(base: JsonObject | undefined, local: JsonObject | undefined, remote: JsonObject | undefined): JsonObject | undefined {
  if (!local && !remote) return undefined
  const b = base ?? {}
  const l = local ?? {}
  const r = remote ?? {}
  return objectOf(keys(b, l, r).map((key) => {
    const [bb, ll, rr] = [get(b, key), get(l, key), get(r, key)]
    if (ADDRESS_LISTS.has(key)) return [key, addressSet(bb, ll, rr)]
    switch (key) {
      case 'batch': return [key, fields(bb, ll, rr, ['vip'])]
      case 'summary': return [key, fields(bb, ll, rr, ['senders'])]
      case 'later': return [key, fields(bb, ll, rr)]
      case 'identities': return [key, entries(bb, ll, rr, (eb, el, er) => {
        // One a device made up (no name, no aliases, and nothing agreed before it, or nothing either)
        // never wipes one the person filled in. One cleared on purpose, from a copy both agreed had a
        // name or an alias, is a change like any other.
        const madeUp = blankIdentity(eb)
        if (madeUp && blankIdentity(el) && !blankIdentity(er)) return er
        if (madeUp && blankIdentity(er) && !blankIdentity(el)) return el
        return fields(eb, el, er, ['aliases'])
      })]
      case 'signatureFor': return [key, entries(bb, ll, rr, pick)]
      case 'signatures': return [key, byKey(bb, ll, rr, 'id')]
      case 'templates': return [key, byKey(bb, ll, rr, 'name')]
      default: return [key, pick(bb, ll, rr)]
    }
  }))
}

/** An identity with neither a name nor an alias: what a device makes up for an account it adds,
 *  with only a colour of its own. None at all counts as one. */
export function blankIdentity(who: Json | undefined): boolean {
  if (!isObject(who)) return true
  const name = get(who, 'name')
  const aliases = get(who, 'aliases')
  return (typeof name === 'string' ? name.trim() : '') === '' && (Array.isArray(aliases) ? aliases.length : 0) === 0
}

/** An object merged field by field, [sets] among them as sets of addresses. */
function fields(base: Json | undefined, local: Json | undefined, remote: Json | undefined, sets: string[] = []): Json | undefined {
  if (!isObject(local) || !isObject(remote)) return pick(base, local, remote)
  const b = objectOr(base) ?? {}
  return objectOf(keys(b, local, remote).map((key) => {
    const [bb, ll, rr] = [get(b, key), get(local, key), get(remote, key)]
    return [key, sets.includes(key) ? addressSet(bb, ll, rr) : pick(bb, ll, rr)]
  }))
}

type Each = (base: Json | undefined, local: Json | undefined, remote: Json | undefined) => Json | undefined

/** A map whose entries are merged one by one: one added on either side is there, one taken out on
 *  one side and left alone on the other goes. */
function entries(base: Json | undefined, local: Json | undefined, remote: Json | undefined, each: Each): Json | undefined {
  if (!isObject(local) || !isObject(remote)) return pick(base, local, remote)
  const b = objectOr(base) ?? {}
  return objectOf(keys(local, remote, b).map((key) => {
    const [bb, ll, rr] = [get(b, key), get(local, key), get(remote, key)]
    // Gone on one side and untouched on the other: gone. Gone on one side and changed on the other:
    // the change stands, as an edit beats a removal it never saw.
    if (ll === undefined && rr === undefined) return [key, undefined]
    if (ll === undefined) return [key, same(rr, bb) ? undefined : rr]
    if (rr === undefined) return [key, same(ll, bb) ? undefined : ll]
    return [key, each(bb, ll, rr)]
  }))
}

const address = (value: Json): string | null => (typeof value === 'string' ? value.trim().toLowerCase() : null)

/** Addresses as a set: there if both sides have it, or one side added it; gone if either side took
 *  it out. In the local side's order, then what the remote side added. */
function addressSet(base: Json | undefined, local: Json | undefined, remote: Json | undefined): Json | undefined {
  if (!Array.isArray(local) && !Array.isArray(remote)) return pick(base, local, remote)
  const b = new Set((Array.isArray(base) ? base : []).map(address).filter((a) => a !== null))
  const l = Array.isArray(local) ? local : []
  const r = Array.isArray(remote) ? remote : []
  const lSet = new Set(l.map(address))
  const rSet = new Set(r.map(address))
  const keep = (who: string): boolean => (lSet.has(who) && rSet.has(who)) || (!b.has(who) && (lSet.has(who) || rSet.has(who)))
  const seen = new Set<string>()
  return [...l, ...r].filter((item) => {
    const who = address(item)
    if (who === null || !keep(who) || seen.has(who)) return false
    seen.add(who)
    return true
  })
}

/** A list of objects, each named by [id], merged as a map of them: the local side's order, then what
 *  the remote side added. */
function byKey(base: Json | undefined, local: Json | undefined, remote: Json | undefined, id: string): Json | undefined {
  if (!Array.isArray(local) || !Array.isArray(remote)) return pick(base, local, remote)
  const named = (list: Json | undefined): Map<string, Json> => {
    const out = new Map<string, Json>()
    for (const item of Array.isArray(list) ? list : []) {
      const name = isObject(item) ? get(item, id) : undefined
      if ((typeof name === 'string' || typeof name === 'number') && !out.has(String(name))) out.set(String(name), item)
    }
    return out
  }
  const b = named(base)
  const l = named(local)
  const r = named(remote)
  const out: Json[] = []
  for (const key of new Set([...l.keys(), ...r.keys()])) {
    const [bb, ll, rr] = [b.get(key), l.get(key), r.get(key)]
    const merged = ll === undefined ? (same(rr, bb) ? undefined : rr) : rr === undefined ? (same(ll, bb) ? undefined : ll) : pick(bb, ll, rr)
    if (merged !== undefined) out.push(merged)
  }
  return out
}

/** When one part of a thread's entry was set: a snooze's or a reminder's `at`, a pin's own time. */
function partAt(part: string, value: Json | undefined): number | null {
  return part === 'pin' ? integer(value) : integer(isObject(value) ? get(value, 'at') : undefined)
}

/** When a thread's entry was last set: the newest of its parts' times. */
function entryAt(entry: Json | undefined): number {
  if (!isObject(entry)) return -Infinity
  const times = Object.keys(entry).map((part) => partAt(part, entry[part])).filter((at) => at !== null)
  return times.length > 0 ? Math.max(...times) : -Infinity
}

const empty = (entry: Json | undefined): boolean => entry === undefined || entry === null || (isObject(entry) && Object.keys(entry).length === 0)

/** A thread's entries, merged a part at a time: its snooze, its reminder and its pin each on its own,
 *  so a pin set on one device keeps a snooze set on the other. A part changed on one side takes that
 *  side's; changed on both, the newer `at` wins, and the local side on a tie; taken out on one side
 *  and changed on the other, the change stands. An entry gone on one side is merged as an empty one,
 *  so what the other side left alone ends with it. An entry with nothing left in it goes. */
function mergeThreads(base: JsonObject | undefined, local: JsonObject | undefined, remote: JsonObject | undefined): JsonObject {
  const b = base ?? {}
  const l = local ?? {}
  const r = remote ?? {}
  return objectOf(keys(l, r, b).map((key) => {
    const [bb, ll, rr] = [get(b, key), get(l, key), get(r, key)]
    let merged: Json | undefined
    if (same(ll, rr)) merged = ll
    else if (same(ll, bb)) merged = rr
    else if (same(rr, bb)) merged = ll
    // Both entries, or one gone (ended on that device): part by part, the gone one as empty, so
    // what the other side didn't touch ends with it.
    else if ((isObject(ll) || empty(ll)) && (isObject(rr) || empty(rr))) merged = mergeEntry(objectOr(bb), objectOr(ll) ?? {}, objectOr(rr) ?? {})
    else if (empty(ll)) merged = rr
    else if (empty(rr)) merged = ll
    else merged = entryAt(rr) > entryAt(ll) ? rr : ll
    return [key, empty(merged) ? undefined : merged]
  }))
}

function mergeEntry(base: JsonObject | undefined, local: JsonObject, remote: JsonObject): JsonObject {
  const b = base ?? {}
  return objectOf(keys(local, remote, b).map((part) => {
    const [bb, ll, rr] = [get(b, part), get(local, part), get(remote, part)]
    let merged: Json | undefined
    if (same(ll, rr)) merged = ll
    else if (same(ll, bb)) merged = rr
    else if (same(rr, bb)) merged = ll
    else if (ll === undefined || ll === null) merged = rr
    else if (rr === undefined || rr === null) merged = ll
    else merged = (partAt(part, rr) ?? -Infinity) > (partAt(part, ll) ?? -Infinity) ? rr : ll
    return [part, merged === null ? undefined : merged]
  }))
}

/** A day as either device writes it, "2026-11-6" or "2026-11-06", for comparing. */
function dayOrder(day: Json | undefined): number | null {
  if (typeof day !== 'string') return null
  const parts = day.split('-').filter((part) => /^\d+$/.test(part)).map(Number)
  return parts.length === 3 ? ((parts[0] ?? 0) * 100 + (parts[1] ?? 0)) * 100 + (parts[2] ?? 0) : null
}

/** The day's Deliver now: on the same day, the most used and every release; on different days, the
 *  newer day's. */
function mergeEarly(base: Json | undefined, local: Json | undefined, remote: Json | undefined): Json | undefined {
  if (!isObject(local) || !isObject(remote)) return pick(base, local, remote)
  const lDay = dayOrder(get(local, 'day'))
  const rDay = dayOrder(get(remote, 'day'))
  if (lDay === null || rDay === null) return lDay === null ? remote : local
  if (lDay > rDay) return local
  if (lDay < rDay) return remote
  const used = Math.max(integer(get(local, 'used')) ?? 0, integer(get(remote, 'used')) ?? 0)
  const listed = (o: JsonObject): Json[] => {
    const releases = get(o, 'releases')
    return Array.isArray(releases) ? releases : []
  }
  const releases = [...new Set([...listed(local), ...listed(remote)].map(integer).filter((at) => at !== null))].sort((x, y) => x - y)
  return objectOf([...Object.entries(local), ['used', used], ['releases', releases]])
}

/** What of [part] (the shared part of a device's settings) the device chose itself, for its first
 *  merge with a copy it has never agreed with: a field still at its first value ([first]) is left
 *  out, so the other side's stands, and so is an identity with neither a name nor an alias, which a
 *  device only made up (its colour too). An identity the person filled in stays, so the laptop's
 *  names and aliases outlast the blank ones the phone sent first. A field this one did change stays
 *  and wins, as a field changed on both sides does. */
export function chosen(part: JsonObject, first: JsonObject): JsonObject {
  return objectOf(Object.entries(part).map(([key, value]): [string, Json | undefined] => {
    if (key === 'identities' && isObject(value)) {
      const filled = Object.entries(value).filter(([, who]) => !blankIdentity(who))
      return [key, filled.length > 0 ? Object.fromEntries(filled) : undefined]
    }
    return [key, Object.hasOwn(first, key) && same(get(first, key), value) ? undefined : value]
  }))
}

/** The names this version knows inside each shared object; any other is kept as it came. */
const KNOWN: Record<string, string[]> = {
  batch: ['live', 'times', 'vip', 'earlyPerDay'],
  summary: ['senders', 'every', 'time', 'day', 'chosen'],
  identity: [...IDENTITY_FIELDS],
  signature: ['id', 'name', 'html', 'text'],
  template: ['name', 'text', 'subject']
}

/** [mine] with what [theirs] holds of the same object that this version has no name for. */
function withUnknown(mine: Json, theirs: Json | undefined, known: string[]): Json {
  if (!isObject(mine) || !isObject(theirs)) return mine
  const extra = Object.entries(theirs).filter(([key]) => !Object.hasOwn(mine, key) && !known.includes(key))
  return extra.length > 0 ? objectOf([...Object.entries(mine), ...extra]) : mine
}

/** A list of objects by [id], each with what its namesake in [theirs] has that this version doesn't know. */
function listWithUnknown(mine: Json, theirs: Json | undefined, id: string, known: string[]): Json {
  if (!Array.isArray(mine) || !Array.isArray(theirs)) return mine
  const byId = new Map<string, Json>()
  for (const item of theirs) {
    const name = isObject(item) ? get(item, id) : undefined
    if (typeof name === 'string' && !byId.has(name)) byId.set(name, item)
  }
  return mine.map((item) => {
    const name = isObject(item) ? get(item, id) : undefined
    return typeof name === 'string' ? withUnknown(item, byId.get(name), known) : item
  })
}

/**
 * [mine] (the shared part of this device's settings) with what [shared] holds that this version
 * doesn't know of, so it goes back as it came: sent without it, the merge would take it as taken out
 * here. A field of `settings` it has no name for is kept; so is a name it doesn't know inside the
 * batch, the Summary, an identity, a signature or a template. The entries of a map (the identities,
 * `signatureFor`) are data, and one this device hasn't got is gone as far as it knows, though each
 * entry it has keeps its own unknown fields. `later` is kept whole: its names are the times there are.
 */
export function keepUnknown(mine: JsonObject, shared: JsonObject | undefined): JsonObject {
  if (!shared) return mine
  const theirs = (key: string): Json | undefined => get(shared, key)
  const kept: [string, Json][] = Object.entries(mine).map(([key, value]) => {
    switch (key) {
      case 'batch':
      case 'summary':
        return [key, withUnknown(value, theirs(key), KNOWN[key] ?? [])]
      case 'later':
        return [key, withUnknown(value, theirs(key), [])]
      case 'identities': {
        const their = objectOr(theirs(key))
        return [key, isObject(value) ? objectOf(Object.entries(value).map(([account, who]) => [account, withUnknown(who, get(their ?? null, account), KNOWN['identity'] ?? [])])) : value]
      }
      case 'signatures': return [key, listWithUnknown(value, theirs(key), 'id', KNOWN['signature'] ?? [])]
      case 'templates': return [key, listWithUnknown(value, theirs(key), 'name', KNOWN['template'] ?? [])]
      default: return [key, value]
    }
  })
  const unknown = Object.entries(shared).filter(([key]) => !(SHARED_FIELDS as readonly string[]).includes(key) && !Object.hasOwn(mine, key))
  return objectOf([...kept, ...unknown])
}
