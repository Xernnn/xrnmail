import type { AccountView, BatchSettings, ListQuery, MessageView, Overview, Settings, ThreadRow } from '@shared/types'
import { dayKey, isTime, nextBatchAfter, releaseAt } from './batches'
import { gmailThreadUrl, isSafeHubUrl } from './safe-url'
import type { Secrets } from './secrets'
import type { MailSource } from './source'
import type { Store } from './store'
import { syncAccount } from './sync'

/** Everything the app does, with the clock and the outside world passed in. */

export const EARLY_WAIT_S = 30

const DEFAULT_SETTINGS: Settings = {
  batch: { times: ['09:00', '13:00', '17:00'], vip: [], earlyPerDay: 1 },
  backfillDays: 90,
  hub: { url: '', user: '', connected: false }
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const HUB_SECRET = 'hub'

export interface ServiceDeps {
  store: Store
  secrets: Secrets
  openSource(email: string, secret: string): MailSource
  now(): number
  /** Something on screen may be out of date. */
  changed(): void
  /** A batch just landed. */
  landed?(count: number): void
  post?: typeof fetch
  earlyWaitSeconds?: number
}

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, Math.round(Number.isFinite(value) ? value : low)))

const unique = (items: string[]): string[] => [...new Set(items)]

export function cleanBatch(batch: BatchSettings): BatchSettings {
  return {
    times: unique(batch.times.filter(isTime)).sort().slice(0, 12),
    vip: unique(batch.vip.map((v) => v.trim().toLowerCase()).filter((v) => v.includes('@'))).slice(0, 200),
    earlyPerDay: clamp(batch.earlyPerDay, 0, 5)
  }
}

/** Fixed words: what a server says is never shown, and can't carry anything back to the page. */
export function describeFailure(error: unknown): string {
  const e = error as { authenticationFailed?: boolean; message?: string }
  if (e?.authenticationFailed) return 'Gmail refused this app password.'
  if (e?.message?.includes('All Mail')) return e.message
  if (e?.message?.includes('read-only')) return e.message
  return "Couldn't reach Gmail."
}

export class MailService {
  private status = new Map<string, Pick<AccountView, 'syncedAt' | 'syncing' | 'error'>>()
  private lastTick: number
  private earlyStarted: number | null = null
  private lastHeld: number | null = null

  constructor(private deps: ServiceDeps) {
    this.lastTick = deps.now()
  }

  private get store(): Store {
    return this.deps.store
  }

  private emails(): string[] {
    try {
      return JSON.parse(this.store.meta('accounts') ?? '[]') as string[]
    } catch {
      return []
    }
  }

  private saveEmails(emails: string[]): void {
    this.store.setMeta('accounts', JSON.stringify(emails))
  }

  private statusOf(email: string): Pick<AccountView, 'syncedAt' | 'syncing' | 'error'> {
    let found = this.status.get(email)
    if (!found) {
      found = { syncedAt: null, syncing: false, error: null }
      this.status.set(email, found)
    }
    return found
  }

  accounts(): AccountView[] {
    return this.emails().map((email) => ({ id: email, email, ...this.statusOf(email) }))
  }

  /** Signs in first, so a wrong app password is said here and not found later. */
  async addAccount(rawEmail: string, secret: string): Promise<void> {
    const email = rawEmail.trim().toLowerCase()
    if (!EMAIL.test(email)) throw new Error("That isn't an email address.")
    if (!secret.trim()) throw new Error('Paste the app password.')
    if (!this.deps.secrets.available()) throw new Error('Unlock your system keyring first.')
    if (this.emails().includes(email)) throw new Error('That account is already here.')
    const source = this.deps.openSource(email, secret)
    try {
      await source.connect()
      await source.open()
    } catch (e) {
      throw new Error(describeFailure(e))
    } finally {
      await source.close().catch(() => undefined)
    }
    this.deps.secrets.set(`account:${email}`, secret)
    this.saveEmails([...this.emails(), email])
    this.deps.changed()
    void this.syncOne(email)
  }

  removeAccount(email: string): void {
    this.saveEmails(this.emails().filter((e) => e !== email))
    this.deps.secrets.remove(`account:${email}`)
    this.store.wipeAccount(email)
    this.status.delete(email)
    this.deps.changed()
  }

  async syncAll(): Promise<void> {
    await Promise.all(this.emails().map((email) => this.syncOne(email)))
  }

  private async syncOne(email: string): Promise<void> {
    const status = this.statusOf(email)
    if (status.syncing) return
    const secret = this.deps.secrets.get(`account:${email}`)
    if (!secret) {
      status.error = 'Add this account again: its app password is gone.'
      return this.deps.changed()
    }
    status.syncing = true
    this.deps.changed()
    const source = this.deps.openSource(email, secret)
    const settings = this.settings()
    try {
      await source.connect()
      await syncAccount(source, this.store, {
        account: email,
        email,
        backfillDays: settings.backfillDays,
        rules: settings.batch,
        now: this.deps.now(),
        progress: this.deps.changed
      })
      status.syncedAt = this.deps.now()
      status.error = null
    } catch (e) {
      status.error = describeFailure(e)
    } finally {
      await source.close().catch(() => undefined)
      status.syncing = false
      this.deps.changed()
    }
    await this.reportHeld()
  }

  /** Runs on a timer. Time passing is what delivers a batch, so nothing else would notice. */
  async tick(): Promise<void> {
    const now = this.deps.now()
    const landed = this.store.landedBetween(this.lastTick, now)
    this.lastTick = now
    if (landed === 0) return
    this.deps.landed?.(landed)
    this.deps.changed()
    await this.report('batch', landed)
  }

  overview(): Overview {
    const now = this.deps.now()
    return {
      held: this.store.heldCount(now),
      nextBatch: this.nextBatch(now),
      earlyLeft: this.earlyLeft(),
      labels: this.store.labelCounts(now)
    }
  }

  private nextBatch(now: number): number | null {
    return this.store.nextRelease(now) ?? nextBatchAfter(now, this.settings().batch.times)
  }

  list(query: ListQuery): ThreadRow[] {
    return this.store.list(query, this.deps.now())
  }

  thread(account: string, thread: string): MessageView[] {
    const now = this.deps.now()
    const messages = this.store.thread(account, thread, now)
    this.store.markRead(account, thread, now)
    return messages
  }

  threadUrl(email: string, thread: string): string {
    return gmailThreadUrl(email, thread)
  }

  settings(): Settings {
    try {
      const saved = JSON.parse(this.store.meta('settings') ?? '{}') as Partial<Settings>
      return {
        batch: saved.batch ?? DEFAULT_SETTINGS.batch,
        backfillDays: saved.backfillDays ?? DEFAULT_SETTINGS.backfillDays,
        hub: saved.hub ?? DEFAULT_SETTINGS.hub
      }
    } catch {
      return DEFAULT_SETTINGS
    }
  }

  private saveSettings(settings: Settings): void {
    this.store.setMeta('settings', JSON.stringify(settings))
  }

  /** Waiting mail moves to the next slot of the new timetable. Measuring from now, not from when it
   *  arrived, means changing the times can't deliver anything early by accident. */
  saveBatch(batch: BatchSettings): void {
    const clean = cleanBatch(batch)
    this.saveSettings({ ...this.settings(), batch: clean })
    const now = this.deps.now()
    this.store.retime((mail) => {
      const holdFrom = this.store.syncState(mail.account)?.holdFrom ?? 0
      return releaseAt({ ...mail, arrived: now }, mail.account, holdFrom, clean)
    }, now)
    this.deps.changed()
  }

  saveBackfill(days: number): void {
    this.saveSettings({ ...this.settings(), backfillDays: clamp(days, 7, 3650) })
    void this.syncAll()
  }

  private earlyUsed(): number {
    try {
      const saved = JSON.parse(this.store.meta('early') ?? '{}') as { day?: string; used?: number }
      return saved.day === dayKey(this.deps.now()) ? (saved.used ?? 0) : 0
    } catch {
      return 0
    }
  }

  private earlyLeft(): number {
    return Math.max(0, this.settings().batch.earlyPerDay - this.earlyUsed())
  }

  /** Early delivery has a door: ask, wait, and only then does it open. */
  beginEarly(): number {
    if (this.earlyLeft() === 0) throw new Error('None left today.')
    this.earlyStarted = this.deps.now()
    return this.deps.earlyWaitSeconds ?? EARLY_WAIT_S
  }

  async finishEarly(): Promise<number> {
    const wait = (this.deps.earlyWaitSeconds ?? EARLY_WAIT_S) * 1000
    const now = this.deps.now()
    if (this.earlyStarted === null || now - this.earlyStarted < wait) throw new Error('Not yet.')
    if (this.earlyLeft() === 0) throw new Error('None left today.')
    this.earlyStarted = null
    const released = this.store.releaseAll(now)
    if (released > 0) {
      this.store.setMeta('early', JSON.stringify({ day: dayKey(now), used: this.earlyUsed() + 1 }))
    }
    this.lastTick = now
    this.deps.changed()
    await this.report('early', released)
    return released
  }

  async connectHub(rawUrl: string, user: string, secret: string): Promise<void> {
    const url = rawUrl.trim().replace(/\/+$/, '')
    if (!isSafeHubUrl(url)) throw new Error('Use an https address.')
    if (!user.trim() || !secret) throw new Error('Fill in the name and password.')
    const ok = await this.send(url, user.trim(), secret, 'state.connected', 0)
    if (!ok) throw new Error("xrnhub didn't accept that.")
    this.deps.secrets.set(HUB_SECRET, secret)
    this.saveSettings({ ...this.settings(), hub: { url, user: user.trim(), connected: true } })
    this.deps.changed()
  }

  disconnectHub(): void {
    this.deps.secrets.remove(HUB_SECRET)
    this.saveSettings({ ...this.settings(), hub: { url: '', user: '', connected: false } })
    this.deps.changed()
  }

  /** The hub's card shows how many are waiting, so it hears when that number changes. `state.`
   *  marks it as a standing report and not something that happened. */
  private async reportHeld(): Promise<void> {
    const held = this.store.heldCount(this.deps.now())
    if (held === this.lastHeld) return
    this.lastHeld = held
    await this.report('state.held', held)
  }

  private async report(kind: string, value: number): Promise<void> {
    const { hub } = this.settings()
    const secret = hub.connected ? this.deps.secrets.get(HUB_SECRET) : null
    if (!secret) return
    this.lastHeld = this.store.heldCount(this.deps.now())
    await this.send(hub.url, hub.user, secret, kind, value)
  }

  /** Counts and times only. Who wrote and what about stay on this laptop. */
  private async send(url: string, user: string, secret: string, kind: string, value: number): Promise<boolean> {
    const now = this.deps.now()
    const event = {
      app: 'xrnmail', kind, at: now, value,
      detail: { held: this.store.heldCount(now), nextBatch: this.nextBatch(now) }
    }
    try {
      const response = await (this.deps.post ?? fetch)(`${url}/api/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${Buffer.from(`${user}:${secret}`).toString('base64')}`
        },
        body: JSON.stringify({ events: [event] }),
        redirect: 'error', // a redirect would carry the password somewhere else
        signal: AbortSignal.timeout(10_000)
      })
      return response.ok
    } catch {
      return false
    }
  }
}
