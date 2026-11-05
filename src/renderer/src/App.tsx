import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { AccountView, ListQuery, MessageView, Overview, ThreadRow } from '@shared/types'
import { clock, mailbox, problem, shortTime } from './format'
import { Reader } from './Reader'
import { SettingsDialog } from './Settings'
import { Welcome } from './Setup'

interface OpenThread {
  account: string
  thread: string
}

const sameQuery = (a: ListQuery, b: ListQuery): boolean => JSON.stringify(a) === JSON.stringify(b)

function Sidebar(props: {
  accounts: AccountView[]
  overview: Overview | null
  query: ListQuery
  go(query: ListQuery): void
  settings(): void
}): ReactNode {
  const { accounts, overview, query, go } = props
  const item = (label: string, target: ListQuery, extra = ''): ReactNode => (
    <button className={`nav-item ${extra} ${sameQuery(query, target) ? 'on' : ''}`} onClick={() => go(target)}>
      {label}
    </button>
  )
  const within = 'account' in query ? query.account : undefined
  const syncing = accounts.some((a) => a.syncing)
  return (
    <nav className="sidebar">
      <div className="brand">xrnmail</div>
      {item('Inbox', { kind: 'inbox' })}
      {accounts.length > 1 && <div className="nav-gap" />}
      {accounts.map((a) => (
        <div key={a.id}>
          {accounts.length > 1 && item(mailbox(a.email), { kind: 'inbox', account: a.email })}
          {a.error && <div className="nav-error">{a.error}</div>}
          {(within === a.email || accounts.length === 1) && (
            <>
              {item('Sent', { kind: 'label', account: a.email, label: '\\Sent' }, 'sub')}
              {overview?.labels
                .filter((l) => l.account === a.email)
                .map((l) => (
                  <div key={l.label}>{item(l.label, { kind: 'label', account: a.email, label: l.label }, 'sub')}</div>
                ))}
            </>
          )}
        </div>
      ))}
      <div className="grow" />
      <div className="sidebar-foot">
        <button className="quiet" onClick={props.settings}>Settings</button>
        <button className="quiet" disabled={syncing} onClick={() => void window.mail.syncNow()}>
          {syncing ? 'Syncing' : 'Sync'}
        </button>
      </div>
    </nav>
  )
}

/** Delivering early is possible, on purpose not instant. */
function BatchStrip({ overview }: { overview: Overview }): ReactNode {
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
      <span className="grow">
        <strong>{clock(overview.nextBatch)}</strong>
        {overview.held > 0 && <span className="muted"> · {overview.held} waiting</span>}
      </span>
      {error && <span className="error">{error}</span>}
      {left === null && canAsk && <button className="quiet" onClick={() => void begin()}>Deliver now</button>}
      {left !== null && left > 0 && <button className="quiet" onClick={() => setLeft(null)}>Cancel {left}</button>}
      {left === 0 && <button className="primary" onClick={() => void finish()}>Deliver {overview.held}</button>}
    </div>
  )
}

function Clip(): ReactNode {
  return (
    <svg className="clip" viewBox="0 0 24 24" role="img" aria-label="Has attachment">
      <path d="M21 11.5 12.5 20a5 5 0 0 1-7-7l9-9a3.3 3.3 0 0 1 4.7 4.7l-9 9a1.7 1.7 0 0 1-2.4-2.4l8.3-8.3" />
    </svg>
  )
}

function Row(props: { row: ThreadRow; many: boolean; on: boolean; open(): void }): ReactNode {
  const { row, many, on, open } = props
  return (
    <button className={`thread ${on ? 'on' : ''} ${row.unread > 0 ? 'unread' : ''}`} onClick={open}>
      <span className="thread-top">
        <span className="sender">{row.fromName || row.fromAddress || 'Unknown'}</span>
        {row.count > 1 && <span className="count">{row.count}</span>}
        {row.attachment && <Clip />}
        <time>{shortTime(row.date)}</time>
      </span>
      <span className="subject">{row.subject || 'No subject'}</span>
      <span className="snippet">{row.snippet}</span>
      {many && <span className="from-account">{mailbox(row.account)}</span>}
    </button>
  )
}

export function App(): ReactNode {
  const [accounts, setAccounts] = useState<AccountView[] | null>(null)
  const [overview, setOverview] = useState<Overview | null>(null)
  const [query, setQuery] = useState<ListQuery>({ kind: 'inbox' })
  const [search, setSearch] = useState('')
  const [rows, setRows] = useState<ThreadRow[]>([])
  const [open, setOpen] = useState<OpenThread | null>(null)
  const [messages, setMessages] = useState<MessageView[]>([])
  const [settings, setSettings] = useState(false)
  const [version, setVersion] = useState(0)
  const [reads, setReads] = useState(0)
  const searchBox = useRef<HTMLInputElement>(null)
  const listAsked = useRef(0)

  const bump = useCallback(() => setVersion((v) => v + 1), [])

  useEffect(() => window.mail.onChanged(bump), [bump])

  useEffect(() => {
    void window.mail.accounts().then(setAccounts)
    void window.mail.overview().then(setOverview)
  }, [version])

  const active: ListQuery = search.trim() ? { kind: 'search', text: search.trim() } : query

  useEffect(() => {
    const asked = ++listAsked.current
    const timer = setTimeout(() => {
      void window.mail.list(active).then((found) => {
        if (asked === listAsked.current) setRows(found)
      })
    }, 120)
    return () => clearTimeout(timer)
  }, [JSON.stringify(active), version, reads])

  useEffect(() => {
    if (!open) return setMessages([])
    void window.mail.thread(open.account, open.thread).then((found) => {
      setMessages(found)
      setReads((n) => n + 1) // opening it read it, and the row should say so
      if (found.length === 0) setOpen(null) // gone from Gmail while on screen
    })
    return undefined
  }, [open?.account, open?.thread, version])

  const move = useCallback(
    (step: number) => {
      const at = rows.findIndex((r) => r.account === open?.account && r.thread === open?.thread)
      const next = rows[Math.min(rows.length - 1, Math.max(0, at + step))]
      if (next) setOpen({ account: next.account, thread: next.thread })
    },
    [rows, open]
  )

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const tag = (event.target as HTMLElement).tagName
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || settings) {
        if (event.key === 'Escape' && event.target === searchBox.current) {
          setSearch('')
          searchBox.current?.blur()
        }
        return
      }
      if (event.key === '/') {
        event.preventDefault()
        searchBox.current?.focus()
      } else if (event.key === 'j') move(1)
      else if (event.key === 'k') move(-1)
      else if (event.key === 'Escape') setOpen(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [move, settings])

  if (accounts === null) return null
  if (accounts.length === 0) return <Welcome />

  const go = (target: ListQuery): void => {
    setQuery(target)
    setSearch('')
    setOpen(null)
  }

  return (
    <div className={open ? 'app reading' : 'app'}>
      <Sidebar accounts={accounts} overview={overview} query={query} go={go} settings={() => setSettings(true)} />
      <section className="list">
        <div className="search">
          <input ref={searchBox} type="search" placeholder="Search" aria-label="Search" value={search}
            onChange={(e) => setSearch(e.target.value)} />
        </div>
        {overview && <BatchStrip overview={overview} />}
        <div className="threads">
          {rows.map((row) => (
            <Row key={`${row.account}/${row.thread}`} row={row} many={accounts.length > 1}
              on={open?.account === row.account && open.thread === row.thread}
              open={() => setOpen({ account: row.account, thread: row.thread })} />
          ))}
          {rows.length === 0 && <p className="empty">{search.trim() ? 'Nothing found' : 'Nothing here'}</p>}
        </div>
      </section>
      <Reader messages={messages} back={() => setOpen(null)} />
      {settings && <SettingsDialog accounts={accounts} version={version} close={() => setSettings(false)} />}
    </div>
  )
}
