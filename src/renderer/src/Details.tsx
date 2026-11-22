import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Ban, Bell, BellOff, Copy, Hourglass, MoreHorizontal, PenLine, Search, Zap, type LucideIcon } from 'lucide-react'
import type { AccountView, Address, MessageDetails, MessageView } from '@shared/types'
import { fullTime, problem, userLabels } from './format'

/** What can be done with an address from the details, as from the reader's own menus. */
export interface AddressActions {
  write(address: string): void
  /** Searches for what's given. Not there in a window of its own, which has no search. */
  find?(text: string): void
  block(address: string): void
  mute(address: string, on: boolean): void
  muted(address: string): boolean
  /** Null while nothing waits for a delivery. */
  straight: ((address: string, on: boolean) => void) | null
  isStraight(address: string): boolean
  /** Only the address itself can be taken off; a whole @domain is for Settings. */
  listedExactly(address: string): boolean
  say(text: string): void
}

const SYSTEM: Record<string, string> = { '\\Inbox': 'Inbox', '\\Sent': 'Sent', '\\Trash': 'Trash', '\\Spam': 'Spam', '\\Junk': 'Spam', '\\Draft': 'Drafts', '\\Archive': 'Archive' }

/** Where it is: the account's own words for its places, Gmail's labels after them. */
function placesOf(labels: string[]): string {
  const system = labels.map((label) => SYSTEM[label]).filter((name): name is string => Boolean(name))
  const own = userLabels(labels)
  const all = [...new Set([...system, ...own])]
  return all.length > 0 ? all.join(', ') : 'Archive'
}


const WORDS: Record<string, string> = {
  pass: 'pass', fail: 'fail', softfail: 'soft fail', neutral: 'neutral', none: 'none', temperror: 'error', permerror: 'error', policy: 'policy', bestguesspass: 'best guess'
}
const word = (result: string): string => WORDS[result] ?? result

/** A sender's dates more than this far from the server's are worth showing beside them. */
const DATE_GAP_MS = 10 * 60_000
/** What's kept clear under the panel, inside the reader. */
const PANEL_MARGIN = 12
/** Less room than this under the message, and the thread scrolls to make it. */
const PANEL_LEAST = 240
/** As tall as it gets, however much room there is. */
const PANEL_MOST = 620

/** Makes the panel as tall as it may be: down to the foot of what's visible of the thread, and no
 *  further. A message near the bottom of a short window is scrolled up first, so there's room to
 *  read it in; past that, the panel scrolls inside itself. Its height is let go of while this is
 *  worked out, since the thread can only scroll as far as the panel reaches. */
function fitPanel(panel: HTMLElement): void {
  const scroller = panel.closest<HTMLElement>('.messages')
  panel.style.maxHeight = ''
  const foot = (): number => Math.min(scroller?.getBoundingClientRect().bottom ?? window.innerHeight, window.innerHeight) - PANEL_MARGIN
  const wanted = Math.min(panel.scrollHeight, PANEL_LEAST)
  const short = wanted - (foot() - panel.getBoundingClientRect().top)
  if (scroller && short > 0) {
    // The panel floats over the thread, and once it's fitted it no longer reaches past its foot, so
    // a thread too short to scroll that far is given the room at its end while the panel is open.
    const had = parseFloat(scroller.style.getPropertyValue('--details-room')) || 0
    const padding = parseFloat(getComputedStyle(scroller).paddingBottom) - had
    const end = (scroller.lastElementChild?.getBoundingClientRect().bottom ?? 0) - scroller.getBoundingClientRect().top + scroller.scrollTop
    const target = scroller.scrollTop + short
    scroller.style.setProperty('--details-room', `${Math.max(0, target - (end + padding - scroller.clientHeight))}px`)
    scroller.scrollTop = target
  }
  panel.style.maxHeight = `${Math.max(120, Math.min(PANEL_MOST, foot() - panel.getBoundingClientRect().top))}px`
}

/** One address: its name and address to select or copy, and a menu of what can be done with it. */
function Person(props: {
  who: Address
  own: string[]
  /** The message's sender, who can also be blocked. */
  sender?: boolean
  open: boolean
  toggle(): void
  close(): void
  actions: AddressActions
}): ReactNode {
  const { who, own, actions } = props
  const address = who.address
  const mine = own.includes(address.toLowerCase())
  const muted = actions.muted(address)
  const item = (Icon: LucideIcon, label: string, run: () => void): ReactNode => (
    <button type="button" role="menuitem" className="menu-item" onClick={() => { props.close(); run() }}>
      <Icon size={15} aria-hidden="true" /> {label}
    </button>
  )
  const copy = (): void => {
    window.mail.copyAddress(address).then(() => actions.say(`Copied ${address}`), (e: unknown) => actions.say(problem(e)))
  }
  const find = actions.find
  return (
    <span className="detail-person">
      <span className="detail-person-line">
        <span className="selectable">
          {who.name && <span className="detail-person-name">{who.name} </span>}
          <span className={who.name ? 'muted' : ''}>{who.name ? `<${address}>` : address}</span>
          {mine && <span className="muted"> (you)</span>}
        </span>
        {address && (
          <button type="button" className="icon small" aria-label={`Actions for ${address}`} aria-haspopup="menu" aria-expanded={props.open}
            onClick={props.toggle}>
            <MoreHorizontal size={14} aria-hidden="true" />
          </button>
        )}
      </span>
      {address && props.open && (
        <span className="detail-person-menu" role="menu" aria-label={`Actions for ${address}`}>
          {item(Copy, 'Copy address', copy)}
          {item(PenLine, 'New message', () => actions.write(address))}
          {find && item(Search, mine ? 'Find mail you sent to yourself' : 'Find mail from them', () => find(`from:${address}`))}
          {!mine && (muted
            ? item(Bell, 'Unmute notifications', () => actions.mute(address, false))
            : item(BellOff, 'Mute notifications', () => actions.mute(address, true)))}
          {!mine && actions.straight && !actions.isStraight(address) && item(Zap, 'Let straight through', () => actions.straight?.(address, true))}
          {!mine && actions.straight && actions.listedExactly(address) && item(Hourglass, 'Hold for deliveries', () => actions.straight?.(address, false))}
          {!mine && props.sender && item(Ban, 'Block sender', () => actions.block(address))}
        </span>
      )}
    </span>
  )
}

/**
 * The details under "To: me": everything about who a message is from and to, when and where it
 * came, and what the server that received it found, as Edison's header opens to show and Gmail's
 * details add to. Escape, or a click elsewhere, closes it; Escape with an address's menu open closes
 * that first.
 */
export function Details(props: {
  message: MessageView
  account: AccountView | undefined
  own: string[]
  cautions: string[]
  close(): void
  /** Not given in Trash or Spam. */
  unsubscribe?: () => void
  actions: AddressActions
}): ReactNode {
  const { message: m, own, actions } = props
  const box = useRef<HTMLDivElement>(null)
  const [facts, setFacts] = useState<MessageDetails | null | 'reading'>('reading')
  const [menu, setMenu] = useState<string | null>(null)
  const menuRef = useRef(menu)
  menuRef.current = menu

  useEffect(() => {
    let current = true
    window.mail.details(m.id).then((found) => { if (current) setFacts(found) }, () => { if (current) setFacts(null) })
    return () => { current = false }
  }, [m.id])

  useLayoutEffect(() => {
    box.current?.focus({ preventScroll: true })
  }, [])

  // Measured again whenever what it says grows, as it does once how it was delivered has been
  // read, and whenever the window changes.
  useLayoutEffect(() => {
    const panel = box.current
    if (!panel) return undefined
    const fit = (): void => fitPanel(panel)
    fit()
    const growing = new ResizeObserver(fit)
    for (const part of panel.children) growing.observe(part)
    window.addEventListener('resize', fit)
    return () => {
      growing.disconnect()
      window.removeEventListener('resize', fit)
      panel.closest<HTMLElement>('.messages')?.style.removeProperty('--details-room')
    }
  }, [facts])

  useEffect(() => {
    const away = (event: MouseEvent): void => {
      if (!box.current?.contains(event.target as Node)) props.close()
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      event.preventDefault()
      if (menuRef.current) setMenu(null)
      else props.close()
    }
    document.addEventListener('mousedown', away)
    window.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('mousedown', away)
      window.removeEventListener('keydown', escape, true)
    }
  }, [props.close])

  const people = (who: Address[], key: string, sender = false): ReactNode => (
    <span className="detail-people">
      {who.map((one, i) => {
        const id = `${key}:${i}`
        return (
          <Person key={id} who={one} own={own} sender={sender} actions={actions} open={menu === id}
            toggle={() => setMenu(menu === id ? null : id)} close={() => setMenu(null)} />
        )
      })}
    </span>
  )

  const known = facts !== 'reading' && facts !== null ? facts : null
  const replies = m.replyTo.filter((r) => r.address.toLowerCase() !== m.from.address.toLowerCase())
  const checks = known?.checks
  const results = checks ? [['SPF', checks.spf], ['DKIM', checks.dkim], ['DMARC', checks.dmarc]].filter(([, result]) => result) : []
  const dated = known?.sent && Math.abs(known.sent - m.date) > DATE_GAP_MS ? known.sent : null
  const delivered = known?.deliveredTo && known.deliveredTo !== m.account.toLowerCase() ? known.deliveredTo : ''

  return (
    <div ref={box} className="popover details-panel" role="dialog" aria-label="Message details" tabIndex={-1}>
      <dl className="details">
        <dt>From</dt><dd>{people([m.from], 'from', true)}</dd>
        {replies.length > 0 && <><dt>Reply to</dt><dd>{people(replies, 'reply')}</dd></>}
        {m.to.length > 0 && <><dt>To</dt><dd>{people(m.to, 'to')}</dd></>}
        {m.cc.length > 0 && <><dt>Cc</dt><dd>{people(m.cc, 'cc')}</dd></>}
        {known && known.bcc.length > 0 && <><dt>Bcc</dt><dd>{people(known.bcc, 'bcc')}</dd></>}
        <dt>Date</dt><dd className="selectable">{fullTime(m.date)}</dd>
        {dated && <><dt>Dated</dt><dd className="selectable">{fullTime(dated)} <span className="muted">(by the sender)</span></dd></>}
        <dt>Mailbox</dt>
        <dd>
          {props.account && <span className="account-swatch" style={{ background: props.account.color }} aria-hidden="true" />}
          <span className="selectable">{m.account}</span> <span className="muted">· {placesOf(m.labels)}</span>
        </dd>
        {delivered && <><dt>Delivered to</dt><dd className="selectable">{delivered}</dd></>}
        {known?.mailedBy && <><dt>Mailed by</dt><dd className="selectable">{known.mailedBy}</dd></>}
        {known && known.signedBy.length > 0 && <><dt>Signed by</dt><dd className="selectable">{known.signedBy.join(', ')}</dd></>}
        {known?.tls && <><dt>Security</dt><dd>Reached your mail service over {known.tls}</dd></>}
        {results.length > 0 && (
          <>
            <dt>Checks</dt>
            <dd>
              {results.map(([name, result]) => <span key={name} className={result === 'fail' || result === 'softfail' ? 'check-result bad' : 'check-result'}>{name} {word(result ?? '')}</span>)}
              {checks?.by && <span className="muted"> by {checks.by}</span>}
            </dd>
          </>
        )}
        {known?.list && (
          <>
            <dt>Mailing list</dt>
            <dd>
              <span className="selectable">{known.list.name ? `${known.list.name} ` : ''}<span className="muted">{known.list.id}</span></span>
              {m.unsubscribe && props.unsubscribe && <button type="button" className="link details-link" onClick={() => { props.close(); props.unsubscribe?.() }}>Unsubscribe</button>}
            </dd>
          </>
        )}
        {!known?.list && m.unsubscribe && (
          <><dt>Mailing list</dt><dd>Sent in bulk {props.unsubscribe && <button type="button" className="link details-link" onClick={() => { props.close(); props.unsubscribe?.() }}>Unsubscribe</button>}</dd></>
        )}
        {known && !own.includes(m.from.address.toLowerCase()) && (
          <><dt>Written to</dt><dd>{known.wroteTo ? "You've written to them before" : "You haven't written to this sender"}</dd></>
        )}
        {props.cautions.length > 0 && <><dt>Warnings</dt><dd className="details-warnings">{props.cautions.map((text) => <p key={text}>{text}</p>)}</dd></>}
      </dl>
      {facts === 'reading' && <p className="muted note details-note">Reading…</p>}
      {facts === null && <p className="muted note details-note">Couldn't be read</p>}
    </div>
  )
}
