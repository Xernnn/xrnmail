import { describe, expect, it } from 'vitest'
import { cleanLater, DEFAULT_LATER, laterChoices, type LaterTimes } from '@shared/later'

/** Each choice as "name: day hh:mm", in this laptop's time. */
const read = (now: Date, times?: LaterTimes): string[] => laterChoices(now, times).map(([name, at]) => {
  const when = new Date(at)
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][when.getDay()]
  return `${name}: ${day} ${when.getDate()} ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`
})

// 2026-11-11 is a Wednesday.
describe('the times offered for snoozing and sending later', () => {
  it('on a weekday morning: three hours on, this evening, tomorrow, Saturday and Monday, at nine', () => {
    expect(read(new Date(2026, 10, 11, 10, 0))).toEqual([
      'Later today: Wed 11 13:00', 'This evening: Wed 11 18:00', 'Tomorrow: Thu 12 09:00', 'This weekend: Sat 14 09:00', 'Next week: Mon 16 09:00'
    ])
  })

  it('offers later today only while three hours on is still today, and this evening only before it comes', () => {
    expect(read(new Date(2026, 10, 11, 20, 59))[0]).toBe('Later today: Wed 11 23:59')
    expect(read(new Date(2026, 10, 11, 23, 21)).map((line) => line.split(':')[0])).toEqual(['Tomorrow', 'This weekend', 'Next week'])
    expect(read(new Date(2026, 10, 11, 21, 0)).some((line) => line.startsWith('Later today'))).toBe(false)
    expect(read(new Date(2026, 10, 11, 18, 0)).some((line) => line.startsWith('This evening'))).toBe(false)
    // Soonest first, whichever that is.
    expect(read(new Date(2026, 10, 11, 16, 30)).slice(0, 2)).toEqual(['This evening: Wed 11 18:00', 'Later today: Wed 11 19:30'])
  })

  it('calls the weekend next weekend while it is already the weekend', () => {
    expect(read(new Date(2026, 10, 14, 10, 0))).toContain('Next weekend: Sat 21 09:00') // a Saturday
    expect(read(new Date(2026, 10, 15, 10, 0))).toContain('Next weekend: Sat 21 09:00') // a Sunday
    expect(read(new Date(2026, 10, 15, 10, 0)).some((line) => line.startsWith('This weekend'))).toBe(false)
  })

  it('means what Settings say: how many hours later today is, and the hour and day of the rest', () => {
    const mine: LaterTimes = { laterHours: 1, evening: 20, tomorrow: 7, weekendDay: 0, weekend: 10, weekDay: 2, week: 8 }
    expect(read(new Date(2026, 10, 11, 10, 0), mine)).toEqual([
      'Later today: Wed 11 11:00', 'This evening: Wed 11 20:00', 'Tomorrow: Thu 12 07:00', 'This weekend: Sun 15 10:00', 'Next week: Tue 17 08:00'
    ])
    // A week from the day it is, when it's the day asked for.
    expect(read(new Date(2026, 10, 17, 6, 0), mine)).toContain('Next week: Tue 24 08:00')
    // On a Saturday, the Sunday after is still this weekend; on that Sunday, the next one isn't.
    expect(read(new Date(2026, 10, 14, 10, 0), mine)).toContain('This weekend: Sun 15 10:00')
    expect(read(new Date(2026, 10, 15, 10, 0), mine)).toContain('Next weekend: Sun 22 10:00')
  })

  it('reads back only times that could have been set', () => {
    expect(cleanLater(null)).toEqual(DEFAULT_LATER)
    expect(cleanLater({ laterHours: 40, evening: 3, tomorrow: 7.4, weekendDay: 3, weekend: 'x', weekDay: -2, week: 30 }))
      .toEqual({ laterHours: 12, evening: 12, tomorrow: 7, weekendDay: 6, weekend: 9, weekDay: 0, week: 23 })
    expect(cleanLater({ weekendDay: 0 }).weekendDay).toBe(0)
  })
})
