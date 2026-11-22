import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type PointerEvent, type ReactNode } from 'react'
import {
  AlarmClockOff, Check, CheckSquare, Clock, Eraser, Filter, Flag, FolderInput, History, Inbox, Mail, MailOpen, MoreVertical, Newspaper, OctagonAlert, Pin, PinOff, Search as SearchIcon, SearchX,
  SlidersHorizontal, Tag, Trash2, Undo2, X
} from 'lucide-react'
import {
  IMPORTANT, type AccountView, type Draft, type DraftStart, type ListQuery, type MailAction, type MessageView, type Overview, type Rsvp, type Settings, type Subscription,
  type SummarySettings, type SwipeAction, type ThreadRef, type ThreadRow
} from '@shared/types'
import { Composer } from './Composer'
import { Boundary, Confirm, ContextMenu, Empty, ImportantMark, Skeleton, type MenuEntry, type Question } from './Common'
import { longTime, problem, setClock24, straightThrough } from './format'
import { BatchStrip, DraftRow, NO_SWIPES, Row, SenderCard, Subscriptions, type Swipes } from './List'
import { FolderMenu, IconButton, Popover, setLaterTimes, TimeMenu } from './Menus'
import { CantShow, Reader, type Panel, type ReplyKind } from './Reader'
import { SettingsDialog, type Tab } from './Settings'
import { keyList, keyName, keysFor, type KeyChanges, type KeyCommand, type KeySet } from '@shared/keys'
import { cleanSidebar } from '@shared/sidebar'
import { soloFrom } from '@shared/solo'
import { Welcome } from './Setup'
import { landedWords, LatestSummary, ScheduleDialog, SummaryBar, SummaryNotice } from './Summary'
import { NewFolderDialog } from './Labels'
import { ASSISTANT, labelsOf, Sidebar, THREADS, type View } from './Sidebar'

const TAKES_AWAY = ['archive', 'trash', 'spam', 'forever', 'move']

interface Toast {
  text: string
  /** What it gives back is waited for by a window of its own, which mustn't close on an Undo still on its way. */
  undo?: () => unknown
  /** How long it stays, when Undo lasts longer than usual. */
  ms?: number
  /** It's about a message on its way, which says how that went once it knows. */
  sending?: boolean
}

const TOAST_MS = 5000
const PAGE = 200

/** Until the settings are read: everything, as it starts out. */
const NO_CHOICE = cleanSidebar(null)

/** Set in a window of its own, which shows one thread or one draft and none of the rest. */
const SOLO = soloFrom(window.location.search)

const keyOf = (ref: ThreadRef): string => `${ref.account}/${ref.thread}`

interface Span { key: string; low: number; high: number; start: number }
/** How wide the list is beside the reader, and how tall over it, as last dragged. */
const LIST_WIDTHS: Span = { key: 'xrnmail.list', low: 320, high: 580, start: 410 }
const LIST_HEIGHTS: Span = { key: 'xrnmail.listHeight', low: 140, high: 900, start: 300 }
/** More than Trash is ever likely to hold on this laptop, and as many as the main process takes in one go. */
const WHOLE_LIST = 20_000

const savedSpan = (span: Span): number => {
  try {
    const saved = Number(localStorage.getItem(span.key))
    return saved >= span.low && saved <= span.high ? saved : span.start
  } catch {
    return span.start
  }
}

const SWIPES: Record<Exclude<SwipeAction, 'none' | 'snooze' | 'read' | 'star'>, [MailAction, string]> = {
  archive: [{ kind: 'archive' }, 'Archived'],
  trash: [{ kind: 'trash' }, 'Moved to Trash']
}

const TITLES: Record<string, string> = {
  today: 'Today', starred: 'Flagged', pinned: 'Pinned', unread: 'Unread', snoozed: 'Snoozed', attachments: 'Attachments', spam: 'Spam', all: 'All Mail',
  drafts: 'Drafts', sent: 'Sent', archive: 'Archive', trash: 'Trash', subscriptions: 'Subscriptions', search: 'Search', recent: 'Recently Seen',
  summary: 'Summary'
}
/** With several accounts, these gather every account's. */
const GATHERED = ['drafts', 'sent', 'archive']

export function titleOf(view: View, many: boolean): string {
  if (view.kind === 'inbox') return many && !view.account ? 'All Inboxes' : 'Inbox'
  if (view.kind === 'assistant') return ASSISTANT.find(([section]) => section === view.section)?.[1] ?? 'Assistant'
  if (view.kind === 'label') return view.label.split('/').at(-1) ?? view.label
  const title = TITLES[view.kind] ?? ''
  return many && GATHERED.includes(view.kind) && !('account' in view && view.account) ? `All ${title}` : title
}

function Help({ close, set, changes }: { close(): void; set: KeySet; changes?: KeyChanges }): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => dialog.current?.showModal(), [])
  return (
    <dialog ref={dialog} className="sheet" onClose={close}>
      <header>
        <h2>Keys</h2>
        <button className="quiet" onClick={close}>Done</button>
      </header>
      <dl className="keys">
        {keyList(set, changes).map(([key, what]) => (
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
  /** The list emptied for its skeleton, so it's asked for again even when what's asked is the same. */
  const [relisted, setRelisted] = useState(0)
  const [limit, setLimit] = useState(PAGE)
  const [open, setOpen] = useState<ThreadRef | null>(SOLO?.kind === 'thread' ? { account: SOLO.account, thread: SOLO.thread } : null)
  /** In a window of its own: whether its thread is in Trash or Spam just now, and whether it's anywhere at all. */
  const [soloBins, setSoloBins] = useState(SOLO?.kind === 'thread' && SOLO.bins)
  const [missing, setMissing] = useState(false)
  /** In a composer of its own, once its draft has been looked for. */
  const [soloReady, setSoloReady] = useState(false)
  /** An Undo pressed in a window of its own and not yet done. What's read of the thread meanwhile is
   *  already old, and [undoEpoch] moves on when it's done so a read begun before then is too. */
  const [undoing, setUndoing] = useState(false)
  const undoingNow = useRef(false)
  /** What an open composer does before its window closes. */
  const leaving = useRef<(() => Promise<void>) | null>(null)
  const undoEpoch = useRef(0)
  const [messages, setMessages] = useState<MessageView[]>([])
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [composing, setComposing] = useState<Draft | null>(null)
  /** The draft as Reply, Forward or Compose just started it. One opened again from anywhere is another copy. */
  const [started, setStarted] = useState<Draft | null>(null)
  const [profile, setProfile] = useState<Settings | null>(null)
  const [settings, setSettings] = useState<Tab | null>(null)
  const [help, setHelp] = useState(false)
  const [panel, setPanel] = useState<Panel>(null)
  const [bulkSnooze, setBulkSnooze] = useState(false)
  /** The bar under a selection's ⋮, and the labels or folders it leads to. */
  const [bulkMenu, setBulkMenu] = useState<'more' | 'file' | null>(null)
  const [toast, setToast] = useState<Toast | null>(null)
  const [question, setQuestion] = useState<Question | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; row: ThreadRow } | null>(null)
  const [sideMenu, setSideMenu] = useState<{ x: number; y: number; target: ListQuery | null } | null>(null)
  /** The sidebar's entries are being chosen and put in order. */
  const [editingMenu, setEditingMenu] = useState(false)
  /** Edit Menu's New Label… or New Folder…, for the account it was asked from. */
  const [newFolder, setNewFolder] = useState<string | null>(null)
  /** The first sender going into the Summary asks when it should land. */
  const [scheduling, setScheduling] = useState<{ summary: SummarySettings; done(summary: SummarySettings | null): void } | null>(null)
  /** On a sender's page: who they are and how they send, and which side of Subscriptions it was opened from. */
  const [sender, setSender] = useState<Subscription | null>(null)
  const [senderFrom, setSenderFrom] = useState<'subscribed' | 'left' | 'summary'>('subscribed')
  const [version, setVersion] = useState(0)
  const [reads, setReads] = useState(0)
  const [listWidth, setListWidth] = useState(() => savedSpan(LIST_WIDTHS))
  const [listHeight, setListHeight] = useState(() => savedSpan(LIST_HEIGHTS))
  const searchBox = useRef<HTMLInputElement>(null)
  /** The searches made lately, which the empty search box offers while it has the focus, and which of
   *  them the arrow keys are on. */
  const [searches, setSearches] = useState<string[]>([])
  const [searchFocus, setSearchFocus] = useState(false)
  const [searchPick, setSearchPick] = useState(-1)
  const listAsked = useRef(0)
  const anchor = useRef<number | null>(null)
  /** A draft on its way to the composer, which Esc can still call off. */
  const starting = useRef<{ off: boolean } | null>(null)
  /** Messages sent from here and not yet gone, by draft. */
  const going = useRef(new Set<number>())
  /** The open composer's draft, and its Close. */
  const closing = useRef<{ id: number; close(): Promise<void> } | null>(null)

  const bump = useCallback(() => setVersion((v) => v + 1), [])
  /** One composer at a time. The one open is closed first, as its own Close would close it, so what's
   *  written there is kept in Drafts and a reply nobody wrote in goes. The same draft stays as it is. */
  const showComposer = useCallback(async (draft: Draft, fresh = false): Promise<void> => {
    const shown = closing.current
    if (shown?.id === draft.id) return
    if (shown) await shown.close().catch(() => undefined)
    if (fresh) setStarted(draft)
    setComposing(draft)
  }, [])
  const say = useCallback((text: string): void => setToast({ text }), [])

  /** "Are you sure", answered in the app's own dialog. */
  const ask = useCallback((asking: Omit<Question, 'answer'>) => new Promise<boolean>((resolve) => {
    setQuestion({ ...asking, answer: (yes) => { setQuestion(null); resolve(yes) } })
  }), [])

  useEffect(() => window.mail.onChanged(bump), [bump])
  // A selection let go of takes its bar's menus with it.
  useEffect(() => { if (picked.size === 0) setBulkMenu(null) }, [picked.size])
  useEffect(() => {
    if (!SOLO) void window.mail.searches().then(setSearches).catch(() => undefined)
  }, [])
  useEffect(() => window.mail.onCompose((draft) => void showComposer(draft)), [])
  // The notice for a new message leads to it, in the inbox it came to.
  useEffect(() => window.mail.onOpenThread((ref) => {
    setView({ kind: 'inbox' })
    setSearch('')
    setPicked(new Set())
    setLimit(PAGE)
    setRows(null)
    setRelisted((n) => n + 1)
    setOpen(ref)
  }), [])

  useEffect(() => {
    void window.mail.accounts().then(setAccounts)
    void window.mail.overview().then(setOverview)
    void window.mail.drafts().then(setDrafts)
    void window.mail.settings().then(setProfile)
  }, [version])

  useEffect(() => {
    document.documentElement.dataset['theme'] = profile?.theme ?? 'system'
  }, [profile?.theme])

  setClock24(profile?.clock24 ?? true) // before anything below writes a time
  setLaterTimes(profile?.later)

  const unread = (accounts ?? []).reduce((sum, a) => sum + a.unread, 0)
  const soloTitle = SOLO?.kind === 'thread' ? messages[0]?.subject || 'xrnmail' : SOLO ? composing?.subject || 'New message' : null
  useEffect(() => {
    document.title = soloTitle ?? (unread > 0 ? `(${unread}) xrnmail` : 'xrnmail')
  }, [unread, soloTitle])

  // One with Undo stays as long as Settings say Undo lasts, and the change waits for it.
  const undoMs = (profile?.undoActionSeconds ?? TOAST_MS / 1000) * 1000
  useEffect(() => {
    if (!toast) return undefined
    const timer = setTimeout(() => setToast(null), toast.ms ?? (toast.undo ? undoMs : TOAST_MS))
    return () => clearTimeout(timer)
  }, [toast])

  /** Undo, from the toast. A window of its own stays until it's done and what it holds has been read again. */
  const undoNow = (undo: (() => unknown) | undefined): void => {
    setToast(null)
    if (!undo) return
    if (!SOLO) return void undo()
    undoingNow.current = true
    setUndoing(true)
    setMissing(false)
    void Promise.resolve().then(undo).catch(() => undefined).then(() => {
      undoingNow.current = false
      undoEpoch.current += 1
      setUndoing(false)
      bump()
    })
  }

  const searching = search.trim() !== ''
  /** A search that was used: finished with Enter, picked again, or a result opened from it. */
  const keepSearch = (text: string): void => {
    if (text.trim()) void window.mail.rememberSearch(text).then(setSearches).catch(() => undefined)
  }
  const forgetSearch = (text: string | null): void => {
    void window.mail.forgetSearch(text).then(setSearches).catch(() => undefined)
  }
  const pickSearch = (text: string): void => {
    setSearch(text)
    setSearchPick(-1)
    keepSearch(text)
  }
  useEffect(() => {
    if (open && searching) keepSearch(search)
  }, [open?.account, open?.thread])
  // All Inboxes is every account's inbox whole. Focused and Other belong to each account's own, and
  // to the inbox of the only account there is.
  const allInboxes = view.kind === 'inbox' && !view.account && (accounts?.length ?? 0) > 1
  const split = (profile?.focused ?? false) && view.kind === 'inbox' && !allInboxes
  const active: View = searching
    ? { kind: 'search', text: search.trim() }
    : split && view.kind === 'inbox' ? { ...view, focus: view.focus ?? 'focused' } : view
  const bins = SOLO ? soloBins : active.kind === 'trash' || active.kind === 'spam'
  const list = rows ?? []

  // A sender's page reads how they send each time something changes: Delete all, or new mail from them.
  const senderKey = active.kind === 'from' ? `${active.account}/${active.address}` : ''
  useEffect(() => {
    if (active.kind !== 'from') return setSender(null)
    let current = true
    void window.mail.sender(active.account, active.address).then((found) => { if (current) setSender(found) })
    return () => { current = false }
  }, [senderKey, version])

  // Opening a thread reads it, so Unread is asked to keep the open one, or it would leave the list as
  // it opened, and j would have nowhere to go on from.
  const query = active.kind === 'unread' && open ? { ...active, keep: open } : active
  useEffect(() => {
    if (SOLO || query.kind === 'drafts' || query.kind === 'subscriptions') return setRows([])
    const asked = ++listAsked.current
    const timer = setTimeout(() => {
      void window.mail.list(query as ListQuery, limit).then((found) => {
        if (asked === listAsked.current) setRows(found)
      })
    }, 120)
    return () => clearTimeout(timer)
  }, [JSON.stringify(query), version, reads, limit, relisted])

  /** Seconds an open thread waits before it's marked read: none, some, or -1 for only when asked. */
  const readAfter = profile?.readAfter ?? 0
  // Read from Recently Seen, a thread stays where it is in that list instead of jumping to its top.
  const remember = SOLO !== null || active.kind !== 'recent'

  useEffect(() => {
    if (!open) return setMessages([])
    void (async () => {
      const epoch = undoEpoch.current
      const read = readAfter === 0
      let found = await window.mail.thread(open.account, open.thread, bins, remember, read)
      if (SOLO && found.length === 0) {
        // A window of its own follows its thread into Trash or Spam and back out, so the Undo for
        // what sent it there is never out of reach.
        const moved = await window.mail.thread(open.account, open.thread, !bins, true, read)
        if (moved.length > 0) {
          found = moved
          setSoloBins(!bins)
        }
      }
      if (SOLO && found.length === 0 && (undoingNow.current || epoch !== undoEpoch.current)) return // the read after the Undo says
      setMessages(found)
      setReads((n) => n + 1) // opening it read it, and the row should say so
      if (SOLO) setMissing(found.length === 0)
      else if (found.length === 0) setOpen(null) // gone from the server while on screen
    })()
    return undefined
  }, [open?.account, open?.thread, version])

  // With a wait set, a thread is read once it has been open that long, so one passed by on the way
  // to another stays unread. Mail arriving in it while it's open waits as long again.
  const unseen = messages.filter((m) => !m.seen).length
  useEffect(() => {
    if (!open || readAfter <= 0 || unseen === 0) return undefined
    const ref = open
    const timer = setTimeout(() => {
      void window.mail.thread(ref.account, ref.thread, bins, remember, true).then(() => setReads((n) => n + 1)).catch(() => undefined)
    }, readAfter * 1000)
    return () => clearTimeout(timer)
  }, [open?.account, open?.thread, readAfter, unseen])

  // A window of its own that's being closed is told first, and closes itself once what's typed is safe.
  useEffect(() => window.mail.onLeaving(() => {
    void Promise.resolve().then(() => leaving.current?.()).catch(() => undefined).then(() => window.close())
  }), [])

  // A composer of its own starts from the draft it was opened for.
  useEffect(() => {
    if (SOLO?.kind !== 'draft') return
    const id = SOLO.id
    void window.mail.drafts().then((all) => {
      setComposing(all.find((draft) => draft.id === id) ?? null)
      setSoloReady(true)
    })
  }, [])

  // A window of its own closes once what it held is gone: after any Undo has had its time, and never
  // around a reply being written.
  useEffect(() => {
    if (!SOLO || toast?.undo || undoing || accounts === null) return
    const done = SOLO.kind === 'thread' ? missing && !composing : soloReady && !composing
    if (done || accounts.length === 0) window.close()
  }, [missing, soloReady, composing, toast, undoing, accounts])

  const move = useCallback(
    (step: number) => {
      const at = list.findIndex((r) => r.account === open?.account && r.thread === open?.thread)
      const next = list[Math.min(list.length - 1, Math.max(0, at + step))]
      if (next) setOpen({ account: next.account, thread: next.thread })
    },
    [list, open]
  )

  /** After a thread leaves the list, the reader moves on to the next one, or the one before, or goes
   *  back to the list, as Settings say. */
  const afterRemove = profile?.afterRemove ?? 'next'
  const leave = useCallback(
    (gone: ThreadRef[]) => {
      if (!open || !gone.some((ref) => keyOf(ref) === keyOf(open))) return
      const leaving = new Set(gone.map(keyOf))
      const at = list.findIndex((r) => keyOf(r) === keyOf(open))
      const below = list.slice(at + 1)
      const above = list.slice(0, Math.max(at, 0)).reverse()
      const order = afterRemove === 'list' ? [] : afterRemove === 'previous' ? [...above, ...below] : [...below, ...above]
      const next = order.find((r) => !leaving.has(keyOf(r)))
      setOpen(next ? { account: next.account, thread: next.thread } : null)
    },
    [list, open, afterRemove]
  )

  // A selection is of the list on screen: a thread that has left it, for a search that doesn't find
  // it say, leaves the selection too.
  useEffect(() => {
    if (rows === null) return
    const listed = new Set(rows.map(keyOf))
    setPicked((now) => ([...now].every((key) => listed.has(key)) ? now : new Set([...now].filter((key) => listed.has(key)))))
  }, [rows])

  /** What's ticked, or with nothing ticked the open thread. Never the open thread while something
   *  is ticked: that would act on a thread nobody chose. */
  const targets = useCallback((): ThreadRef[] => {
    const chosen = list.filter((r) => picked.has(keyOf(r))).map((r) => ({ account: r.account, thread: r.thread }))
    return picked.size > 0 ? chosen : open ? [open] : []
  }, [list, picked, open])

  const run = useCallback(
    async (refs: ThreadRef[], action: MailAction, label?: string) => {
      if (refs.length === 0) return
      const leaves = TAKES_AWAY.includes(action.kind) || (action.kind === 'inbox' && bins)
      // Marked unread, the open thread closes: moving on to the next would open it, and so read it.
      const closes = action.kind === 'unread' && open !== null && refs.some((ref) => keyOf(ref) === keyOf(open))
      try {
        if (leaves && !SOLO) leave(refs)
        if (closes && !SOLO) setOpen(null)
        // What's offered with Undo waits for it before the server hears, or Undo would have nothing to call back.
        const token = await window.mail.act(refs, action, label !== undefined)
        // Reading it again would only mark it read again, so a window of its own goes with it.
        if (SOLO && action.kind === 'unread') return window.close()
        setPicked(new Set())
        if (label) {
          const text = refs.length > 1 ? `${label}: ${refs.length} threads` : label
          setToast({ text, undo: () => window.mail.undo(token) })
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
        if (!SOLO) leave(refs)
        await window.mail.snooze(refs, at)
        setPicked(new Set())
        setToast({ text: `Snoozed until ${longTime(at)}`, undo: () => window.mail.unsnooze(refs) })
      } catch (e) {
        say(problem(e))
      }
    },
    [leave, say]
  )

  /** Back from snooze now. Undo snoozes each again until its own time, if that's still to come. */
  const unsnooze = useCallback(
    async (refs: ThreadRef[]) => {
      const until = new Map(refs.map((ref) => [keyOf(ref), list.find((r) => keyOf(r) === keyOf(ref))?.snoozedUntil ?? null]))
      try {
        if (!SOLO && active.kind === 'snoozed') leave(refs)
        await window.mail.unsnooze(refs)
        setPicked(new Set())
        setToast({
          text: refs.length > 1 ? `Unsnoozed: ${refs.length} threads` : 'Unsnoozed',
          undo: async () => {
            const times = new Set([...until.values()].filter((at): at is number => at !== null && at > Date.now()))
            for (const at of times) await window.mail.snooze(refs.filter((ref) => until.get(keyOf(ref)) === at), at)
          }
        })
      } catch (e) {
        say(problem(e))
      }
    },
    [leave, say, list, active.kind]
  )

  const compose = useCallback(
    async (start: DraftStart) => {
      const attempt = { off: false }
      starting.current = attempt
      try {
        const draft = await window.mail.startDraft(start)
        await showComposer(draft, true)
      } catch (e) {
        if (starting.current === attempt) starting.current = null
        say(problem(e))
      }
    },
    [say, showComposer]
  )

  // Once the composer is on screen it hears its own keys.
  useEffect(() => {
    starting.current = null
  }, [composing?.id])

  /** The search box sits in the band over the list, which one-pane reading hides, so that comes back first. */
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
    else if (command === 'summary') {
      // The notice for a Summary that landed leads to it.
      setView({ kind: 'summary' })
      setSearch('')
      setOpen(null)
      setRows(null)
      setRelisted((n) => n + 1)
    }
    else if (command === 'help') setHelp(true)
    else if (command === 'print') window.print()
    else if (command === 'search') focusSearch()
  }), [compose, focusSearch])

  const reopen = async (draft: Draft): Promise<void> => {
    try {
      // Being written in a window of its own: that window comes forward, and there's still one editor.
      if (draft.state !== 'queued' && await window.mail.showDraftWindow(draft.id)) return
      if (draft.state === 'queued') await window.mail.unsend(draft.id)
      await showComposer({ ...draft, state: 'draft', sendAt: null })
    } catch (e) {
      say(problem(e))
    }
  }

  // A message on its way is "Sent" once it has gone from Drafts, and a failure says so; what went
  // wrong is on the draft, which stays. An Undo on offer for something else meanwhile stays.
  useEffect(() => {
    for (const id of going.current) {
      const draft = drafts.find((d) => d.id === id)
      if (draft && draft.state !== 'failed') continue
      going.current.delete(id)
      const text = draft ? 'Sending failed' : 'Sent'
      setToast((now) => (now?.undo && !now.sending ? now : { text }))
    }
  }, [drafts])

  /** "Sending", with Undo bringing the message back to the composer. */
  const announce = (id: number, when: number, scheduled: boolean): void => {
    const undo = async (): Promise<void> => {
      going.current.delete(id)
      try {
        await window.mail.unsend(id)
        const draft = (await window.mail.drafts()).find((d) => d.id === id)
        if (draft) await showComposer(draft)
      } catch (e) {
        say(problem(e))
      }
    }
    if (scheduled) return setToast({ text: `Sends ${longTime(when)}`, undo })
    const left = when - Date.now()
    going.current.add(id)
    setToast(left > 0 ? { text: 'Sending', undo, ms: left, sending: true } : { text: 'Sending', sending: true })
  }

  /** "Draft discarded", with Undo bringing it back to Drafts, and to the composer if it was thrown
   *  away from there. */
  const discarded = (id: number, reopen: boolean): void => {
    setToast({
      text: 'Draft discarded',
      undo: async () => {
        try {
          await window.mail.undiscardDraft(id)
          const draft = reopen ? (await window.mail.drafts()).find((d) => d.id === id) : undefined
          if (draft) await showComposer(draft)
        } catch (e) {
          say(problem(e))
        }
      }
    })
  }

  const sent = (id: number, when: number, scheduled: boolean): void => {
    setComposing(null)
    announce(id, when, scheduled)
  }

  const reply = useCallback((kind: ReplyKind, message: number) => void compose({ kind, message }), [compose])

  /** The straight-through list from the reader: one address on or off, and the rest as they are by
   *  the time it's saved, which the main process sees to. */
  const straight = async (address: string, on: boolean): Promise<void> => {
    try {
      await window.mail.editSenders('vip', [address], on)
      bump()
      say(on ? `Mail from ${address} comes straight through` : `Mail from ${address} waits for the next delivery`)
    } catch (e) {
      say(problem(e))
    }
  }

  const unsubscribe = async (message: number): Promise<void> => {
    try {
      const result = await window.mail.unsubscribe(message)
      if (result.kind === 'draft') await showComposer(result.draft)
      else say(result.kind === 'done' ? 'Unsubscribed' : 'Opened their page in your browser')
      bump()
    } catch (e) {
      say(problem(e))
    }
  }

  /** Pinned threads stay where they are; Pinned in the sidebar gathers them. */
  const pin = async (refs: ThreadRef[], on: boolean): Promise<void> => {
    try {
      await window.mail.pin(refs, on)
      const word = on ? 'Pinned' : 'Unpinned'
      setToast({ text: refs.length > 1 ? `${word}: ${refs.length} threads` : word, undo: () => window.mail.pin(refs, !on) })
    } catch (error) {
      say(problem(error))
    }
  }

  /** Blocked from a thread, it's that thread that goes to Trash, whatever else is ticked in the list. */
  const block = async (address: string, refs: ThreadRef[]): Promise<void> => {
    if (!await ask({ title: `Block ${address}?`, note: 'New mail from them goes straight to Trash.', action: 'Block', danger: true })) return
    await window.mail.block(address)
    await run(refs, { kind: 'trash' }, `Blocked ${address}`)
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

  /** Every unread thread of a place in the sidebar, whether or not it's the one on screen. */
  const markAllRead = async (target: ListQuery): Promise<void> => {
    try {
      const unread = (await window.mail.list(target, WHOLE_LIST)).filter((r) => r.unread > 0).map((r) => ({ account: r.account, thread: r.thread }))
      if (unread.length === 0) say('Nothing unread there')
      else await run(unread, { kind: 'read' }, 'Marked as read')
    } catch (e) {
      say(problem(e))
    }
  }

  /** Senders into the Summary or out of it. The first one in asks when it should land. The main
   *  process puts them in the list as it is then: two added one after the other both go in. */
  const summarize = async (addresses: string[], on: boolean): Promise<void> => {
    if (addresses.length === 0) return
    try {
      const { summary } = await window.mail.settings()
      if (on && !summary.chosen) {
        const picked = await new Promise<SummarySettings | null>((resolve) => setScheduling({ summary, done: resolve }))
        setScheduling(null)
        if (!picked) return
        await window.mail.saveSummary({ every: picked.every, time: picked.time, day: picked.day, chosen: true })
      }
      await window.mail.editSenders('summary', addresses, on)
      bump()
      const who = addresses.length === 1 ? addresses[0] : `${addresses.length} senders`
      const text = on ? `${who} ${addresses.length === 1 ? 'goes' : 'go'} into your Summary` : `${who} ${addresses.length === 1 ? 'is' : 'are'} out of your Summary`
      setToast({ text, undo: () => summarize(addresses, !on) })
    } catch (e) {
      say(problem(e))
    }
  }

  /** All a Summary brought, to Trash at once, as Edison offers. */
  const clearSummary = async (refs: ThreadRef[], at: number): Promise<void> => {
    const note = `${refs.length === 1 ? '1 thread goes' : `${refs.length} threads go`} to Trash.`
    if (!await ask({ title: `Delete the Summary of ${landedWords(at)}?`, note, action: 'Delete all', danger: true })) return
    await run(refs, { kind: 'trash' }, 'Moved to Trash')
  }

  /** What was opened is this laptop's own record, so clearing it asks first and can't be undone. */
  const clearRecent = async (): Promise<void> => {
    if (!await ask({ title: 'Clear Recently Seen?', action: 'Clear' })) return
    try {
      await window.mail.clearRecent()
      say('Recently Seen cleared')
    } catch (e) {
      say(problem(e))
    }
  }

  /** Everything in Trash, not only the rows read so far. */
  const emptyTrash = async (): Promise<void> => {
    if (active.kind !== 'trash') return
    try {
      const all = (await window.mail.list(active, WHOLE_LIST)).map((r) => ({ account: r.account, thread: r.thread }))
      if (all.length === 0) return
      const note = `${all.length === 1 ? '1 thread is' : `${all.length} threads are`} deleted for good. This can't be got back once Undo has gone.`
      if (await ask({ title: 'Empty Trash?', note, action: 'Empty Trash', danger: true })) void run(all, { kind: 'forever' }, 'Trash emptied')
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

  /** Focused and Other go by sender, so moving several threads keeps each one's sender on that side. */
  const keepSenders = async (rows: ThreadRow[], focused: boolean): Promise<void> => {
    const mine = new Set(own)
    const senders = [...new Set(rows.map((r) => r.fromAddress.toLowerCase()).filter((a) => a && !mine.has(a)))]
    setPicked(new Set())
    if (senders.length === 1) return keepSender(senders[0] ?? '', focused)
    try {
      for (const address of senders) await window.mail.setFocus(address, focused)
      say(`${senders.length} senders stay in ${focused ? 'Focused' : 'Other'}`)
    } catch (e) {
      say(problem(e))
    }
  }

  /** A muted sender's mail still arrives; it just isn't announced. */
  const mute = async (address: string, on: boolean): Promise<void> => {
    try {
      await window.mail.editSenders('muted', [address], on)
      say(on ? `Mail from ${address} won't be announced` : `Mail from ${address} is announced again`)
    } catch (e) {
      say(problem(e))
    }
  }

  const trustImages = async (address: string): Promise<void> => {
    try {
      await window.mail.editSenders('imagesFrom', [address], true)
      say(`Images from ${address} will load by themselves`)
    } catch (e) {
      say(problem(e))
    }
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
    else if (target.kind === 'all' || target.kind === 'archive') void run(refs, { kind: 'archive' }, 'Archived')
    else if (target.kind === 'trash') void run(refs, { kind: 'trash' }, 'Moved to Trash')
    else if (target.kind === 'spam') void run(refs, { kind: 'spam' }, 'Reported as spam')
    else if (target.kind === 'starred') void run(refs, { kind: 'star' })
    else if (target.kind === 'pinned') void pin(refs, true)
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
      { label: row.starred ? 'Remove flag' : 'Flag', icon: Flag, run: () => void run(refs, { kind: row.starred ? 'unstar' : 'star' }) },
      row.pinned
        ? { label: 'Unpin', icon: PinOff, run: () => void pin(refs, false) }
        : { label: 'Pin', icon: Pin, run: () => void pin(refs, true) },
      'gap',
      { label: 'Archive', icon: Check, run: () => void run(refs, { kind: 'archive' }, 'Archived') },
      { label: 'Snooze', icon: Clock, run: () => { setPicked(new Set(refs.map(keyOf))); setBulkSnooze(true) } },
      ...(active.kind === 'snoozed' ? [{ label: 'Unsnooze', icon: AlarmClockOff, run: () => void unsnooze(refs) }] : []),
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
      // The composer sits docked over the reader, so the list and the thread go on hearing keys
      // beside it; only what's pressed inside it is its own. A composer of its own is all its window has.
      const writing = Boolean(element.closest?.('.composer')) || SOLO?.kind === 'draft'
      if (typing || settings || help || writing || question) {
        if (event.key === 'Escape' && event.target === searchBox.current) {
          setSearch('')
          searchBox.current?.blur()
        }
        return
      }
      const last = messages.at(-1)
      const trash = (): void => (bins ? forever(targets()) : void run(targets(), { kind: 'trash' }, 'Moved to Trash'))
      const commands: Record<KeyCommand, () => void> = {
        search: focusSearch,
        next: () => move(1),
        previous: () => move(-1),
        close: () => {
          if (starting.current) starting.current.off = true
          else if (picked.size > 0) setPicked(new Set())
          else if (!SOLO) setOpen(null)
        },
        compose: () => void compose({ kind: 'new' }),
        reply: () => { if (last) reply('reply', last.id) },
        replyAll: () => { if (last) reply('replyAll', last.id) },
        forward: () => { if (last) reply('forward', last.id) },
        archive: () => { if (!bins) void run(targets(), { kind: 'archive' }, 'Archived') },
        trash,
        // Out of the list in front of you: archived, where that's something a thread there can be.
        removeFromView: () => { if (!bins && active.kind !== 'archive' && active.kind !== 'sent') void run(targets(), { kind: 'archive' }, 'Archived') },
        spam: () => void (active.kind === 'spam' ? run(targets(), { kind: 'inbox' }, 'Moved to Inbox') : run(targets(), { kind: 'spam' }, 'Reported as spam')),
        flag: () => {
          const flagged = picked.size > 0 ? list.filter((r) => picked.has(keyOf(r))).every((r) => r.starred) : messages.some((m) => m.flagged)
          void run(targets(), { kind: flagged ? 'unstar' : 'star' })
        },
        read: () => void run(targets(), { kind: 'read' }),
        unread: () => void run(targets(), { kind: 'unread' }),
        toggleRead: () => {
          const unread = picked.size > 0 ? list.some((r) => picked.has(keyOf(r)) && r.unread > 0) : messages.some((m) => !m.seen)
          void run(targets(), { kind: unread ? 'read' : 'unread' })
        },
        pin: () => {
          if (bins) return
          const pinned = picked.size > 0 ? list.filter((r) => picked.has(keyOf(r))).every((r) => r.pinned) : messages.some((m) => m.pinned)
          void pin(targets(), !pinned)
        },
        sync: () => void window.mail.syncNow(),
        snooze: () => {
          if (picked.size > 0) setBulkSnooze(true)
          else if (open) setPanel('snooze')
        },
        labels: () => { if (open) setPanel('labels') },
        select: () => {
          const index = list.findIndex((r) => r.account === open?.account && r.thread === open?.thread)
          const row = list[index]
          if (row) togglePick(row, index, false)
        },
        selectAll: () => setPicked(new Set(list.map(keyOf))),
        undo: () => toast?.undo?.(),
        help: () => setHelp(true)
      }
      const set = profile?.keys ?? 'edison'
      const command = keysFor(set, profile?.keyChanges[set])[keyName(event)]
      const handler = command && commands[command]
      if (!handler) return
      event.preventDefault()
      handler()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const own = useMemo(() => (accounts ?? []).flatMap((a) => [a.email, ...(profile?.identities[a.email]?.aliases ?? [])]).map((a) => a.toLowerCase()), [accounts, profile])

  /** The line between list and reader, dragged: sideways beside it, up and down over it. */
  const resize = (down: PointerEvent): void => {
    const over = profile?.layout === 'below'
    const span = over ? LIST_HEIGHTS : LIST_WIDTHS
    const set = over ? setListHeight : setListWidth
    const start = over ? down.clientY : down.clientX
    const from = over ? listHeight : listWidth
    // Over the reader, the list can't take so much that the reader has no room.
    const high = over ? Math.min(span.high, window.innerHeight - 260) : span.high
    let now = from
    const moved = (event: globalThis.PointerEvent): void => {
      now = Math.round(Math.max(span.low, Math.min(high, from + (over ? event.clientY : event.clientX) - start)))
      set(now)
    }
    const done = (): void => {
      window.removeEventListener('pointermove', moved)
      window.removeEventListener('pointerup', done)
      try {
        localStorage.setItem(span.key, String(now))
      } catch {
        // Only a convenience: next time it starts at its usual size.
      }
    }
    window.addEventListener('pointermove', moved)
    window.addEventListener('pointerup', done)
  }

  if (accounts === null) return null
  if (accounts.length === 0) return SOLO ? null : <Welcome />

  const go = (target: View): void => {
    setView(target)
    setSearch('')
    setOpen(null)
    setPicked(new Set())
    setLimit(PAGE)
    setRows(null)
    setRelisted((n) => n + 1)
  }

  const refs = targets()
  const many = accounts.length > 1
  const showDrafts = active.kind === 'drafts'
  const showSubscriptions = active.kind === 'subscriptions'
  const subscriptionSide = active.kind === 'subscriptions' ? active.side ?? 'subscribed' : 'subscribed'
  const changeSummary = (): void => setSettings('summary')
  const summaryBar = profile && <SummaryBar summary={profile.summary} overview={overview} change={changeSummary} />
  const backToSubscriptions = (): void => go(senderFrom === 'subscribed' ? { kind: 'subscriptions' } : { kind: 'subscriptions', side: senderFrom })
  /** Over each Summary's threads in the Summary list: when it landed, and Delete all. */
  const summaryHead = (at: number): ReactNode => {
    const refs = list.filter((r) => r.summaryAt === at).map((r) => ({ account: r.account, thread: r.thread }))
    return (
      <div className="summary-head">
        <Newspaper size={14} aria-hidden="true" />
        <span className="grow"><strong>Summary</strong> · {landedWords(at)} · {refs.length === 1 ? '1 thread' : `${refs.length} threads`}</span>
        <button className="link danger" onClick={() => void clearSummary(refs, at)}>Delete all</button>
      </div>
    )
  }
  const shownDrafts = active.kind === 'drafts' && active.account ? drafts.filter((d) => d.account === active.account) : drafts
  const openAccount = accounts.find((a) => a.email === open?.account)
  const anyPicked = picked.size > 0
  const firstRead = accounts.some((a) => a.syncing && a.syncedAt === null)
  const progress = accounts.map((a) => a.progress).filter((p) => p !== null)
  const done = progress.reduce((sum, p) => sum + p.done, 0)
  const total = progress.reduce((sum, p) => sum + p.total, 0)
  const single = profile?.layout === 'list'
  const below = profile?.layout === 'below'
  const lines = profile?.previewLines ?? 2
  const showRecent = searchFocus && !searching && searches.length > 0
  // What the bar under a selection's ⋮ works on: labels and folders are one account's own.
  const pickedRows = list.filter((r) => picked.has(keyOf(r)))
  const pickedAccounts = [...new Set(pickedRows.map((r) => r.account))]
  const pickedAccount = pickedAccounts.length === 1 ? accounts.find((a) => a.email === pickedAccounts[0]) : undefined
  const allPinned = pickedRows.length > 0 && pickedRows.every((r) => r.pinned)
  // Importance is Gmail's, so it's offered only for threads that are all on Gmail.
  const pickedGmail = pickedRows.length > 0 && pickedRows.every((r) => accounts.find((a) => a.email === r.account)?.labels)
  const onOther = active.kind === 'inbox' && active.focus === 'other'
  const appClass = ['app', open ? 'reading' : '', single ? 'one-pane' : '', below ? 'below' : '', lines === 0 ? 'no-preview' : '', profile?.sidebarIcons === false ? 'no-icons' : ''].join(' ')
  const swipes: Swipes = profile?.swipes
    ? { left: profile.swipeLeft, leftLong: profile.swipeLeftLong, right: profile.swipeRight, rightLong: profile.swipeRightLong }
    : NO_SWIPES
  const quick = profile?.quickOn ? profile.quickActions : []
  const emptyList = showDrafts ? shownDrafts.length === 0 : !showSubscriptions && rows !== null && rows.length === 0
  const splitAccount = active.kind === 'inbox' ? accounts.find((a) => a.email === active.account) ?? (many ? undefined : accounts[0]) : undefined
  const otherCount = splitAccount?.otherUnread ?? 0
  const inboxScope = active.kind === 'inbox' && active.account ? { account: active.account } : {}
  // Live, nothing waits for a delivery, so there's nobody to let straight through.
  const batching = profile ? !profile.batch.live && profile.batch.times.length > 0 : false

  // Snoozed lists what's away; elsewhere a snoozed thread is one a reply has woken.
  const openSnoozed = active.kind === 'snoozed' && open !== null && list.some((r) => keyOf(r) === keyOf(open))
  const popOut = (): void => {
    if (!open) return
    // It's read there from now on. Left open here as well, this window would mark it read again
    // each time it changed, whatever was done to it there.
    void window.mail.openThreadWindow(open.account, open.thread, bins).then(() => setOpen(null), (e: unknown) => say(problem(e)))
  }
  // One message that can't be drawn takes the reader with it, not the window. Another thread tries again.
  const reader = (
    <Boundary reset={open ? keyOf(open) : ''} fallback={(again) => (
      <CantShow label={SOLO ? 'Close' : 'Back to the list'} back={() => {
        if (SOLO) return window.close()
        setOpen(null)
        again()
      }} />
    )}>
    <Reader messages={messages} account={openAccount} bins={bins} panel={panel} setPanel={setPanel} back={() => setOpen(null)} popOut={SOLO ? undefined : popOut} own={own}
      settings={profile} unread={unread} held={overview?.held ?? 0} vip={batching ? profile?.batch.vip ?? [] : null} many={many}
      labels={openAccount ? labelsOf(openAccount, overview) : []}
      act={(action, label) => void run(open ? [open] : [], action, label)}
      snooze={(at) => void snooze(open ? [open] : [], at)}
      unsnooze={openSnoozed ? () => void unsnooze(open ? [open] : []) : undefined}
      reply={reply} unsubscribe={(message) => void unsubscribe(message)} block={(address) => void block(address, open ? [open] : [])} say={say}
      rsvp={(message, reply) => void answer(message, reply)} setFocus={(address, focused) => void keepSender(address, focused)}
      trust={(address) => void trustImages(address)} straight={(address, on) => void straight(address, on)}
      forever={() => forever(open ? [open] : [])} pin={(on) => void pin(open ? [open] : [], on)} mute={(address, on) => void mute(address, on)}
      summarize={(address, on) => void summarize([address], on)}
      write={(address) => void compose({ kind: 'new', account: open?.account, to: address })}
      find={SOLO ? undefined : (text) => {
        setSearch(text)
        focusSearch()
      }} />
    </Boundary>
  )
  /** What's drawn over the page, in any window. */
  const over = (
    <>
      {composing && (
        <Composer key={composing.id} draft={composing} accounts={accounts} settings={profile} sent={sent} starting={starting.current}
          solo={SOLO?.kind === 'draft'} leaving={leaving} closing={closing} fresh={composing === started}
          discarded={(id) => discarded(id, true)}
          moveOut={(id) => {
            setComposing(null)
            void window.mail.openDraftWindow(id).catch((e: unknown) => say(problem(e)))
          }}
          close={(saved) => {
            setComposing(null)
            if (saved && SOLO?.kind !== 'draft') say('Saved to Drafts') // a composer of its own just closes
          }} />
      )}
      {toast && (
        <div className="toast" role="status">
          <span>{toast.text}</span>
          {toast.undo && <button className="link" onClick={() => undoNow(toast.undo)}>Undo</button>}
        </div>
      )}
      {help && <Help close={() => setHelp(false)} set={profile?.keys ?? 'edison'} changes={profile?.keyChanges[profile.keys]} />}
      {settings && (
        <SettingsDialog accounts={accounts} version={version} tab={settings} ask={ask} close={() => setSettings(null)}
          editMenu={SOLO ? undefined : () => { setSettings(null); setEditingMenu(true) }} />
      )}
      {question && <Confirm question={question} />}
      {scheduling && <ScheduleDialog summary={scheduling.summary} done={scheduling.done} />}
      {newFolder && (
        <NewFolderDialog accounts={accounts} account={newFolder} done={(made) => {
          if (made) say(`Made the ${made.kind} ${made.path}`)
          setNewFolder(null)
        }} />
      )}
    </>
  )

  if (SOLO) return <div className={`app solo solo-${SOLO.kind}`}>{SOLO.kind === 'thread' && reader}{over}</div>

  return (
    <div className={appClass} style={{ '--list': `${listWidth}px`, '--list-height': `${listHeight}px`, '--preview-lines': lines } as CSSProperties}>
      <Sidebar accounts={accounts} overview={overview} view={view} drafts={drafts} go={go}
        compose={() => void compose({ kind: 'new' })} settings={() => setSettings('general')} drop={dropOn}
        menu={(target, x, y) => setSideMenu({ x, y, target })} newFolder={setNewFolder}
        choice={profile?.sidebar ?? NO_CHOICE} editing={editingMenu}
        edited={(choice) => {
          setEditingMenu(false)
          if (!choice) return
          setProfile((now) => (now ? { ...now, sidebar: choice } : now)) // shown at once; the save follows
          void window.mail.saveProfile({ sidebar: choice }).catch((e: unknown) => say(problem(e))).then(bump)
        }} />
      <div className="main">
        <header className="band">
          <h1 className="view-title">{active.kind === 'from' ? sender?.name || active.address : titleOf(active, many)}</h1>
          <div className="search">
            <SearchIcon size={16} aria-hidden="true" />
            <input ref={searchBox} type="search" placeholder="Search all mail" aria-label="Search" value={search} spellCheck={false}
              role="combobox" aria-expanded={showRecent} aria-controls="recent-searches" aria-autocomplete="list"
              aria-activedescendant={showRecent && searchPick >= 0 ? `recent-search-${searchPick}` : undefined}
              onFocus={() => { setSearchFocus(true); setSearchPick(-1) }}
              onBlur={() => setSearchFocus(false)}
              onChange={(e) => { setSearch(e.target.value); setSearchPick(-1) }}
              onKeyDown={(e) => {
                if (showRecent && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                  e.preventDefault()
                  const count = searches.length
                  setSearchPick((at) => (e.key === 'ArrowDown' ? (at + 1) % count : at <= 0 ? count - 1 : at - 1))
                } else if (e.key === 'Enter') {
                  const picked = showRecent ? searches[searchPick] : undefined
                  if (picked !== undefined) pickSearch(picked)
                  else keepSearch(search)
                }
              }} />
            {searching && <button className="search-clear" aria-label="Clear" onClick={() => setSearch('')}><X size={14} aria-hidden="true" /></button>}
            {showRecent && (
              <div className="recent-searches" onMouseDown={(e) => e.preventDefault()}>
                <div className="recent-head">
                  <span className="grow">Recent searches</span>
                  <button className="link" aria-label="Clear recent searches" onClick={() => forgetSearch(null)}>Clear</button>
                </div>
                <ul role="listbox" id="recent-searches" aria-label="Recent searches">
                  {searches.map((text, i) => (
                    <li key={text} id={`recent-search-${i}`} role="option" aria-selected={i === searchPick} className={i === searchPick ? 'on' : ''}
                      onClick={() => pickSearch(text)}>
                      <History size={14} aria-hidden="true" />
                      <span className="grow">{text}</span>
                      <button className="icon small" tabIndex={-1} aria-label={`Remove ${text}`} onClick={(e) => { e.stopPropagation(); forgetSearch(text) }}>
                        <X size={13} aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </header>
        {/* Subscriptions are a page of senders with nothing to open beside them, so they take the width. */}
        <div className={showSubscriptions ? 'panes whole' : 'panes'}>
          <section className="list" aria-label="Threads">
            {split && active.kind === 'inbox' && (
              <div className="tabs" role="group" aria-label="Focused and Other">
                <button className={active.focus !== 'other' ? 'tab on' : 'tab'} aria-pressed={active.focus !== 'other'}
                  onClick={() => go({ kind: 'inbox', ...inboxScope })}>Focused</button>
                <button className={active.focus === 'other' ? 'tab on' : 'tab'} aria-pressed={active.focus === 'other'}
                  onClick={() => go({ kind: 'inbox', ...inboxScope, focus: 'other' })}>
                  Other{otherCount > 0 && ` (${otherCount > 99 ? '99+' : otherCount})`}
                </button>
              </div>
            )}
            {active.kind === 'subscriptions' && (
              <div className="tabs" role="group" aria-label="Sides of Subscriptions">
                <button className={subscriptionSide === 'subscribed' ? 'tab on' : 'tab'} aria-pressed={subscriptionSide === 'subscribed'} onClick={() => go({ kind: 'subscriptions' })}>Subscribed</button>
                <button className={subscriptionSide === 'left' ? 'tab on' : 'tab'} aria-pressed={subscriptionSide === 'left'} onClick={() => go({ kind: 'subscriptions', side: 'left' })}>Unsubscribed</button>
                <button className={subscriptionSide === 'summary' ? 'tab on' : 'tab'} aria-pressed={subscriptionSide === 'summary'} onClick={() => go({ kind: 'subscriptions', side: 'summary' })}>Summary</button>
              </div>
            )}
            {overview && <BatchStrip overview={overview} />}
            {total > 0 && (
              <div className="sync-progress" role="status">
                <span className="muted">Getting your mail · {done.toLocaleString()} of {total.toLocaleString()}</span>
                <span className="bar"><i style={{ width: `${Math.round((done / total) * 100)}%` }} /></span>
              </div>
            )}
            {active.kind === 'summary' && summaryBar}
            {active.kind === 'from' && (sender ? (
              <SenderCard item={sender} back={backToSubscriptions} unsubscribe={(message) => void unsubscribe(message)} clear={(item) => void clearSender(item)}
                summarize={(items, on) => void summarize(items.map((item) => item.address), on)}
                inSummary={straightThrough(sender.address, profile?.summary.senders ?? [])} left={(profile?.unsubscribed ?? []).includes(sender.address)} />
            ) : (
              <div className="strip"><button className="link" onClick={backToSubscriptions}>‹ Subscriptions</button></div>
            ))}
            {active.kind === 'inbox' && active.focus !== 'other' && overview && <SummaryNotice overview={overview} open={() => go({ kind: 'summary' })} />}
            {active.kind === 'trash' && list.length > 0 && (
              <div className="strip">
                <span className="muted">{list.length >= limit ? `${list.length}+` : list.length} {list.length === 1 ? 'thread' : 'threads'} in Trash</span>
                <span aria-hidden="true" className="muted">·</span>
                <button className="link" onClick={() => void emptyTrash()}>Empty Trash now</button>
              </div>
            )}
            <div className={anyPicked ? 'threads picking' : 'threads'} onScroll={(e) => {
              const box = e.currentTarget
              if (list.length >= limit && box.scrollTop + box.clientHeight > box.scrollHeight - 300) setLimit(limit + PAGE)
            }}>
              {showDrafts && shownDrafts.map((draft) => (
                <DraftRow key={draft.id} draft={draft} account={many ? accounts.find((a) => a.email === draft.account) : undefined} open={() => void reopen(draft)}
                  discard={() => void window.mail.discardDraft(draft.id, true).then(() => discarded(draft.id, false), (e: unknown) => say(problem(e)))} />
              ))}
              {showSubscriptions && (
                <Subscriptions version={version} side={subscriptionSide} accounts={accounts} unsubscribe={(message) => void unsubscribe(message)} clear={(item) => void clearSender(item)}
                  summarize={(items, on) => void summarize(items.map((item) => item.address), on)}
                  open={(item) => {
                    setSenderFrom(subscriptionSide)
                    go({ kind: 'from', account: item.account, address: item.address })
                  }}
                  top={subscriptionSide === 'summary' && <>{summaryBar}<LatestSummary overview={overview} open={() => go({ kind: 'summary' })} /></>} />
              )}
              {!showDrafts && !showSubscriptions && list.map((row, index) => (
                <Fragment key={keyOf(row)}>
                {active.kind === 'summary' && row.summaryAt !== null && row.summaryAt !== list[index - 1]?.summaryAt && summaryHead(row.summaryAt)}
                <Row row={row} many={many} own={own} bins={bins} assistant={active.kind === 'assistant'} snoozed={active.kind === 'snoozed'}
                  account={accounts.find((a) => a.email === row.account)}
                  on={open?.account === row.account && open.thread === row.thread} picked={picked.has(keyOf(row))}
                  swipe={swipes} quick={quick} cards={profile?.attachmentCards ?? true} importance={profile?.importanceMarks ?? true}
                  open={() => setOpen({ account: row.account, thread: row.thread })}
                  pick={(event) => togglePick(row, index, event.shiftKey)}
                  act={(action, label) => void run([{ account: row.account, thread: row.thread }], action, label)}
                  snooze={() => snoozeRow(row)}
                  swiped={(action) => swiped(row, action)}
                  menu={(x, y) => setMenu({ x, y, row })}
                  drag={(event) => dragged(event, row)} />
                </Fragment>
              ))}
              {(rows === null || (firstRead && list.length === 0)) && !showDrafts && !showSubscriptions && <Skeleton />}
              {emptyList && !firstRead && (
                searching ? <Empty icon={SearchX} title="Nothing found" />
                  : active.kind === 'inbox' && active.focus !== 'other' ? <Empty icon={Check} title="Nothing here" />
                  : active.kind === 'recent' ? <Empty icon={History} title="Nothing seen yet" />
                  : active.kind === 'summary' ? <Empty icon={Newspaper} title="No Summary here" />
                  : <Empty icon={Inbox} title="Nothing here" />
              )}
            </div>
            {anyPicked && (
              <div className="bulk" role="toolbar" aria-label="Selected threads">
                <div className="bulk-top">
                  <strong className="grow">{picked.size} selected</strong>
                  <button className="bulk-pill" onClick={() => setPicked(new Set(list.map(keyOf)))}>Select All ({list.length})</button>
                  <button className="bulk-pill" onClick={() => setPicked(new Set())}>Cancel</button>
                </div>
                <div className="bulk-tools">
                  {bins ? (
                    <>
                      <IconButton icon={Undo2} label="Restore selected" click={() => void run(refs, { kind: 'inbox' }, 'Moved to Inbox')} />
                      <IconButton icon={Trash2} label="Delete selected forever" click={() => forever(refs)} />
                    </>
                  ) : (
                    <>
                      <IconButton icon={Check} label="Archive selected" click={() => void run(refs, { kind: 'archive' }, 'Archived')} />
                      <IconButton icon={OctagonAlert} label="Report selected as spam" click={() => void run(refs, { kind: 'spam' }, 'Reported as spam')} />
                      <IconButton icon={Trash2} label="Delete selected" click={() => void run(refs, { kind: 'trash' }, 'Moved to Trash')} />
                      <IconButton icon={Flag} label="Flag selected" click={() => void run(refs, { kind: 'star' })} />
                    </>
                  )}
                  <IconButton icon={MailOpen} label="Mark selected read" click={() => void run(refs, { kind: 'read' })} />
                  <IconButton icon={Mail} label="Mark selected unread" click={() => void run(refs, { kind: 'unread' })} />
                  {active.kind === 'snoozed' && <IconButton icon={AlarmClockOff} label="Unsnooze selected" click={() => void unsnooze(refs)} />}
                  {!bins && (
                    <div className="anchor">
                      <IconButton icon={Clock} label="Snooze selected" click={() => setBulkSnooze(!bulkSnooze)} />
                      {bulkSnooze && <TimeMenu title="Snooze until" up right pick={(at) => void snooze(refs, at)} close={() => setBulkSnooze(false)} />}
                    </div>
                  )}
                  {!bins && (
                    <div className="anchor">
                      <IconButton icon={MoreVertical} label="More for the selected" click={() => setBulkMenu(bulkMenu ? null : 'more')} />
                      {bulkMenu === 'more' && (
                        <Popover up right close={() => setBulkMenu(null)}>
                          {pickedAccount ? (
                            <button type="button" className="menu-item" onClick={() => setBulkMenu('file')}>
                              {pickedAccount.labels ? <Tag size={15} aria-hidden="true" /> : <FolderInput size={15} aria-hidden="true" />}
                              {pickedAccount.labels ? 'Labels…' : 'Move to…'}
                            </button>
                          ) : (
                            <p className="muted note menu-note">Pick threads from one account</p>
                          )}
                          {pickedGmail && pickedRows.some((r) => !r.important) && (
                            <button type="button" className="menu-item" onClick={() => { setBulkMenu(null); void run(refs, { kind: 'label', label: IMPORTANT, add: true }) }}>
                              <ImportantMark size={15} /> Mark as important
                            </button>
                          )}
                          {pickedGmail && pickedRows.some((r) => r.important) && (
                            <button type="button" className="menu-item" onClick={() => { setBulkMenu(null); void run(refs, { kind: 'label', label: IMPORTANT, add: false }) }}>
                              <ImportantMark size={15} /> Mark as not important
                            </button>
                          )}
                          <button type="button" className="menu-item" onClick={() => { setBulkMenu(null); setPicked(new Set()); void pin(refs, !allPinned) }}>
                            {allPinned ? <PinOff size={15} aria-hidden="true" /> : <Pin size={15} aria-hidden="true" />} {allPinned ? 'Unpin' : 'Pin'}
                          </button>
                          {profile?.focused && (
                            <button type="button" className="menu-item" onClick={() => { setBulkMenu(null); void keepSenders(pickedRows, onOther) }}>
                              <Filter size={15} aria-hidden="true" /> {onOther ? 'Move to Focused' : 'Move to Other'}
                            </button>
                          )}
                        </Popover>
                      )}
                      {bulkMenu === 'file' && pickedAccount && (
                        <FolderMenu up right title={pickedAccount.labels ? 'Add a label' : undefined}
                          folders={pickedAccount.labels ? labelsOf(pickedAccount, overview) : pickedAccount.folders} close={() => setBulkMenu(null)}
                          pick={(to) => {
                            setBulkMenu(null)
                            void (pickedAccount.labels ? run(refs, { kind: 'label', label: to, add: true }, `Labelled ${to}`) : run(refs, { kind: 'move', to }, `Moved to ${to}`))
                          }} />
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
          </section>
          <div className="resize" aria-hidden="true" onPointerDown={resize} />
          {reader}
        </div>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuFor(menu.row)} close={() => setMenu(null)} />}
      {sideMenu && (
        <ContextMenu x={sideMenu.x} y={sideMenu.y} close={() => setSideMenu(null)}
          items={[
            ...(sideMenu.target ? [{ label: 'Mark all as read', icon: MailOpen, run: () => void markAllRead(sideMenu.target as ListQuery) }] : []),
            ...(sideMenu.target?.kind === 'recent' ? [{ label: 'Clear Recently Seen', icon: Eraser, run: () => void clearRecent() }] : []),
            { label: 'Edit Menu', icon: SlidersHorizontal, run: () => setEditingMenu(true) }
          ]} />
      )}
      {over}
    </div>
  )
}
