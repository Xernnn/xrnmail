/**
 * Which moment a message lands. This is the whole idea of xrnmail: mail arrives a few times a day
 * instead of whenever someone sends it. Nothing here touches the clock, so it can be tested on any
 * day; local time and clock changes are left to Date.
 */

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/
const DAY_MS = 86_400_000

export interface SummaryRules {
  /** Addresses or @domains whose new mail waits for the Summary. None, and there is no Summary. */
  senders: string[]
  every: 'daily' | 'weekly'
  /** "HH:MM". */
  time: string
  /** For a weekly Summary: 0 is Sunday, as Date counts. */
  day: number
}

export interface BatchRules {
  times: string[]
  vip: string[]
  summary?: SummaryRules
}

/** When a message may be seen, and whether it's the Summary that holds it. */
export interface Hold {
  at: number
  summary: boolean
}

export interface Arrival {
  arrived: number
  fromAddress: string
  labels: string[]
}

export const isTime = (text: string): boolean => TIME.test(text)

/** The first batch strictly after [at]; null when no times are set, which means no batching. */
export function nextBatchAfter(at: number, times: string[]): number | null {
  const slots = times
    .filter(isTime)
    .map((t) => t.split(':').map(Number) as [number, number])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (slots.length === 0) return null
  const day = new Date(at)
  for (let offset = 0; offset <= 2; offset++) {
    for (const [hour, minute] of slots) {
      const slot = new Date(day.getFullYear(), day.getMonth(), day.getDate() + offset, hour, minute).getTime()
      if (slot > at) return slot
    }
  }
  return at + DAY_MS // only reachable if the clock skips days; never strand a message
}

/** The first Summary strictly after [at]: the chosen time, every day or on the chosen day. */
export function nextSummaryAfter(at: number, summary: SummaryRules): number {
  const [hour, minute] = (isTime(summary.time) ? summary.time : '08:00').split(':').map(Number) as [number, number]
  const day = new Date(at)
  for (let offset = 0; offset <= 8; offset++) {
    const slot = new Date(day.getFullYear(), day.getMonth(), day.getDate() + offset, hour, minute)
    if (slot.getTime() > at && (summary.every === 'daily' || slot.getDay() === summary.day)) return slot.getTime()
  }
  return at + 7 * DAY_MS // only reachable if the clock skips days; never strand a message
}

/** An address, or a whole @domain, that skips the wait. */
export function isVip(address: string, vip: string[]): boolean {
  const who = address.trim().toLowerCase()
  if (!who) return false
  return vip.some((entry) => {
    const rule = entry.trim().toLowerCase()
    if (!rule) return false
    return rule.startsWith('@') ? who.endsWith(rule) : who === rule
  })
}

/**
 * When a message may be seen. Only new incoming inbox mail waits: anything from before the account
 * was added, your own sent mail, and mail filed away by a filter are there at once. A sender in the
 * Summary waits for the Summary, whatever the batches say; then the straight-through senders; then
 * everyone else waits for the next batch.
 */
export function holdOf(mail: Arrival, ownAddress: string, holdFrom: number, rules: BatchRules): Hold {
  const now = { at: mail.arrived, summary: false }
  if (mail.arrived <= holdFrom) return now
  if (!mail.labels.includes('\\Inbox')) return now
  if (mail.fromAddress.toLowerCase() === ownAddress.toLowerCase()) return now
  if (rules.summary && isVip(mail.fromAddress, rules.summary.senders)) return { at: nextSummaryAfter(mail.arrived, rules.summary), summary: true }
  if (isVip(mail.fromAddress, rules.vip)) return now
  return { at: nextBatchAfter(mail.arrived, rules.times) ?? mail.arrived, summary: false }
}

export const releaseAt = (mail: Arrival, ownAddress: string, holdFrom: number, rules: BatchRules): number =>
  holdOf(mail, ownAddress, holdFrom, rules).at

/** The start of the local day, for "how many times today". */
export function dayKey(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}
