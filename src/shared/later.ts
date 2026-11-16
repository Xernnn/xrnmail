/** The times offered for snoozing a thread and for sending later, and what each of them means. */

const HOUR_MS = 3_600_000

/** What the choices mean, as Settings set them: hours of the day, and days of the week from 0 for
 *  Sunday. */
export interface LaterTimes {
  /** Later today is this many hours on. */
  laterHours: number
  /** This evening, at this hour. */
  evening: number
  /** Tomorrow, at this hour. */
  tomorrow: number
  /** The weekend: this day (Saturday or Sunday), at this hour. */
  weekendDay: number
  weekend: number
  /** Next week: this day, at this hour. */
  weekDay: number
  week: number
}

export const DEFAULT_LATER: LaterTimes = { laterHours: 3, evening: 18, tomorrow: 9, weekendDay: 6, weekend: 9, weekDay: 1, week: 9 }

const whole = (value: unknown, low: number, high: number, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(low, Math.min(high, Math.round(value))) : fallback

/** Times as saved or sent, made whole: each in its range, and anything missing as it starts out. */
export function cleanLater(value: unknown): LaterTimes {
  const saved = value && typeof value === 'object' ? (value as Partial<Record<keyof LaterTimes, unknown>>) : {}
  return {
    laterHours: whole(saved.laterHours, 1, 12, DEFAULT_LATER.laterHours),
    evening: whole(saved.evening, 12, 23, DEFAULT_LATER.evening),
    tomorrow: whole(saved.tomorrow, 0, 23, DEFAULT_LATER.tomorrow),
    weekendDay: saved.weekendDay === 0 ? 0 : 6,
    weekend: whole(saved.weekend, 0, 23, DEFAULT_LATER.weekend),
    weekDay: whole(saved.weekDay, 0, 6, DEFAULT_LATER.weekDay),
    week: whole(saved.week, 0, 23, DEFAULT_LATER.week)
  }
}

/** Each choice's name and time, from [now], soonest first. A name only says what's true of its time:
 *  late in the day the hours on are tomorrow, so there's no later today, nor this evening once it has
 *  come, and on a Saturday or a Sunday the weekend to come is next weekend. */
export function laterChoices(now: Date, times: LaterTimes = DEFAULT_LATER): [string, number][] {
  const at = (days: number, hour: number): number => new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, hour).getTime()
  const daysTo = (day: number): number => (day - now.getDay() + 7) % 7 || 7
  const later = new Date(now.getTime() + times.laterHours * HOUR_MS)
  const evening = at(0, times.evening)
  const toWeekend = daysTo(times.weekendDay)
  // On a Saturday, a Sunday tomorrow is still this weekend.
  const nextWeekend = (now.getDay() === 6 || now.getDay() === 0) && toWeekend > 1
  const choices: [string, number][] = [
    ...(later.getDate() === now.getDate() ? [['Later today', later.getTime()] as [string, number]] : []),
    ...(evening > now.getTime() ? [['This evening', evening] as [string, number]] : []),
    ['Tomorrow', at(1, times.tomorrow)],
    [nextWeekend ? 'Next weekend' : 'This weekend', at(toWeekend, times.weekend)],
    ['Next week', at(daysTo(times.weekDay), times.week)]
  ]
  return choices.sort(([, a], [, b]) => a - b)
}
