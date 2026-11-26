import type { Settings, ThreadRef } from '@shared/types'
import { dayKey } from './batches'
import { chosen, get, isObject, keepUnknown, same, SCHEMA, SHARED_FIELDS, type Json, type JsonObject } from './shared-state'
import type { SharedPlace } from './shared-sync'
import type { Store } from './store'

/** What the laptop's share needs of the rest of the app. */
export interface LaptopSide {
  settings(): Settings
  /** The settings as a new profile has them: a field still like this is one nobody chose here. */
  defaults(): Settings
  /** The accounts on this laptop, as the store has them. */
  accounts(): string[]
  /** The colour an account's mail is marked with here: its own, or the one it was given. */
  colorOf(account: string): string
  /** Shared settings the other device changed, field by field, each cleaned as a change from the
   *  page is before it's kept. */
  takeSettings(part: JsonObject): void
  store: Store
  now(): number
  changed(): void
}

/** As it's kept in the store's `early`. */
interface Early {
  day: string
  used: number
  releases: number[]
}

const integer = (value: Json | undefined): number | null => (typeof value === 'number' && Number.isInteger(value) ? value : null)
const objectOr = (value: Json | undefined): JsonObject | undefined => (isObject(value) ? value : undefined)
const plain = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json

/** A thread's key in the shared document, read back: the account, then the thread. */
function refOfKey(key: string): ThreadRef | null {
  const cut = key.indexOf('\n')
  if (cut <= 0 || cut === key.length - 1) return null
  return { account: key.slice(0, cut), thread: key.slice(cut + 1) }
}

/** The parts of a thread's entry that are kept in this laptop's store; any other part (one a newer
 *  phone shares) is left as it came. */
const OWN_PARTS = ['snooze', 'reminder', 'pin']

/** A day as `dayKey` writes it, from either device's way: "2026-11-06" is "2026-11-6". */
const unpadded = (day: string): string => day.split('-').map((part) => (/^\d+$/.test(part) ? String(Number(part)) : part)).join('-')

const snoozeJson = (s: { at: number; until: number } | null): Json | undefined => (s ? { until: s.until, at: s.at } : undefined)
const reminderJson = (r: { at: number; until: number; fired: boolean } | null): Json | undefined => (r ? { until: r.until, at: r.at, fired: r.fired } : undefined)

/**
 * What this laptop holds of the shared document (docs/design.md, "Shared with the phone"): the
 * shared part of its settings, its threads' snoozes, reminders and pins, and the day's Deliver now.
 * Each comes laid over the copy last agreed with the server, so what this version doesn't know of
 * goes back as it came; and the identity or a thread of an account this laptop hasn't got is left
 * as the phone wrote it.
 */
export class LaptopShare implements SharedPlace {
  constructor(private readonly side: LaptopSide) {}

  /** This laptop's accounts, found by their address in any case. */
  private mine(): Map<string, string> {
    return new Map(this.side.accounts().map((email) => [email.toLowerCase(), email]))
  }

  private part(settings: Settings, identities: JsonObject): JsonObject {
    const all = settings as unknown as Record<string, unknown>
    return Object.fromEntries(SHARED_FIELDS.filter((field) => all[field] !== undefined).map((field) => [field, field === 'identities' ? identities : plain(all[field])]))
  }

  /** The shared part of this laptop's settings, with what [agreed] holds that this laptop doesn't. */
  private settingsPart(agreed: JsonObject | undefined): JsonObject {
    const settings = this.side.settings()
    const mine = this.mine()
    const own: [string, Json][] = this.side.accounts().map((email) => {
      const who = settings.identities[email]
      return [email, { name: who?.name ?? '', aliases: plain(who?.aliases ?? []), color: this.side.colorOf(email) }]
    })
    const theirs = Object.entries(objectOr(get(agreed, 'identities')) ?? {}).filter(([account]) => !mine.has(account.toLowerCase()))
    return keepUnknown(this.part(settings, Object.fromEntries([...theirs, ...own])), agreed)
  }

  private threadsPart(agreed: JsonObject | undefined): JsonObject {
    const mine = this.mine()
    const out = new Map<string, JsonObject>()
    // The key a thread already has, whatever the case its account was written in.
    const keyed = new Map<string, string>()
    for (const [key, entry] of Object.entries(agreed ?? {})) {
      const ref = refOfKey(key)
      if (!isObject(entry)) continue
      if (!ref || !mine.has(ref.account.toLowerCase())) {
        out.set(key, entry)
        continue
      }
      keyed.set(`${ref.account.toLowerCase()}\n${ref.thread}`, key)
      const rest = Object.entries(entry).filter(([part]) => !OWN_PARTS.includes(part))
      if (rest.length > 0) out.set(key, Object.fromEntries(rest))
    }
    const add = (ref: ThreadRef, part: string, value: Json | undefined): void => {
      if (value === undefined || !mine.has(ref.account.toLowerCase())) return
      const key = keyed.get(`${ref.account.toLowerCase()}\n${ref.thread}`) ?? `${ref.account}\n${ref.thread}`
      out.set(key, Object.fromEntries([...Object.entries(out.get(key) ?? {}), [part, value]]))
    }
    const { store } = this.side
    for (const s of store.snoozes()) add(s, 'snooze', snoozeJson(s))
    for (const r of store.reminders()) add(r, 'reminder', reminderJson(r))
    for (const p of store.pins()) add(p, 'pin', p.at)
    return Object.fromEntries(out)
  }

  private early(): Early | null {
    try {
      const saved = JSON.parse(this.side.store.meta('early') ?? 'null') as Partial<Early> | null
      if (!saved || typeof saved.day !== 'string' || !saved.day) return null
      const releases = Array.isArray(saved.releases) ? saved.releases.filter((at) => Number.isInteger(at)) : []
      return { day: saved.day, used: Number.isInteger(saved.used) ? (saved.used as number) : 0, releases }
    } catch {
      return null
    }
  }

  private earlyPart(agreed: JsonObject | undefined): JsonObject | undefined {
    const early = this.early()
    if (!early) return agreed
    return Object.fromEntries([...Object.entries(agreed ?? {}), ['day', early.day], ['used', early.used], ['releases', early.releases]])
  }

  document(agreed: JsonObject | null): JsonObject {
    const doc: [string, Json | undefined][] = [
      ['schema', Math.max(SCHEMA, integer(get(agreed, 'schema')) ?? 0)],
      ['settings', this.settingsPart(objectOr(get(agreed, 'settings')))],
      ['threads', this.threadsPart(objectOr(get(agreed, 'threads')))],
      ['early', this.earlyPart(objectOr(get(agreed, 'early')))]
    ]
    return Object.fromEntries(doc.filter((entry): entry is [string, Json] => entry[1] !== undefined))
  }

  chosen(doc: JsonObject): JsonObject {
    const first = this.part(this.side.defaults(), {})
    return { ...doc, settings: chosen(objectOr(get(doc, 'settings')) ?? {}, first) }
  }

  take(was: JsonObject, merged: JsonObject): void {
    const settings = this.takeSettings(objectOr(get(was, 'settings')), objectOr(get(merged, 'settings')))
    const threads = this.takeThreads(objectOr(get(was, 'threads')), objectOr(get(merged, 'threads')))
    const early = this.takeEarly(objectOr(get(was, 'early')), objectOr(get(merged, 'early')))
    if (settings || threads || early) this.side.changed()
  }

  private takeSettings(was: JsonObject | undefined, merged: JsonObject | undefined): boolean {
    const before = was ?? {}
    const after = merged ?? {}
    const fields = SHARED_FIELDS.filter((field) => !same(get(after, field), get(before, field)))
    if (fields.length === 0) return false
    // Only what this laptop hasn't changed since: a change made meanwhile goes up next time.
    const now = this.settingsPart(before)
    const first = this.part(this.side.defaults(), {})
    const part = fields
      .filter((field) => same(get(now, field), get(before, field)))
      .map((field): [string, Json | undefined] => [field, get(after, field) ?? get(first, field)])
      .filter((entry): entry is [string, Json] => entry[1] !== undefined)
    if (part.length === 0) return false
    this.side.takeSettings(Object.fromEntries(part))
    return true
  }

  private takeThreads(was: JsonObject | undefined, merged: JsonObject | undefined): boolean {
    const before = was ?? {}
    const after = merged ?? {}
    const mine = this.mine()
    const { store } = this.side
    let took = false
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const then = objectOr(get(before, key))
      const next = objectOr(get(after, key))
      if (same(then, next)) continue
      const keyRef = refOfKey(key)
      const account = keyRef ? mine.get(keyRef.account.toLowerCase()) : undefined
      if (!keyRef || !account) continue
      const ref = { account, thread: keyRef.thread }
      const changed = (part: string): boolean => !same(get(next, part), get(then, part))
      // Each part only where this laptop still has it as it was: changed here meanwhile, it goes up next time.
      if (changed('snooze') && same(snoozeJson(store.snoozeOf(ref)), get(then, 'snooze'))) {
        const s = objectOr(get(next, 'snooze'))
        const [at, until] = [integer(get(s, 'at')), integer(get(s, 'until'))]
        if (!s) store.unsnooze(ref)
        else if (until !== null) store.snooze(ref, at ?? 0, until)
        took = true
      }
      if (changed('reminder') && same(reminderJson(store.reminderOf(ref)), get(then, 'reminder'))) {
        const r = objectOr(get(next, 'reminder'))
        const [at, until] = [integer(get(r, 'at')), integer(get(r, 'until'))]
        if (!r) store.unremind(ref)
        else if (until !== null) store.setReminder(ref, at ?? 0, until, get(r, 'fired') === true)
        took = true
      }
      if (changed('pin') && same(store.pinOf(ref) ?? undefined, get(then, 'pin'))) {
        const pin = get(next, 'pin')
        if (pin === undefined) store.unpin(ref)
        else if (integer(pin) !== null) store.setPin(ref, pin as number)
        took = true
      }
    }
    return took
  }

  private takeEarly(was: JsonObject | undefined, merged: JsonObject | undefined): boolean {
    if (same(was, merged) || !merged) return false
    const day = get(merged, 'day')
    if (typeof day !== 'string' || !day) return false
    // Deliver now used here meanwhile: merged next time, with this one in it.
    if (!same(this.earlyPart(was), was)) return false
    const listed = get(merged, 'releases')
    const releases = (Array.isArray(listed) ? listed : []).map(integer).filter((at) => at !== null)
    const now = this.side.now()
    // What the other device let in, let in here too: what waited at each of its moments. Each is let
    // in again when the day's count changes, which lands only what still waits and had come by then.
    // Read as this laptop writes a day, so its own count for today goes on from it.
    const own = unpadded(day)
    for (const at of releases) if (at <= now && dayKey(at) === own) this.side.store.releaseWaitingAt(at, now)
    const early: Early = { day: own, used: integer(get(merged, 'used')) ?? 0, releases }
    this.side.store.setMeta('early', JSON.stringify(early))
    return true
  }
}
