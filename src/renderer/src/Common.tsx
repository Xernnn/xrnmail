import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

const AVATAR_COLORS = ['#b4532a', '#2f6fb2', '#7a4fb5', '#0f8a7e', '#b03a6a', '#8a6a14', '#4a7c3a', '#5b5fc7', '#a34a4a', '#3b7a8c']

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

/** A face for a sender. Pictures would have to be fetched, which would say who writes to you, so
 *  it's made here from their name, and always comes out the same for the same address. */
export function Avatar(props: { name: string; address: string; size?: number; marker?: string }): ReactNode {
  const size = props.size ?? 36
  const style: CSSProperties = {
    width: size, height: size, fontSize: Math.round(size * 0.38),
    background: AVATAR_COLORS[hash(props.address.toLowerCase() || props.name) % AVATAR_COLORS.length]
  }
  return (
    <span className="avatar" style={style} aria-hidden="true">
      {initials(props.name, props.address)}
      {props.marker && <span className="avatar-mark" style={{ background: props.marker }} />}
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
