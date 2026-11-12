import type { Address, Facts } from '@shared/types'

const DAY_MS = 86_400_000

let hour12 = false

/** Every time the app writes follows the one setting. */
export const setClock24 = (on: boolean): void => {
  hour12 = !on
}

export const clock = (at: number): string =>
  new Date(at).toLocaleTimeString([], { hour: hour12 ? 'numeric' : '2-digit', minute: '2-digit', hour12 })

/** The list's time: a clock today, a short date any other day. */
export function shortTime(at: number, now = Date.now()): string {
  const then = new Date(at)
  const today = new Date(now)
  if (then.toDateString() === today.toDateString()) return clock(at)
  const sameYear = then.getFullYear() === today.getFullYear()
  return then.toLocaleDateString([], { day: 'numeric', month: 'short', year: sameYear ? undefined : 'numeric' })
}

const startOfDay = (at: number): number => {
  const day = new Date(at)
  return new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime()
}

/** Calendar days from one moment to the next, so 23:59 and 00:01 are a day apart. Rounded for clock changes. */
const daysBetween = (from: number, to: number): number => Math.round((startOfDay(to) - startOfDay(from)) / DAY_MS)

/** The heading a thread sits under in the list. Weeks start on Monday. */
export function dayGroup(at: number, now = Date.now()): string {
  const days = daysBetween(at, now)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  const intoWeek = (new Date(now).getDay() + 6) % 7
  if (days <= intoWeek) return 'This week'
  if (days <= intoWeek + 7) return 'Last week'
  const then = new Date(at)
  const today = new Date(now)
  if (then.getFullYear() === today.getFullYear() && then.getMonth() === today.getMonth()) return 'This month'
  return then.toLocaleDateString([], { month: 'long', year: then.getFullYear() === today.getFullYear() ? undefined : 'numeric' })
}

/** The same test as `isVip` in the main process's batches.ts: an address, or a whole @domain. */
export function straightThrough(address: string, vip: string[]): boolean {
  const who = address.trim().toLowerCase()
  if (!who) return false
  return vip.some((entry) => {
    const rule = entry.trim().toLowerCase()
    return rule !== '' && (rule.startsWith('@') ? who.endsWith(rule) : who === rule)
  })
}

export const longTime = (at: number): string =>
  new Date(at).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: hour12 ? 'numeric' : '2-digit', minute: '2-digit', hour12 })

/** Every part of a moment, to the second and with its zone, for a message's details. */
export const fullTime = (at: number): string =>
  new Date(at).toLocaleString([], {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: hour12 ? 'numeric' : '2-digit', minute: '2-digit', second: '2-digit', hour12, timeZoneName: 'short'
  })

export const mailbox = (email: string): string => email.split('@')[0] ?? email

/** Electron wraps what the main process threw; only its own sentence is for reading. */
export const problem = (error: unknown): string =>
  String((error as Error)?.message ?? error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** One line about what the Assistant found. */
export function factLine(facts: Facts): string {
  const day = (at: number | null): string => (at === null ? '' : longTime(at))
  switch (facts.type) {
    case 'package':
      return [facts.carrier, facts.tracking, facts.arrives ? `Arrives ${day(facts.arrives)}` : ''].filter(Boolean).join(' · ')
    case 'travel':
      return [facts.title, facts.detail, day(facts.when), facts.code].filter(Boolean).join(' · ')
    case 'money':
      return [facts.merchant, facts.amount, facts.due ? `Due ${day(facts.due)}` : ''].filter(Boolean).join(' · ')
    case 'event':
      return [facts.title, day(facts.start), facts.location].filter(Boolean).join(' · ')
  }
}

/** How long ago, for the line that says how fresh the mail is. */
export function ago(at: number, now = Date.now()): string {
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  return `at ${clock(at)}`
}

const firstName = (who: Address): string => {
  const name = who.name.trim()
  if (!name || name.includes('@')) return mailbox(who.address)
  return name.split(/\s+/)[0] ?? name
}

const MOST_NAMES = 3

/** "Mai, me & Linh": who's in a thread, or a whole name when there's only one of them. */
export function peopleLine(people: Address[], own: string[]): string {
  const mine = (who: Address): boolean => own.includes(who.address.toLowerCase())
  const only = people[0]
  if (people.length === 0) return 'Unknown'
  if (people.length === 1 && only) return mine(only) ? 'me' : only.name || only.address || 'Unknown'
  const names = people.map((who) => (mine(who) ? 'me' : firstName(who)))
  const shown = names.slice(0, MOST_NAMES)
  const rest = names.length - shown.length
  if (rest > 0) return `${shown.join(', ')} & ${rest} more`
  return `${shown.slice(0, -1).join(', ')} & ${shown.at(-1)}`
}

export type FileKind = 'image' | 'pdf' | 'doc' | 'sheet' | 'slides' | 'archive' | 'calendar' | 'audio' | 'video' | 'file'

const KINDS: [RegExp, FileKind][] = [
  [/\.(png|jpe?g|gif|webp|heic|bmp|svg)$/, 'image'],
  [/\.pdf$/, 'pdf'],
  [/\.(docx?|odt|rtf|txt|md|pages)$/, 'doc'],
  [/\.(xlsx?|ods|csv|numbers)$/, 'sheet'],
  [/\.(pptx?|odp|key)$/, 'slides'],
  [/\.(zip|rar|7z|tar|gz)$/, 'archive'],
  [/\.ics$/, 'calendar'],
  [/\.(mp3|wav|m4a|ogg|flac)$/, 'audio'],
  [/\.(mp4|mov|webm|mkv|avi)$/, 'video']
]

export const fileKind = (name: string): FileKind => KINDS.find(([pattern]) => pattern.test(name.toLowerCase()))?.[1] ?? 'file'

const SYSTEM_LABELS = /^\\/

export const userLabels = (labels: string[]): string[] => labels.filter((l) => !SYSTEM_LABELS.test(l))
