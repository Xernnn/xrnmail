import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { CalendarRange, File as FileIcon, FileArchive, FileAudio, FileImage, FileSpreadsheet, FileText, FileVideo, Presentation, type LucideIcon } from 'lucide-react'
import type { FileKind } from './format'
import { useFace } from './pictures'

/** The picture a file gets from its name, in the list and in the reader. */
export const KIND_ICONS: Record<FileKind, LucideIcon> = {
  image: FileImage, pdf: FileText, doc: FileText, sheet: FileSpreadsheet, slides: Presentation, archive: FileArchive,
  calendar: CalendarRange, audio: FileAudio, video: FileVideo, file: FileIcon
}

/** Mid tones that carry white letters, light or dark. */
const AVATAR_COLORS = ['#3a74d9', '#5b5bd6', '#8150c9', '#c0437a', '#d14a3d', '#c8651f', '#a87a12', '#2f8a4f', '#16878a', '#2b7fb0', '#5e6b80']

function hash(text: string): number {
  let value = 7
  for (const char of text) value = (value * 31 + (char.codePointAt(0) ?? 0)) % 9973
  return value
}

/** Two letters from a name, or one from an address or a company's single word. */
export function initials(name: string, address: string): string {
  const words = name.replace(/["'()[\]]/g, ' ').split(/\s+/).filter((word) => /\p{L}|\p{N}/u.test(word))
  const usable = words.length > 0 && !name.includes('@')
  const first = (word: string | undefined): string => [...(word ?? '')][0] ?? ''
  const letters = usable ? first(words[0]) + (words.length > 1 ? first(words.at(-1)) : '') : first(address)
  return letters.toLocaleUpperCase() || '?'
}

/** Gmail's importance marker: a small arrow-shaped tag, drawn in the page's own colours. With [label]
 *  it says what it is; without, it's beside words that do. */
export function ImportantMark(props: { size?: number; label?: string; className?: string }): ReactNode {
  const size = props.size ?? 13
  return (
    <svg className={props.className} width={size} height={size} viewBox="0 0 16 16" fill="currentColor"
      {...(props.label ? { role: 'img', 'aria-label': props.label } : { 'aria-hidden': true })}>
      <path d="M1.5 3.5h9.2a1 1 0 0 1 .8.4L14.5 8l-3 4.1a1 1 0 0 1-.8.4H1.5L4.7 8z" />
    </svg>
  )
}

/** A face for someone: their photo or their company's logo where the main process has one, or
 *  initials in a colour that's always the same for the same address. [lookUp] lets it be looked up,
 *  which only lists do; [plain] is initials whatever there is, for mail with a sender warning. */
export function Avatar(props: { name: string; address: string; size?: number; lookUp?: boolean; plain?: boolean }): ReactNode {
  const size = props.size ?? 40
  const face = useFace(props.plain ? '' : props.address, props.lookUp ?? false)
  const [broken, setBroken] = useState<string | null>(null)
  const shown = face && face.url !== broken ? face : null
  const style: CSSProperties = {
    width: size, height: size, fontSize: Math.round(size * 0.37),
    background: AVATAR_COLORS[hash(props.address.toLowerCase() || props.name) % AVATAR_COLORS.length]
  }
  if (shown) {
    // A BIMI logo is a square meant to fill a circle; a site's icon sits whole on white.
    const kind = !shown.logo ? 'photo' : shown.url.startsWith('data:image/svg+xml') ? 'logo mark' : 'logo icon'
    return (
      <span className={`avatar picture ${kind}`} style={{ width: size, height: size }} aria-hidden="true">
        <img src={shown.url} alt="" draggable={false} onError={() => setBroken(shown.url)} />
      </span>
    )
  }
  return (
    <span className="avatar" style={style} aria-hidden="true">
      {initials(props.name, props.address)}
    </span>
  )
}

export function Empty(props: { icon: LucideIcon; title: string; note?: string }): ReactNode {
  const Icon = props.icon
  return (
    <div className="empty">
      <span className="empty-mark"><Icon size={22} aria-hidden="true" /></span>
      <p className="empty-title">{props.title}</p>
      {props.note && <p className="muted note">{props.note}</p>}
    </div>
  )
}

export function Skeleton({ rows = 8 }: { rows?: number }): ReactNode {
  return (
    <div aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div className="skeleton-row" key={i}>
          <span className="skeleton-face" />
          <span className="skeleton-lines"><i /><i /><i /></span>
        </div>
      ))}
    </div>
  )
}

export interface Question {
  title: string
  note?: string
  action: string
  danger?: boolean
  answer(yes: boolean): void
}

/** The app's own "Are you sure", in place of the browser's. */
export function Confirm({ question }: { question: Question }): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => dialog.current?.showModal(), [])
  return (
    <dialog ref={dialog} className="confirm" onCancel={() => question.answer(false)}>
      <h2>{question.title}</h2>
      {question.note && <p className="muted">{question.note}</p>}
      <div className="confirm-end">
        <button className="quiet" onClick={() => question.answer(false)}>Cancel</button>
        <button className={question.danger ? 'primary danger-fill' : 'primary'} autoFocus onClick={() => question.answer(true)}>{question.action}</button>
      </div>
    </dialog>
  )
}

export interface MenuEntry {
  label: string
  icon?: LucideIcon
  danger?: boolean
  run(): void
}

/** The menu for something right-clicked, kept inside the window. */
export function ContextMenu(props: { x: number; y: number; items: (MenuEntry | 'gap')[]; close(): void }): ReactNode {
  const box = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState({ left: props.x, top: props.y })

  useLayoutEffect(() => {
    const rect = box.current?.getBoundingClientRect()
    if (!rect) return
    setPlace({
      left: Math.min(props.x, window.innerWidth - rect.width - 8),
      top: Math.min(props.y, window.innerHeight - rect.height - 8)
    })
  }, [props.x, props.y])

  useEffect(() => {
    const away = (event: MouseEvent): void => {
      if (!box.current?.contains(event.target as Node)) props.close()
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      props.close()
    }
    document.addEventListener('mousedown', away)
    window.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('mousedown', away)
      window.removeEventListener('keydown', escape, true)
    }
  }, [props.close])

  return (
    <div ref={box} className="context-menu" role="menu" style={place}>
      {props.items.map((item, i) => {
        if (item === 'gap') return <hr key={i} />
        const Icon = item.icon
        return (
          <button key={item.label} role="menuitem" className={item.danger ? 'menu-item danger' : 'menu-item'}
            onClick={() => { props.close(); item.run() }}>
            {Icon && <Icon size={15} aria-hidden="true" />} {item.label}
          </button>
        )
      })}
    </div>
  )
}
