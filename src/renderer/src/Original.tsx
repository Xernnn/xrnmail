import { useEffect, useRef, useState, type ReactNode } from 'react'
import { fileSize, problem } from './format'

/**
 * View original: a message as the server has it, headers and every part, fetched when asked for
 * (it isn't kept here). It's a stranger's text, so it's only ever text in a <pre>, and Save as .eml
 * writes the bytes as they came. The app's keys wait while it's open.
 */
export function Original(props: { message: number; subject: string; close(): void }): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null)
  const [found, setFound] = useState<{ text: string; size: number; cut: boolean } | null>(null)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  useEffect(() => dialog.current?.showModal(), [])
  useEffect(() => {
    let current = true
    window.mail.original(props.message).then((source) => { if (current) setFound(source) }, (e: unknown) => { if (current) setError(problem(e)) })
    return () => { current = false }
  }, [props.message])

  const save = (): void => {
    setError('')
    window.mail.saveOriginal(props.message).then(setSaved, (e: unknown) => setError(problem(e)))
  }

  const title = `Original: ${props.subject || 'No subject'}`
  return (
    <dialog ref={dialog} className="sheet original" aria-label={title} onClose={props.close} onKeyDown={(e) => e.stopPropagation()}>
      <header>
        <h2 className="original-title">{title}</h2>
        <span className="grow" />
        {saved ? <span className="muted note">Saved</span> : found && <span className="muted note">{fileSize(found.size)}</span>}
        <button className="quiet" disabled={!found} onClick={save}>Save as .eml</button>
        <button className="quiet" onClick={() => dialog.current?.close()}>Done</button>
      </header>
      {error && <p className="error original-note">{error}</p>}
      {!found ? !error && <p className="muted original-note">Fetching it from the server…</p>
        : (
          <>
            <pre className="original-text">{found.text}</pre>
            {found.cut && <p className="muted note original-note">This is the start of it. Save as .eml keeps it whole.</p>}
          </>
        )}
    </dialog>
  )
}
