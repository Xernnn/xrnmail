import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type PointerEvent, type ReactNode } from 'react'
import {
  Archive, Check, CheckSquare, Clock, Inbox, Mail, MailOpen, OctagonAlert, Search as SearchIcon, SearchX, Star, Trash2, Undo2, X
} from 'lucide-react'
import type {
  AccountView, Draft, DraftEdit, DraftStart, ListQuery, MailAction, MessageView, Overview, Rsvp, Settings, Subscription, SwipeAction, ThreadRef, ThreadRow
} from '@shared/types'
import { cleanQuote, Composer } from './Composer'
import { Confirm, ContextMenu, Empty, Skeleton, type MenuEntry, type Question } from './Common'
import { dayGroup, longTime, problem, textToHtml } from './format'
import { BatchStrip, DraftRow, Row, Subscriptions } from './List'
import { sanitize } from './MailBody'
import { IconButton, TimeMenu } from './Menus'
import { Reader, type Panel, type QuickSend, type ReplyKind } from './Reader'
import { SettingsDialog, SHORTCUTS, type Tab } from './Settings'
import { Welcome } from './Setup'
import { ASSISTANT, Sidebar, THREADS, type View } from './Sidebar'

const TAKES_AWAY = ['archive', 'trash', 'spam', 'forever', 'move']

interface Toast {
  text: string
  undo?: () => void
  /** How long it stays, when Undo lasts longer than usual. */
  ms?: number
}

const TOAST_MS = 5000
const PAGE = 200

const keyOf = (ref: ThreadRef): string => `${ref.account}/${ref.thread}`

const LIST_WIDTHS = { key: 'xrnmail.list', low: 320, high: 580, start: 384 }

const savedWidth = (): number => {
  try {
    const saved = Number(localStorage.getItem(LIST_WIDTHS.key))
    return saved >= LIST_WIDTHS.low && saved <= LIST_WIDTHS.high ? saved : LIST_WIDTHS.start
  } catch {
    return LIST_WIDTHS.start
  }
}

const SWIPES: Record<Exclude<SwipeAction, 'none' | 'snooze' | 'read' | 'star'>, [MailAction, string]> = {
  archive: [{ kind: 'archive' }, 'Archived'],
  trash: [{ kind: 'trash' }, 'Moved to Trash']
}

const TITLES: Record<string, string> = {
  today: 'Today', starred: 'Starred', unread: 'Unread', snoozed: 'Snoozed', attachments: 'Attachments', spam: 'Spam', all: 'All Mail',
  drafts: 'Drafts', sent: 'Sent', trash: 'Trash', subscriptions: 'Subscriptions', search: 'Search'
}

function titleOf(view: View, many: boolean): string {
  if (view.kind === 'inbox') {
    if (view.account) return view.account
    return many ? 'All Inboxes' : 'Inbox'
  }
  if (view.kind === 'assistant') return ASSISTANT.find(([section]) => section === view.section)?.[1] ?? 'Assistant'
  if (view.kind === 'label') return view.label.split('/').at(-1) ?? view.label
  return TITLES[view.kind] ?? ''
}

function Help({ close }: { close(): void }): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => dialog.current?.showModal(), [])
  return (
    <dialog ref={dialog} className="sheet" onClose={close}>
      <header>
        <h2>Keys</h2>
        <button className="quiet" onClick={close}>Done</button>
      </header>
      <dl className="keys">
        {SHORTCUTS.map(([key, what]) => (
          <div key={key}><dt><kbd>{key}</kbd></dt><dd>{what}</dd></div>
        ))}
      </dl>
    </dialog>
  )
}

export function App(): ReactNode {
  const [accounts, setAccounts] = useState<AccountView[] | null>(null)
  const [overview, setOverview] = useState<Overview | null>(null)
  const [view, setView] = useState<View>({ kind: 'inbox' })
  const [search, setSearch] = useState('')
  const [rows, setRows] = useState<ThreadRow[] | null>(null)
  const [limit, setLimit] = useState(PAGE)
  const [open, setOpen] = useState<ThreadRef | null>(null)
  const [messages, setMessages] = useState<MessageView[]>([])
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [composing, setComposing] = useState<Draft | null>(null)
  const [profile, setProfile] = useState<Settings | null>(null)
  const [settings, setSettings] = useState<Tab | null>(null)
  const [help, setHelp] = useState(false)
  const [panel, setPanel] = useState<Panel>(null)
  const [bulkSnooze, setBulkSnooze] = useState(false)
  const [toast, setToast] = useState<Toast | null>(null)
  const [question, setQuestion] = useState<Question | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; row: ThreadRow } | null>(null)
  const [version, setVersion] = useState(0)
  const [reads, setReads] = useState(0)
  const [listWidth, setListWidth] = useState(savedWidth)
  const searchBox = useRef<HTMLInputElement>(null)
  const listAsked = useRef(0)
  const anchor = useRef<number | null>(null)

  const bump = useCallback(() => setVersion((v) => v + 1), [])
  const say = useCallback((text: string): void => setToast({ text }), [])

  /** "Are you sure", answered in the app's own dialog. */
  const ask = useCallback((asking: Omit<Question, 'answer'>) => new Promise<boolean>((resolve) => {
    setQuestion({ ...asking, answer: (yes) => { setQuestion(null); resolve(yes) } })
  }), [])

  useEffect(() => window.mail.onChanged(bump), [bump])
  useEffect(() => window.mail.onCompose(setComposing), [])

  useEffect(() => {
    void window.mail.accounts().then(setAccounts)
    void window.mail.overview().then(setOverview)
    void window.mail.drafts().then(setDrafts)
    void window.mail.settings().then(setProfile)
  }, [version])

  useEffect(() => {
    document.documentElement.dataset['theme'] = profile?.theme ?? 'system'
  }, [profile?.theme])

  const unread = (accounts ?? []).reduce((sum, a) => sum + a.unread, 0)
  useEffect(() => {
    document.title = unread > 0 ? `(${unread}) xrnmail` : 'xrnmail'
  }, [unread])

  useEffect(() => {
    if (!toast) return undefined
    const timer = setTimeout(() => setToast(null), toast.ms ?? TOAST_MS)
    return () => clearTimeout(timer)
  }, [toast])

  const searching = search.trim() !== ''
  const split = profile?.focused ?? false
  const active: View = searching
    ? { kind: 'search', text: search.trim() }
    : split && view.kind === 'inbox' ? { ...view, focus: view.focus ?? 'focused' } : view
  const bins = active.kind === 'trash' || active.kind === 'spam'
  const list = rows ?? []

  useEffect(() => {
    if (active.kind === 'drafts' || active.kind === 'subscriptions') return setRows([])
    const asked = ++listAsked.current
    const timer = setTimeout(() => {
      void window.mail.list(active as ListQuery, limit).then((found) => {
        if (asked === listAsked.current) setRows(found)
      })
    }, 120)
    return () => clearTimeout(timer)
  }, [JSON.stringify(active), version, reads, limit])

  useEffect(() => {
    if (!open) return setMessages([])
    void window.mail.thread(open.account, open.thread, bins).then((found) => {
      setMessages(found)
      setReads((n) => n + 1) // opening it read it, and the row should say so
      if (found.length === 0) setOpen(null) // gone from the server while on screen
    })
    return undefined
  }, [open?.account, open?.thread, version])

  const move = useCallback(
    (step: number) => {
      const at = list.findIndex((r) => r.account === open?.account && r.thread === open?.thread)
      const next = list[Math.min(list.length - 1, Math.max(0, at + step))]
      if (next) setOpen({ account: next.account, thread: next.thread })
    },
    [list, open]
  )

  /** After a thread leaves the list, the reader moves on to the next one instead of closing. */
  const leave = useCallback(
    (gone: ThreadRef[]) => {
      if (!open || !gone.some((ref) => keyOf(ref) === keyOf(open))) return
      const leaving = new Set(gone.map(keyOf))
      const at = list.findIndex((r) => keyOf(r) === keyOf(open))
      const next = [...list.slice(at + 1), ...list.slice(0, Math.max(at, 0)).reverse()].find((r) => !leaving.has(keyOf(r)))
      setOpen(next ? { account: next.account, thread: next.thread } : null)
    },
    [list, open]
  )

  const targets = useCallback((): ThreadRef[] => {
    const chosen = list.filter((r) => picked.has(keyOf(r))).map((r) => ({ account: r.account, thread: r.thread }))
    return chosen.length > 0 ? chosen : open ? [open] : []
  }, [list, picked, open])

  const run = useCallback(
    async (refs: ThreadRef[], action: MailAction, label?: string) => {
      if (refs.length === 0) return
      const leaves = TAKES_AWAY.includes(action.kind) || (action.kind === 'inbox' && bins) || (action.kind === 'unread' && open !== null)
      try {
        if (leaves) leave(refs)
        const token = await window.mail.act(refs, action)
        setPicked(new Set())
        if (label) {
          const text = refs.length > 1 ? `${label}: ${refs.length} threads` : label
          setToast({ text, undo: () => void window.mail.undo(token) })
        }
      } catch (e) {
        say(problem(e))
      }
    },
    [leave, open, say, bins]
  )

  const forever = useCallback(
    (refs: ThreadRef[]) => {
      if (refs.length === 0) return
      void ask({ title: 'Delete forever?', note: "This can't be got back once Undo has gone.", action: 'Delete forever', danger: true }).then((yes) => {
        if (yes) void run(refs, { kind: 'forever' }, 'Deleted forever')
      })
    },
    [run, ask]
  )

  const snooze = useCallback(
    async (refs: ThreadRef[], at: number) => {
      setPanel(null)
      setBulkSnooze(false)
      try {
        leave(refs)
        await window.mail.snooze(refs, at)
        setPicked(new Set())
        setToast({ text: `Snoozed until ${longTime(at)}`, undo: () => void window.mail.unsnooze(refs) })
      } catch (e) {
        say(problem(e))
      }
    },
    [leave, say]
  )

  const compose = useCallback(
    async (start: DraftStart) => {
      try {
        setComposing(await window.mail.startDraft(start))
      } catch (e) {
        say(problem(e))
      }
    },
    [say]
  )

  /** The search box sits over the list, which one-pane reading hides, so that comes back first. */
  const focusSearch = useCallback((): void => {
    if (searchBox.current?.offsetParent === null) {
      setOpen(null)
      requestAnimationFrame(() => searchBox.current?.focus())
    } else searchBox.current?.focus()
  }, [])

  useEffect(() => window.mail.onCommand((command) => {
    if (command === 'compose') void compose({ kind: 'new' })
    else if (command === 'settings') setSettings('general')
    else if (command === 'about') setSettings('about')
    else if (command === 'help') setHelp(true)
    else if (command === 'print') window.print()
    else if (command === 'search') focusSearch()
  }), [compose, focusSearch])

  const reopen = async (draft: Draft): Promise<void> => {
    try {
      if (draft.state === 'queued') await window.mail.unsend(draft.id)
      setComposing({ ...draft, state: 'draft', sendAt: null })
    } catch (e) {
      say(problem(e))
    }
  }

  /** "Sending", with Undo bringing the message back to the composer. */
  const announce = (id: number, when: number, scheduled: boolean): void => {
    const undo = async (): Promise<void> => {
      try {
        await window.mail.unsend(id)
        const draft = (await window.mail.drafts()).find((d) => d.id === id)
        if (draft) setComposing(draft)
      } catch (e) {
        say(problem(e))
      }
    }
    if (scheduled) return setToast({ text: `Sends ${longTime(when)}`, undo: () => void undo() })
    const left = when - Date.now()
    setToast(left > 0 ? { text: 'Sending', undo: () => void undo(), ms: left } : { text: 'Sent' })
  }

  const sent = (id: number, when: number, scheduled: boolean): void => {
    setComposing(null)
    announce(id, when, scheduled)
  }

  const reply = useCallback((kind: ReplyKind, message: number) => void compose({ kind, message }), [compose])

  /** What's typed under a thread becomes an ordinary reply: sent through the same door, with Undo,
   *  opened in the composer, or kept in Drafts when the thread is left with words still in the box. */
  const replyWith = async (message: MessageView, text: string, then: QuickSend): Promise<boolean> => {
    let draft: Draft
    try {
      const started = await window.mail.startDraft({ kind: 'reply', message: message.id })
      const edit: DraftEdit = {
        account: started.account, from: started.from, to: started.to, cc: started.cc, bcc: started.bcc, subject: started.subject,
        quote: cleanQuote(started.quote), html: sanitize(textToHtml(text)), text
      }
      await window.mail.saveDraft(started.id, edit)
      draft = { ...started, ...edit }
    } catch (e) {
      say(problem(e))
      return false
    }
    // Kept quietly: leaving a thread often comes with its own Undo, which a second message would replace.
    if (then === 'open') setComposing(draft)
    else if (then === 'send') {
      try {
        announce(draft.id, await window.mail.send(draft.id), false) // a message open in the composer stays open
      } catch (e) {
        setComposing({ ...draft, error: problem(e) }) // what it was going to, and why it couldn't
      }
    }
    return true
  }

  /** The straight-through list from the reader: one address on or off, and the rest as they were. */
  const straight = async (address: string, on: boolean): Promise<void> => {
    const batch = profile?.batch
    if (!batch) return
    const who = address.toLowerCase()
    try {
      await window.mail.saveBatch({ ...batch, vip: on ? [...batch.vip, who] : batch.vip.filter((v) => v.trim().toLowerCase() !== who) })
      bump()
      say(on ? `Mail from ${address} comes straight through` : `Mail from ${address} waits for the next delivery`)
    } catch (e) {
      say(problem(e))
    }
  }

  const unsubscribe = async (message: number): Promise<void> => {
    try {
      const result = await window.mail.unsubscribe(message)
      if (result.kind === 'draft') setComposing(result.draft)
      else say(result.kind === 'done' ? 'Unsubscribed' : 'Opened their page in your browser')
      bump()
    } catch (e) {
      say(problem(e))
    }
  }

  const block = async (address: string): Promise<void> => {
    if (!await ask({ title: `Block ${address}?`, note: 'New mail from them goes straight to Trash.', action: 'Block', danger: true })) return
    await window.mail.block(address)
    await run(targets(), { kind: 'trash' }, `Blocked ${address}`)
  }

  const clearSender = async (item: Subscription): Promise<void> => {
    if (!await ask({ title: `Delete everything from ${item.name || item.address}?`, note: `${item.count === 1 ? '1 message goes' : `${item.count} messages go`} to Trash.`, action: 'Delete all', danger: true })) return
    try {
      const token = await window.mail.clearSender(item.account, item.address)
      setToast({ text: `Moved ${item.count === 1 ? '1 message' : `${item.count} messages`} to Trash`, undo: () => void window.mail.undo(token) })
    } catch (e) {
      say(problem(e))
    }
  }

  const answer = async (message: number, reply: Rsvp): Promise<void> => {
    try {
      const { id, when } = await window.mail.rsvp(message, reply)
      sent(id, when, false)
    } catch (e) {
      say(problem(e))
    }
  }

  const keepSender = async (address: string, focused: boolean): Promise<void> => {
    await window.mail.setFocus(address, focused)
    say(`${address} stays in ${focused ? 'Focused' : 'Other'}`)
  }

  const trustImages = async (address: string): Promise<void> => {
    await window.mail.saveProfile({ imagesFrom: [...(profile?.imagesFrom ?? []), address] })
    say(`Images from ${address} will load by themselves`)
  }

  const togglePick = (row: ThreadRow, index: number, range: boolean): void => {
    const from = anchor.current // read now: the update below runs later, after this has moved
    anchor.current = index
    setPicked((now) => {
      const next = new Set(now)
      const key = keyOf(row)
      if (range && from !== null) {
        const adding = !now.has(key)
        for (const item of list.slice(Math.min(from, index), Math.max(from, index) + 1)) {
          if (adding) next.add(keyOf(item))
          else next.delete(keyOf(item))
        }
      } else if (!next.delete(key)) next.add(key)
      return next
    })
  }

  /** Snoozing one row asks "until when" where a selection would. */
  const snoozeRow = (row: ThreadRow): void => {
    setPicked(new Set([keyOf(row)]))
    setBulkSnooze(true)
  }

  const swiped = (row: ThreadRow, action: SwipeAction): void => {
    const ref = { account: row.account, thread: row.thread }
    if (action === 'archive' || action === 'trash') void run([ref], SWIPES[action][0], SWIPES[action][1])
    else if (action === 'read') void run([ref], { kind: row.unread > 0 ? 'read' : 'unread' })
    else if (action === 'star') void run([ref], { kind: row.starred ? 'unstar' : 'star' })
    else if (action === 'snooze') snoozeRow(row)
  }

  const dragged = (event: DragEvent, row: ThreadRow): void => {
    const refs = picked.has(keyOf(row)) ? targets() : [{ account: row.account, thread: row.thread }]
    event.dataTransfer.setData(THREADS, JSON.stringify(refs))
    event.dataTransfer.effectAllowed = 'move'
  }

  const dropOn = (target: View, refs: ThreadRef[]): void => {
    if (target.kind === 'inbox') void run(refs, { kind: 'inbox' }, 'Moved to Inbox')
    else if (target.kind === 'all') void run(refs, { kind: 'archive' }, 'Archived')
    else if (target.kind === 'trash') void run(refs, { kind: 'trash' }, 'Moved to Trash')
    else if (target.kind === 'spam') void run(refs, { kind: 'spam' }, 'Reported as spam')
    else if (target.kind === 'starred') void run(refs, { kind: 'star' })
    else if (target.kind === 'label') {
      const mine = refs.filter((ref) => ref.account === target.account)
      const labels = accounts?.find((a) => a.email === target.account)?.labels
      if (labels) void run(mine, { kind: 'label', label: target.label, add: true }, `Labelled ${target.label}`)
      else void run(mine, { kind: 'move', to: target.label }, `Moved to ${target.label}`)
    }
  }

  const menuFor = (row: ThreadRow): (MenuEntry | 'gap')[] => {
    const one = { account: row.account, thread: row.thread }
    const refs = picked.has(keyOf(row)) ? targets() : [one]
    if (bins) {
      return [
        { label: 'Move to Inbox', icon: Undo2, run: () => void run(refs, { kind: 'inbox' }, 'Moved to Inbox') },
        { label: 'Delete forever', icon: Trash2, danger: true, run: () => forever(refs) }
      ]
    }
    return [
      row.unread > 0
        ? { label: 'Mark as read', icon: MailOpen, run: () => void run(refs, { kind: 'read' }) }
        : { label: 'Mark as unread', icon: Mail, run: () => void run(refs, { kind: 'unread' }) },
      { label: row.starred ? 'Remove star' : 'Star', icon: Star, run: () => void run(refs, { kind: row.starred ? 'unstar' : 'star' }) },
      'gap',
      { label: 'Archive', icon: Archive, run: () => void run(refs, { kind: 'archive' }, 'Archived') },
      { label: 'Snooze', icon: Clock, run: () => { setPicked(new Set(refs.map(keyOf))); setBulkSnooze(true) } },
      { label: 'Report spam', icon: OctagonAlert, run: () => void run(refs, { kind: 'spam' }, 'Reported as spam') },
      { label: 'Delete', icon: Trash2, danger: true, run: () => void run(refs, { kind: 'trash' }, 'Moved to Trash') },
      'gap',
      { label: 'Select', icon: CheckSquare, run: () => togglePick(row, list.indexOf(row), false) }
    ]
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const element = event.target as HTMLElement
      // A ticked checkbox keeps the focus, and that shouldn't cost the keyboard. Keys forwarded from
      // a message's frame have the window as their target, which isn't an element at all.
      const typing = element.matches?.('input:not([type=checkbox]), textarea, select') || element.isContentEditable
      if (typing || settings || help || composing || question) {
        if (event.key === 'Escape' && event.target === searchBox.current) {
          setSearch('')
          searchBox.current?.blur()
        }
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        setPicked(new Set(list.map(keyOf)))
        return
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return
      const last = messages.at(-1)
      const handlers: Record<string, () => void> = {
        '/': focusSearch,
        j: () => move(1),
        k: () => move(-1),
        ArrowDown: () => move(1),
        ArrowUp: () => move(-1),
        Escape: () => {
          if (picked.size > 0) setPicked(new Set())
          else setOpen(null)
        },
        c: () => void compose({ kind: 'new' }),
        r: () => { if (last) reply('reply', last.id) },
        a: () => { if (last) reply('replyAll', last.id) },
        f: () => { if (last) reply('forward', last.id) },
        e: () => { if (!bins) void run(targets(), { kind: 'archive' }, 'Archived') },
        '#': () => (bins ? forever(targets()) : void run(targets(), { kind: 'trash' }, 'Moved to Trash')),
        Delete: () => (bins ? forever(targets()) : void run(targets(), { kind: 'trash' }, 'Moved to Trash')),
        '!': () => void (active.kind === 'spam' ? run(targets(), { kind: 'inbox' }, 'Moved to Inbox') : run(targets(), { kind: 'spam' }, 'Reported as spam')),
        s: () => {
          const starred = messages.some((m) => m.flagged)
          void run(targets(), { kind: starred ? 'unstar' : 'star' })
        },
        U: () => void run(targets(), { kind: 'unread' }),
        b: () => {
          if (picked.size > 0) setBulkSnooze(true)
          else if (open) setPanel('snooze')
        },
        l: () => { if (open) setPanel('labels') },
        x: () => {
          const index = list.findIndex((r) => r.account === open?.account && r.thread === open?.thread)
          const row = list[index]
          if (row) togglePick(row, index, false)
        },
        z: () => toast?.undo?.(),
        '?': () => setHelp(true)
      }
      const handler = handlers[event.key]
      if (!handler) return
      event.preventDefault()
      handler()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const own = useMemo(() => (accounts ?? []).flatMap((a) => [a.email, ...(profile?.identities[a.email]?.aliases ?? [])]).map((a) => a.toLowerCase()), [accounts, profile])

  const resize = (down: PointerEvent): void => {
    const start = down.clientX
    const from = listWidth
    let now = from
    const moved = (event: globalThis.PointerEvent): void => {
      now = Math.max(LIST_WIDTHS.low, Math.min(LIST_WIDTHS.high, from + event.clientX - start))
      setListWidth(now)
    }
    const done = (): void => {
      window.removeEventListener('pointermove', moved)
      window.removeEventListener('pointerup', done)
      try {
        localStorage.setItem(LIST_WIDTHS.key, String(now))
      } catch {
        // Only a convenience: next time it starts at its usual width.
      }
    }
    window.addEventListener('pointermove', moved)
    window.addEventListener('pointerup', done)
  }

  if (accounts === null) return null
  if (accounts.length === 0) return <Welcome />

  const go = (target: View): void => {
    setView(target)
    setSearch('')
    setOpen(null)
    setPicked(new Set())
    setLimit(PAGE)
    setRows(null)
  }

  const refs = targets()
  const many = accounts.length > 1
  const showDrafts = active.kind === 'drafts'
  const showSubscriptions = active.kind === 'subscriptions'
  const shownDrafts = active.kind === 'drafts' && active.account ? drafts.filter((d) => d.account === active.account) : drafts
  const openAccount = accounts.find((a) => a.email === open?.account)
  const anyPicked = picked.size > 0
  const firstRead = accounts.some((a) => a.syncing && a.syncedAt === null)
  const progress = accounts.map((a) => a.progress).filter((p) => p !== null)
  const done = progress.reduce((sum, p) => sum + p.done, 0)
  const total = progress.reduce((sum, p) => sum + p.total, 0)
  const single = profile?.layout === 'list'
  const appClass = ['app', open ? 'reading' : '', single ? 'one-pane' : '', profile?.density === 'compact' ? 'compact' : ''].join(' ')
  const emptyList = showDrafts ? shownDrafts.length === 0 : !showSubscriptions && rows !== null && rows.length === 0
  // Headings by day, where the list runs newest first.
  const byDay = !showDrafts && !showSubscriptions && active.kind !== 'assistant' && active.kind !== 'snoozed'
  const now = Date.now()
  let lastDay = ''
  const otherCount = overview?.otherUnread ?? 0
  const inboxScope = active.kind === 'inbox' && active.account ? { account: active.account } : {}
  const batching = (profile?.batch.times.length ?? 0) > 0

  return (
    <div className={appClass} style={{ '--list': `${listWidth}px` } as CSSProperties}>
      <Sidebar accounts={accounts} overview={overview} view={view} drafts={drafts} go={go}
        compose={() => void compose({ kind: 'new' })} settings={() => setSettings('general')} drop={dropOn} />
      <div className="main">
        <div className="panes">
          <section className="list" aria-label="Threads">
            <div className="list-top">
              <div className="search">
                <SearchIcon size={16} aria-hidden="true" />
                <input ref={searchBox} type="search" placeholder="Search mail" aria-label="Search" value={search} spellCheck={false}
                  onChange={(e) => setSearch(e.target.value)} />
                {searching && <button className="search-clear" aria-label="Clear" onClick={() => setSearch('')}><X size={14} aria-hidden="true" /></button>}
              </div>
            </div>
            {anyPicked ? (
              <div className="bulk" role="toolbar" aria-label="Selected threads">
                <button className="link" onClick={() => setPicked(new Set())}>{picked.size} selected</button>
                <button className="link" onClick={() => setPicked(new Set(list.map(keyOf)))}>All</button>
                <span className="grow" />
                {bins ? (
                  <>
                    <IconButton icon={Undo2} label="Restore selected" click={() => void run(refs, { kind: 'inbox' }, 'Moved to Inbox')} />
                    <IconButton icon={Trash2} label="Delete selected forever" click={() => forever(refs)} />
                  </>
                ) : (
                  <>
                    <IconButton icon={Archive} label="Archive selected" click={() => void run(refs, { kind: 'archive' }, 'Archived')} />
                    <IconButton icon={Trash2} label="Delete selected" click={() => void run(refs, { kind: 'trash' }, 'Moved to Trash')} />
                  </>
                )}
                <IconButton icon={MailOpen} label="Mark selected read" click={() => void run(refs, { kind: 'read' })} />
                <IconButton icon={Mail} label="Mark selected unread" click={() => void run(refs, { kind: 'unread' })} />
                <div className="anchor">
                  <IconButton icon={Clock} label="Snooze selected" click={() => setBulkSnooze(!bulkSnooze)} />
                  {bulkSnooze && <TimeMenu title="Snooze until" right pick={(at) => void snooze(refs, at)} close={() => setBulkSnooze(false)} />}
                </div>
              </div>
            ) : (
              <div className="list-head">
                <h1 className="list-title">{titleOf(active, many)}</h1>
                {split && active.kind === 'inbox' && (
                  <div className="tabs" role="group" aria-label="Focused and Other">
                    <button className={active.focus !== 'other' ? 'tab on' : 'tab'} aria-pressed={active.focus !== 'other'}
                      onClick={() => go({ kind: 'inbox', ...inboxScope })}>Focused</button>
                    <button className={active.focus === 'other' ? 'tab on' : 'tab'} aria-pressed={active.focus === 'other'}
                      onClick={() => go({ kind: 'inbox', ...inboxScope, focus: 'other' })}>
                      Other {otherCount > 0 && <span className="tab-count">{otherCount > 99 ? '99+' : otherCount}</span>}
                    </button>
                  </div>
                )}
              </div>
            )}
            {overview && <BatchStrip overview={overview} />}
            {total > 0 && (
              <div className="sync-progress" role="status">
                <span className="muted">Getting your mail · {done.toLocaleString()} of {total.toLocaleString()}</span>
                <span className="bar"><i style={{ width: `${Math.round((done / total) * 100)}%` }} /></span>
              </div>
            )}
            <div className="threads" onScroll={(e) => {
              const box = e.currentTarget
              if (list.length >= limit && box.scrollTop + box.clientHeight > box.scrollHeight - 300) setLimit(limit + PAGE)
            }}>
              {showDrafts && shownDrafts.map((draft) => (
                <DraftRow key={draft.id} draft={draft} open={() => void reopen(draft)}
                  discard={() => void window.mail.discardDraft(draft.id).catch((e) => say(problem(e)))} />
              ))}
              {showSubscriptions && (
                <Subscriptions version={version} unsubscribe={(message) => void unsubscribe(message)} clear={(item) => void clearSender(item)} />
              )}
              {!showDrafts && !showSubscriptions && list.map((row, index) => {
                const day = byDay ? dayGroup(row.date, now) : ''
                const heading = day !== lastDay ? day : ''
                lastDay = day
                return (
                  <Fragment key={keyOf(row)}>
                    {heading && <h2 className="list-section">{heading}</h2>}
                    <Row row={row} many={many} own={own} bins={bins} assistant={active.kind === 'assistant'}
                      account={accounts.find((a) => a.email === row.account)}
                      on={open?.account === row.account && open.thread === row.thread} picked={picked.has(keyOf(row))}
                      swipeLeft={profile?.swipeLeft ?? 'none'} swipeRight={profile?.swipeRight ?? 'none'}
                      open={() => setOpen({ account: row.account, thread: row.thread })}
                      pick={(event) => togglePick(row, index, event.shiftKey)}
                      act={(action, label) => void run([{ account: row.account, thread: row.thread }], action, label)}
                      snooze={() => snoozeRow(row)}
                      swiped={(action) => swiped(row, action)}
                      menu={(x, y) => setMenu({ x, y, row })}
                      drag={(event) => dragged(event, row)} />
                  </Fragment>
                )
              })}
              {(rows === null || (firstRead && list.length === 0)) && !showDrafts && !showSubscriptions && <Skeleton />}
              {emptyList && !firstRead && (
                searching ? <Empty icon={SearchX} title="Nothing found" note="Search covers the mail kept on this laptop." />
                  : active.kind === 'inbox' && active.focus !== 'other' ? <Empty icon={Check} title="Nothing here" note="You're all caught up." />
                  : <Empty icon={Inbox} title="Nothing here" />
              )}
            </div>
          </section>
          <div className="resize" aria-hidden="true" onPointerDown={resize} />
          <Reader messages={messages} account={openAccount} bins={bins} panel={panel} setPanel={setPanel} back={() => setOpen(null)} own={own}
            settings={profile} unread={unread} held={overview?.held ?? 0} vip={batching ? profile?.batch.vip ?? [] : null} many={many}
            labels={(overview?.labels ?? []).filter((l) => l.account === open?.account).map((l) => l.label)}
            act={(action, label) => void run(open ? [open] : [], action, label)}
            snooze={(at) => void snooze(open ? [open] : [], at)}
            reply={reply} replyWith={replyWith} unsubscribe={(message) => void unsubscribe(message)} block={(address) => void block(address)} say={say}
            rsvp={(message, reply) => void answer(message, reply)} setFocus={(address, focused) => void keepSender(address, focused)}
            trust={(address) => void trustImages(address)} straight={(address, on) => void straight(address, on)}
            forever={() => forever(open ? [open] : [])} />
        </div>
      </div>
      {composing && (
        <Composer key={composing.id} draft={composing} accounts={accounts} settings={profile} sent={sent}
          close={(saved) => {
            setComposing(null)
            if (saved) say('Saved to Drafts')
          }} />
      )}
      {toast && (
        <div className="toast" role="status">
          <span>{toast.text}</span>
          {toast.undo && <button className="link" onClick={() => { toast.undo?.(); setToast(null) }}>Undo</button>}
        </div>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuFor(menu.row)} close={() => setMenu(null)} />}
      {help && <Help close={() => setHelp(false)} />}
      {settings && <SettingsDialog accounts={accounts} version={version} tab={settings} ask={ask} close={() => setSettings(null)} />}
      {question && <Confirm question={question} />}
    </div>
  )
}
