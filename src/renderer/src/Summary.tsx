import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronRight, Newspaper } from 'lucide-react'
import type { Overview, SummarySettings } from '@shared/types'
import { clock, dayGroup } from './format'

/** The Subscription Summary as the page shows it: when it lands, the choice of when, and the notices
 *  that one has. What it holds and when it lands is the main process's business. */

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** Edison's three suggested times, then any other. */
const SUGGESTED: [string, string][] = [['08:00', 'Morning'], ['12:00', 'Afternoon'], ['18:00', 'Evening']]

/** "HH:MM" as the app's clock writes times. */
const atTime = (time: string): string => {
  const [hour, minute] = time.split(':').map(Number)
  return clock(new Date(2000, 0, 3, hour ?? 8, minute ?? 0).getTime())
}

/** "Delivered daily at 08:00", or "every Monday at 08:00". */
export const scheduleWords = (summary: SummarySettings): string =>
  `Delivered ${summary.every === 'weekly' ? `every ${DAYS[summary.day] ?? 'Monday'}` : 'daily'} at ${atTime(summary.time)}`

/** When a Summary landed, for a heading: "Today, 08:00", "Yesterday, 08:00", or the day. */
export function landedWords(at: number, now = Date.now()): string {
  const group = dayGroup(at, now)
  const day = group === 'Today' || group === 'Yesterday' ? group : new Date(at).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })
  return `${day}, ${clock(at)}`
}

/** Daily or weekly, which day, and what time: the same controls in Settings and on first use. */
export function SummarySchedule(props: { summary: SummarySettings; set(summary: SummarySettings): void }): ReactNode {
  const { summary, set } = props
  const suggested = SUGGESTED.some(([time]) => time === summary.time)
  const [picking, setPicking] = useState(!suggested)
  return (
    <div className="schedule">
      <div className="schedule-row">
        <span className="schedule-name">Schedule</span>
        <span className="segments" role="group" aria-label="How often">
          {(['daily', 'weekly'] as const).map((every) => (
            <button key={every} type="button" className={summary.every === every ? 'segment on' : 'segment'} aria-pressed={summary.every === every}
              onClick={() => set({ ...summary, every })}>{every === 'daily' ? 'Daily' : 'Weekly'}</button>
          ))}
        </span>
      </div>
      {summary.every === 'weekly' && (
        <label className="inline">
          On
          <select aria-label="Summary day" value={summary.day} onChange={(e) => set({ ...summary, day: Number(e.target.value) })}>
            {[1, 2, 3, 4, 5, 6, 0].map((day) => <option key={day} value={day}>{DAYS[day]}</option>)}
          </select>
        </label>
      )}
      <div className="schedule-times" role="radiogroup" aria-label="Time">
        {SUGGESTED.map(([time, name]) => (
          <label className="schedule-time" key={time}>
            <span className="grow">{name} {atTime(time)}{time === '08:00' ? ' (default)' : ''}</span>
            <input type="radio" name="summary-time" checked={!picking && summary.time === time}
              onChange={() => { setPicking(false); set({ ...summary, time }) }} />
          </label>
        ))}
        <label className="schedule-time">
          <span className="grow">Pick a time</span>
          {picking && <input type="time" aria-label="Summary time" value={summary.time} onChange={(e) => { if (e.target.value) set({ ...summary, time: e.target.value }) }} />}
          <input type="radio" name="summary-time" aria-label="Pick a time" checked={picking} onChange={() => setPicking(true)} />
        </label>
      </div>
    </div>
  )
}

/** Asked the first time a sender goes into the Summary, as Edison asks: when should it land? */
export function ScheduleDialog(props: { summary: SummarySettings; done(summary: SummarySettings | null): void }): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null)
  const [summary, setSummary] = useState(props.summary)
  useEffect(() => dialog.current?.showModal(), [])
  return (
    <dialog ref={dialog} className="confirm schedule-dialog" aria-label="When your Summary arrives" onCancel={() => props.done(null)}>
      <h2>When should your Summary arrive?</h2>
      <p className="muted">Its senders' new mail waits, and comes together at this time.</p>
      <SummarySchedule summary={summary} set={setSummary} />
      <div className="confirm-end">
        <button className="quiet" onClick={() => props.done(null)}>Cancel</button>
        <button className="primary" autoFocus onClick={() => props.done({ ...summary, chosen: true })}>Schedule</button>
      </div>
    </dialog>
  )
}

/** Edison's blue bar over the Summary: when it lands, and Change. */
export function SummaryBar(props: { summary: SummarySettings; overview: Overview | null; change(): void }): ReactNode {
  const { summary } = props
  const waiting = props.overview?.summary.held ?? 0
  const next = props.overview?.summary.next ?? null
  return (
    <div className="summary-bar">
      <span className="grow summary-bar-words">
        {summary.senders.length > 0 ? scheduleWords(summary) : 'No senders yet'}
        {next !== null && waiting > 0 && <span className="muted"> · {waiting} waiting for {landedWords(next)}</span>}
      </span>
      <button className="link" onClick={props.change}>Change</button>
    </div>
  )
}

/** "Latest Summary", at the top of the Summary side of Subscriptions. */
export function LatestSummary(props: { open(): void; overview: Overview | null }): ReactNode {
  const latest = props.overview?.summary.latest ?? null
  return (
    <button className="latest-summary" onClick={props.open}>
      <Newspaper size={20} aria-hidden="true" />
      <span className="grow">
        <strong>Latest Summary</strong>
        <span className="muted note">{latest ? `Landed ${landedWords(latest.at)}` : 'Nothing has landed yet'}</span>
      </span>
      <ChevronRight size={16} aria-hidden="true" />
    </button>
  )
}

/** At the top of the inbox while the last Summary has something unread: one entry for all it brought. */
export function SummaryNotice(props: { overview: Overview; open(): void }): ReactNode {
  const latest = props.overview.summary.latest
  if (!latest || latest.unread === 0) return null
  const named = latest.senders.slice(0, 2).join(', ')
  const others = latest.senders.length - 2
  return (
    <button className="summary-notice" onClick={props.open}>
      <span className="summary-notice-mark" aria-hidden="true"><Newspaper size={18} /></span>
      <span className="grow summary-notice-words">
        <strong>Your Summary</strong> <span className="muted">· {landedWords(latest.at)}</span>
        <span className="summary-notice-who">
          {latest.unread === 1 ? '1 thread' : `${latest.unread} threads`} from {named}{others > 0 ? ` and ${others} more` : ''}
        </span>
      </span>
      <span className="link">Open</span>
    </button>
  )
}
