const DAY_MS = 86_400_000

export const clock = (at: number): string =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })

/** The list's time: a clock today, a weekday this week, a date after that. */
export function shortTime(at: number, now = Date.now()): string {
  const then = new Date(at)
  const today = new Date(now)
  if (then.toDateString() === today.toDateString()) return clock(at)
  if (now - at < 6 * DAY_MS) return then.toLocaleDateString([], { weekday: 'short' })
  const sameYear = then.getFullYear() === today.getFullYear()
  return then.toLocaleDateString([], { day: 'numeric', month: 'short', year: sameYear ? undefined : 'numeric' })
}

export const longTime = (at: number): string =>
  new Date(at).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })

export const mailbox = (email: string): string => email.split('@')[0] ?? email

/** Electron wraps what the main process threw; only its own sentence is for reading. */
export const problem = (error: unknown): string =>
  String((error as Error)?.message ?? error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
