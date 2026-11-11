import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent, type ReactNode, type WheelEvent } from 'react'
import { plainName } from '@shared/names'
import { chipLabel, readRecipient, splitRecipients } from '@shared/recipients'
import { Archive, CalendarRange, Clock, Mail, MailMinus, MailOpen, Package, Paperclip, Plane, Receipt, Star, Trash2, Undo2, type LucideIcon } from 'lucide-react'
import type { AccountView, Draft, Facts, MailAction, Overview, Subscription, SwipeAction, ThreadRow } from '@shared/types'
import { Avatar, Empty } from './Common'
import { clock, factLine, longTime, peopleLine, problem, shortTime } from './format'
import { IconButton } from './Menus'

const SWIPE_FAR = 150
/** How far a swipe has to go before letting go means it. */
const SWIPE_COMMIT = 86
const SWIPE_SETTLE_MS = 130

const SWIPE_LOOK: Record<Exclude<SwipeAction, 'none'>, { icon: LucideIcon; tone: string }> = {
  archive: { icon: Archive, tone: 'swipe-archive' },
  trash: { icon: Trash2, tone: 'swipe-trash' },
  read: { icon: MailOpen, tone: 'swipe-read' },
  star: { icon: Star, tone: 'swipe-star' },
  snooze: { icon: Clock, tone: 'swipe-snooze' }
}

const FACT_ICONS: Record<Facts['type'], LucideIcon> = { package: Package, travel: Plane, money: Receipt, event: CalendarRange }

/** The headline of an Assistant entry, and what's most worth seeing next to it. */
function factHead(facts: Facts): { title: string; side: string } {
  switch (facts.type) {
    case 'package': return { title: facts.carrier || 'Package', side: facts.arrives ? shortTime(facts.arrives) : '' }
    case 'travel': return { title: facts.title || 'Trip', side: facts.when ? shortTime(facts.when) : '' }
    case 'money': return { title: facts.merchant || (facts.what === 'bill' ? 'Bill' : 'Receipt'), side: facts.amount }
    case 'event': return { title: facts.title || 'Event', side: facts.start ? shortTime(facts.start) : '' }
  }
}

export function Row(props: {
  row: ThreadRow
  account: AccountView | undefined
  own: string[]
  /** Several accounts share this list, so each row says whose it is. */
  many: boolean
  bins: boolean
  /** Showing what the Assistant found, not who wrote. */
  assistant: boolean
  on: boolean
  picked: boolean
  swipeLeft: SwipeAction
  swipeRight: SwipeAction
  open(): void
  pick(event: MouseEvent): void
  act(action: MailAction, label?: string): void
  snooze(): void
  swiped(action: SwipeAction): void
  menu(x: number, y: number): void
  drag(event: DragEvent): void
}): ReactNode {
  const { row, account, own, many, bins, assistant, on, picked, open, pick, act, swiped, drag } = props
  const [shift, setShift] = useState(0)
  const moved = useRef(0)
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const swipes = !bins && !picked

  useEffect(() => () => { if (settle.current) clearTimeout(settle.current) }, [])
  // Moving with j and k keeps the open thread in sight.
  useEffect(() => { if (on) box.current?.scrollIntoView({ block: 'nearest' }) }, [on])

  const wheel = (event: WheelEvent): void => {
    if (!swipes || Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return
    moved.current = Math.max(-SWIPE_FAR, Math.min(SWIPE_FAR, moved.current - event.deltaX))
    setShift(moved.current)
    if (settle.current) clearTimeout(settle.current)
    settle.current = setTimeout(() => {
      const went = moved.current
      moved.current = 0
      setShift(0)
      if (Math.abs(went) >= SWIPE_COMMIT) swiped(went > 0 ? props.swipeRight : props.swipeLeft)
    }, SWIPE_SETTLE_MS)
  }

  const action = shift > 0 ? props.swipeRight : props.swipeLeft
  const look = shift !== 0 && action !== 'none' ? SWIPE_LOOK[action] : null
  const LookIcon = look?.icon
  const facts = assistant ? row.facts : null
  const FactIcon = facts ? FACT_ICONS[facts.type] : null
  const head = facts ? factHead(facts) : null
  const style: CSSProperties | undefined = shift !== 0 ? { transform: `translateX(${shift}px)`, transition: 'none' } : undefined
  const names = peopleLine(row.people.length > 0 ? row.people : [{ name: row.fromName, address: row.fromAddress }], own)
  const unread = row.unread > 0
  const stateClass = `${on ? 'on' : ''} ${unread ? 'unread' : ''} ${picked ? 'picked' : ''}`
  const files = row.file ? `Has attachment: ${plainName(row.file)}${row.files > 1 ? ` and ${row.files - 1} more` : ''}` : 'Has attachment'

  return (
    <div ref={box} className={`thread ${stateClass}`} draggable onDragStart={drag} onWheel={wheel}
      onContextMenu={(e) => { e.preventDefault(); props.menu(e.clientX, e.clientY) }}>
      {look && LookIcon && (
        <div className={`swipe-under ${look.tone} ${shift > 0 ? 'from-left' : 'from-right'} ${Math.abs(shift) >= SWIPE_COMMIT ? 'ready' : ''}`}>
          <LookIcon size={18} aria-hidden="true" />
        </div>
      )}
      <div className="thread-card" style={style}>
        {many && account && <span className="account-mark" style={{ background: account.color }} title={account.email} aria-hidden="true" />}
        {unread && <span className="unread-dot" aria-hidden="true" />}
        <span className="face">
          {facts && FactIcon
            ? <span className={`fact-tile fact-${facts.type}`} aria-hidden="true"><FactIcon size={18} /></span>
            : <Avatar name={row.fromName} address={row.fromAddress} />}
          <input type="checkbox" className="pick" aria-label={`Select ${row.subject}`} checked={picked} onClick={pick} readOnly />
        </span>
        <button className="thread-open" onClick={(e) => (e.ctrlKey || e.metaKey || e.shiftKey ? pick(e) : open())}>
          <span className="thread-top">
            {unread && <span className="sr-only">Unread, </span>}
            <span className="sender">{head ? head.title : names}</span>
            {!head && row.count > 1 && <span className="count">{row.count}</span>}
            <time dateTime={new Date(row.date).toISOString()}>{head?.side || shortTime(row.date)}</time>
          </span>
          <span className="thread-mid">
            <span className="subject">{row.subject || 'No subject'}</span>
            {row.starred && <Star className="mark star" size={13} aria-label="Starred" />}
            {row.attachment && <Paperclip className="mark" size={13} aria-label={files} />}
          </span>
          <span className="snippet">{row.facts ? factLine(row.facts) : row.snippet || ' '}</span>
        </button>
        <span className="row-actions">
          {bins ? (
            <IconButton icon={Undo2} label="Move to Inbox" click={() => act({ kind: 'inbox' }, 'Moved to Inbox')} />
          ) : (
            <>
              <IconButton icon={Archive} label="Archive" click={() => act({ kind: 'archive' }, 'Archived')} />
              <IconButton icon={Trash2} label="Delete" click={() => act({ kind: 'trash' }, 'Moved to Trash')} />
              <IconButton icon={unread ? MailOpen : Mail} label={unread ? 'Mark read' : 'Mark unread'} click={() => act({ kind: unread ? 'read' : 'unread' })} />
              <IconButton icon={Star} label={row.starred ? 'Remove star' : 'Star'} on={row.starred} click={() => act({ kind: row.starred ? 'unstar' : 'star' })} />
              <IconButton icon={Clock} label="Snooze" click={props.snooze} />
            </>
          )}
        </span>
      </div>
    </div>
  )
}

export function DraftRow(props: { draft: Draft; open(): void; discard(): void }): ReactNode {
  const { draft, open, discard } = props
  const people = splitRecipients(draft.to).map(readRecipient)
  const first = people[0]
  const status = draft.error ?? (draft.state === 'queued' && draft.sendAt ? `Sends ${longTime(draft.sendAt)}` : '')
  return (
    <div className={draft.error ? 'thread problem' : 'thread'}>
      <div className="thread-card">
        <span className="face"><Avatar name={first?.name ?? ''} address={first?.address ?? draft.account} /></span>
        <button className="thread-open" onClick={open}>
          <span className="thread-top">
            <span className="sender">{people.map(chipLabel).join(', ') || 'No recipients'}</span>
            <time dateTime={new Date(draft.updated).toISOString()}>{shortTime(draft.updated)}</time>
          </span>
          <span className="thread-mid"><span className="subject">{draft.subject || 'No subject'}</span></span>
          <span className="snippet">{status || draft.text.slice(0, 120) || ' '}</span>
        </button>
        <span className="row-actions">
          <IconButton icon={Trash2} label={`Discard ${draft.subject || 'draft'}`} click={discard} />
        </span>
      </div>
    </div>
  )
}

/** Everyone mailing you in bulk, biggest first, with the way out next to each. */
export function Subscriptions(props: { version: number; unsubscribe(message: number): void; clear(item: Subscription): void }): ReactNode {
  const [items, setItems] = useState<Subscription[] | null>(null)
  useEffect(() => {
    void window.mail.subscriptions().then(setItems)
  }, [props.version])
  if (items === null) return null
  if (items.length === 0) return <Empty icon={MailMinus} title="No subscriptions" note="Newsletters and offers show up here, ready to leave." />
  return (
    <>
      {items.map((item) => (
        <div className="subscription" key={`${item.account}/${item.address}`}>
          <Avatar name={item.name} address={item.address} />
          <div className="grow">
            <strong>{item.name || item.address}</strong>
            <div className="muted note">{item.address}</div>
            <div className="muted note">{item.count === 1 ? '1 message' : `${item.count} messages`} · {shortTime(item.latest)}</div>
          </div>
          <div className="subscription-actions">
            <button className="pill" onClick={() => props.unsubscribe(item.message)}>Unsubscribe</button>
            <button className="pill danger" aria-label={`Delete all from ${item.address}`} onClick={() => props.clear(item)}>Delete all</button>
          </div>
        </div>
      ))}
    </>
  )
}

/** When mail lands next. Delivering early is possible, on purpose not instant. */
export function BatchStrip({ overview }: { overview: Overview }): ReactNode {
  const [left, setLeft] = useState<number | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (left === null || left === 0) return undefined
    const timer = setTimeout(() => setLeft(left - 1), 1000)
    return () => clearTimeout(timer)
  }, [left])

  const begin = async (): Promise<void> => {
    try {
      setError('')
      setLeft(await window.mail.beginEarly())
    } catch (e) {
      setError(problem(e))
    }
  }

  const finish = async (): Promise<void> => {
    try {
      await window.mail.finishEarly()
    } catch (e) {
      setError(problem(e))
    }
    setLeft(null)
  }

  if (overview.nextBatch === null) return null
  const canAsk = overview.held > 0 && overview.earlyLeft > 0
  return (
    <div className="batch">
      <Clock size={13} aria-hidden="true" />
      <span className="batch-words">
        Next delivery <strong>{clock(overview.nextBatch)}</strong>
        {overview.held > 0 && <span> · {overview.held} waiting</span>}
      </span>
      {error && <span className="error">{error}</span>}
      {left === null && canAsk && <><span aria-hidden="true">·</span><button className="link" onClick={() => void begin()}>Deliver now</button></>}
      {left !== null && left > 0 && <><span aria-hidden="true">·</span><button className="link" onClick={() => setLeft(null)}>Cancel {left}</button></>}
      {left === 0 && <button className="pill strong" onClick={() => void finish()}>Deliver {overview.held}</button>}
    </div>
  )
}
