import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent, type ReactNode, type WheelEvent } from 'react'
import { plainName } from '@shared/names'
import { openRate, sortSenders, type SenderOrder } from '@shared/senders'
import { chipLabel, readRecipient, splitRecipients } from '@shared/recipients'
import { Archive, Check, Clock, DollarSign, Flag, ListChecks, Mail, MailOpen, Newspaper, OctagonAlert, Paperclip, Pin, Plane, Ticket, Trash2, Truck, Undo2, type LucideIcon } from 'lucide-react'
import type { AccountView, Draft, Facts, MailAction, Overview, QuickAction, Subscription, SwipeAction, ThreadRow } from '@shared/types'
import { Avatar, Empty, ImportantMark, KIND_ICONS } from './Common'
import { wantFaces } from './pictures'
import { clock, comesBack, factLine, fileKind, longTime, peopleLine, problem, shortTime } from './format'
import { IconButton } from './Menus'

const SWIPE_FAR = 240
/** How far a swipe has to go before letting go means it, and how far for the second thing it can do. */
const SWIPE_COMMIT = 86
const SWIPE_LONG = 180
const SWIPE_SETTLE_MS = 130

/** What a swipe does each way: a short one, and a long one. */
export interface Swipes { left: SwipeAction; leftLong: SwipeAction; right: SwipeAction; rightLong: SwipeAction }
export const NO_SWIPES: Swipes = { left: 'none', leftLong: 'none', right: 'none', rightLong: 'none' }

/** A long swipe with nothing of its own does what the short one does. */
export function swipeAction(moved: number, swipe: Swipes): SwipeAction {
  const long = Math.abs(moved) >= SWIPE_LONG
  if (Math.abs(moved) < SWIPE_COMMIT) return 'none'
  if (moved > 0) return long && swipe.rightLong !== 'none' ? swipe.rightLong : swipe.right
  return long && swipe.leftLong !== 'none' ? swipe.leftLong : swipe.left
}

const SWIPE_LOOK: Record<Exclude<SwipeAction, 'none'>, { icon: LucideIcon; tone: string }> = {
  archive: { icon: Archive, tone: 'swipe-archive' },
  trash: { icon: Trash2, tone: 'swipe-trash' },
  read: { icon: MailOpen, tone: 'swipe-read' },
  star: { icon: Flag, tone: 'swipe-star' },
  snooze: { icon: Clock, tone: 'swipe-snooze' }
}

const FACT_ICONS: Record<Facts['type'], LucideIcon> = { package: Truck, travel: Plane, money: DollarSign, event: Ticket }


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
  /** In Snoozed, where the time is when it comes back. */
  snoozed?: boolean
  on: boolean
  picked: boolean
  swipe: Swipes
  /** Whether the thread's files show as cards under the row. */
  cards: boolean
  /** Whether Gmail's importance shows, where Gmail has marked the thread. */
  importance: boolean
  /** The buttons that show under the pointer, in order. */
  quick: QuickAction[]
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
  // Everyone the row names is looked up now, so opening the thread asks nothing. A warned sender isn't.
  const everyone = row.people.map((who) => who.address).filter((address) => !row.warned || address.toLowerCase() !== row.fromAddress.toLowerCase())
  useEffect(() => wantFaces(everyone), [everyone.join()])
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
      const action = swipeAction(went, props.swipe)
      if (action !== 'none') swiped(action)
    }, SWIPE_SETTLE_MS)
  }

  // Under the row: what letting go now would do, or before that what a short swipe will.
  const action = Math.abs(shift) >= SWIPE_COMMIT ? swipeAction(shift, props.swipe) : shift > 0 ? props.swipe.right : props.swipe.left
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

  const quick = (kind: QuickAction): ReactNode => {
    switch (kind) {
      case 'archive': return <IconButton key={kind} icon={Check} label="Archive" click={() => act({ kind: 'archive' }, 'Archived')} />
      case 'flag': return <IconButton key={kind} icon={Flag} label={row.starred ? 'Remove flag' : 'Flag'} on={row.starred} click={() => act({ kind: row.starred ? 'unstar' : 'star' })} />
      case 'trash': return <IconButton key={kind} icon={Trash2} label="Delete" click={() => act({ kind: 'trash' }, 'Moved to Trash')} />
      case 'read': return <IconButton key={kind} icon={unread ? MailOpen : Mail} label={unread ? 'Mark read' : 'Mark unread'} click={() => act({ kind: unread ? 'read' : 'unread' })} />
      case 'snooze': return <IconButton key={kind} icon={Clock} label="Snooze" click={props.snooze} />
      case 'spam': return <IconButton key={kind} icon={OctagonAlert} label="Report spam" click={() => act({ kind: 'spam' }, 'Reported as spam')} />
      case 'none': return null
    }
  }
  const shown = bins ? [] : [...new Set(props.quick)].filter((kind) => kind !== 'none')

  return (
    <div ref={box} className={`thread ${stateClass}`} data-account={row.account} data-thread={row.thread} draggable onDragStart={drag} onWheel={wheel}
      onContextMenu={(e) => { e.preventDefault(); props.menu(e.clientX, e.clientY) }}>
      {look && LookIcon && (
        <div className={`swipe-under ${look.tone} ${shift > 0 ? 'from-left' : 'from-right'} ${Math.abs(shift) >= SWIPE_COMMIT ? 'ready' : ''}`}>
          <LookIcon size={18} aria-hidden="true" />
        </div>
      )}
      <div className="thread-card" style={style}>
        {many && account && <span className="account-mark" style={{ background: account.color }} title={account.email} aria-hidden="true" />}
        <span className="face">
          {facts && FactIcon
            ? <span className={`fact-tile fact-${facts.type}`} aria-hidden="true"><FactIcon size={20} /></span>
            : <Avatar name={row.fromName} address={row.fromAddress} size={44} lookUp plain={row.warned} />}
          <input type="checkbox" className="pick" aria-label={`Select ${row.subject}`} checked={picked} onClick={pick} readOnly />
        </span>
        <button className="thread-open" onClick={(e) => (e.ctrlKey || e.metaKey || e.shiftKey ? pick(e) : open())}>
          <span className="thread-top">
            {unread && <span className="unread-dot" aria-hidden="true" />}
            {unread && <span className="sr-only">Unread, </span>}
            <span className="sender">{head ? head.title : <bdi>{plainName(names)}</bdi>}</span>
            {!head && row.count > 1 && <span className="count">({row.count})</span>}
            {props.snoozed && row.snoozedUntil !== null
              ? <time className="back" dateTime={new Date(row.snoozedUntil).toISOString()}><Clock size={11} aria-hidden="true" />{comesBack(row.snoozedUntil)}</time>
              : <time dateTime={new Date(row.date).toISOString()}>{head?.side || shortTime(row.date)}</time>}
          </span>
          <span className="thread-mid">
            <span className="subject">{row.subject || 'No subject'}</span>
            {props.importance && row.important && <ImportantMark className="mark important" label="Important" />}
            {row.starred && <Flag className="mark flag" size={13} aria-label="Flagged" />}
            {row.pinned && <Pin className="mark pin" size={13} aria-label="Pinned" />}
            {row.attachment && <Paperclip className="mark" size={13} aria-label={files} />}
          </span>
          <span className="snippet">{row.facts ? factLine(row.facts) : row.snippet || ' '}</span>
          {props.cards && row.cards.length > 0 && (
            <span className="cards" aria-hidden="true">
              {row.cards.map((name, i) => {
                const kind = fileKind(name)
                const Icon = KIND_ICONS[kind]
                return <span className="card" key={i}><Icon className={`file-${kind}`} size={14} /><span className="card-name">{plainName(name)}</span></span>
              })}
              {row.files > row.cards.length && <span className="card more">+{row.files - row.cards.length}</span>}
            </span>
          )}
        </button>
        {(bins || shown.length > 0) && (
          <span className="row-actions">
            {bins ? <IconButton icon={Undo2} label="Move to Inbox" click={() => act({ kind: 'inbox' }, 'Moved to Inbox')} /> : shown.map(quick)}
          </span>
        )}
      </div>
    </div>
  )
}

export function DraftRow(props: { draft: Draft; account?: AccountView; open(): void; discard(): void }): ReactNode {
  const { draft, account, open, discard } = props
  const people = splitRecipients(draft.to).map(readRecipient)
  const first = people[0]
  const status = draft.error ?? (draft.state === 'queued' && draft.sendAt ? `Sends ${longTime(draft.sendAt)}` : '')
  return (
    <div className={draft.error ? 'thread problem' : 'thread'}>
      <div className="thread-card">
        {account && <span className="account-mark" style={{ background: account.color }} title={account.email} aria-hidden="true" />}
        <span className="face"><Avatar name={first?.name ?? ''} address={first?.address ?? draft.account} size={44} /></span>
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

const keyOfSender = (item: Subscription): string => `${item.account}/${item.address}`

const ORDERS: [SenderOrder, string][] = [['most', 'Most mail'], ['read', 'Open rate'], ['name', 'Name']]

/** Everyone mailing you in bulk, biggest first, with the way out and the Summary next to each; or, on
 *  the other sides, the ones already left, and the ones whose mail waits for the Summary. Each row
 *  says how much of a sender's mail gets read, and opens their page. Several can be picked, by their
 *  tick boxes or with Ctrl or Shift, and put into the Summary or taken out of it together, as
 *  Edison's bar at the foot of the page does. */
export function Subscriptions(props: {
  version: number
  side: 'subscribed' | 'left' | 'summary'
  unsubscribe(message: number): void
  clear(item: Subscription): void
  /** Into the Summary, or out of it. */
  summarize(items: Subscription[], on: boolean): void
  /** A sender's own page. */
  open(item: Subscription): void
  /** What sits over the list on its side. */
  top?: ReactNode
  /** The accounts, to show one's alone when there are several. */
  accounts: AccountView[]
}): ReactNode {
  const { side } = props
  const [found, setItems] = useState<Subscription[] | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [order, setOrder] = useState<SenderOrder>('most')
  const [account, setAccount] = useState('')
  useEffect(() => {
    let current = true
    const asked = side === 'left' ? window.mail.unsubscribed() : side === 'summary' ? window.mail.summarySenders() : window.mail.subscriptions()
    void asked.then((found) => { if (current) setItems(found) })
    return () => { current = false }
  }, [props.version, side])
  useEffect(() => setPicked(new Set()), [side])
  if (found === null) return props.top ?? null
  // Senders with nothing here have no account, and stay in every account's list.
  const items = sortSenders(found.filter((item) => !account || !item.account || item.account === account), order)
  // Only what's still listed can be picked: one taken into the Summary drops off the list.
  const chosen = items.filter((item) => picked.has(keyOfSender(item)))
  const pick = (item: Subscription): void => setPicked((now) => {
    const next = new Set(now)
    if (!next.delete(keyOfSender(item))) next.add(keyOfSender(item))
    return next
  })
  const empty = items.length === 0 && (
    side === 'left' ? <Empty icon={ListChecks} title="Nobody yet" />
      : side === 'summary' ? <Empty icon={Newspaper} title="Nobody in your Summary" />
      : <Empty icon={ListChecks} title="No subscriptions" />
  )
  const count = (item: Subscription): string =>
    item.count === 0 ? 'Nothing from them is left here' : `${item.count === 1 ? '1 message' : `${item.count} messages`} · ${shortTime(item.latest)}`
  const together = (on: boolean): void => {
    props.summarize(chosen, on)
    setPicked(new Set())
  }
  return (
    <>
      {props.top}
      {found.length > 1 && (
        <div className="subscription-tools">
          <label className="inline">
            Sort by
            <select aria-label="Sort by" value={order} onChange={(e) => setOrder(e.target.value as SenderOrder)}>
              {ORDERS.map(([value, name]) => <option key={value} value={value}>{name}</option>)}
            </select>
          </label>
          {props.accounts.length > 1 && (
            <label className="inline">
              Account
              <select aria-label="Account" value={account} onChange={(e) => setAccount(e.target.value)}>
                <option value="">All</option>
                {props.accounts.map((a) => <option key={a.email} value={a.email}>{a.email}</option>)}
              </select>
            </label>
          )}
        </div>
      )}
      {empty}
      {items.map((item) => {
        const key = keyOfSender(item)
        const name = item.name || item.address
        return (
          <div className={picked.has(key) ? 'subscription picked' : 'subscription'} key={key}>
            {side !== 'left' && (
              <input type="checkbox" className={chosen.length > 0 ? 'pick shown' : 'pick'} aria-label={`Select ${item.address}`} checked={picked.has(key)} onChange={() => pick(item)} />
            )}
            <Avatar name={item.name} address={item.address} size={44} lookUp />
            <div className="grow">
              {item.count > 0 && item.account ? (
                <button className="subscription-open" aria-label={`Open ${name}`}
                  onClick={(e) => (e.ctrlKey || e.metaKey || e.shiftKey) && side !== 'left' ? pick(item) : props.open(item)}>
                  <strong>{name}</strong>
                </button>
              ) : <strong>{name}</strong>}
              <div className="muted note">{item.address}</div>
              <div className="muted note">{count(item)}</div>
              <div className="subscription-links">
                {side === 'subscribed' && <button className="link" aria-label={`Unsubscribe from ${item.address}`} onClick={() => props.unsubscribe(item.message)}>Unsubscribe</button>}
                {side === 'subscribed' && <button className="link" aria-label={`Add ${item.address} to Summary`} onClick={() => props.summarize([item], true)}>Add to Summary</button>}
                {side === 'summary' && <button className="link" aria-label={`Remove ${item.address} from Summary`} onClick={() => props.summarize([item], false)}>Remove from Summary</button>}
              </div>
            </div>
            <div className="subscription-actions">
              {item.count > 0 && <span className="open-rate" title={`${item.read} of ${item.count} read`}>{openRate(item)}%</span>}
              {item.count > 0 && <button className="pill danger" aria-label={`Delete all from ${item.address}`} onClick={() => props.clear(item)}>Delete all</button>}
            </div>
          </div>
        )
      })}
      {chosen.length > 0 && <div className="bulk-room" aria-hidden="true" />}
      {chosen.length > 0 && (
        <div className="bulk" role="toolbar" aria-label="Selected senders">
          <div className="bulk-top">
            <strong className="grow">{chosen.length} selected</strong>
            <button className="bulk-pill" onClick={() => setPicked(new Set(items.filter((item) => item.count > 0 || side === 'summary').map(keyOfSender)))}>Select All ({items.length})</button>
            <button className="bulk-pill" onClick={() => setPicked(new Set())}>Cancel</button>
          </div>
          <div className="bulk-tools">
            {side === 'subscribed' && <button className="bulk-action" onClick={() => together(true)}><Newspaper size={16} aria-hidden="true" /> Add to Summary</button>}
            {side === 'summary' && <button className="bulk-action" onClick={() => together(false)}><Newspaper size={16} aria-hidden="true" /> Remove from Summary</button>}
          </div>
        </div>
      )}
    </>
  )
}

/** Edison's page for one sender: how much they send, how much of it is read, and what to do about
 *  them. Their threads are the list under it. */
export function SenderCard(props: {
  item: Subscription
  /** Whose mail waits for the Summary. */
  inSummary: boolean
  /** Left behind already. */
  left: boolean
  back(): void
  unsubscribe(message: number): void
  clear(item: Subscription): void
  summarize(items: Subscription[], on: boolean): void
}): ReactNode {
  const { item } = props
  const facts: [string, string][] = [
    [String(item.count), item.count === 1 ? 'email here' : 'emails here'],
    [String(item.week), 'in the last week'],
    [`${openRate(item)}%`, 'read']
  ]
  return (
    <div className="sender-card">
      <button className="link sender-back" onClick={props.back}>‹ Subscriptions</button>
      <div className="sender-who">
        <Avatar name={item.name} address={item.address} size={56} lookUp />
        <div className="grow">
          <strong>{item.name || item.address}</strong>
          <div className="muted note">{item.address}</div>
        </div>
      </div>
      <dl className="sender-facts" aria-label={`How ${item.name || item.address} sends`}>
        {facts.map(([value, what]) => <div key={what}><dt>{value}</dt><dd>{what}</dd></div>)}
      </dl>
      <div className="sender-actions">
        {!props.left && <button className="pill" onClick={() => props.unsubscribe(item.message)}>Unsubscribe</button>}
        {props.inSummary
          ? <button className="pill" onClick={() => props.summarize([item], false)}>Remove from Summary</button>
          : <button className="pill" onClick={() => props.summarize([item], true)}>Add to Summary</button>}
        <button className="pill danger" onClick={() => props.clear(item)}>Delete all</button>
      </div>
    </div>
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
