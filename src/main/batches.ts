/**
 * Which moment a message lands. This is the whole idea of xrnmail: mail arrives a few times a day
 * instead of whenever someone sends it. Nothing here touches the clock, so it can be tested on any
 * day; local time and clock changes are left to Date.
 */

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/
const DAY_MS = 86_400_000

export interface BatchRules {
  times: string[]
  vip: string[]
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
 * was added, your own sent mail, and mail filed away by a filter are there at once.
 */
export function releaseAt(mail: Arrival, ownAddress: string, holdFrom: number, rules: BatchRules): number {
  if (mail.arrived <= holdFrom) return mail.arrived
  if (!mail.labels.includes('\\Inbox')) return mail.arrived
  if (mail.fromAddress.toLowerCase() === ownAddress.toLowerCase()) return mail.arrived
  if (isVip(mail.fromAddress, rules.vip)) return mail.arrived
  return nextBatchAfter(mail.arrived, rules.times) ?? mail.arrived
}

/** The start of the local day, for "how many times today". */
export function dayKey(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}
