import { Fragment, useEffect, useState, type DragEvent, type ReactNode } from 'react'
import {
  CalendarDays, Check, ChevronDown, ChevronRight, ChevronUp, Clock, DollarSign, FileText, Flag, Folder, GripHorizontal, History, ListChecks, Mail, Mails, OctagonAlert,
  Paperclip, Pencil, Pin, Plane, RotateCw, Send, Settings as Gear, Tag, Ticket, Trash2, Truck, type LucideIcon
} from 'lucide-react'
import { arranged, cleanSidebar, moved, SIDEBAR_GROUPS, type SidebarChoice, type SidebarEntry } from '@shared/sidebar'
import type { AccountView, AssistantSection, Draft, ListQuery, Overview, ThreadRef } from '@shared/types'
import { ago, mailbox } from './format'

export type View = ListQuery | { kind: 'drafts'; account?: string } | { kind: 'subscriptions'; left?: boolean }

export const sameView = (a: View, b: View): boolean => JSON.stringify(a) === JSON.stringify(b)

/** What a thread carries when it's dragged. */
export const THREADS = 'application/x-xrnmail-threads'

const BIGGEST_COUNT = 99
const showCount = (count: number): string => (count > BIGGEST_COUNT ? `${BIGGEST_COUNT}+` : String(count))

/** In the order the sidebar lists them. */
export const ASSISTANT: [AssistantSection, string, LucideIcon][] = [
  ['travel', 'Travel', Plane], ['packages', 'Packages', Truck], ['money', 'Bills & Receipts', DollarSign], ['events', 'Events', Ticket]
]

/** The entries of the two lists that can be edited. With several accounts, [gathered] ones are "All …". */
const ENTRIES: Record<SidebarEntry, { label: string; icon: LucideIcon; target: View; gathered?: boolean }> = {
  today: { label: 'Today', icon: CalendarDays, target: { kind: 'today' } },
  unread: { label: 'Unread', icon: Mail, target: { kind: 'unread' } },
  starred: { label: 'Flagged', icon: Flag, target: { kind: 'starred' } },
  pinned: { label: 'Pinned', icon: Pin, target: { kind: 'pinned' } },
  snoozed: { label: 'Snoozed', icon: Clock, target: { kind: 'snoozed' } },
  attachments: { label: 'Attachments', icon: Paperclip, target: { kind: 'attachments' } },
  drafts: { label: 'Drafts', icon: FileText, target: { kind: 'drafts' }, gathered: true },
  spam: { label: 'Spam', icon: OctagonAlert, target: { kind: 'spam' } },
  trash: { label: 'Trash', icon: Trash2, target: { kind: 'trash' } },
  archive: { label: 'Archive', icon: Check, target: { kind: 'archive' }, gathered: true },
  sent: { label: 'Sent', icon: Send, target: { kind: 'sent' }, gathered: true },
  recent: { label: 'Recently Seen', icon: History, target: { kind: 'recent' } },
  subscriptions: { label: 'Subscriptions', icon: ListChecks, target: { kind: 'subscriptions' } },
  ...Object.fromEntries(ASSISTANT.map(([section, label, icon]) => [section, { label, icon, target: { kind: 'assistant', section } }])) as
    Record<AssistantSection, { label: string; icon: LucideIcon; target: View }>
}
const GROUP_NAMES = ['Folders', 'Assistant']

/** What an entry carries while it's dragged to another place in its list. */
const ENTRY = 'application/x-xrnmail-entry'

/** Dragging something onto a place in the list does what going there would mean. */
const DROPS = new Set(['inbox', 'starred', 'pinned', 'all', 'archive', 'spam', 'trash', 'label'])

/** The accounts whose folders aren't as they start out: folded, or with several accounts unfolded. */
const CLOSED_KEY = 'xrnmail.sidebar.closed'

const savedClosed = (): Set<string> => {
  try {
    const saved = JSON.parse(localStorage.getItem(CLOSED_KEY) ?? '[]') as unknown
    return new Set(Array.isArray(saved) ? saved.filter((s): s is string => typeof s === 'string') : [])
  } catch {
    return new Set()
  }
}

export function Sidebar(props: {
  accounts: AccountView[]
  overview: Overview | null
  view: View
  drafts: Draft[]
  go(view: View): void
  compose(): void
  settings(): void
  drop(target: View, refs: ThreadRef[]): void
  /** Right-clicked: a list of mail, or none when it was somewhere else on the sidebar, and where the pointer was. */
  menu(target: ListQuery | null, x: number, y: number): void
  /** Which entries show, and in what order. */
  choice: SidebarChoice
  /** Being edited: the entries turn into switches that can be moved. */
  editing: boolean
  /** Editing is over, with what was chosen, or with nothing when it was called off. */
  edited(choice: SidebarChoice | null): void
}): ReactNode {
  const { accounts, overview, view, go, drafts } = props
  const many = accounts.length > 1
  const [closed, setClosed] = useState(savedClosed)
  const [draft, setDraft] = useState(() => cleanSidebar(props.choice))

  // Each time editing starts, it starts from what's saved.
  useEffect(() => {
    if (props.editing) setDraft(cleanSidebar(props.choice))
  }, [props.editing])

  useEffect(() => {
    if (!props.editing) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      props.edited(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [props.editing])

  const toggle = (id: string): void => {
    const next = new Set(closed)
    if (!next.delete(id)) next.add(id)
    setClosed(next)
    try {
      localStorage.setItem(CLOSED_KEY, JSON.stringify([...next]))
    } catch {
      // Only a convenience: next time every account starts unfolded.
    }
  }

  const dropping = (target: View) => DROPS.has(target.kind) ? {
    onDragOver: (event: DragEvent) => {
      if (!event.dataTransfer.types.includes(THREADS)) return
      event.preventDefault()
      event.currentTarget.classList.add('drop')
    },
    onDragLeave: (event: DragEvent) => event.currentTarget.classList.remove('drop'),
    onDrop: (event: DragEvent) => {
      event.preventDefault()
      event.currentTarget.classList.remove('drop')
      const refs = JSON.parse(event.dataTransfer.getData(THREADS) || '[]') as ThreadRef[]
      if (refs.length > 0) props.drop(target, refs)
    }
  } : {}

  /** An inbox stays lit on either side of Focused and Other, and Subscriptions on either of its sides. */
  const isOn = (target: View): boolean => {
    if (target.kind === 'inbox' && view.kind === 'inbox') return view.account === target.account
    return target.kind === 'subscriptions' ? view.kind === 'subscriptions' : sameView(view, target)
  }

  const item = (label: string, target: View, options: { icon?: LucideIcon; count?: number; extra?: string; lead?: ReactNode } = {}): ReactNode => {
    const Icon = options.icon
    const count = options.count ?? 0
    return (
      <button className={`nav-item ${options.extra ?? ''} ${isOn(target) ? 'on' : ''}`} aria-current={isOn(target) ? 'page' : undefined}
        onClick={() => go(target)} {...dropping(target)}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          props.menu(target.kind === 'drafts' || target.kind === 'subscriptions' ? null : target, e.clientX, e.clientY)
        }}>
        {options.lead}
        {Icon && <Icon className="nav-icon" size={16} aria-hidden="true" />}
        <span className="grow">{label}</span>
        {count > 0 && <span className="nav-count">{showCount(count)}</span>}
      </button>
    )
  }

  const syncing = accounts.some((a) => a.syncing)
  const unread = accounts.reduce((sum, a) => sum + a.unread, 0)
  const lastSync = Math.max(0, ...accounts.map((a) => a.syncedAt ?? 0))

  /** What belongs to one account alone: its own folders when there are several accounts, and its labels. */
  const folders = (a: AccountView): ReactNode => {
    const labels = (overview?.labels ?? []).filter((l) => l.account === a.email)
    const scope = { account: a.email }
    return (
      <div className="nav-folders">
        {many && item('Drafts', { kind: 'drafts', ...scope }, { icon: FileText, count: drafts.filter((d) => d.account === a.email).length })}
        {many && item('Sent', { kind: 'sent', ...scope }, { icon: Send })}
        {item('All Mail', many ? { kind: 'all', ...scope } : { kind: 'all' }, { icon: Mails })}
        {many && item('Spam', { kind: 'spam', ...scope }, { icon: OctagonAlert })}
        {many && item('Trash', { kind: 'trash', ...scope }, { icon: Trash2 })}
        {labels.length > 0 && <h2 className="nav-head">{a.labels ? 'Labels' : 'Folders'}</h2>}
        {labels.map((l) => {
          const depth = l.label.split('/').length - 1
          return (
            <div key={l.label} style={{ paddingLeft: depth * 14 }}>
              {item(l.label.split('/').at(-1) ?? l.label, { kind: 'label', account: a.email, label: l.label }, { icon: a.labels ? Tag : Folder })}
            </div>
          )
        })}
      </div>
    )
  }

  /** An account: its inbox when there are several, and an arrow that unfolds what's its own. */
  const account = (a: AccountView): ReactNode => {
    const id = `account:${a.email}`
    // One account shows its labels from the start; several start folded, or the list would never end.
    const open = closed.has(id) === many
    const face = <span className="account-face" style={{ background: a.color }} aria-hidden="true">{a.email.slice(0, 1).toUpperCase()}</span>
    const arrow = <ChevronRight className="nav-chevron" size={14} aria-hidden="true" />
    return (
      <div className="nav-account" key={a.id}>
        {many ? (
          <div className="nav-account-row">
            {item(a.email, { kind: 'inbox', account: a.email }, { extra: 'account', count: a.unread, lead: face })}
            <button className="nav-fold" aria-expanded={open} aria-label={`Folders of ${a.email}`} onClick={() => toggle(id)}>{arrow}</button>
          </div>
        ) : (
          <button className="nav-item account" aria-expanded={open} aria-label={`Folders of ${a.email}`} onClick={() => toggle(id)}>
            {face}
            <span className="grow">{a.email}</span>
            {arrow}
          </button>
        )}
        {open && folders(a)}
      </div>
    )
  }

  const labelOf = (entry: SidebarEntry): string => `${many && ENTRIES[entry].gathered ? 'All ' : ''}${ENTRIES[entry].label}`
  const countOf = (entry: SidebarEntry): number | undefined =>
    entry === 'drafts' ? drafts.length : entry === 'spam' ? overview?.spam : entry in (overview?.assistant ?? {}) ? overview?.assistant[entry as AssistantSection] : undefined

  if (props.editing) {
    const toggleEntry = (entry: SidebarEntry): void =>
      setDraft({ ...draft, hidden: draft.hidden.includes(entry) ? draft.hidden.filter((e) => e !== entry) : [...draft.hidden, entry] })
    return (
      <nav className="sidebar editing" aria-label="Mailboxes">
        <div className="sidebar-top">
          <button className="link" onClick={() => props.edited(null)}>Cancel</button>
          <span className="grow" />
          <button className="pill strong" onClick={() => props.edited(draft)}>Done</button>
        </div>
        <div className="sidebar-scroll">
          {SIDEBAR_GROUPS.map((group, g) => {
            const list = arranged(group, draft)
            return (
              <Fragment key={g}>
                {g > 0 && <hr />}
                <ul className="nav-group nav-editing" aria-label={GROUP_NAMES[g]}>
                  {list.map((entry, at) => {
                    const { icon: Icon } = ENTRIES[entry]
                    const label = labelOf(entry)
                    return (
                      <li className="nav-edit" key={entry} draggable
                        onDragStart={(e) => { e.dataTransfer.setData(ENTRY, entry); e.dataTransfer.effectAllowed = 'move' }}
                        onDragOver={(e) => {
                          if (!e.dataTransfer.types.includes(ENTRY)) return
                          e.preventDefault()
                          e.currentTarget.classList.add('drop')
                        }}
                        onDragLeave={(e) => e.currentTarget.classList.remove('drop')}
                        onDrop={(e) => {
                          e.preventDefault()
                          e.currentTarget.classList.remove('drop')
                          const from = e.dataTransfer.getData(ENTRY) as SidebarEntry
                          if (from in ENTRIES) setDraft(moved(draft, from, entry))
                        }}>
                        <label className="grow">
                          <input type="checkbox" checked={!draft.hidden.includes(entry)} onChange={() => toggleEntry(entry)} aria-label={`Show ${label}`} />
                          <Icon className="nav-icon" size={16} aria-hidden="true" />
                          <span className="grow">{label}</span>
                        </label>
                        <button className="icon" aria-label={`Move ${label} up`} disabled={at === 0}
                          onClick={() => setDraft(moved(draft, entry, list[at - 1] ?? entry))}><ChevronUp size={14} aria-hidden="true" /></button>
                        <button className="icon" aria-label={`Move ${label} down`} disabled={at === list.length - 1}
                          onClick={() => setDraft(moved(draft, entry, list[at + 1] ?? entry))}><ChevronDown size={14} aria-hidden="true" /></button>
                        <GripHorizontal className="nav-grip" size={15} aria-hidden="true" />
                      </li>
                    )
                  })}
                </ul>
              </Fragment>
            )
          })}
        </div>
      </nav>
    )
  }

  const choice = cleanSidebar(props.choice)

  return (
    <nav className="sidebar" aria-label="Mailboxes"
      onContextMenu={(e) => {
        e.preventDefault()
        props.menu(null, e.clientX, e.clientY)
      }}>
      <div className="sidebar-top">
        <button className="compose" title="New message (c)" onClick={props.compose}><Pencil size={15} aria-hidden="true" /> Compose</button>
        <span className="grow" />
        <button className="icon" disabled={syncing} aria-label={syncing ? 'Syncing' : 'Sync'} title="Check for mail (F5)" onClick={() => void window.mail.syncNow()}>
          <RotateCw className={syncing ? 'spin' : ''} size={17} aria-hidden="true" />
        </button>
      </div>
      <div className="sidebar-scroll">
        <div className="nav-group">
          {item(many ? 'All Inboxes' : 'Inbox', { kind: 'inbox' }, {
            count: unread, lead: <span className="inbox-mark" aria-hidden="true"><Mail size={12} /></span>
          })}
        </div>
        <hr />
        <div className="nav-group">{accounts.map(account)}</div>
        {accounts.map((a) => a.error && <div className="nav-error" role="alert" key={a.id}>{many ? `${mailbox(a.email)}: ` : ''}{a.error}</div>)}
        {SIDEBAR_GROUPS.map((group, g) => {
          const shown = arranged(group, choice).filter((entry) => !choice.hidden.includes(entry))
          return shown.length > 0 && (
            <Fragment key={g}>
              <hr />
              <div className="nav-group">
                {shown.map((entry) => (
                  <Fragment key={entry}>{item(labelOf(entry), ENTRIES[entry].target, { icon: ENTRIES[entry].icon, count: countOf(entry) })}</Fragment>
                ))}
              </div>
            </Fragment>
          )
        })}
      </div>
      <div className="sidebar-foot">
        <span className="muted grow status">{syncing ? 'Checking for mail' : lastSync > 0 ? `Updated ${ago(lastSync)}` : ''}</span>
        <button className="icon" aria-label="Settings" title="Settings (Ctrl+,)" onClick={props.settings}><Gear size={16} aria-hidden="true" /></button>
      </div>
    </nav>
  )
}
