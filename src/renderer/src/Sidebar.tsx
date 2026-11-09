import { useState, type DragEvent, type ReactNode } from 'react'
import {
  Archive, CalendarDays, CalendarRange, ChevronDown, CircleDot, Clock, FileText, Inbox, MailMinus, OctagonAlert, Package, Paperclip, PenLine, Plane,
  Receipt, RefreshCw, Send, Settings as Gear, Star, Tag, Trash2, type LucideIcon
} from 'lucide-react'
import type { AccountView, AssistantSection, Draft, ListQuery, Overview, ThreadRef } from '@shared/types'
import { ago, mailbox } from './format'

export type View = ListQuery | { kind: 'drafts'; account?: string } | { kind: 'subscriptions' }

export const sameView = (a: View, b: View): boolean => JSON.stringify(a) === JSON.stringify(b)

/** What a thread carries when it's dragged. */
export const THREADS = 'application/x-xrnmail-threads'

const BIGGEST_COUNT = 99
const showCount = (count: number): string => (count > BIGGEST_COUNT ? `${BIGGEST_COUNT}+` : String(count))

export const ASSISTANT: [AssistantSection, string, LucideIcon][] = [
  ['packages', 'Packages', Package], ['travel', 'Travel', Plane], ['money', 'Bills & receipts', Receipt], ['events', 'Events', CalendarRange]
]

/** Dragging something onto a place in the list does what going there would mean. */
const DROPS = new Set(['inbox', 'starred', 'all', 'spam', 'trash', 'label'])

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
}): ReactNode {
  const { accounts, overview, view, go, drafts } = props
  const many = accounts.length > 1
  const [closed, setClosed] = useState(savedClosed)

  const toggle = (id: string): void => {
    const next = new Set(closed)
    if (!next.delete(id)) next.add(id)
    setClosed(next)
    try {
      localStorage.setItem(CLOSED_KEY, JSON.stringify([...next]))
    } catch {
      // Only a convenience: next time every section starts open.
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

  /** An inbox stays lit on either side of Focused and Other. */
  const isOn = (target: View): boolean =>
    target.kind === 'inbox' && view.kind === 'inbox' ? view.account === target.account : sameView(view, target)

  const item = (label: string, target: View, options: { icon?: LucideIcon; count?: number; color?: string; extra?: string; badge?: boolean } = {}): ReactNode => {
    const Icon = options.icon
    const count = options.count ?? 0
    return (
      <button className={`nav-item ${options.extra ?? ''} ${isOn(target) ? 'on' : ''}`} aria-current={isOn(target) ? 'page' : undefined}
        onClick={() => go(target)} {...dropping(target)}>
        {options.color && <span className="dot" style={{ background: options.color }} aria-hidden="true" />}
        {Icon && <Icon className="nav-icon" size={16} aria-hidden="true" />}
        <span className="grow">{label}</span>
        {count > 0 && <span className={options.badge ? 'nav-badge' : 'nav-count'}>{showCount(count)}</span>}
      </button>
    )
  }

  /** A heading that folds what's under it away, remembered on this laptop. */
  const section = (id: string, title: string, label: string, body: ReactNode): ReactNode => {
    const open = !closed.has(id)
    return (
      <div className="nav-section" key={id}>
        <button className="nav-section-head" aria-expanded={open} aria-label={label} onClick={() => toggle(id)}>
          <span className="grow">{title}</span>
          <ChevronDown className="nav-chevron" size={14} aria-hidden="true" />
        </button>
        {open && <div className="nav-section-body">{body}</div>}
      </div>
    )
  }

  const syncing = accounts.some((a) => a.syncing)
  const unread = accounts.reduce((sum, a) => sum + a.unread, 0)
  const lastSync = Math.max(0, ...accounts.map((a) => a.syncedAt ?? 0))
  // One account keeps the views it always had; several get a set each.
  const scope = (a: AccountView): { account?: string } => (many ? { account: a.email } : {})

  const folders = (a: AccountView): ReactNode => {
    const labels = (overview?.labels ?? []).filter((l) => l.account === a.email)
    const own = drafts.filter((d) => !many || d.account === a.email).length
    return (
      <>
        {item('Drafts', { kind: 'drafts', ...scope(a) }, { icon: FileText, count: own })}
        {item('Sent', { kind: 'sent', ...scope(a) }, { icon: Send })}
        {item('All Mail', { kind: 'all', ...scope(a) }, { icon: Archive })}
        {item('Spam', { kind: 'spam', ...scope(a) }, { icon: OctagonAlert, count: many ? 0 : overview?.spam })}
        {item('Trash', { kind: 'trash', ...scope(a) }, { icon: Trash2 })}
        {labels.length > 0 && <h2 className="nav-head">{a.labels ? 'Labels' : 'Folders'}</h2>}
        {labels.map((l) => {
          const depth = l.label.split('/').length - 1
          return (
            <div key={l.label} style={{ paddingLeft: depth * 12 }}>
              {item(l.label.split('/').at(-1) ?? l.label, { kind: 'label', account: a.email, label: l.label }, { icon: Tag })}
            </div>
          )
        })}
      </>
    )
  }

  return (
    <nav className="sidebar" aria-label="Mailboxes">
      <div className="sidebar-top">
        <button className="compose" title="New message (c)" onClick={props.compose}><PenLine size={16} aria-hidden="true" /> Compose</button>
      </div>
      <div className="sidebar-scroll">
        <div className="nav-group">
          {item(many ? 'All Inboxes' : 'Inbox', { kind: 'inbox' }, { icon: Inbox, count: unread })}
          {many && accounts.map((a) => (
            <div key={a.id}>{item(a.email, { kind: 'inbox', account: a.email }, { extra: 'account', count: a.unread, color: a.color })}</div>
          ))}
        </div>
        {accounts.map((a) => a.error && <div className="nav-error" role="alert" key={a.id}>{many ? `${mailbox(a.email)}: ` : ''}{a.error}</div>)}
        <div className="nav-group">
          {item('Unread', { kind: 'unread' }, { icon: CircleDot })}
          {item('Starred', { kind: 'starred' }, { icon: Star })}
          {item('Snoozed', { kind: 'snoozed' }, { icon: Clock })}
          {item('Today', { kind: 'today' }, { icon: CalendarDays })}
          {item('Attachments', { kind: 'attachments' }, { icon: Paperclip })}
        </div>
        {accounts.map((a) => section(`account:${a.email}`, a.email, `Folders of ${a.email}`, folders(a)))}
        {section('assistant', 'Assistant', 'Assistant', (
          <>
            {ASSISTANT.map(([kind, label, icon]) => (
              <div key={kind}>{item(label, { kind: 'assistant', section: kind }, { icon, count: overview?.assistant[kind], badge: true })}</div>
            ))}
            {item('Subscriptions', { kind: 'subscriptions' }, { icon: MailMinus })}
          </>
        ))}
      </div>
      <div className="sidebar-foot">
        <span className="muted grow status">{syncing ? 'Checking for mail' : lastSync > 0 ? `Updated ${ago(lastSync)}` : ''}</span>
        <button className="icon" disabled={syncing} aria-label={syncing ? 'Syncing' : 'Sync'} title="Check for mail (F5)" onClick={() => void window.mail.syncNow()}>
          <RefreshCw className={syncing ? 'spin' : ''} size={16} aria-hidden="true" />
        </button>
        <button className="icon" aria-label="Settings" title="Settings (Ctrl+,)" onClick={props.settings}><Gear size={16} aria-hidden="true" /></button>
      </div>
    </nav>
  )
}
