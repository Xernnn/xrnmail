import { describe, expect, it } from 'vitest'
import { laterChoices } from '@shared/later'

/** Each choice as "name: day hh:mm", in this laptop's time. */
const read = (now: Date): string[] => laterChoices(now).map(([name, at]) => {
  const when = new Date(at)
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][when.getDay()]
  return `${name}: ${day} ${when.getDate()} ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`
})

// 2026-11-11 is a Wednesday.
describe('the times offered for snoozing and sending later', () => {
  it('on a weekday morning: three hours on, tomorrow, Saturday and Monday, at nine', () => {
    expect(read(new Date(2026, 10, 11, 10, 0))).toEqual([
      'Later today: Wed 11 13:00', 'Tomorrow: Thu 12 09:00', 'This weekend: Sat 14 09:00', 'Next week: Mon 16 09:00'
    ])
  })

  it('offers later today only while three hours on is still today', () => {
    expect(read(new Date(2026, 10, 11, 20, 59))[0]).toBe('Later today: Wed 11 23:59')
    expect(read(new Date(2026, 10, 11, 23, 21)).map((line) => line.split(':')[0])).toEqual(['Tomorrow', 'This weekend', 'Next week'])
    expect(read(new Date(2026, 10, 11, 21, 0)).some((line) => line.startsWith('Later today'))).toBe(false)
  })

  it('calls Saturday next weekend while it is already the weekend', () => {
    expect(read(new Date(2026, 10, 14, 10, 0))).toContain('Next weekend: Sat 21 09:00') // a Saturday
    expect(read(new Date(2026, 10, 15, 10, 0))).toContain('Next weekend: Sat 21 09:00') // a Sunday
    expect(read(new Date(2026, 10, 15, 10, 0)).some((line) => line.startsWith('This weekend'))).toBe(false)
  })
})
