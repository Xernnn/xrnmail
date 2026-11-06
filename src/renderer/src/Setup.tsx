import { useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Mail } from 'lucide-react'
import { PROVIDERS, provider, providerFor, type Security, type Server } from '@shared/providers'
import { problem } from './format'
import icon from './icon.svg'

const REGISTER_APP = 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade'

/** Plain letters on a colour rather than anyone's logo. */
const TILES: Record<string, string> = {
  gmail: '#d0392b', outlook: '#2f6fb2', yahoo: '#6b3fa0', icloud: '#3b82c4', aol: '#44474d', fastmail: '#1f5fbf', zoho: '#b8741a', other: '#6b6b73'
}

function ServiceTiles(props: { chosen: string; pick(id: string): void }): ReactNode {
  return (
    <div className="tiles" role="radiogroup" aria-label="Service">
      {PROVIDERS.map((p) => (
        <label key={p.id} className={props.chosen === p.id ? 'tile on' : 'tile'}>
          <input type="radio" name="service" checked={props.chosen === p.id} readOnly onClick={() => props.pick(p.id)} />
          <span className="tile-mark" style={{ background: TILES[p.id] }} aria-hidden="true">
            {p.id === 'other' ? <Mail size={15} /> : p.name[0]}
          </span>
          {p.name}
        </label>
      ))}
    </div>
  )
}

function ServerFields(props: { title: string; value: Server; change(server: Server): void }): ReactNode {
  const { title, value, change } = props
  return (
    <fieldset>
      <legend>{title}</legend>
      <label>
        Server
        <input aria-label={`${title} server`} autoComplete="off" spellCheck={false} required value={value.host}
          onChange={(e) => change({ ...value, host: e.target.value.trim() })} />
      </label>
      <div className="two">
        <label>
          Port
          <input aria-label={`${title} port`} type="number" min={1} max={65535} required value={value.port}
            onChange={(e) => change({ ...value, port: Number(e.target.value) })} />
        </label>
        <label>
          Security
          <select aria-label={`${title} security`} value={value.security} onChange={(e) => change({ ...value, security: e.target.value as Security })}>
            <option value="tls">TLS</option>
            <option value="starttls">STARTTLS</option>
          </select>
        </label>
      </div>
    </fieldset>
  )
}

export function AddAccount(props: { done?(): void }): ReactNode {
  const [email, setEmail] = useState('')
  const [chosen, setChosen] = useState('gmail')
  const picked = useRef(false) // what someone chose isn't second-guessed, even by a lookup under way
  const [secret, setSecret] = useState('')
  const [user, setUser] = useState('')
  const [imap, setImap] = useState<Server>({ host: '', port: 993, security: 'tls' })
  const [smtp, setSmtp] = useState<Server>({ host: '', port: 465, security: 'tls' })
  const [clientId, setClientId] = useState('')
  const [code, setCode] = useState<{ code: string; url: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const service = provider(chosen)
  const custom = chosen === 'other'
  const microsoft = service.signIn === 'microsoft'

  /** Fills in what it can from the address, which is only ever a suggestion. */
  const look = async (): Promise<void> => {
    if (picked.current || !email.includes('@')) return
    setChosen(providerFor(email).id)
    const found = await window.mail.detectProvider(email)
    if (picked.current) return
    setChosen(found.provider)
    if (found.imap) setImap(found.imap)
    if (found.smtp) setSmtp(found.smtp)
  }

  const finished = (): void => {
    setEmail('')
    setSecret('')
    setCode(null)
    props.done?.()
  }

  const signInWithMicrosoft = async (): Promise<void> => {
    setCode(await window.mail.startMicrosoft(email, clientId))
    await window.mail.finishMicrosoft()
    finished()
  }

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      if (microsoft) await signInWithMicrosoft()
      else {
        await window.mail.addAccount({ email, secret, provider: chosen, ...(custom ? { imap, smtp, user: user || undefined } : {}) })
        finished()
      }
    } catch (e) {
      setCode(null)
      setError(problem(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="add-account" onSubmit={(e) => void submit(e)}>
      <ServiceTiles chosen={chosen} pick={(id) => { picked.current = true; setChosen(id) }} />
      <label>
        Email address
        <input type="email" autoComplete="off" required value={email} onChange={(e) => setEmail(e.target.value)} onBlur={() => void look()} />
      </label>
      {microsoft ? (
        <>
          <label>
            Application ID
            <input autoComplete="off" spellCheck={false} required placeholder="00000000-0000-0000-0000-000000000000" value={clientId}
              onChange={(e) => setClientId(e.target.value)} />
          </label>
          <p className="muted note">
            Microsoft only lets a registered app in, and yours is free: register one for "personal and work accounts", turn on
            public client flows, and copy its Application ID here. Your password stays with Microsoft.
          </p>
          {code && (
            <p className="device-code">
              Enter <strong>{code.code}</strong> on the Microsoft page that just opened.
            </p>
          )}
        </>
      ) : (
        <label>
          {service.help ? 'App password' : 'Password'}
          <input type="password" autoComplete="off" required value={secret} onChange={(e) => setSecret(e.target.value)} />
        </label>
      )}
      {custom && (
        <>
          <label>
            Sign-in name, if it isn't your address
            <input autoComplete="off" spellCheck={false} value={user} onChange={(e) => setUser(e.target.value)} />
          </label>
          <ServerFields title="Incoming" value={imap} change={setImap} />
          <ServerFields title="Outgoing" value={smtp} change={setSmtp} />
        </>
      )}
      {error && <p className="error">{error}</p>}
      <div className="row-end">
        {service.help && (
          <button type="button" className="link" onClick={() => void window.mail.openLink(service.help ?? '')}>
            Get an app password
          </button>
        )}
        {microsoft && (
          <button type="button" className="link" onClick={() => void window.mail.openLink(REGISTER_APP)}>
            Register an app
          </button>
        )}
        <span className="grow" />
        <button type="submit" className="primary" disabled={busy}>
          {busy ? (code ? 'Waiting' : 'Checking') : microsoft ? 'Sign in' : 'Add'}
        </button>
      </div>
    </form>
  )
}

export function Welcome(): ReactNode {
  return (
    <div className="welcome">
      <div className="welcome-card">
        <img src={icon} alt="" width={64} height={64} />
        <h1>Welcome to xrnmail</h1>
        <p className="muted">Add your first account. You can add the others in Settings at any time.</p>
        <AddAccount />
      </div>
    </div>
  )
}
