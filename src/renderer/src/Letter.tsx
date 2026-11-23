import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { FileWarning } from 'lucide-react'
import { keyName, keysFor } from '@shared/keys'
import type { AccountView, MessageView, Settings } from '@shared/types'
import { Confirm, Empty, type Question } from './Common'
import { problem, setClock24 } from './format'
import { Reader, type Panel, type ReplyKind } from './Reader'

/**
 * A message opened from a .eml file, in a window of its own: the reader, read-only, behind the same
 * walls as mail, with nothing to archive, flag or move, since it's in no mailbox. Reply and Forward
 * start a composer of its own from an account, when there is one.
 */
export function Letter({ token }: { token: string }): ReactNode {
  const [message, setMessage] = useState<MessageView | null>(null)
  const [failed, setFailed] = useState('')
  const [accounts, setAccounts] = useState<AccountView[]>([])
  const [settings, setSettings] = useState<Settings | null>(null)
  const [panel, setPanel] = useState<Panel>(null)
  const [toast, setToast] = useState('')
  const [question, setQuestion] = useState<Question | null>(null)
  const [findAsked, setFindAsked] = useState(0)
  const [version, setVersion] = useState(0)

  const say = useCallback((text: string) => setToast(text), [])
  useEffect(() => {
    window.mail.letter(token).then(setMessage, (e: unknown) => setFailed(problem(e)))
  }, [])
  useEffect(() => window.mail.onChanged(() => setVersion((n) => n + 1)), [])
  useEffect(() => {
    void window.mail.accounts().then(setAccounts)
    void window.mail.settings().then(setSettings)
  }, [version])
  useEffect(() => window.mail.onLeaving(() => window.close()), [])
  useEffect(() => window.mail.onCommand((command) => { if (command === 'print') window.print() }), [])
  useEffect(() => {
    document.documentElement.dataset['theme'] = settings?.theme ?? 'system'
  }, [settings?.theme])
  useEffect(() => {
    document.title = message ? message.subject || 'No subject' : 'xrnmail'
  }, [message])
  useEffect(() => {
    if (!toast) return undefined
    const timer = setTimeout(() => setToast(''), 5000)
    return () => clearTimeout(timer)
  }, [toast])
  setClock24(settings?.clock24 ?? true)

  const replies = accounts.length > 0
  const reply = (kind: ReplyKind): void => {
    if (replies) window.mail.replyToLetter(token, kind).catch((e: unknown) => say(problem(e)))
  }

  // The keys of the set in use that mean something here: finding, and answering.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const element = event.target as HTMLElement
      if (element.matches?.('input, textarea, select') || element.isContentEditable || question) return
      const set = settings?.keys ?? 'edison'
      const command = keysFor(set, settings?.keyChanges[set])[keyName(event)]
      if (command === 'find') setFindAsked((n) => n + 1)
      else if (command === 'reply' || command === 'replyAll' || command === 'forward') reply(command)
      else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const own = useMemo(() => accounts.flatMap((a) => [a.email, ...(settings?.identities[a.email]?.aliases ?? [])]).map((a) => a.toLowerCase()), [accounts, settings])

  if (failed) {
    return (
      <div className="app solo solo-file">
        <main className="reader reader-empty" role="alert">
          <Empty icon={FileWarning} title="Couldn't open this file" note={failed} />
          <button type="button" className="pill" onClick={() => window.close()}>Close</button>
        </main>
      </div>
    )
  }
  if (!message) return null

  const ask = (title: string, action: string, run: () => Promise<unknown>, done: string): void => setQuestion({
    title, action, danger: true,
    answer: (yes) => {
      setQuestion(null)
      if (yes) run().then(() => say(done), (e: unknown) => say(problem(e)))
    }
  })
  const edit = (list: 'muted', address: string, on: boolean, done: string): void => {
    window.mail.editSenders(list, [address], on).then(() => say(done), (e: unknown) => say(problem(e)))
  }

  return (
    <div className="app solo solo-file">
      <Reader messages={[message]} account={undefined} labels={[]} bins={false} panel={panel} setPanel={setPanel} own={own} settings={settings}
        unread={0} held={0} vip={null} many={false} file={{ replies }} findAsked={findAsked}
        back={() => window.close()} act={() => undefined} snooze={() => undefined} remind={() => undefined} unremind={() => undefined} reply={(kind) => reply(kind)}
        unsubscribe={() => undefined} rsvp={() => undefined} setFocus={() => undefined} trust={() => undefined}
        straight={() => undefined} forever={() => undefined} pin={() => undefined} summarize={() => undefined}
        block={(address) => ask(`Block ${address}?`, 'Block', () => window.mail.block(address), `Blocked ${address}`)}
        mute={(address, on) => edit('muted', address, on, on ? `Mail from ${address} won't be announced` : `Mail from ${address} is announced again`)}
        write={(address) => {
          if (!replies) return
          window.mail.startDraft({ kind: 'new', to: address }).then((draft) => window.mail.openDraftWindow(draft.id)).catch((e: unknown) => say(problem(e)))
        }}
        say={say} />
      {toast && <div className="toast" role="status"><span>{toast}</span></div>}
      {question && <Confirm question={question} />}
    </div>
  )
}
