import { type DragEvent, type ReactNode } from 'react'
import {
  Archive, CalendarDays, CalendarRange, CircleDot, Clock, FileText, Inbox, Layers, MailMinus, OctagonAlert, Package, Paperclip, PenLine, Plane, Receipt,
  RefreshCw, Send, Settings as Gear, Star, Tag, Trash2, type LucideIcon
} from 'lucide-react'
import type { AccountView, AssistantSection, ListQuery, Overview, ThreadRef } from '@shared/types'
import { ago, mailbox } from './format'

export type View = ListQuery | { kind: 'drafts' } | { kind: 'subscriptions' }

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

export function Sidebar(props: {
  accounts: AccountView[]
  overview: Overview | null
  view: View
  draftCount: number
  /** Split into Focused and Other. */
  split: boolean
  go(view: View): void
  compose(): void
  settings(): void
  drop(target: View, refs: ThreadRef[]): void
}): ReactNode {
  const { accounts, overview, view, go, draftCount, split } = props
  const many = accounts.length > 1
  const within = 'account' in view ? view.account : undefined
  const scoped = many ? within : undefined
  const scope = scoped ? { account: scoped } : {}

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

  const item = (label: string, target: View, options: { icon?: LucideIcon; count?: number; color?: string; extra?: string; badge?: boolean } = {}): ReactNode => {
    const Icon = options.icon
    const count = options.count ?? 0
    return (
      <button className={`nav-item ${options.extra ?? ''} ${sameView(view, target) ? 'on' : ''}`} onClick={() => go(target)} {...dropping(target)}>
        {options.color && <span className="dot" style={{ background: options.color }} aria-hidden="true" />}
        {Icon && <Icon className="nav-icon" size={15} aria-hidden="true" />}
        <span className="grow">{label}</span>
        {count > 0 && <span className={options.badge ? 'nav-badge' : 'nav-count'}>{showCount(count)}</span>}
      </button>
    )
  }

  const syncing = accounts.some((a) => a.syncing)
  const unread = accounts.reduce((sum, a) => sum + a.unread, 0)
  const scopedUnread = scoped ? accounts.find((a) => a.email === scoped)?.unread : unread
  const lastSync = Math.max(0, ...accounts.map((a) => a.syncedAt ?? 0))
  const inbox: View = { kind: 'inbox', ...scope }

  return (
    <nav className="sidebar">
      <div className="sidebar-scroll">
        <button className="compose" onClick={props.compose}><PenLine size={15} aria-hidden="true" /> Compose</button>
        {item(many && !scoped ? 'All Inboxes' : 'Inbox', inbox, { icon: Inbox, count: scopedUnread })}
        {split && item(many && !scoped ? 'All Other' : 'Other', { kind: 'inbox', ...scope, focus: 'other' }, { icon: Layers, count: overview?.otherUnread })}
        {many && (
          <>
            <hr />
            {accounts.map((a) => (
              <div key={a.id}>
                {item(a.email, { kind: 'inbox', account: a.email }, { extra: 'account', count: a.unread, color: a.color })}
              </div>
            ))}
          </>
        )}
        {accounts.map((a) => a.error && <div className="nav-error" key={a.id}>{many ? `${mailbox(a.email)}: ` : ''}{a.error}</div>)}
        <hr />
        {item('Today', { kind: 'today', ...scope }, { icon: CalendarDays })}
        {item('Starred', { kind: 'starred', ...scope }, { icon: Star })}
        {item('Unread', { kind: 'unread', ...scope }, { icon: CircleDot })}
        {item('Snoozed', { kind: 'snoozed', ...scope }, { icon: Clock })}
        {item('Attachments', { kind: 'attachments', ...scope }, { icon: Paperclip })}
        {item('Spam', { kind: 'spam', ...scope }, { icon: OctagonAlert, count: overview?.spam })}
        {item('All Mail', { kind: 'all', ...scope }, { icon: Archive })}
        {item('Drafts', { kind: 'drafts' }, { icon: FileText, count: draftCount })}
        {item('Sent', { kind: 'sent', ...scope }, { icon: Send })}
        {item('Trash', { kind: 'trash', ...scope }, { icon: Trash2 })}
        {accounts.filter((a) => a.email === scoped || !many).map((a) => {
          const labels = (overview?.labels ?? []).filter((l) => l.account === a.email)
          return labels.length === 0 ? null : (
            <div key={a.id}>
              <h2 className="nav-head">{a.labels ? 'Labels' : 'Folders'}</h2>
              {labels.map((l) => {
                const depth = l.label.split('/').length - 1
                return (
                  <div key={l.label} style={{ paddingLeft: depth * 12 }}>
                    {item(l.label.split('/').at(-1) ?? l.label, { kind: 'label', account: a.email, label: l.label }, { icon: Tag })}
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
      <div className="sidebar-assistant">
        <h2 className="nav-head">Assistant</h2>
        {ASSISTANT.map(([section, label, icon]) => (
          <div key={section}>{item(label, { kind: 'assistant', section }, { icon, count: overview?.assistant[section], badge: true })}</div>
        ))}
        {item('Subscriptions', { kind: 'subscriptions' }, { icon: MailMinus })}
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
