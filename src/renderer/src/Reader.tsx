import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import {
  ArrowLeft, Ban, Bell, BellOff, Check, ChevronDown, Clock, DollarSign, Download, ExternalLink, FileCode,
  Filter, Flag, FolderInput, Forward, Hourglass, Inbox, Mail, MailOpen, MoreVertical, Newspaper, OctagonAlert, Pin, PinOff, Plane, Printer, Reply, SquareArrowOutUpRight,
  ReplyAll, Tag, Ticket, Trash2, TriangleAlert, Truck, Undo2, Zap, type LucideIcon
} from 'lucide-react'
import { imagesLoad } from '@shared/images'
import { plainName } from '@shared/names'
import { IMPORTANT, type AccountView, type Address, type Facts, type MailAction, type MessageView, type Rsvp, type SenderWarning, type Settings } from '@shared/types'
import { Avatar, Empty, ImportantMark, KIND_ICONS } from './Common'
import { Details, type AddressActions } from './Details'
import { factLine, fileKind, fileSize, longTime, problem, shortTime, straightThrough, userLabels } from './format'
import { MailBody } from './MailBody'
import { Original } from './Original'
import { FolderMenu, IconButton, LabelMenu, Popover, TimeMenu } from './Menus'

const nameOf = (who: Address): string => who.name || who.address || 'Unknown'

/** The mail system's own addresses, which send bounces and notices: no person to block. */
const SYSTEM_SENDER = /^(?:mailer-daemon|postmaster)@/i

export type ReplyKind = 'reply' | 'replyAll' | 'forward'
export type Panel = 'snooze' | 'labels' | 'more' | null

const FORWARDED = /^\s*(fwd?|tr|wg|rv|i)\s*:/i
/** Threads longer than this show their ends, with the middle folded away. */
const LONG_THREAD = 4

const CAUTIONS: Record<SenderWarning, (m: MessageView) => string> = {
  forged: () => "This message failed the checks that prove who sent it. It may not be from who it says.",
  'name-mismatch': (m) => `The name on this message shows a different address from the one it came from: ${m.from.address}.`,
  lookalike: () => 'This sender\'s address uses characters that can imitate another one.',
  'replies-elsewhere': (m) => `Replies to this go to a different address: ${m.replyTo[0]?.address ?? ''}.`
}

function Cautions({ message }: { message: MessageView }): ReactNode {
  if (message.warnings.length === 0) return null
  return (
    <div className="caution" role="alert">
      <TriangleAlert size={15} aria-hidden="true" />
      <div>{message.warnings.map((w) => <p key={w}>{CAUTIONS[w](message)}</p>)}</div>
    </div>
  )
}

const ANSWERS: [Rsvp, string][] = [['ACCEPTED', 'Accept'], ['TENTATIVE', 'Maybe'], ['DECLINED', 'Decline']]
const FACT_ICONS: Record<Facts['type'], LucideIcon> = { package: Truck, travel: Plane, money: DollarSign, event: Ticket }
const FACT_NAMES: Record<Facts['type'], string> = { package: 'Package', travel: 'Travel', money: 'Bill or receipt', event: 'Event' }

/** What the Assistant made of a message. Every word here came from a stranger, so it's only text. */
function FactCard(props: { message: MessageView; facts: Facts; rsvp(message: number, answer: Rsvp): void }): ReactNode {
  const { message, facts, rsvp } = props
  const Icon = FACT_ICONS[facts.type]
  // An invitation to something that's over has nothing left to answer.
  const ends = facts.type === 'event' ? facts.end ?? facts.start : null
  const over = ends !== null && ends < Date.now()
  return (
    <div className="fact">
      <span className={`fact-tile fact-${facts.type}`} aria-hidden="true"><Icon size={17} /></span>
      <div className="grow">
        <div className="fact-kind muted">{FACT_NAMES[facts.type]}</div>
        <div className="fact-line">{factLine(facts)}</div>
      </div>
      {facts.type === 'package' && facts.url && (
        <button className="pill strong" onClick={() => void window.mail.openLink(facts.url ?? '')}>Track</button>
      )}
      {facts.type === 'event' && facts.invite && !over && ANSWERS.map(([answer, word]) => (
        <button key={answer} className="pill" onClick={() => rsvp(message.id, answer)}>{word}</button>
      ))}
    </div>
  )
}

function Attachments(props: { message: MessageView; say(text: string): void }): ReactNode {
  const { message: m, say } = props
  const open = (index: number): void => {
    window.mail.openAttachment(m.id, index).catch((e) => say(problem(e)))
  }
  const save = (index: number): void => {
    window.mail.saveAttachment(m.id, index).then((done) => { if (done) say('Saved') }, (e) => say(problem(e)))
  }
  return (
    <ul className="attachments" aria-label="Attachments">
      {m.attachments.map((file, i) => {
        const kind = fileKind(file.name)
        const Icon = KIND_ICONS[kind]
        return (
          <li key={i}>
            <button type="button" className="file" title="Open" onClick={() => open(i)}>
              <span className={`file-tile file-${kind}`} aria-hidden="true"><Icon size={18} /></span>
              <span className="file-words">
                <span className="file-name">{plainName(file.name)}</span>
                <span className="muted">{fileSize(file.size)}</span>
              </span>
            </button>
            <button type="button" className="icon" aria-label={`Save ${plainName(file.name)}`} title="Save" onClick={() => save(i)}>
              <Download size={15} aria-hidden="true" />
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/** "To: me ⌄": who it went to. Pressed, it opens the message's details. */
function Recipients(props: { message: MessageView; own: string[]; open: boolean; toggle(): void; button: RefObject<HTMLButtonElement | null> }): ReactNode {
  const { message: m, own } = props
  const label = (who: Address): string => (own.includes(who.address.toLowerCase()) ? 'me' : nameOf(who))
  const everyone = [...m.to, ...m.cc]
  return (
    <button ref={props.button} type="button" className="who-to" aria-expanded={props.open} aria-haspopup="dialog" title="Details"
      onClick={props.toggle}>
      <span className="muted">To:</span> {everyone.length > 0 ? everyone.map(label).join(', ') : 'undisclosed'}
      <ChevronDown className={props.open ? 'flip' : ''} size={13} aria-hidden="true" />
    </button>
  )
}

function Message(props: {
  message: MessageView
  open: boolean
  /** The one that offers Unsubscribe, when a thread has several that could. */
  leaving: boolean
  /** The one that offers to block its sender, where there's nothing to unsubscribe from. */
  blocking: boolean
  /** It's in Trash or Spam. */
  bins: boolean
  own: string[]
  settings: Settings | null
  account: AccountView | undefined
  /** What the details offer to do with each address. */
  actions: AddressActions
  /** The sender skips the wait for a delivery. */
  straight: boolean
  toggle(): void
  onPeek(url: string | null): void
  say(text: string): void
  rsvp(message: number, answer: Rsvp): void
  reply(kind: ReplyKind, message: number): void
  unsubscribe(message: number): void
  block(address: string): void
  trust(address: string): void
}): ReactNode {
  const { message: m, open, leaving, bins, own, settings, toggle, onPeek, say, rsvp } = props
  const [menu, setMenu] = useState(false)
  /** View original is open for this message. */
  const [source, setSource] = useState(false)
  const [details, setDetails] = useState(false)
  const toggleButton = useRef<HTMLButtonElement>(null)
  // Closed by Escape or a click elsewhere, it hands the focus back to what opened it.
  const closeDetails = useCallback((): void => {
    setDetails(false)
    toggleButton.current?.focus()
  }, [])
  const images = imagesLoad(m, settings, bins)
  // Its own reply button answers everyone on it, when Settings say so and there's someone else.
  const replyAll = settings?.defaultReply === 'replyAll' && m.to.length + m.cc.length > 1
  if (!open) {
    return (
      <article className="message">
        <button className="message-head closed" onClick={toggle} aria-expanded={false}>
          <Avatar name={m.from.name} address={m.from.address} size={36} plain={m.warnings.length > 0} />
          <span className="who">
            {m.warnings.length > 0 && <TriangleAlert className="mark warn" size={13} aria-label="Check this sender" />}
            <strong>{nameOf(m.from)}</strong>
            <span className="muted"> {(m.snippet || m.text.replace(/\s+/g, ' ')).slice(0, 160)}</span>
          </span>
          <span className="muted when">{shortTime(m.date)}</span>
        </button>
      </article>
    )
  }
  return (
    <article className="message open">
      <div className="message-head" onClick={(e) => { if (!(e.target as Element).closest('button, .popover')) toggle() }}>
        <Avatar name={m.from.name} address={m.from.address} size={44} plain={m.warnings.length > 0} />
        <div className="who">
          <div className="who-name">
            {m.warnings.length > 0 && <TriangleAlert className="mark warn" size={13} aria-label="Check this sender" />}
            <strong>{nameOf(m.from)}</strong>
            {m.from.name && <span className="muted who-address"> {m.from.address}</span>}
            {props.straight && (
              <span className="straight">
                <Zap size={11} aria-hidden="true" />Straight through
              </span>
            )}
          </div>
          <Recipients message={m} own={own} open={details} toggle={() => setDetails(!details)} button={toggleButton} />
        </div>
        <span className="muted when">{longTime(m.date)}</span>
        {!bins && (replyAll
          ? <IconButton icon={ReplyAll} label="Reply all to this" click={() => props.reply('replyAll', m.id)} />
          : <IconButton icon={Reply} label="Reply to this" click={() => props.reply('reply', m.id)} />)}
        {leaving && <button className="pill soft" onClick={() => props.unsubscribe(m.id)}>Unsubscribe</button>}
        {props.blocking && !leaving && <button className="pill soft" onClick={() => props.block(m.from.address)}>Block</button>}
        {!bins && (
          <div className="anchor">
            <IconButton icon={MoreVertical} label="Message actions" click={() => setMenu(!menu)} />
            {menu && (
              <Popover right close={() => setMenu(false)}>
                <button type="button" className="menu-item" onClick={() => { setMenu(false); props.reply('replyAll', m.id) }}>
                  <ReplyAll size={15} aria-hidden="true" /> Reply all
                </button>
                <button type="button" className="menu-item" onClick={() => { setMenu(false); props.reply('forward', m.id) }}>
                  <Forward size={15} aria-hidden="true" /> Forward
                </button>
                <button type="button" className="menu-item" onClick={() => { setMenu(false); setSource(true) }}>
                  <FileCode size={15} aria-hidden="true" /> View original
                </button>
              </Popover>
            )}
          </div>
        )}
        {source && <Original message={m.id} subject={m.subject} close={() => setSource(false)} />}
        {details && (
          <Details message={m} account={props.account} own={own} actions={props.actions} close={closeDetails}
            cautions={m.warnings.map((w) => CAUTIONS[w](m))} unsubscribe={() => props.unsubscribe(m.id)} />
        )}
      </div>
      <div className="message-body">
        <Cautions message={m} />
        {m.facts && <FactCard message={m} facts={m.facts} rsvp={rsvp} />}
        <MailBody text={m.text} html={m.html} onPeek={onPeek} images={images} sender={m.from.address.toLowerCase()} trust={props.trust} darken={settings?.darkMail !== false}
          keepQuoted={FORWARDED.test(m.subject)} />
        {m.attachments.length > 0 && <Attachments message={m} say={say} />}
        {m.truncated && <p className="muted note message-note">Truncated</p>}
      </div>
    </article>
  )
}

/** A closed envelope among a few sparks, for when nothing is open. Drawn here, in the page's own colours. */
function Nothing(): ReactNode {
  return (
    <svg className="nothing" width="250" height="210" viewBox="0 0 250 210" fill="none" aria-hidden="true">
      <rect className="nothing-paper" x="77" y="72" width="96" height="68" rx="6" />
      <path className="nothing-fold" d="M79 76l46 36 46-36" />
      <g className="nothing-spark">
        <circle cx="42" cy="34" r="9" />
        <circle cx="206" cy="24" r="5" />
        <path d="M118 30v14M111 37h14" />
        <path d="M30 118v12M24 124h12" />
        <path d="M212 164v16M204 172h16" />
        <path d="M218 62l3.2 6.6 7.2 1-5.2 5.1 1.2 7.2-6.4-3.4-6.4 3.4 1.2-7.2-5.2-5.1 7.2-1z" />
        <path d="M58 168l2.8 5.7 6.3.9-4.6 4.4 1.1 6.3-5.6-3-5.6 3 1.1-6.3-4.6-4.4 6.3-.9z" />
      </g>
    </svg>
  )
}

/** In the reader's place when a thread couldn't be drawn, so the rest of the window carries on. */
export function CantShow(props: { back(): void; label: string }): ReactNode {
  return (
    <main className="reader reader-empty" role="alert">
      <Empty icon={TriangleAlert} title="Couldn't show this message" />
      <button type="button" className="pill" onClick={props.back}>{props.label}</button>
    </main>
  )
}

export function Reader(props: {
  messages: MessageView[]
  account: AccountView | undefined
  labels: string[]
  /** Reading what's in Trash or Spam, where the choices are different. */
  bins: boolean
  panel: Panel
  own: string[]
  settings: Settings | null
  unread: number
  held: number
  /** Who comes straight through, while mail is held for deliveries at all. */
  vip: string[] | null
  /** Several accounts are signed in, so the thread says whose it is. */
  many: boolean
  setPanel(panel: Panel): void
  back(): void
  /** Opens the thread in a window of its own. Not given in one. */
  popOut?: () => void
  act(action: MailAction, label?: string): void
  snooze(at: number): void
  reply(kind: ReplyKind, message: number): void
  unsubscribe(message: number): void
  block(address: string): void
  rsvp(message: number, answer: Rsvp): void
  setFocus(address: string, focused: boolean): void
  trust(address: string): void
  straight(address: string, on: boolean): void
  forever(): void
  pin(on: boolean): void
  mute(address: string, on: boolean): void
  /** Into the Summary, or out of it. */
  summarize(address: string, on: boolean): void
  /** A new message to an address. */
  write(address: string): void
  /** Searches for what's given. Not in a window of its own. */
  find?: (text: string) => void
  say(text: string): void
}): ReactNode {
  const { messages, account, labels, bins, panel, setPanel, back, act, own, settings, vip } = props
  const last = messages.at(-1)
  const [open, setOpen] = useState<Set<number>>(new Set())
  const [unfolded, setUnfolded] = useState(false)
  const [peek, setPeek] = useState<string | null>(null)

  useEffect(() => {
    // What's unread, and always the newest, opens by itself.
    setOpen(new Set(messages.filter((m, i) => !m.seen || i === messages.length - 1).map((m) => m.id)))
    setUnfolded(false)
    setPeek(null)
    return () => void window.mail.allowRemoteImages(false)
  }, [last?.thread, last?.account])

  if (!last) {
    return (
      <main className="reader reader-empty">
        <Nothing />
        <Empty icon={Mail} title={props.unread > 0 ? `${props.unread} unread` : 'Nothing open'} />
      </main>
    )
  }

  const toggle = (id: number): void =>
    setOpen((now) => {
      const next = new Set(now)
      if (!next.delete(id)) next.add(id)
      return next
    })

  const inInbox = messages.some((m) => m.labels.includes('\\Inbox'))
  // Opened, a thread is read at once unless Settings say to wait or to leave it to you; then it can
  // be marked read from here.
  const unread = (settings?.readAfter ?? 0) !== 0 && messages.some((m) => !m.seen)
  const starred = messages.some((m) => m.flagged)
  const pinned = messages.some((m) => m.pinned)
  const important = messages.some((m) => m.labels.includes(IMPORTANT))
  const active = [...new Set(messages.flatMap((m) => userLabels(m.labels)))]
  const person = messages.find((m) => m.from.address && m.from.address !== last.account)
  const sender = person?.from.address
  const gmail = account?.labels ?? false
  const folded = !unfolded && messages.length > LONG_THREAD
  const hidden = folded ? messages.slice(1, -2).filter((m) => !open.has(m.id)) : []
  const shown = messages.filter((m) => !hidden.includes(m))
  // Newest first, the thread reads from the top down the other way, and the fold sits above the first.
  const newestFirst = settings?.threadOrder === 'newest'
  const ordered = newestFirst ? [...shown].reverse() : shown
  const foldAt = newestFirst ? ordered.length - 1 : 1
  const leaving = [...messages].reverse().find((m) => m.unsubscribe)
  const blockable = [...messages].reverse().find((m) => m.from.address && !own.includes(m.from.address.toLowerCase()) && !SYSTEM_SENDER.test(m.from.address))
  const several = last.to.length + last.cc.length > 1
  const isStraight = (address: string): boolean => vip !== null && !own.includes(address.toLowerCase()) && straightThrough(address, vip)
  const muted = sender !== undefined && (settings?.muted ?? []).includes(sender.toLowerCase())
  // Only a sender mailing in bulk is offered the Summary, as Edison offers it from Subscriptions.
  const bulkSender = leaving && !own.includes(leaving.from.address.toLowerCase()) ? leaving.from.address : undefined
  const summarized = bulkSender !== undefined && (settings?.summary.senders ?? []).includes(bulkSender.toLowerCase())
  // Only the address itself can be taken off here; a whole @domain stays a decision for Settings.
  const listedExactly = sender !== undefined && (vip ?? []).some((v) => v.trim().toLowerCase() === sender.toLowerCase())

  const actions: AddressActions = {
    write: props.write,
    find: props.find,
    block: props.block,
    mute: props.mute,
    muted: (address) => (settings?.muted ?? []).includes(address.toLowerCase()),
    straight: vip !== null && !bins ? props.straight : null,
    isStraight,
    listedExactly: (address) => (vip ?? []).some((v) => v.trim().toLowerCase() === address.toLowerCase()),
    say: props.say
  }

  const moreItem = (Icon: LucideIcon, label: string, run: () => void): ReactNode => (
    <button type="button" className="menu-item" onClick={() => { setPanel(null); run() }}>
      <Icon size={15} aria-hidden="true" /> {label}
    </button>
  )

  return (
    <main className="reader">
      <div className="toolbar" role="toolbar" aria-label="Thread">
        <button className="icon back" onClick={back} aria-label="Back"><ArrowLeft size={18} aria-hidden="true" /></button>
        {props.many && account && (
          <span className="reader-account">
            <span className="account-swatch" style={{ background: account.color }} aria-hidden="true" /><span className="reader-account-name">{account.email}</span>
          </span>
        )}
        <span className="grow" />
        {bins ? (
          <>
            <IconButton icon={Undo2} label="Move to Inbox" click={() => act({ kind: 'inbox' }, 'Moved to Inbox')} />
            <IconButton icon={Trash2} label="Delete forever" hint="#" click={props.forever} />
          </>
        ) : (
          <>
            {inInbox
              ? <IconButton icon={Check} label="Archive" hint="e" click={() => act({ kind: 'archive' }, 'Archived')} />
              : <IconButton icon={Inbox} label="Move to Inbox" click={() => act({ kind: 'inbox' }, 'Moved to Inbox')} />}
            <IconButton icon={Trash2} label="Delete" hint="#" click={() => act({ kind: 'trash' }, 'Moved to Trash')} />
            <IconButton icon={Flag} label={starred ? 'Remove flag' : 'Flag'} hint="s" on={starred}
              click={() => act({ kind: starred ? 'unstar' : 'star' })} />
            {unread
              ? <IconButton icon={MailOpen} label="Mark read" hint="Shift+I" click={() => act({ kind: 'read' })} />
              : <IconButton icon={Mail} label="Mark unread" hint="Shift+U" click={() => act({ kind: 'unread' })} />}
            <div className="anchor">
              <IconButton icon={gmail ? Tag : FolderInput} label={gmail ? 'Labels' : 'Move to'} hint="l" click={() => setPanel(panel === 'labels' ? null : 'labels')} />
              {panel === 'labels' && (gmail
                ? <LabelMenu labels={labels} active={active} right set={(label, add) => act({ kind: 'label', label, add })} close={() => setPanel(null)} />
                : <FolderMenu folders={account?.folders ?? []} right close={() => setPanel(null)} pick={(to) => { setPanel(null); act({ kind: 'move', to }, `Moved to ${to}`) }} />)}
            </div>
            <div className="anchor">
              <IconButton icon={Clock} label="Snooze" hint="b" click={() => setPanel(panel === 'snooze' ? null : 'snooze')} />
              {panel === 'snooze' && <TimeMenu title="Snooze until" right pick={props.snooze} close={() => setPanel(null)} />}
            </div>
          </>
        )}
        <div className="anchor">
          <IconButton icon={MoreVertical} label="More" click={() => setPanel(panel === 'more' ? null : 'more')} />
          {panel === 'more' && (
            <Popover right close={() => setPanel(null)}>
              {!bins && moreItem(pinned ? PinOff : Pin, pinned ? 'Unpin thread' : 'Pin thread', () => props.pin(!pinned))}
              {!bins && moreItem(OctagonAlert, 'Report spam', () => act({ kind: 'spam' }, 'Reported as spam'))}
              {gmail && !bins && (
                // As with a flag, the mark itself says it's done: no toast, since an Undo there couldn't
                // call back a change that has already gone to Gmail.
                <button type="button" className="menu-item" onClick={() => { setPanel(null); act({ kind: 'label', label: IMPORTANT, add: !important }) }}>
                  <ImportantMark size={15} /> {important ? 'Mark as not important' : 'Mark as important'}
                </button>
              )}
              {/* With the inbox in one piece there's no Other to keep anyone in, so no word of it. */}
              {sender && inInbox && props.settings?.focused && moreItem(Filter, person?.focused ? 'Keep this sender in Other' : 'Keep this sender in Focused', () => props.setFocus(sender, !person?.focused))}
              {sender && !bins && vip !== null && !isStraight(sender) && moreItem(Zap, 'Let this sender straight through', () => props.straight(sender, true))}
              {sender && !bins && listedExactly && moreItem(Hourglass, 'Hold this sender for deliveries', () => props.straight(sender, false))}
              {sender && !bins && !own.includes(sender.toLowerCase()) && (muted
                ? moreItem(Bell, 'Unmute notifications', () => props.mute(sender, false))
                : moreItem(BellOff, 'Mute notifications', () => props.mute(sender, true)))}
              {bulkSender && !bins && (summarized
                ? moreItem(Newspaper, 'Remove sender from Summary', () => props.summarize(bulkSender, false))
                : moreItem(Newspaper, 'Add sender to Summary', () => props.summarize(bulkSender, true)))}
              {sender && !bins && moreItem(Ban, 'Block sender', () => props.block(sender))}
              {moreItem(Printer, 'Print', () => window.print())}
              {gmail && moreItem(ExternalLink, 'Open in Gmail', () => void window.mail.openInGmail(last.account, last.thread))}
            </Popover>
          )}
        </div>
        {props.popOut && (
          <>
            <span className="toolbar-rule" aria-hidden="true" />
            <IconButton icon={SquareArrowOutUpRight} label="Open in a window" click={props.popOut} />
          </>
        )}
      </div>
      <div className="messages">
        <div className={props.many && account ? 'thread-head marked' : 'thread-head'}>
          {props.many && account && <span className="account-bar" style={{ background: account.color }} title={account.email} aria-hidden="true" />}
          <h2 className="thread-subject">{messages[0]?.subject || 'No subject'}</h2>
          {active.length > 0 && (
            <div className="tags">{active.map((label) => <span className="tag" key={label}>{label}</span>)}</div>
          )}
        </div>
        {ordered.map((m, i) => (
          <div key={m.id} className="message-slot">
            {hidden.length > 0 && i === foldAt && (
              <button className="fold" onClick={() => setUnfolded(true)}>
                <span className="fold-count">{hidden.length}</span> more {hidden.length === 1 ? 'email' : 'emails'}
              </button>
            )}
            <Message message={m} open={open.has(m.id)} leaving={m === leaving} blocking={!bins && !leaving && m === blockable} bins={bins} own={own}
              settings={settings} account={account} actions={actions} straight={isStraight(m.from.address)}
              toggle={() => toggle(m.id)} onPeek={setPeek} say={props.say} rsvp={props.rsvp} reply={props.reply}
              unsubscribe={props.unsubscribe} block={props.block} trust={props.trust} />
          </div>
        ))}
      </div>
      {!bins && (
        <div className="reply-bar">
          <button type="button" title="Reply (r)" onClick={() => props.reply('reply', last.id)}><Reply size={17} aria-hidden="true" /> Reply</button>
          {several && (
            <button type="button" title="Reply all (a)" onClick={() => props.reply('replyAll', last.id)}><ReplyAll size={17} aria-hidden="true" /> Reply All</button>
          )}
          <button type="button" title="Forward (f)" onClick={() => props.reply('forward', last.id)}><Forward size={17} aria-hidden="true" /> Forward</button>
        </div>
      )}
      {peek && <div className="peek">{peek}</div>}
    </main>
  )
}
