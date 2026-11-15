/** The times offered for snoozing a thread and for sending later. */

const HOUR_MS = 3_600_000

/** Each choice's name and time, from [now]. A name only says what's true of its time: late in the
 *  evening three hours on is tomorrow, so there's no later today, and on a Saturday or a Sunday the
 *  Saturday to come is next weekend's. */
export function laterChoices(now: Date): [string, number][] {
  const at = (days: number): number => new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, 9).getTime()
  const toSaturday = (6 - now.getDay() + 7) % 7 || 7
  const toMonday = (8 - now.getDay()) % 7 || 7
  const later = new Date(now.getTime() + 3 * HOUR_MS)
  const weekend = now.getDay() === 6 || now.getDay() === 0
  return [
    ...(later.getDate() === now.getDate() ? [['Later today', later.getTime()] as [string, number]] : []),
    ['Tomorrow', at(1)],
    [weekend ? 'Next weekend' : 'This weekend', at(toSaturday)],
    ['Next week', at(toMonday)]
  ]
}
