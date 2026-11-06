import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Calendar, CalendarClock, CalendarDays, Sun, Sunset, type LucideIcon } from 'lucide-react'
import { longTime } from './format'

export function IconButton(props: { icon: LucideIcon; label: string; on?: boolean; hint?: string; click(): void }): ReactNode {
  const Icon = props.icon
  const title = props.hint ? `${props.label} (${props.hint})` : props.label
  return (
    <button type="button" className={props.on ? 'icon on' : 'icon'} aria-label={props.label} title={title} onClick={props.click}>
      <Icon size={17} aria-hidden="true" />
    </button>
  )
}

/** A panel under a button that goes away on Escape or a click elsewhere. */
export function Popover(props: { close(): void; up?: boolean; right?: boolean; children: ReactNode }): ReactNode {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const away = (event: MouseEvent): void => {
      if (!box.current?.contains(event.target as Node)) props.close()
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      props.close()
    }
    document.addEventListener('mousedown', away)
    window.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('mousedown', away)
      window.removeEventListener('keydown', escape, true)
    }
  }, [props.close])
  return <div ref={box} className={`popover ${props.up ? 'up' : ''} ${props.right ? 'right' : ''}`}>{props.children}</div>
}

const HOUR_MS = 3_600_000

const WHEN_ICONS: Record<string, LucideIcon> = {
  'Later today': Sunset, Tomorrow: Sun, 'This weekend': CalendarDays, 'Next week': Calendar
}

function laterChoices(now: Date): [string, number][] {
  const at = (days: number): number => new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, 9).getTime()
  const toSaturday = (6 - now.getDay() + 7) % 7 || 7
  const toMonday = (8 - now.getDay()) % 7 || 7
  return [
    ['Later today', now.getTime() + 3 * HOUR_MS],
    ['Tomorrow', at(1)],
    ['This weekend', at(toSaturday)],
    ['Next week', at(toMonday)]
  ]
}

/** "When?", for snoozing and for sending later. */
export function TimeMenu(props: { title: string; extra?: [string, number][]; up?: boolean; right?: boolean; pick(at: number): void; close(): void }): ReactNode {
  const [custom, setCustom] = useState('')
  const choices = [...(props.extra ?? []), ...laterChoices(new Date())].filter(
    ([, at], i, all) => all.findIndex(([, other]) => other === at) === i // on a Friday, tomorrow is the weekend
  )
  const when = custom ? new Date(custom).getTime() : NaN
  return (
    <Popover close={props.close} up={props.up} right={props.right}>
      <h4>{props.title}</h4>
      {choices.map(([label, at]) => (
        <button type="button" key={label} className="menu-item" onClick={() => props.pick(at)}>
          {(() => {
            const Icon = WHEN_ICONS[label] ?? CalendarClock
            return <Icon size={15} aria-hidden="true" />
          })()}
          <span className="grow">{label}</span>
          <span className="muted">{longTime(at)}</span>
        </button>
      ))}
      <div className="menu-row">
        <input type="datetime-local" aria-label="Pick a time" value={custom} onChange={(e) => setCustom(e.target.value)} />
        <button type="button" className="quiet" disabled={Number.isNaN(when)} onClick={() => props.pick(when)}>Set</button>
      </div>
    </Popover>
  )
}

export function LabelMenu(props: { labels: string[]; active: string[]; set(label: string, add: boolean): void; close(): void }): ReactNode {
  const [name, setName] = useState('')
  const all = [...new Set([...props.labels, ...props.active.filter((l) => !l.startsWith('\\'))])].sort()
  const create = (): void => {
    const label = name.trim()
    if (!label) return
    props.set(label, true)
    setName('')
  }
  return (
    <Popover close={props.close}>
      <h4>Labels</h4>
      {all.map((label) => (
        <label key={label} className="menu-item">
          <input type="checkbox" checked={props.active.includes(label)} onChange={(e) => props.set(label, e.target.checked)} />
          <span className="grow">{label}</span>
        </label>
      ))}
      <div className="menu-row">
        <input aria-label="New label" placeholder="New label" value={name} onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') create() }} />
        <button type="button" className="quiet" disabled={!name.trim()} onClick={create}>Add</button>
      </div>
    </Popover>
  )
}

/** Where a folder account files mail: one place at a time, unlike a label. */
export function FolderMenu(props: { folders: string[]; pick(folder: string): void; close(): void }): ReactNode {
  return (
    <Popover close={props.close}>
      <h4>Move to</h4>
      {props.folders.map((folder) => (
        <button type="button" key={folder} className="menu-item" onClick={() => props.pick(folder)}>{folder}</button>
      ))}
      {props.folders.length === 0 && <p className="muted note menu-note">No folders of your own yet.</p>}
    </Popover>
  )
}
