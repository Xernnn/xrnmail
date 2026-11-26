import { addressAllowed, cleanAddress, isDeviceLogin, sha256, SharedFailure, type SharedServer } from './shared-server'
import { isObject, merge, same, type JsonObject } from './shared-state'
import type { ShareView } from '@shared/types'
import type { Secrets } from './secrets'

/** What a device holds of the shared document: its settings, its threads' snoozes, reminders and
 *  pins, its day's Deliver now. */
export interface SharedPlace {
  /** The device's own document as it is now, laid over [agreed] (the copy last agreed with the
   *  server, if any), so what this version doesn't know of comes through as it was. */
  document(agreed: JsonObject | null): JsonObject
  /** [doc] with only what the device chose itself, for a first merge with a copy it never agreed
   *  with: what's still as it started out is left for the other side's to stand. */
  chosen(doc: JsonObject): JsonObject
  /** Takes in [merged]: only what differs from [was] (what [document] gave before the merge), and
   *  only where the device hasn't changed it since, so a change made meanwhile isn't lost; it goes
   *  up with the next sync. */
  take(was: JsonObject, merged: JsonObject): void
}

/** The copy this device last agreed with the server on, and which one that was. */
export interface SharedMeta {
  version: number
  tag: string
  agreed: JsonObject
}

export interface SharedMetaStore {
  load(): SharedMeta | null
  /** Null forgets it: the next sync is a first one. */
  save(meta: SharedMeta | null): void
}

export type SharedOutcome = 'up to date' | 'sent' | 'took' | 'took and sent'

/** Merges in a row lost to another device writing first, before giving up until the next try. */
const MAX_TRIES = 5

/**
 * Keeps this laptop's part of the shared document in step with the home server (docs/design.md,
 * "Shared with the phone"): fetched, merged three ways against the copy last agreed on, taken in,
 * and sent back when the merge holds something the server's copy lacks. A 412 means another device
 * wrote first: fetch, merge, send again. Nothing is ever overwritten that the other side hasn't
 * seen; a copy that can't be read (503) is left alone, and this laptop's changes wait for the next
 * try. One cycle at a time.
 */
export class SharedSync {
  private lane: Promise<unknown> = Promise.resolve()

  constructor(private readonly server: SharedServer, private readonly place: SharedPlace, private readonly meta: SharedMetaStore) {}

  /** The last copy agreed on; null before the first sync. */
  agreed(): SharedMeta | null {
    return this.meta.load()
  }

  sync(): Promise<SharedOutcome> {
    return this.inLane(() => this.cycle())
  }

  /** Sends this laptop's changes, if it has any, without asking the server for its own when it
   *  hasn't: for a change made here, while a long-poll waits to hear of the other side's. */
  sendChanges(): Promise<SharedOutcome> {
    return this.inLane(async () => {
      const known = this.meta.load()
      return known && same(this.place.document(known.agreed), known.agreed) ? 'up to date' : this.cycle()
    })
  }

  private inLane<T>(work: () => Promise<T>): Promise<T> {
    const next = this.lane.then(work, work)
    this.lane = next.catch(() => undefined)
    return next
  }

  private async cycle(): Promise<SharedOutcome> {
    let took = false
    const outcome = (sent: boolean): SharedOutcome => (took ? (sent ? 'took and sent' : 'took') : sent ? 'sent' : 'up to date')
    for (let i = 0; i < MAX_TRIES; i++) {
      const known = this.meta.load()
      const mine = this.place.document(known?.agreed ?? null)
      const theirs = known ? await this.server.newerThan(known.version, known.tag) : await this.server.current()
      if (!theirs) {
        // The server still has the copy agreed on (there is one, or it'd have answered): only this
        // laptop can have moved.
        const agreed = known as SharedMeta
        if (same(mine, agreed.agreed)) return outcome(false)
        if (await this.send(mine, agreed.version, agreed.tag)) return outcome(true)
        continue
      }
      if (theirs.version === 0) {
        // Nothing there: a first sync, or a server that lost its copy. It's owed what's here.
        if (await this.send(mine, 0, '')) return outcome(true)
        continue
      }
      // Put back from a backup and written to since, or gone backwards: what was agreed can't be told
      // apart from what wasn't, so every difference is a change on both sides, and this laptop's own
      // wins, as the design says; no field either side holds is lost.
      const sameLine = known !== null && theirs.follows && theirs.version >= known.version
      const merged = known === null
        ? merge(null, this.place.chosen(mine), theirs.doc)
        : sameLine ? merge(known.agreed, mine, theirs.doc) : merge(null, mine, theirs.doc)
      if (!same(merged, mine)) {
        this.place.take(mine, merged)
        took = true
      }
      if (same(merged, theirs.doc)) {
        this.meta.save({ version: theirs.version, tag: theirs.tag, agreed: merged })
        return outcome(false)
      }
      if (await this.send(merged, theirs.version, theirs.tag)) return outcome(true)
    }
    throw new SharedFailure(412)
  }

  /** True once [doc] is the server's copy; false when another device wrote first. */
  private async send(doc: JsonObject, version: number, tag: string): Promise<boolean> {
    const body = JSON.stringify(doc)
    const answer = await this.server.put(body, version, tag)
    // A 412 whose copy is these very bytes: an earlier send of this same copy, whose answer was lost
    // on the way back.
    if (answer.kind === 'accepted' || (answer.hash !== '' && answer.hash === sha256(body))) {
      this.meta.save({ version: answer.version, tag: answer.tag, agreed: doc })
      return true
    }
    return false
  }
}

/** The part of the store the agreed copy and the login are kept in. */
export interface MetaKeeper {
  meta(key: string): string | null
  setMeta(key: string, value: string): void
  deleteMeta(key: string): void
}

const AGREED_KEY = 'share:agreed'
const LOGIN_KEY = 'share:login'
const SECRET = 'share'

/** The copy last agreed with the server, kept in the store, with when that was. */
export class StoredMeta implements SharedMetaStore {
  private cached: { raw: string | null; meta: SharedMeta | null; at: number | null } | null = null

  constructor(private readonly store: MetaKeeper, private readonly now: () => number = Date.now) {}

  private read(): { meta: SharedMeta | null; at: number | null } {
    const raw = this.store.meta(AGREED_KEY)
    if (this.cached && this.cached.raw === raw) return this.cached
    let meta: SharedMeta | null = null
    let at: number | null = null
    try {
      const saved = JSON.parse(raw ?? 'null') as { version?: unknown; tag?: unknown; agreed?: unknown; at?: unknown } | null
      if (saved && Number.isInteger(saved.version) && typeof saved.tag === 'string' && isObject(saved.agreed as JsonObject)) {
        meta = { version: saved.version as number, tag: saved.tag, agreed: saved.agreed as JsonObject }
        at = typeof saved.at === 'number' ? saved.at : null
      }
    } catch {
      // Read as none: the next sync is a first one, which loses nothing either side has.
    }
    this.cached = { raw, meta, at }
    return this.cached
  }

  load(): SharedMeta | null {
    return this.read().meta
  }

  save(meta: SharedMeta | null): void {
    if (meta) this.store.setMeta(AGREED_KEY, JSON.stringify({ ...meta, at: this.now() }))
    else this.store.deleteMeta(AGREED_KEY)
  }

  /** When this laptop last agreed with the server. */
  syncedAt(): number | null {
    return this.read().at
  }

  /** Agreed again with no change: noted as the last sync. */
  touch(): void {
    const meta = this.load()
    if (meta) this.save(meta)
  }
}

export const SIGN_IN_AGAIN = 'Sign in again'
export const NOT_FOR_XRNMAIL = "Device login doesn't reach xrnmail"

/** A failure as Settings shows it: a few words. */
export function problemOf(e: unknown): string {
  if (!(e instanceof SharedFailure)) return 'Error'
  if (e.status === 0) return 'Server unreachable'
  if (e.status === 401) return SIGN_IN_AGAIN
  // The device login is right, and made for other services only: a new password wouldn't help.
  if (e.status === 403) return NOT_FOR_XRNMAIL
  if (e.status === 429) return 'Too many tries'
  if (e.status === 404) return 'Not found'
  if (e.status === 412) return 'Busy'
  if (e.status === 503) return 'Unreadable'
  if (e.status >= 500) return 'Server error'
  return `Error ${e.status}`
}

/** 5 s, 10 s, 20 s, … at most 5 min between tries while the server can't be reached. */
export const backoff = (failures: number): number => Math.min(5_000 * 2 ** Math.min(failures, 6), 300_000)

export interface SharingDeps {
  store: MetaKeeper
  secrets: Secrets
  place: SharedPlace
  serverFor(url: string, user: string, secret: string): SharedServer
  /** Something Settings shows changed. */
  changed(): void
  now?: () => number
  /** How long a long-poll waits on the server. */
  pollSeconds?: number
  /** How long after a change made here it goes, so a flurry is one send. */
  settleMs?: number
}

interface Poll {
  stop: boolean
  /** Ends the wait between tries early, when the poll is stopped. */
  wake: (() => void) | null
}

/**
 * Sharing with the phone through the home server. Signed in once (the sync password, or a device
 * login in its place), it waits on the server for the other device's changes (a long-poll) while
 * something holds it, the window being shown; checks once with each pass through the mail
 * otherwise; and sends this laptop's own a moment after each one. Offline, changes wait here and go
 * when the server answers again; mail never waits on it. A login the server refuses (401), a device
 * login that isn't for xrnmail (403), or an address that's wrong isn't tried again by itself, as each
 * wrong login counts towards the server's lockout: it waits for the login to be entered again.
 */
export class Sharing {
  private server: SharedServer | null = null
  private engine: SharedSync | null = null
  private readonly meta: StoredMeta
  private readonly holds = new Set<string>()
  private poll: Poll | null = null
  private pending: NodeJS.Timeout | null = null
  private problem: string | null = null
  /** Set by a failure that trying again can't mend. Nothing is asked of the server until the login
   *  is entered again. */
  private stopped = false
  private busy = false

  constructor(private readonly deps: SharingDeps) {
    this.meta = new StoredMeta(deps.store, deps.now)
    const login = this.login()
    const secret = login ? deps.secrets.get(SECRET) : null
    if (login && secret) {
      try {
        this.use(login.url, login.user, secret)
      } catch {
        // An address saved by an older version that this one won't take: shown as Sign in again.
      }
    }
  }

  private login(): { url: string; user: string } | null {
    try {
      const saved = JSON.parse(this.deps.store.meta(LOGIN_KEY) ?? 'null') as { url?: unknown; user?: unknown } | null
      return saved && typeof saved.url === 'string' && typeof saved.user === 'string' ? { url: saved.url, user: saved.user } : null
    } catch {
      return null
    }
  }

  private use(url: string, user: string, secret: string): void {
    this.server?.abort()
    const server = this.deps.serverFor(url, user, secret)
    this.server = server
    this.engine = new SharedSync(server, this.deps.place, this.meta)
  }

  view(): ShareView {
    const login = this.login()
    const unopened = login && !this.engine ? (this.deps.secrets.has(SECRET) && !this.deps.secrets.available() ? 'Keyring locked' : SIGN_IN_AGAIN) : null
    return {
      on: login !== null,
      url: login?.url ?? '',
      user: login?.user ?? '',
      syncedAt: this.meta.syncedAt(),
      problem: unopened ?? this.problem,
      stopped: unopened !== null || this.stopped,
      busy: this.busy
    }
  }

  /** Signs in and syncs once, which is the check: on success the login is kept in the keyring and
   *  sharing is on; otherwise nothing is kept, the login before goes on, and the problem is thrown. */
  async connect(rawUrl: string, rawUser: string, secret: string): Promise<void> {
    const url = cleanAddress(rawUrl)
    if (!addressAllowed(url)) throw new Error('Use an https address.')
    const user = rawUser.trim()
    if (!secret || (!isDeviceLogin(secret) && !user)) throw new Error('Fill in the name and password.')
    if (!this.deps.secrets.available()) throw new Error('Unlock your system keyring first.')
    // Nothing else syncs meanwhile: the trial starts from no agreed copy, and is the only writer of it.
    this.stopPoll()
    this.clearPending()
    const old = { server: this.server, engine: this.engine }
    this.server = null
    this.engine = null
    this.busy = true
    this.deps.changed()
    // A server or login of its own: the copy agreed with any other means nothing to it. The same
    // ones signed in to again (after a new password) keep it: forgotten, the sync after would be a
    // first merge, and whatever the phone changed meanwhile would be decided as if new on both sides,
    // the laptop's way, putting back senders it unblocked and snoozes it ended.
    const before = this.deps.store.meta(AGREED_KEY)
    const saved = this.login()
    if (!saved || saved.url !== url || saved.user !== user) this.meta.save(null)
    const trial = this.deps.serverFor(url, user, secret)
    try {
      await new SharedSync(trial, this.deps.place, this.meta).sync()
    } catch (e) {
      if (before === null) this.deps.store.deleteMeta(AGREED_KEY)
      else this.deps.store.setMeta(AGREED_KEY, before)
      this.server = old.server
      this.engine = old.engine
      this.busy = false
      this.restartPoll()
      this.deps.changed()
      throw new Error(problemOf(e))
    }
    this.deps.secrets.set(SECRET, secret)
    this.deps.store.setMeta(LOGIN_KEY, JSON.stringify({ url, user }))
    this.server = trial
    this.engine = new SharedSync(trial, this.deps.place, this.meta)
    this.problem = null
    this.stopped = false
    this.busy = false
    this.restartPoll()
    this.deps.changed()
  }

  /** Sharing off: the login and the agreed copy are forgotten. The settings stay as they are. */
  disconnect(): void {
    this.stopPoll()
    this.clearPending()
    this.server?.abort()
    this.server = null
    this.engine = null
    this.deps.secrets.remove(SECRET)
    this.deps.store.deleteMeta(LOGIN_KEY)
    this.meta.save(null)
    this.problem = null
    this.stopped = false
    this.deps.changed()
  }

  /** Waits on the server for the other device's changes while [why] holds (the window being shown). */
  hold(why: string): void {
    this.holds.add(why)
    if (!this.poll) this.restartPoll()
  }

  release(why: string): void {
    this.holds.delete(why)
    if (this.holds.size === 0) this.stopPoll()
  }

  /** Something here changed: sent once things have been quiet a moment, so a flurry is one send. */
  changedHere(): void {
    if (!this.engine || this.stopped) return
    this.clearPending()
    this.pending = setTimeout(() => {
      this.pending = null
      const engine = this.engine
      if (engine && !this.stopped) void this.attempt(() => engine.sendChanges())
    }, this.deps.settleMs ?? 2_000)
    this.pending.unref?.()
  }

  /** One sync, as each pass through the mail does, unless sharing is off, waiting for a login, or
   *  already waiting on the server for the phone's changes. */
  async check(): Promise<void> {
    const engine = this.engine
    if (!engine || this.stopped || this.poll) return
    await this.attempt(() => engine.sync())
  }

  /** After waking or a network change: the long-poll's connection may be dead, so it starts over. */
  restart(): void {
    if (this.poll) this.restartPoll()
  }

  /** On the way out: a change made here a moment ago goes now, not at the next start. */
  async finish(): Promise<void> {
    this.holds.clear()
    this.stopPoll()
    const waiting = this.pending !== null
    this.clearPending()
    const engine = this.engine
    if (waiting && engine && !this.stopped) await this.attempt(() => engine.sendChanges())
  }

  private clearPending(): void {
    if (this.pending) clearTimeout(this.pending)
    this.pending = null
  }

  private agreedNow(): void {
    this.problem = null
    this.deps.changed()
  }

  /** Notes [e]. False when it's one that waits for the login to be entered again. */
  private failedWith(e: unknown): boolean {
    this.problem = problemOf(e)
    const temporary = e instanceof SharedFailure ? e.temporary : true
    if (!temporary) {
      this.stopped = true
      this.stopPoll()
      this.clearPending()
    }
    this.deps.changed()
    return temporary
  }

  private async attempt(work: () => Promise<unknown>): Promise<void> {
    try {
      await work()
      this.agreedNow()
    } catch (e) {
      this.failedWith(e)
    }
  }

  private stopPoll(): void {
    const poll = this.poll
    this.poll = null
    if (!poll) return
    poll.stop = true
    poll.wake?.()
    this.server?.abort()
  }

  private restartPoll(): void {
    this.stopPoll()
    if (this.holds.size === 0 || !this.engine || this.stopped) return
    const poll: Poll = { stop: false, wake: null }
    this.poll = poll
    void this.pollLoop(poll)
  }

  private wait(poll: Poll, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        poll.wake = null
        resolve()
      }, ms)
      timer.unref?.()
      poll.wake = () => {
        clearTimeout(timer)
        poll.wake = null
        resolve()
      }
    })
  }

  private async pollLoop(poll: Poll): Promise<void> {
    let failures = 0
    while (!poll.stop) {
      const engine = this.engine
      const server = this.server
      if (!engine || !server || this.stopped) return
      try {
        await engine.sync()
        if (poll.stop) return
        this.meta.touch()
        this.agreedNow()
        failures = 0
        for (;;) {
          const known = engine.agreed()
          if (!known) break
          const asked = Date.now()
          const newer = await server.newerThan(known.version, known.tag, this.deps.pollSeconds ?? 25)
          if (poll.stop) return
          if (!newer) {
            // Nothing new. Something between that answers at once instead of waiting isn't asked
            // again at once.
            if (Date.now() - asked < 1_000) await this.wait(poll, 1_000)
            if (poll.stop) return
            continue
          }
          if (newer.version !== known.version || newer.tag !== known.tag) break // merged at the top
        }
      } catch (e) {
        if (poll.stop) return
        if (!this.failedWith(e)) return
        const asked = e instanceof SharedFailure ? e.retryAfter : null
        await this.wait(poll, asked ? asked * 1000 : backoff(failures++))
      }
    }
  }
}
