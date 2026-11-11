import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from 'react'
import { Bold, Clock, Italic, Link, List, Maximize2, Minimize2, Paperclip, Trash2, Underline, Upload, X } from 'lucide-react'
import { plainName } from '@shared/names'
import { chipLabel, readRecipient, splitRecipients } from '@shared/recipients'
import type { AccountView, Address, Draft, DraftEdit, Quote, Settings } from '@shared/types'
import { Avatar } from './Common'
import { fileSize, problem } from './format'
import { MailBody, sanitize } from './MailBody'
import { IconButton, Popover, TimeMenu } from './Menus'

const SAVE_AFTER_MS = 700

/** What's quoted came from a stranger, so it's cleaned on its way into the draft: this copy is what gets sent. */
export const cleanQuote = (quote: Quote | null): Quote | null =>
  quote ? { ...quote, html: quote.html ? sanitize(quote.html) : null } : null

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
  sent(id: number, when: number, scheduled: boolean): void
  /** How it was asked for: Esc may have been pressed before it could open. */
  starting?: { off: boolean } | null
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
  const [linking, setLinking] = useState<string | null>(null)
  const [templates, setTemplates] = useState(false)
  const [busy, setBusy] = useState(false)
  const [wide, setWide] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [saved, setSaved] = useState(false)
  // Sanitised on the way in, because this copy is what gets sent. It's never put in this page: only
  // a frame shows it, which is why the editor below holds nothing but what's typed here.
  const [quote] = useState(() => cleanQuote(draft.quote))
  const editor = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const gone = useRef(false)
  const selection = useRef<Range | null>(null)
  const ownDrag = useRef(false)

  const collect = useCallback((): DraftEdit => ({
    account, from, to, cc, bcc, subject, quote,
    html: sanitize(editor.current?.innerHTML ?? ''),
    text: editor.current?.innerText ?? ''
  }), [account, from, to, cc, bcc, subject, quote])

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
    if (editor.current) editor.current.innerHTML = sanitize(draft.html)
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

  useEffect(soon, [account, from, to, cc, bcc, subject])

  useEffect(() => () => {
    if (timer.current) void save()
  }, [save])

  const closeUp = async (): Promise<void> => {
    const edit = collect()
    const empty = !edit.to && !edit.cc && !edit.bcc && !edit.subject && !edit.text.trim() && files.length === 0 && !quote
    if (empty) {
      gone.current = true
      await window.mail.discardDraft(draft.id)
      return props.close(false)
    }
    await save()
    gone.current = true
    props.close(true)
  }

  // An Esc pressed while this was on its way counts as pressed here.
  useLayoutEffect(() => {
    if (props.starting?.off) void closeUp()
  }, [])

  const discard = async (): Promise<void> => {
    gone.current = true
    await window.mail.discardDraft(draft.id)
    props.close(false)
  }

  const send = async (at?: number): Promise<void> => {
    setBusy(true)
    setError('')
    setLater(false)
    try {
      await save()
      const when = await window.mail.send(draft.id, at)
      gone.current = true
      props.sent(draft.id, when, at !== undefined)
    } catch (e) {
      setError(problem(e))
      setBusy(false)
    }
  }

  const format = (command: string, value?: string): void => {
    editor.current?.focus()
    document.execCommand(command, false, value)
    soon()
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
    editor.current?.focus()
    if (range) {
      window.getSelection()?.removeAllRanges()
      window.getSelection()?.addRange(range)
    }
    if (range?.collapsed) document.execCommand('insertText', false, url)
    format('createLink', url)
  }

  const useTemplate = (text: string): void => {
    setTemplates(false)
    editor.current?.focus()
    document.execCommand('insertText', false, text)
    soon()
  }

  const addFiles = async (list: FileList): Promise<void> => {
    try {
      for (const file of list) {
        const next = await window.mail.addFile(draft.id, file.name, file.type || 'application/octet-stream', await file.arrayBuffer())
        setFiles(next.files)
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
    void addFiles(event.dataTransfer.files)
  }

  const paste = (event: ClipboardEvent): void => {
    if (event.clipboardData.files.length > 0) {
      event.preventDefault()
      return void addFiles(event.clipboardData.files)
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

  const signature = props.settings?.identities[account]?.signature.trim()
  const senders = props.accounts.flatMap((a) => [a.email, ...(props.settings?.identities[a.email]?.aliases ?? [])].map((address) => [a.email, address] as const))
  const templateList = props.settings?.templates ?? []

  return (
    <section className={wide ? 'composer wide' : 'composer'} aria-label="Compose" onDrop={drop}
      onDragOver={(e) => {
        e.preventDefault()
        if (e.dataTransfer.types.includes('Files')) setDragging(true)
      }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false) }}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void send() }
        else if (e.key === 'Escape') { e.preventDefault(); void closeUp() }
      }}>
      <header>
        <h2>{subject || (quote?.kind === 'reply' ? 'Reply' : 'New message')}</h2>
        <IconButton icon={wide ? Minimize2 : Maximize2} label={wide ? 'Smaller' : 'Full size'} click={() => setWide(!wide)} />
        <IconButton icon={X} label="Close" click={() => void closeUp()} />
      </header>
      {senders.length > 1 && (
        <label className="field">
          <span>From</span>
          <select aria-label="From" value={JSON.stringify([account, from || account])} onChange={(e) => {
            const [nextAccount = account, nextFrom = ''] = JSON.parse(e.target.value) as string[]
            setAccount(nextAccount)
            setFrom(nextFrom === nextAccount ? '' : nextFrom)
          }}>
            {senders.map(([owner, address]) => <option key={address} value={JSON.stringify([owner, address])}>{address}</option>)}
          </select>
        </label>
      )}
      <div className="field-row">
        <Recipients label="To" focus={!draft.to} value={to} change={setTo} />
        {!showCopies && <button type="button" className="link" onClick={() => setShowCopies(true)}>Cc Bcc</button>}
      </div>
      {showCopies && <Recipients label="Cc" value={cc} change={setCc} />}
      {showCopies && <Recipients label="Bcc" value={bcc} change={setBcc} />}
      <label className="field">
        <span>Subject</span>
        <input aria-label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
      </label>
      <div className="compose-scroll">
        <div ref={editor} className="editor" role="textbox" aria-multiline="true" aria-label="Message" contentEditable
          suppressContentEditableWarning onInput={soon} onPaste={paste} onDrop={dropText}
          onDragStart={() => (ownDrag.current = true)} onDragEnd={() => (ownDrag.current = false)} />
        {signature && <p className="signature muted">-- <br />{signature}</p>}
        {quote && (
          <div className="quote">
            <button type="button" className="quiet" aria-expanded={quoteOpen} onClick={() => setQuoteOpen(!quoteOpen)}>
              {quote.kind === 'reply' ? 'Quoted message' : 'Forwarded message'}
            </button>
            {quoteOpen && <MailBody text={quote.text} html={quote.html} keepQuoted onPeek={() => undefined} />}
          </div>
        )}
      </div>
      {files.length > 0 && (
        <ul className="attachments">
          {files.map((file) => (
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
      <footer>
        <button type="button" className="primary" disabled={busy} onClick={() => void send()}>Send</button>
        <div className="anchor">
          <IconButton icon={Clock} label="Send later" click={() => setLater(!later)} />
          {later && <TimeMenu title="Send" up pick={(at) => void send(at)} close={() => setLater(false)} />}
        </div>
        <span className="tool-gap" />
        <div className="format" onMouseDown={(e) => e.preventDefault()}>
          <IconButton icon={Bold} label="Bold" click={() => format('bold')} />
          <IconButton icon={Italic} label="Italic" click={() => format('italic')} />
          <IconButton icon={Underline} label="Underline" click={() => format('underline')} />
          <IconButton icon={List} label="List" click={() => format('insertUnorderedList')} />
          <IconButton icon={Link} label="Add link" click={startLink} />
        </div>
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
