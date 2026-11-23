import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode, type RefObject } from 'react'
import {
  Archive, Bold, Check, Clock, Italic, Link, List, ListOrdered, Paperclip, Quote as QuoteIcon, RemoveFormatting, SendHorizontal, Signature, Strikethrough, Trash2,
  SquareArrowOutUpRight, Underline, Upload, X
} from 'lucide-react'
import { plainName } from '@shared/names'
import { hintFor, keyName, keysFor } from '@shared/keys'
import { chipLabel, readRecipient, splitRecipients } from '@shared/recipients'
import { INLINE_PICTURES, signatureFor, type AccountView, type Address, type Draft, type DraftEdit, type DraftFile, type Quote, type Settings, type ThreadRef } from '@shared/types'
import { Avatar } from './Common'
import { fileSize, problem } from './format'
import { MailBody, sanitize } from './MailBody'
import { IconButton, Popover, TimeMenu } from './Menus'

const SAVE_AFTER_MS = 700

/** What's quoted came from a stranger, so it's cleaned on its way into the draft: this copy is what gets sent. */
const cleanQuote = (quote: Quote | null): Quote | null =>
  quote ? { ...quote, html: quote.html ? sanitize(quote.html) : null } : null

/** What the editor may hold: what's typed, and pictures that are the draft's own. [keep] says what an
 *  <img> shows instead of its src, or null for one that isn't the draft's, which goes: no picture
 *  from anywhere else is ever fetched here. */
export function ownMarkup(html: string, keep: (src: string) => string | null): string {
  const clean = sanitize(html)
  if (!/<img\b/i.test(clean)) return clean
  const box = document.createElement('template')
  box.innerHTML = clean
  for (const img of box.content.querySelectorAll('img')) {
    const src = keep(img.getAttribute('src') ?? '')
    if (src === null) img.remove()
    else img.setAttribute('src', src)
  }
  return box.innerHTML
}

/** What's typed, as text, with "[image: name]" where a picture is, as the text part of a message
 *  with pictures says it. A copy of the words is measured off screen, without its pictures, since
 *  only words that are laid out have lines. */
export function textOf(editor: HTMLElement | null): string {
  if (!editor) return ''
  if (!editor.querySelector('img')) return editor.innerText
  const box = document.createElement('template')
  box.innerHTML = editor.innerHTML
  for (const img of box.content.querySelectorAll('img')) img.replaceWith(`[image: ${img.getAttribute('alt') || 'image'}]`)
  const copy = document.createElement('div')
  copy.style.cssText = 'position:fixed;left:-100000px;top:0;width:600px;pointer-events:none'
  copy.append(box.content)
  document.body.append(copy)
  try {
    return copy.innerText
  } finally {
    copy.remove()
  }
}

/** A picture written into a signature, which is all a signature may show. */
const DATA_PICTURE = /^data:image\/(?:png|jpeg|gif|webp);base64,/i
export const signatureMarkup = (html: string): string => ownMarkup(html, (src) => (DATA_PICTURE.test(src) ? src : null))

export const asDataUrl = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(String(reader.result))
  reader.onerror = () => reject(reader.error ?? new Error("That picture couldn't be read."))
  reader.readAsDataURL(blob)
})

export const escapeAttribute = (text: string): string => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Bold, italic, links, lists and the rest, for an editor of the app's own: a message's words, and a
 *  signature in Settings. [changed] is told after each. */
export function FormatBar(props: { editor: RefObject<HTMLDivElement | null>; changed(): void }): ReactNode {
  const [linking, setLinking] = useState<string | null>(null)
  const selection = useRef<Range | null>(null)

  const format = (command: string, value?: string): void => {
    props.editor.current?.focus()
    document.execCommand(command, false, value)
    props.changed()
  }

  const startLink = (): void => {
    const picked = window.getSelection()
    selection.current = picked && picked.rangeCount > 0 ? picked.getRangeAt(0).cloneRange() : null
    setLinking('https://')
  }

  const finishLink = (): void => {
    const url = (linking ?? '').trim()
    setLinking(null)
    if (!/^(https?:\/\/|mailto:)/i.test(url)) return
    const range = selection.current
    props.editor.current?.focus()
    if (range) {
      window.getSelection()?.removeAllRanges()
      window.getSelection()?.addRange(range)
    }
    if (range?.collapsed) document.execCommand('insertText', false, url)
    format('createLink', url)
  }

  return (
    <>
      {linking !== null && (
        <div className="menu-row link-row">
          <input aria-label="Link address" autoFocus value={linking} onChange={(e) => setLinking(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); finishLink() }
              else if (e.key === 'Escape') { e.stopPropagation(); setLinking(null) }
            }} />
          <button type="button" className="quiet" onClick={finishLink}>Link</button>
        </div>
      )}
      <div className="format" role="toolbar" aria-label="Formatting" onMouseDown={(e) => e.preventDefault()}>
        <IconButton icon={Bold} label="Bold" click={() => format('bold')} />
        <IconButton icon={Italic} label="Italic" click={() => format('italic')} />
        <IconButton icon={Underline} label="Underline" click={() => format('underline')} />
        <IconButton icon={Strikethrough} label="Strikethrough" click={() => format('strikeThrough')} />
        <IconButton icon={RemoveFormatting} label="Clear formatting" click={() => format('removeFormat')} />
        <span className="tool-gap" />
        <IconButton icon={Link} label="Add link" click={startLink} />
        <IconButton icon={QuoteIcon} label="Quote" click={() => format('formatBlock', 'blockquote')} />
        <IconButton icon={ListOrdered} label="Numbered list" click={() => format('insertOrderedList')} />
        <IconButton icon={List} label="List" click={() => format('insertUnorderedList')} />
      </div>
    </>
  )
}

const asRecipient = (who: Address): string => {
  if (!who.name) return who.address
  return /[,"<>]/.test(who.name) ? `"${who.name.replace(/"/g, '')}" <${who.address}>` : `${who.name} <${who.address}>`
}

function Chip(props: { text: string; remove(): void; edit(): void }): ReactNode {
  const who = readRecipient(props.text)
  return (
    <span className={who.valid ? 'person' : 'person bad'} title={who.address} onDoubleClick={props.edit}>
      {chipLabel(who)}
      <button type="button" aria-label={`Remove ${who.address}`} onClick={props.remove}><X size={12} aria-hidden="true" /></button>
    </span>
  )
}

function Recipients(props: { label: string; value: string; focus?: boolean; change(value: string): void }): ReactNode {
  const [chips, setChips] = useState(() => splitRecipients(props.value))
  const [typing, setTyping] = useState('')
  const [hits, setHits] = useState<Address[]>([])
  const [at, setAt] = useState(0)
  const box = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (typing.trim().length < 2) return setHits([])
    const timer = setTimeout(() => {
      void window.mail.contacts(typing.trim()).then((found) => {
        setHits(found)
        setAt(0)
      })
    }, 120)
    return () => clearTimeout(timer)
  }, [typing])

  /** The draft always holds what's being typed too, so nothing is lost by leaving mid-address. */
  const publish = (nextChips: string[], nextTyping: string): void => {
    setChips(nextChips)
    setTyping(nextTyping)
    props.change([...nextChips, nextTyping.trim()].filter(Boolean).join(', '))
  }

  const commit = (): void => {
    if (typing.trim()) publish([...chips, ...splitRecipients(typing)], '')
    setHits([])
  }

  const edit = (text: string): void => {
    const parts = splitRecipients(text)
    const ended = splitRecipients(`${text}x`).length > parts.length // the separator wasn't in a name
    if (ended) publish([...chips, ...parts], '')
    else publish([...chips, ...parts.slice(0, -1)], parts.length > 1 ? parts.at(-1) ?? '' : text)
  }

  const accept = (who: Address): void => {
    publish([...chips, asRecipient(who)], '')
    setHits([])
    box.current?.focus()
  }

  return (
    <div className="field people" onClick={(e) => { if (e.target === e.currentTarget) box.current?.focus() }}>
      <span onClick={() => box.current?.focus()}>{props.label}</span>
      {chips.map((text, i) => (
        <Chip key={`${i}/${text}`} text={text} remove={() => publish(chips.filter((_, n) => n !== i), typing)}
          edit={() => { publish(chips.filter((_, n) => n !== i), text); box.current?.focus() }} />
      ))}
      <input ref={box} autoFocus={props.focus} autoComplete="off" spellCheck={false} aria-label={props.label} value={typing}
        onChange={(e) => edit(e.target.value)}
        onBlur={() => setTimeout(commit, 120)}
        onKeyDown={(e) => {
          const hit = hits[at]
          if (e.key === 'Backspace' && !typing && chips.length > 0) publish(chips.slice(0, -1), '')
          else if (hit && e.key === 'ArrowDown') { e.preventDefault(); setAt((at + 1) % hits.length) }
          else if (hit && e.key === 'ArrowUp') { e.preventDefault(); setAt((at - 1 + hits.length) % hits.length) }
          else if (hit && (e.key === 'Enter' || e.key === 'Tab')) { e.preventDefault(); accept(hit) }
          // The suggestions go, and the composer stays: it's the next Esc that closes it.
          else if (hit && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setHits([]) }
          else if (e.key === 'Enter' && typing.trim()) { e.preventDefault(); commit() }
          else if (e.key === ' ' && readRecipient(typing.trim()).valid) { e.preventDefault(); commit() }
        }} />
      {hits.length > 0 && (
        <ul className="hits" role="listbox">
          {hits.map((who, i) => (
            <li key={who.address} role="option" aria-selected={i === at} className={i === at ? 'on' : ''}
              onMouseDown={(e) => { e.preventDefault(); accept(who) }}>
              <Avatar name={who.name} address={who.address} size={26} />
              <span className="hit-words">
                <strong>{who.name || who.address}</strong>
                {who.name && <span className="muted">{who.address}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function Composer(props: {
  draft: Draft
  accounts: AccountView[]
  settings: Settings | null
  close(saved: boolean): void
  /** [archived] is the thread Send & Archive archived, and what undoes that. */
  sent(id: number, when: number, scheduled: boolean, archived?: { about: ThreadRef; undo: number }): void
  /** How it was asked for: Esc may have been pressed before it could open. */
  starting?: { off: boolean } | null
  /** It has a window to itself, and fills it. */
  solo?: boolean
  /** Carries the draft on in a window of its own, once what's typed is kept. */
  moveOut(id: number): void
  /** Filled in while it's open with what to do before its window closes. */
  leaving: { current: (() => Promise<void>) | null }
  /** Filled in while it's open with its own Close, for when another composer takes its place. */
  closing?: { current: { id: number; close(): Promise<void> } | null }
  /** Just started here, by Reply, Forward or a new message: closed as it started, it goes. */
  fresh?: boolean
  /** Thrown away with something in it, which Undo can bring back. */
  discarded?: (id: number) => void
}): ReactNode {
  const { draft } = props
  const [account, setAccount] = useState(draft.account)
  const [from, setFrom] = useState(draft.from)
  const [to, setTo] = useState(draft.to)
  const [cc, setCc] = useState(draft.cc)
  const [bcc, setBcc] = useState(draft.bcc)
  const [subject, setSubject] = useState(draft.subject)
  const [showCopies, setShowCopies] = useState(Boolean(draft.cc || draft.bcc))
  const [files, setFiles] = useState(draft.files)
  const [error, setError] = useState(draft.error ?? '')
  const [quoteOpen, setQuoteOpen] = useState(false)
  const [later, setLater] = useState(false)
  const [templates, setTemplates] = useState(false)
  const [signature, setSignature] = useState(draft.signature)
  const [signing, setSigning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [saved, setSaved] = useState(false)
  // Sanitised on the way in, because this copy is what gets sent. It's never put in this page: only
  // a frame shows it, which is why the editor below holds nothing but what's typed here.
  const [quote] = useState(() => cleanQuote(draft.quote))
  const editor = useRef<HTMLDivElement>(null)
  /** What the editor held when it opened. */
  const startText = useRef('')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const gone = useRef(false)
  const ownDrag = useRef(false)
  /** The draft's pictures the editor shows, by the data: address each is shown with. */
  const shown = useRef(new Map<string, string>())
  const filesNow = useRef(files)
  filesNow.current = files

  /** The editor's words, with each picture named by its Content-ID, as the draft keeps it. */
  const written = (): string => {
    const own = new Set(filesNow.current.flatMap((file) => (file.cid ? [file.cid] : [])))
    return ownMarkup(editor.current?.innerHTML ?? '', (src) => {
      const cid = src.startsWith('data:') ? shown.current.get(src) : src.startsWith('cid:') ? src.slice(4) : undefined
      return cid && own.has(cid) ? `cid:${cid}` : null
    })
  }

  const collect = useCallback((): DraftEdit => ({
    account, from, to, cc, bcc, subject, quote,
    html: written(),
    text: textOf(editor.current),
    signature
  }), [account, from, to, cc, bcc, subject, quote, signature])

  const latest = useRef(collect)
  latest.current = collect

  const save = useCallback(async (): Promise<void> => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    if (gone.current) return
    const edit = latest.current()
    await window.mail.saveDraft(draft.id, edit)
    setSaved(Boolean(edit.to || edit.subject || edit.text.trim()))
  }, [draft.id])

  const soon = useCallback((): void => {
    if (timer.current) clearTimeout(timer.current)
    setSaved(false)
    timer.current = setTimeout(() => void save(), SAVE_AFTER_MS)
  }, [save])

  useEffect(() => {
    const own = new Set(draft.files.flatMap((file) => (file.cid ? [`cid:${file.cid}`] : [])))
    if (editor.current) editor.current.innerHTML = ownMarkup(draft.html, (src) => (own.has(src) ? src : null))
    startText.current = textOf(editor.current)
    // The pictures come from the draft's own files, and are shown as data: addresses.
    for (const file of draft.files) {
      if (!file.cid || !editor.current?.querySelector('img')) continue
      const cid = file.cid
      void window.mail.draftPicture(draft.id, file.id).then((url) => {
        shown.current.set(url, cid)
        editor.current?.querySelectorAll('img').forEach((img) => { if (img.getAttribute('src') === `cid:${cid}`) img.setAttribute('src', url) })
      }, () => undefined)
    }
    if (!draft.to) return
    if (editor.current) {
      editor.current.focus()
      const range = document.createRange()
      range.selectNodeContents(editor.current)
      range.collapse(false)
      window.getSelection()?.removeAllRanges()
      window.getSelection()?.addRange(range)
    }
  }, [draft.id])

  useEffect(soon, [account, from, to, cc, bcc, subject, signature])

  // While it's open here, what the server says about the draft leaves it as it is.
  useEffect(() => {
    void window.mail.holdDraft(draft.id, true)
    return () => void window.mail.holdDraft(draft.id, false)
  }, [draft.id])

  useEffect(() => () => {
    if (timer.current) void save()
  }, [save])

  const isEmpty = (edit: DraftEdit): boolean =>
    !edit.to && !edit.cc && !edit.bcc && !edit.subject && !edit.text.trim() && files.length === 0 && !quote

  /** A reply or forward comes with a subject, someone to write to and what it quotes, so it isn't
   *  empty; but as it started, nothing was written and there's nothing to keep. */
  const untouched = (edit: DraftEdit): boolean =>
    Boolean(props.fresh) && edit.account === draft.account && edit.from === draft.from && edit.to === draft.to && edit.cc === draft.cc &&
    edit.bcc === draft.bcc && edit.subject === draft.subject && edit.text === startText.current && files.length === draft.files.length &&
    edit.signature === draft.signature

  // A window of its own can be closed around its composer. The app is asked first, and through this
  // it keeps what's typed, or takes away a draft with nothing in it, as closing the composer would.
  useEffect(() => {
    const keep = async (): Promise<void> => {
      if (gone.current) return
      if (!isEmpty(latest.current())) return save()
      gone.current = true
      await window.mail.discardDraft(draft.id)
    }
    props.leaving.current = keep
    return () => { if (props.leaving.current === keep) props.leaving.current = null }
  })

  const closeUp = async (): Promise<void> => {
    const edit = collect()
    if (isEmpty(edit) || untouched(edit)) {
      gone.current = true
      await window.mail.discardDraft(draft.id)
      return props.close(false)
    }
    await save()
    gone.current = true
    props.close(true)
  }

  useEffect(() => {
    const { closing } = props
    if (!closing) return undefined
    const mine = { id: draft.id, close: closeUp }
    closing.current = mine
    return () => { if (closing.current === mine) closing.current = null }
  })

  // An Esc pressed while this was on its way counts as pressed here.
  useLayoutEffect(() => {
    if (props.starting?.off) void closeUp()
  }, [])

  /** On to a window of its own. This one lets go without a word: nothing was closed or saved away. */
  const moveOut = async (): Promise<void> => {
    try {
      await save()
      gone.current = true
      props.moveOut(draft.id)
    } catch (e) {
      setError(problem(e))
    }
  }

  /** Thrown away with Undo, as other things are, unless there's nothing in it to want back. */
  const discard = async (): Promise<void> => {
    const edit = collect()
    const worth = !isEmpty(edit) && !untouched(edit)
    if (worth) await save() // what was typed just now is what Undo brings back
    gone.current = true
    await window.mail.discardDraft(draft.id, worth)
    props.close(false)
    if (worth) props.discarded?.(draft.id)
  }

  /** With [archive], it's Send & Archive: the thread it answers is archived as it goes. */
  const send = async (at?: number, archive = false): Promise<void> => {
    setBusy(true)
    setError('')
    setLater(false)
    try {
      await save()
      if (archive && draft.about) {
        const { when, undo } = await window.mail.sendAndArchive(draft.id)
        gone.current = true
        return props.sent(draft.id, when, false, { about: draft.about, undo })
      }
      const when = await window.mail.send(draft.id, at)
      gone.current = true
      props.sent(draft.id, when, at !== undefined)
    } catch (e) {
      setError(problem(e))
      setBusy(false)
    }
  }

  const useTemplate = (text: string): void => {
    setTemplates(false)
    editor.current?.focus()
    document.execCommand('insertText', false, text)
    soon()
  }

  /** Where the caret is in the words, if it's there. */
  const caret = (): Range | null => {
    const picked = window.getSelection()
    const range = picked && picked.rangeCount > 0 ? picked.getRangeAt(0) : null
    return range && editor.current?.contains(range.startContainer) ? range.cloneRange() : null
  }

  /** A picture goes into the words at [at], or at their end, as wide as the page it's read on at
   *  most. That's said on the picture itself, for whoever reads it, and so the editor has no rule of
   *  its own for it: Chromium drops a style a rule already gives. */
  const place = async (file: DraftFile, bytes: ArrayBuffer, at: Range | null): Promise<void> => {
    const url = await asDataUrl(new Blob([bytes], { type: file.type }))
    if (!file.cid || !editor.current) return
    shown.current.set(url, file.cid)
    editor.current.focus()
    const range = at ?? document.createRange()
    if (!at) {
      range.selectNodeContents(editor.current)
      range.collapse(false)
    }
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
    document.execCommand('insertHTML', false, `<img src="${url}" alt="${escapeAttribute(plainName(file.name))}" style="max-width:100%">`)
    soon()
  }

  /** Pictures of the kinds mail shows go in the words, where [at] says; anything else is attached. */
  const addFiles = async (list: File[], at: Range | null = null): Promise<void> => {
    try {
      let had = new Set(filesNow.current.map((file) => file.id))
      for (const file of list) {
        const bytes = await file.arrayBuffer()
        const inline = INLINE_PICTURES.includes(file.type)
        const next = await window.mail.addFile(draft.id, file.name, file.type || 'application/octet-stream', bytes, inline)
        setFiles(next.files)
        const added = next.files.find((f) => !had.has(f.id))
        had = new Set(next.files.map((f) => f.id))
        if (added?.cid) await place(added, bytes, at)
      }
    } catch (e) {
      setError(problem(e))
    }
  }

  const pick = async (): Promise<void> => {
    try {
      setFiles((await window.mail.pickFiles(draft.id)).files)
    } catch (e) {
      setError(problem(e))
      // Files picked before the one that was refused are on the draft, so they have to be listed.
      const kept = (await window.mail.drafts().catch(() => [])).find((d) => d.id === draft.id)
      if (kept) setFiles(kept.files)
    }
  }

  const drop = (event: DragEvent): void => {
    setDragging(false)
    if (event.dataTransfer.files.length === 0) return
    event.preventDefault()
    // A picture dropped on the words goes where it was dropped; anywhere else, where the caret was.
    const point = document.caretPositionFromPoint(event.clientX, event.clientY)
    let at = caret()
    if (point && editor.current?.contains(point.offsetNode)) {
      at = document.createRange()
      at.setStart(point.offsetNode, point.offset)
      at.collapse(true)
    }
    void addFiles([...event.dataTransfer.files], at)
  }

  const paste = (event: ClipboardEvent): void => {
    if (event.clipboardData.files.length > 0) {
      event.preventDefault()
      return void addFiles([...event.clipboardData.files], caret())
    }
    // As text: what's on the clipboard may well have come from a stranger's email.
    event.preventDefault()
    document.execCommand('insertText', false, event.clipboardData.getData('text/plain'))
  }

  /** As text too, where it's dropped, so a selection dragged out of a web page or a message can't
   *  bring its markup. Words dragged within the message stay put: the composer takes every drag for
   *  its files, which leaves Chromium's own drop, and with it moving them, off. */
  const dropText = (event: DragEvent): void => {
    if (event.dataTransfer.files.length > 0) return // the composer attaches them
    event.preventDefault()
    const text = event.dataTransfer.getData('text/plain')
    const at = document.caretPositionFromPoint(event.clientX, event.clientY)
    if (ownDrag.current || !text || !at || !editor.current?.contains(at.offsetNode)) return
    editor.current.focus()
    window.getSelection()?.setPosition(at.offsetNode, at.offset)
    document.execCommand('insertText', false, text)
  }

  // Only a reply or forward to a thread that's in the inbox has anything to archive.
  const archivable = Boolean(draft.archivable && draft.about)
  const keySet = props.settings?.keys ?? 'edison'
  const archiveKey = hintFor(keySet, props.settings?.keyChanges[keySet], 'sendArchive')
  const signatures = props.settings?.signatures ?? []
  // The one chosen for this message, or the one its From address has.
  const signedWith = !props.settings ? null : signature !== undefined ? signatures.find((s) => s.id === signature) ?? null : signatureFor(props.settings, account, from)
  const senders = props.accounts.flatMap((a) => [a.email, ...(props.settings?.identities[a.email]?.aliases ?? [])].map((address) => [a.email, address] as const))
  const templateList = props.settings?.templates ?? []

  return (
    <section className={props.solo ? 'composer solo' : 'composer'} aria-label="Compose" onDrop={drop}
      onDragOver={(e) => {
        e.preventDefault()
        if (e.dataTransfer.types.includes('Files')) setDragging(true)
      }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false) }}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void send() }
        else if (e.key === 'Escape') { e.preventDefault(); void closeUp() }
        else if (archivable && (e.ctrlKey || e.metaKey || e.altKey) && keysFor(keySet, props.settings?.keyChanges[keySet])[keyName(e)] === 'sendArchive') {
          e.preventDefault()
          void send(undefined, true)
        }
      }}>
      <header>
        <h2>{subject || (quote?.kind === 'reply' ? 'Reply' : 'New message')}</h2>
        {!props.solo && <IconButton icon={SquareArrowOutUpRight} label="Open in a window" click={() => void moveOut()} />}
        <IconButton icon={X} label="Close" click={() => void closeUp()} />
      </header>
      <div className="field-row">
        <Recipients label="To" focus={!draft.to} value={to} change={setTo} />
        {!showCopies && <button type="button" className="link" onClick={() => setShowCopies(true)}>Cc Bcc</button>}
      </div>
      {showCopies && <Recipients label="Cc" value={cc} change={setCc} />}
      {showCopies && <Recipients label="Bcc" value={bcc} change={setBcc} />}
      <label className="field">
        <span>From</span>
        <select aria-label="From" value={JSON.stringify([account, from || account])} disabled={senders.length < 2} onChange={(e) => {
          const [nextAccount = account, nextFrom = ''] = JSON.parse(e.target.value) as string[]
          setAccount(nextAccount)
          setFrom(nextFrom === nextAccount ? '' : nextFrom)
          // Another address signs with its own, whatever was picked for the one before.
          setSignature(undefined)
        }}>
          {senders.map(([owner, address]) => <option key={address} value={JSON.stringify([owner, address])}>{address}</option>)}
        </select>
      </label>
      <label className="field">
        <span>Subject</span>
        <input aria-label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
      </label>
      <div className="compose-scroll">
        <div ref={editor} className="editor" role="textbox" aria-multiline="true" aria-label="Message" contentEditable
          suppressContentEditableWarning onInput={soon} onPaste={paste} onDrop={dropText}
          onDragStart={() => (ownDrag.current = true)} onDragEnd={() => (ownDrag.current = false)} />
        {signedWith && <div className="signature muted" dangerouslySetInnerHTML={{ __html: `-- <br>${signatureMarkup(signedWith.html)}` }} />}
        {quote && (
          <div className="quote">
            <button type="button" className="quiet" aria-expanded={quoteOpen} onClick={() => setQuoteOpen(!quoteOpen)}>
              {quote.kind === 'reply' ? 'Quoted message' : 'Forwarded message'}
            </button>
            {quoteOpen && <MailBody text={quote.text} html={quote.html} keepQuoted onPeek={() => undefined} />}
          </div>
        )}
      </div>
      {files.some((file) => !file.cid) && (
        <ul className="attachments">
          {files.filter((file) => !file.cid).map((file) => (
            <li key={file.id}>
              <Paperclip size={14} aria-hidden="true" />
              <span className="file-name">{plainName(file.name)}</span> <span className="muted">{fileSize(file.size)}</span>
              <button type="button" className="icon small" aria-label={`Remove ${plainName(file.name)}`}
                onClick={() => void window.mail.removeFile(draft.id, file.id).then((next) => setFiles(next.files))}>
                <X size={13} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="error compose-error">{error}</p>}
      <FormatBar editor={editor} changed={soon} />
      <footer>
        <button type="button" className="send" disabled={busy} onClick={() => void send()}><SendHorizontal size={18} aria-hidden="true" /> Send</button>
        {archivable && <IconButton icon={Archive} label="Send & Archive" hint={archiveKey} click={() => { if (!busy) void send(undefined, true) }} />}
        <div className="anchor">
          <IconButton icon={Clock} label="Send later" click={() => setLater(!later)} />
          {later && <TimeMenu title="Send" up pick={(at) => void send(at)} close={() => setLater(false)} />}
        </div>
        <span className="tool-gap" />
        <IconButton icon={Paperclip} label="Attach files" click={() => void pick()} />
        {templateList.length > 0 && (
          <div className="anchor">
            <button type="button" className="quiet" onClick={() => setTemplates(!templates)}>Templates</button>
            {templates && (
              <Popover up close={() => setTemplates(false)}>
                {templateList.map((t) => (
                  <button type="button" key={t.name} className="menu-item" onClick={() => useTemplate(t.text)}>{t.name}</button>
                ))}
              </Popover>
            )}
          </div>
        )}
        {signatures.length > 0 && (
          <div className="anchor">
            <IconButton icon={Signature} label="Signature" on={signing} click={() => setSigning(!signing)} />
            {signing && (
              <Popover up close={() => setSigning(false)}>
                {[{ id: '', name: 'None' }, ...signatures].map((each) => (
                  <button type="button" key={each.id} className="menu-item" aria-pressed={(signedWith?.id ?? '') === each.id}
                    onClick={() => { setSigning(false); setSignature(each.id) }}>
                    <span className="grow">{each.name}</span>
                    {(signedWith?.id ?? '') === each.id && <Check size={15} aria-hidden="true" />}
                  </button>
                ))}
              </Popover>
            )}
          </div>
        )}
        <span className="grow" />
        {saved && <span className="muted note">Saved</span>}
        <IconButton icon={Trash2} label="Discard draft" click={() => void discard()} />
      </footer>
      {dragging && (
        <div className="drop-cover">
          <Upload size={22} aria-hidden="true" />
          Drop files to attach them
        </div>
      )}
    </section>
  )
}
