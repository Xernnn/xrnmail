import { useEffect, useState, type ReactNode } from 'react'
import {
  Archive, ArrowLeft, Ban, CalendarRange, ChevronDown, Clock, Download, ExternalLink, File as FileIcon, FileArchive, FileAudio, FileImage, FileSpreadsheet, FileText, FileVideo,
  Filter, FolderInput, Forward, Inbox, Mail, MoreVertical, OctagonAlert, Package, Plane, Presentation, Printer, Receipt, Reply, ReplyAll, Star, Tag, Trash2,
  TriangleAlert, Undo2, type LucideIcon
} from 'lucide-react'
import type { AccountView, Address, Facts, MailAction, MessageView, Rsvp, SenderWarning, Settings } from '@shared/types'
import { Avatar, Empty } from './Common'
import { factLine, fileKind, fileSize, longTime, problem, shortTime, userLabels, type FileKind } from './format'
import { MailBody } from './MailBody'
import { FolderMenu, IconButton, LabelMenu, Popover, TimeMenu } from './Menus'
import icon from './icon.svg'

const nameOf = (who: Address): string => who.name || who.address || 'Unknown'

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
const FACT_ICONS: Record<Facts['type'], LucideIcon> = { package: Package, travel: Plane, money: Receipt, event: CalendarRange }
const FACT_NAMES: Record<Facts['type'], string> = { package: 'Package', travel: 'Travel', money: 'Bill or receipt', event: 'Event' }

/** What the Assistant made of a message. Every word here came from a stranger, so it's only text. */
function FactCard(props: { message: MessageView; facts: Facts; rsvp(message: number, answer: Rsvp): void }): ReactNode {
  const { message, facts, rsvp } = props
  const Icon = FACT_ICONS[facts.type]
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
      {facts.type === 'event' && facts.invite && ANSWERS.map(([answer, word]) => (
        <button key={answer} className="pill" onClick={() => rsvp(message.id, answer)}>{word}</button>
      ))}
    </div>
  )
}

const KIND_ICONS: Record<FileKind, LucideIcon> = {
  image: FileImage, pdf: FileText, doc: FileText, sheet: FileSpreadsheet, slides: Presentation, archive: FileArchive,
  calendar: CalendarRange, audio: FileAudio, video: FileVideo, file: FileIcon
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
    <ul className="attachments">
      {m.attachments.map((file, i) => {
        const kind = fileKind(file.name)
        const Icon = KIND_ICONS[kind]
        return (
          <li key={i}>
            <button type="button" className="file" title="Open" onClick={() => open(i)}>
              <span className={`file-tile file-${kind}`} aria-hidden="true"><Icon size={18} /></span>
              <span className="file-words">
                <span className="file-name">{file.name}</span>
                <span className="muted">{fileSize(file.size)}</span>
              </span>
            </button>
            <button type="button" className="icon" aria-label={`Save ${file.name}`} title="Save" onClick={() => save(i)}>
              <Download size={15} aria-hidden="true" />
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/** "To: Me", and everything else about who it went to when that's opened. */
function Recipients(props: { message: MessageView; own: string[] }): ReactNode {
  const { message: m, own } = props
  const [open, setOpen] = useState(false)
  const label = (who: Address): string => (own.includes(who.address.toLowerCase()) ? 'Me' : nameOf(who))
  const everyone = [...m.to, ...m.cc]
  const line = (who: Address[]): string => who.map((one) => (one.name ? `${one.name} <${one.address}>` : one.address)).join(', ')
  return (
    <>
      <button className="who-to" aria-expanded={open} onClick={() => setOpen(!open)}>
        To: {everyone.length > 0 ? everyone.map(label).join(', ') : 'undisclosed'}
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open && (
        <Popover close={() => setOpen(false)}>
          <dl className="details">
            <dt>From</dt><dd>{line([m.from])}</dd>
            {m.to.length > 0 && <><dt>To</dt><dd>{line(m.to)}</dd></>}
            {m.cc.length > 0 && <><dt>Cc</dt><dd>{line(m.cc)}</dd></>}
            {m.replyTo.length > 0 && <><dt>Reply to</dt><dd>{line(m.replyTo)}</dd></>}
            <dt>Date</dt><dd>{longTime(m.date)}</dd>
            <dt>Account</dt><dd>{m.account}</dd>
          </dl>
        </Popover>
      )}
    </>
  )
}

function Message(props: {
  message: MessageView
  open: boolean
  /** The one that offers Unsubscribe, when a thread has several that could. */
  leaving: boolean
  /** It's in Trash or Spam. */
  bins: boolean
  own: string[]
  settings: Settings | null
  toggle(): void
  onPeek(url: string | null): void
  say(text: string): void
  rsvp(message: number, answer: Rsvp): void
  reply(kind: ReplyKind, message: number): void
  unsubscribe(message: number): void
  trust(address: string): void
}): ReactNode {
  const { message: m, open, leaving, bins, own, settings, toggle, onPeek, say, rsvp } = props
  const address = m.from.address.toLowerCase()
  const trusted = settings?.images === 'always' || (settings?.imagesFrom ?? []).includes(address)
  // A From line can be forged, so being trusted only counts on mail that passed for its sender.
  const images = trusted && !bins && m.warnings.length === 0
  if (!open) {
    return (
      <article className="message">
        <button className="message-head closed" onClick={toggle} aria-expanded={false}>
          <Avatar name={m.from.name} address={m.from.address} size={28} />
          <span className="who">
            {m.warnings.length > 0 && <TriangleAlert className="mark warn" size={13} aria-label="Check this sender" />}
            <strong>{nameOf(m.from)}</strong>
            <span className="muted"> {m.text.replace(/\s+/g, ' ').slice(0, 140)}</span>
          </span>
          <span className="muted when">{shortTime(m.date)}</span>
        </button>
      </article>
    )
  }
  return (
    <article className="message open">
      <div className="message-head" onClick={(e) => { if (!(e.target as Element).closest('button, .popover')) toggle() }}>
        <Avatar name={m.from.name} address={m.from.address} />
        <div className="who">
          <div className="who-name">
            {m.warnings.length > 0 && <TriangleAlert className="mark warn" size={13} aria-label="Check this sender" />}
            <strong>{nameOf(m.from)}</strong>
            {m.from.name && <span className="muted"> {m.from.address}</span>}
          </div>
          <div className="anchor"><Recipients message={m} own={own} /></div>
        </div>
        <span className="muted when">{longTime(m.date)}</span>
        {leaving && (
          <button className="pill strong" onClick={() => props.unsubscribe(m.id)}>Unsubscribe</button>
        )}
        <IconButton icon={Reply} label="Reply to this" click={() => props.reply('reply', m.id)} />
      </div>
      <Cautions message={m} />
      {m.facts && <FactCard message={m} facts={m.facts} rsvp={rsvp} />}
      <MailBody text={m.text} html={m.html} onPeek={onPeek} images={images} sender={m.from.address.toLowerCase()} trust={props.trust}
        keepQuoted={FORWARDED.test(m.subject)} />
      {m.attachments.length > 0 && <Attachments message={m} say={say} />}
      {m.truncated && <p className="muted note message-note">Too big to keep whole here.</p>}
    </article>
  )
}

/** A few ready answers to a person's message, in the language they wrote in. Nothing leaves the
 *  laptop to come up with these, and pressing one only starts a reply. */
function quickAnswers(message: MessageView, own: string[]): string[] {
  if (message.unsubscribe || own.includes(message.from.address.toLowerCase())) return []
  if (/no-?reply|notifications?@|mailer-daemon/i.test(message.from.address)) return []
  return /[ăâđêôơưạảãáàậẩẫấầặẳẵắằẹẻẽéèệểễếềịỉĩíìọỏõóòộổỗốồợởỡớờụủũúùựửữứừỵỷỹýỳ]/i.test(message.text.slice(0, 2000))
    ? ['Cảm ơn bạn!', 'Mình đã nhận được.', 'Được nhé.']
    : ['Thanks!', 'Sounds good.', 'Got it, thank you.']
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
  setPanel(panel: Panel): void
  back(): void
  act(action: MailAction, label?: string): void
  snooze(at: number): void
  reply(kind: ReplyKind, message: number, text?: string): void
  unsubscribe(message: number): void
  block(address: string): void
  rsvp(message: number, answer: Rsvp): void
  setFocus(address: string, focused: boolean): void
  trust(address: string): void
  forever(): void
  say(text: string): void
}): ReactNode {
  const { messages, account, labels, bins, panel, setPanel, back, act, own, settings } = props
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
        <img src={icon} alt="" width={56} height={56} />
        <Empty icon={Mail} title={props.unread > 0 ? `${props.unread} unread` : 'Pick something to read'}
          note={props.held > 0 ? `${props.held} more waiting for the next delivery` : 'Press ? for the keys'} />
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
  const starred = messages.some((m) => m.flagged)
  const active = [...new Set(messages.flatMap((m) => userLabels(m.labels)))]
  const person = messages.find((m) => m.from.address && m.from.address !== last.account)
  const sender = person?.from.address
  const gmail = account?.labels ?? false
  const answers = quickAnswers(last, own)
  const folded = !unfolded && messages.length > LONG_THREAD
  const hidden = folded ? messages.slice(1, -2).filter((m) => !open.has(m.id)) : []
  const shown = messages.filter((m) => !hidden.includes(m))
  const leaving = [...messages].reverse().find((m) => m.unsubscribe)

  const moreItem = (Icon: LucideIcon, label: string, run: () => void): ReactNode => (
    <button type="button" className="menu-item" onClick={() => { setPanel(null); run() }}>
      <Icon size={15} aria-hidden="true" /> {label}
    </button>
  )

  return (
    <main className="reader">
      <div className="toolbar" role="toolbar" aria-label="Thread">
        <button className="icon back" onClick={back} aria-label="Back"><ArrowLeft size={17} aria-hidden="true" /></button>
        <span className="grow" />
        {bins ? (
          <>
            <IconButton icon={Undo2} label="Move to Inbox" click={() => act({ kind: 'inbox' }, 'Moved to Inbox')} />
            <IconButton icon={Trash2} label="Delete forever" hint="#" click={props.forever} />
          </>
        ) : (
          <>
            {inInbox
              ? <IconButton icon={Archive} label="Archive" hint="e" click={() => act({ kind: 'archive' }, 'Archived')} />
              : <IconButton icon={Inbox} label="Move to Inbox" click={() => act({ kind: 'inbox' }, 'Moved to Inbox')} />}
            <IconButton icon={Trash2} label="Delete" hint="#" click={() => act({ kind: 'trash' }, 'Moved to Trash')} />
            <IconButton icon={Star} label={starred ? 'Remove star' : 'Star'} hint="s" on={starred}
              click={() => act({ kind: starred ? 'unstar' : 'star' })} />
            <IconButton icon={Mail} label="Mark unread" hint="Shift+U" click={() => act({ kind: 'unread' })} />
            <div className="anchor">
              <IconButton icon={Clock} label="Snooze" hint="b" click={() => setPanel(panel === 'snooze' ? null : 'snooze')} />
              {panel === 'snooze' && <TimeMenu title="Snooze until" right pick={props.snooze} close={() => setPanel(null)} />}
            </div>
            <div className="anchor">
              <IconButton icon={gmail ? Tag : FolderInput} label={gmail ? 'Labels' : 'Move to'} hint="l" click={() => setPanel(panel === 'labels' ? null : 'labels')} />
              {panel === 'labels' && (gmail
                ? <LabelMenu labels={labels} active={active} set={(label, add) => act({ kind: 'label', label, add })} close={() => setPanel(null)} />
                : <FolderMenu folders={account?.folders ?? []} close={() => setPanel(null)} pick={(to) => { setPanel(null); act({ kind: 'move', to }, `Moved to ${to}`) }} />)}
            </div>
          </>
        )}
        <div className="anchor">
          <IconButton icon={MoreVertical} label="More" click={() => setPanel(panel === 'more' ? null : 'more')} />
          {panel === 'more' && (
            <Popover right close={() => setPanel(null)}>
              {!bins && moreItem(OctagonAlert, 'Report spam', () => act({ kind: 'spam' }, 'Reported as spam'))}
              {sender && inInbox && moreItem(Filter, person?.focused ? 'Keep this sender in Other' : 'Keep this sender in Focused', () => props.setFocus(sender, !person?.focused))}
              {sender && !bins && moreItem(Ban, 'Block sender', () => props.block(sender))}
              {moreItem(Printer, 'Print', () => window.print())}
              {gmail && moreItem(ExternalLink, 'Open in Gmail', () => void window.mail.openInGmail(last.account, last.thread))}
            </Popover>
          )}
        </div>
      </div>
      <div className="messages">
        <h2 className="thread-subject">{messages[0]?.subject || 'No subject'}</h2>
        {active.length > 0 && (
          <div className="tags">{active.map((label) => <span className="tag" key={label}>{label}</span>)}</div>
        )}
        {shown.map((m, i) => (
          <div key={m.id}>
            {hidden.length > 0 && i === 1 && (
              <button className="fold" onClick={() => setUnfolded(true)}>
                <span className="fold-count">{hidden.length}</span> more {hidden.length === 1 ? 'email' : 'emails'}
              </button>
            )}
            <Message message={m} open={open.has(m.id)} leaving={m === leaving} bins={bins} own={own} settings={settings} toggle={() => toggle(m.id)} onPeek={setPeek} say={props.say} rsvp={props.rsvp} reply={props.reply}
              unsubscribe={props.unsubscribe} trust={props.trust} />
          </div>
        ))}
        {!bins && (
          <div className="answers">
            {answers.length > 0 && (
              <div className="quick">
                {answers.map((words) => <button key={words} className="pill" onClick={() => props.reply('reply', last.id, words)}>{words}</button>)}
              </div>
            )}
            <div className="answer">
              <button className="pill" onClick={() => props.reply('reply', last.id)}><Reply size={15} aria-hidden="true" /> Reply</button>
              <button className="pill" onClick={() => props.reply('replyAll', last.id)}><ReplyAll size={15} aria-hidden="true" /> Reply all</button>
              <button className="pill" onClick={() => props.reply('forward', last.id)}><Forward size={15} aria-hidden="true" /> Forward</button>
            </div>
          </div>
        )}
      </div>
      {peek && <div className="peek">{peek}</div>}
    </main>
  )
}
