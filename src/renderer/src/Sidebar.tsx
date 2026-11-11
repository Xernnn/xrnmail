import { useState, type DragEvent, type ReactNode } from 'react'
import {
  CalendarDays, Check, ChevronRight, Clock, DollarSign, FileText, Flag, Folder, ListChecks, Mail, Mails, OctagonAlert, Paperclip, Pencil, Plane,
  RotateCw, Send, Settings as Gear, Tag, Ticket, Trash2, Truck, type LucideIcon
} from 'lucide-react'
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

/** Dragging something onto a place in the list does what going there would mean. */
const DROPS = new Set(['inbox', 'starred', 'all', 'archive', 'spam', 'trash', 'label'])

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
  /** Right-clicked: a list of mail, and where the pointer was. */
  menu(target: ListQuery, x: number, y: number): void
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
          if (target.kind === 'drafts' || target.kind === 'subscriptions') return
          e.preventDefault()
          props.menu(target, e.clientX, e.clientY)
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
  const all = many ? 'All ' : ''

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

  return (
    <nav className="sidebar" aria-label="Mailboxes">
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
        <hr />
        <div className="nav-group">
          {item('Today', { kind: 'today' }, { icon: CalendarDays })}
          {item('Unread', { kind: 'unread' }, { icon: Mail })}
          {item('Flagged', { kind: 'starred' }, { icon: Flag })}
          {item('Snoozed', { kind: 'snoozed' }, { icon: Clock })}
          {item('Attachments', { kind: 'attachments' }, { icon: Paperclip })}
          {item(`${all}Drafts`, { kind: 'drafts' }, { icon: FileText, count: drafts.length })}
          {item('Spam', { kind: 'spam' }, { icon: OctagonAlert, count: overview?.spam })}
          {item('Trash', { kind: 'trash' }, { icon: Trash2 })}
          {item(`${all}Archive`, { kind: 'archive' }, { icon: Check })}
          {item(`${all}Sent`, { kind: 'sent' }, { icon: Send })}
        </div>
        <hr />
        <div className="nav-group">
          {item('Subscriptions', { kind: 'subscriptions' }, { icon: ListChecks })}
          {ASSISTANT.map(([kind, label, icon]) => (
            <div key={kind}>{item(label, { kind: 'assistant', section: kind }, { icon, count: overview?.assistant[kind] })}</div>
          ))}
        </div>
      </div>
      <div className="sidebar-foot">
        <span className="muted grow status">{syncing ? 'Checking for mail' : lastSync > 0 ? `Updated ${ago(lastSync)}` : ''}</span>
        <button className="icon" aria-label="Settings" title="Settings (Ctrl+,)" onClick={props.settings}><Gear size={16} aria-hidden="true" /></button>
      </div>
    </nav>
  )
}
