import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { AccountView } from '@shared/types'
import { problem } from './format'

/** What an account files mail under: a Gmail account's labels, any other's folders. */
export const kindOf = (account: AccountView | undefined): 'label' | 'folder' => (account?.labels ? 'label' : 'folder')

/** Edison's New Label… and New Folder…, from Edit Menu: which account it belongs to, and its name. A
 *  slash in the name puts it inside the one before. It's made on the server there and then. */
export function NewFolderDialog(props: { accounts: AccountView[]; account: string; done(made: { path: string; kind: 'label' | 'folder' } | null): void }): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null)
  const [account, setAccount] = useState(props.account)
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [making, setMaking] = useState(false)
  useEffect(() => dialog.current?.showModal(), [])
  const chosen = props.accounts.find((a) => a.email === account)
  const kind = kindOf(chosen)
  const title = kind === 'label' ? 'New Label' : 'New Folder'

  const create = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setError('')
    setMaking(true)
    try {
      const path = await window.mail.createFolder(account, name)
      props.done({ path, kind })
    } catch (e) {
      setError(problem(e))
      setMaking(false)
    }
  }

  return (
    <dialog ref={dialog} className="confirm new-folder" aria-label={title} onCancel={(e) => { e.preventDefault(); props.done(null) }}>
      <form onSubmit={(e) => void create(e)}>
        <h2>{title}</h2>
        {props.accounts.length > 1 && (
          <label>
            <span className="muted">Where does this {kind} belong?</span>
            <select value={account} onChange={(e) => setAccount(e.target.value)}>
              {props.accounts.map((a) => <option key={a.email} value={a.email}>{a.email}</option>)}
            </select>
          </label>
        )}
        <label>
          <span className="muted">Name</span>
          <input autoFocus required value={name} maxLength={200} placeholder="Receipts, or Work/Plans"
            onChange={(e) => setName(e.target.value)} />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="confirm-end">
          <button type="button" className="quiet" onClick={() => props.done(null)}>Cancel</button>
          <button type="submit" className="primary" disabled={making || !name.trim()}>{making ? 'Making it…' : 'Create New'}</button>
        </div>
      </form>
    </dialog>
  )
}
