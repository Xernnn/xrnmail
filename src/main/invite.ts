import { randomUUID } from 'node:crypto'
import type { Rsvp } from '@shared/types'

/** Calendar invitations: the one part of an .ics an inbox needs, read by hand because they're small
 *  and a stranger wrote them. It never throws, and it only keeps what it can name. */

export interface Invite {
  method: string
  uid: string
  sequence: number
  summary: string
  location: string
  organizer: string
  organizerName: string
  attendees: string[]
  start: number | null
  end: number | null
}

interface Line {
  name: string
  params: Record<string, string>
  value: string
}

const MAX_ICS = 256 * 1024

/** Where a line's value starts: the first colon outside quotes. Counted by hand, because asking a
 *  pattern to look ahead from every colon takes minutes on a line a stranger made for it. */
function valueStart(raw: string): number {
  let quoted = false
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '"') quoted = !quoted
    else if (raw[i] === ':' && !quoted) return i
  }
  return -1
}

function linesOf(text: string): Line[] {
  const unfolded = text.slice(0, MAX_ICS).replace(/\r?\n[ \t]/g, '')
  const found: Line[] = []
  for (const raw of unfolded.split(/\r?\n/)) {
    const colon = valueStart(raw)
    if (colon < 0) continue
    const [name = '', ...params] = raw.slice(0, colon).split(';')
    found.push({
      name: name.toUpperCase(),
      params: Object.fromEntries(params.map((p) => {
        const at = p.indexOf('=')
        return [p.slice(0, at).toUpperCase(), p.slice(at + 1).replace(/^"|"$/g, '')]
      })),
      value: raw.slice(colon + 1)
    })
  }
  return found
}

const unescaped = (value: string): string =>
  value.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1').trim().slice(0, 500)

/** How far ahead of UTC a zone was at a moment, in ms. */
function zoneOffset(at: number, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric'
  }).formatToParts(at)
  const part = (type: string): number => Number(parts.find((p) => p.type === type)?.value)
  return Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second')) - at
}

/** A time in an .ics: UTC with a Z, in a named zone, floating, or a whole day. */
export function icsTime(line: Line | undefined): number | null {
  const m = line && /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/.exec(line.value.trim())
  if (!m) return null
  const [, y, mo, d, h = '0', mi = '0', s = '0', utc] = m
  const wall = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))
  if (utc) return wall
  const zone = line?.params['TZID']
  if (zone) {
    try {
      return wall - zoneOffset(wall - zoneOffset(wall, zone), zone)
    } catch {
      // A zone name only Outlook knows. Its wall clock read as local is closer than nothing.
    }
  }
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)).getTime()
}

const addressIn = (value: string): string => value.replace(/^mailto:/i, '').trim().toLowerCase().slice(0, 320)

export function inviteOf(text: string): Invite | null {
  const lines = linesOf(text)
  const begin = lines.findIndex((l) => l.name === 'BEGIN' && l.value.trim().toUpperCase() === 'VEVENT')
  if (begin < 0) return null
  const after = lines.slice(begin)
  const end = after.findIndex((l) => l.name === 'END' && l.value.trim().toUpperCase() === 'VEVENT')
  const event = end < 0 ? after : after.slice(0, end)
  const field = (name: string): Line | undefined => event.find((l) => l.name === name)
  const organizer = field('ORGANIZER')
  return {
    method: (lines.find((l) => l.name === 'METHOD')?.value ?? '').trim().toUpperCase(),
    uid: (field('UID')?.value ?? '').trim().slice(0, 500),
    sequence: /^\d{1,6}$/.test(field('SEQUENCE')?.value.trim() ?? '') ? Number(field('SEQUENCE')?.value) : 0,
    summary: unescaped(field('SUMMARY')?.value ?? ''),
    location: unescaped(field('LOCATION')?.value ?? ''),
    organizer: addressIn(organizer?.value ?? ''),
    organizerName: unescaped(organizer?.params['CN'] ?? ''),
    attendees: event.filter((l) => l.name === 'ATTENDEE').map((l) => addressIn(l.value)),
    start: icsTime(field('DTSTART')),
    end: icsTime(field('DTEND'))
  }
}

const icsStamp = (at: number): string => new Date(at).toISOString().replace(/[-:]|\.\d{3}/g, '')
const icsText = (value: string): string => value.replace(/[\r\n]+/g, ' ').replace(/([\\;,])/g, '\\$1')

/** What goes back to the organizer. Only the fields the standard asks for in a reply. */
export function replyIcs(invite: { uid: string; sequence: number; summary: string; stamp: string }, attendee: string, answer: Rsvp, now: number): string {
  return [
    'BEGIN:VCALENDAR', 'PRODID:-//xrnmail//EN', 'VERSION:2.0', 'METHOD:REPLY', 'BEGIN:VEVENT',
    `UID:${icsText(invite.uid) || randomUUID()}`,
    `SEQUENCE:${invite.sequence}`,
    `DTSTAMP:${icsStamp(now)}`,
    `DTSTART:${invite.stamp}`,
    `SUMMARY:${icsText(invite.summary)}`,
    `ATTENDEE;PARTSTAT=${answer}:mailto:${attendee}`,
    'END:VEVENT', 'END:VCALENDAR', ''
  ].join('\r\n')
}

export const icsStampOf = (at: number | null): string => (at === null ? '' : icsStamp(at))
