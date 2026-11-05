import { useEffect, useState, type ReactNode } from 'react'
import type { Address, MessageView } from '@shared/types'
import { fileSize, longTime } from './format'
import { MailBody } from './MailBody'

const nameOf = (who: Address): string => who.name || who.address || 'Unknown'

function Message(props: { message: MessageView; open: boolean; toggle(): void; onPeek(url: string | null): void }): ReactNode {
  const { message: m, open, toggle, onPeek } = props
  const others = [...m.to, ...m.cc]
  return (
    <article className={open ? 'message open' : 'message'}>
      <button className="message-head" onClick={toggle} aria-expanded={open}>
        <span className="who">
          <strong>{nameOf(m.from)}</strong>
          {open && m.from.name && <span className="muted"> {m.from.address}</span>}
        </span>
        <span className="muted when">{longTime(m.date)}</span>
      </button>
      {open && (
        <>
          {others.length > 0 && <div className="muted to">To {others.map(nameOf).join(', ')}</div>}
          <MailBody text={m.text} html={m.html} onPeek={onPeek} />
          {m.attachments.length > 0 && (
            <ul className="attachments">
              {m.attachments.map((file, i) => (
                <li key={i}>
                  {file.name} <span className="muted">{fileSize(file.size)}</span>
                </li>
              ))}
            </ul>
          )}
          {m.truncated && <p className="muted note">Too big to keep whole here.</p>}
        </>
      )}
    </article>
  )
}

export function Reader(props: { messages: MessageView[]; back(): void }): ReactNode {
  const { messages, back } = props
  const last = messages.at(-1)
  const [open, setOpen] = useState<Set<number>>(new Set())
  const [peek, setPeek] = useState<string | null>(null)

  useEffect(() => {
    setOpen(new Set(last ? [last.id] : []))
    setPeek(null)
    return () => void window.mail.allowRemoteImages(false)
  }, [last?.thread, last?.account])

  if (!last) return <main className="reader empty-reader" />

  const toggle = (id: number): void =>
    setOpen((now) => {
      const next = new Set(now)
      if (!next.delete(id)) next.add(id)
      return next
    })

  return (
    <main className="reader">
      <header className="reader-head">
        <button className="quiet back" onClick={back} aria-label="Back">←</button>
        <h1>{messages[0]?.subject || 'No subject'}</h1>
        <button className="quiet" onClick={() => void window.mail.openInGmail(last.account, last.thread)}>
          Reply in Gmail
        </button>
      </header>
      <div className="messages">
        {messages.map((m) => (
          <Message key={m.id} message={m} open={open.has(m.id)} toggle={() => toggle(m.id)} onPeek={setPeek} />
        ))}
      </div>
      {peek && <div className="peek">{peek}</div>}
    </main>
  )
}
