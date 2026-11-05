import { useState, type FormEvent, type ReactNode } from 'react'
import { problem } from './format'
import icon from './icon.svg'

const APP_PASSWORDS = 'https://myaccount.google.com/apppasswords'

export function AddAccount(props: { done?(): void }): ReactNode {
  const [email, setEmail] = useState('')
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await window.mail.addAccount(email, secret)
      setEmail('')
      setSecret('')
      props.done?.()
    } catch (e) {
      setError(problem(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="add-account" onSubmit={(e) => void submit(e)}>
      <label>
        Gmail
        <input type="email" autoComplete="off" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label>
        App password
        <input type="password" autoComplete="off" required value={secret} onChange={(e) => setSecret(e.target.value)} />
      </label>
      {error && <p className="error">{error}</p>}
      <div className="row-end">
        <button type="button" className="link" onClick={() => void window.mail.openLink(APP_PASSWORDS)}>
          Get an app password
        </button>
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Checking' : 'Add'}
        </button>
      </div>
    </form>
  )
}

export function Welcome(): ReactNode {
  return (
    <div className="welcome">
      <img src={icon} alt="" width={72} height={72} />
      <h1>xrnmail</h1>
      <AddAccount />
    </div>
  )
}
