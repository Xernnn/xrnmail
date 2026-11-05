import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { AccountView, BatchSettings, Settings } from '@shared/types'
import { problem } from './format'
import { AddAccount } from './Setup'

const KEEP_DAYS = [30, 90, 365, 1095]

function Batches(props: { batch: BatchSettings; save(batch: BatchSettings): void }): ReactNode {
  const { batch, save } = props
  const [time, setTime] = useState('')
  const [vip, setVip] = useState(batch.vip.join('\n'))

  const add = (): void => {
    if (!time) return
    save({ ...batch, times: [...batch.times, time] })
    setTime('')
  }

  return (
    <section>
      <h3>Batches</h3>
      <div className="chips">
        {batch.times.map((t) => (
          <button key={t} className="chip" aria-label={`Remove ${t}`}
            onClick={() => save({ ...batch, times: batch.times.filter((x) => x !== t) })}>
            {t} <span aria-hidden="true">×</span>
          </button>
        ))}
        <input type="time" aria-label="New time" value={time} onChange={(e) => setTime(e.target.value)} />
        <button className="quiet" onClick={add} disabled={!time}>Add</button>
      </div>
      {batch.times.length === 0 && <p className="muted note">No times: mail arrives as it comes.</p>}
      <label>
        Straight through
        <textarea rows={3} placeholder="boss@work.com&#10;@school.edu" value={vip}
          onChange={(e) => setVip(e.target.value)}
          onBlur={() => save({ ...batch, vip: vip.split(/\s+/).filter(Boolean) })} />
      </label>
      <label className="inline">
        Early deliveries a day
        <select value={batch.earlyPerDay} onChange={(e) => save({ ...batch, earlyPerDay: Number(e.target.value) })}>
          {[0, 1, 2, 3, 5].map((n) => <option key={n}>{n}</option>)}
        </select>
      </label>
    </section>
  )
}

function Accounts(props: { accounts: AccountView[]; settings: Settings; saveKeep(days: number): void }): ReactNode {
  const { accounts, settings, saveKeep } = props
  const [adding, setAdding] = useState(false)
  return (
    <section>
      <h3>Accounts</h3>
      {accounts.map((a) => (
        <div className="line" key={a.id}>
          <span className="grow">{a.email}</span>
          <button className="quiet danger"
            onClick={() => { if (confirm(`Remove ${a.email} from this laptop? Gmail keeps its mail.`)) void window.mail.removeAccount(a.id) }}>
            Remove
          </button>
        </div>
      ))}
      {adding ? <AddAccount done={() => setAdding(false)} /> : <button className="quiet" onClick={() => setAdding(true)}>Add account</button>}
      <label className="inline">
        Keep on this laptop
        <select value={settings.backfillDays} onChange={(e) => saveKeep(Number(e.target.value))}>
          {[...new Set([...KEEP_DAYS, settings.backfillDays])].sort((a, b) => a - b).map((n) => (
            <option key={n} value={n}>{n >= 365 ? `${Math.round(n / 365)} year${n >= 730 ? 's' : ''}` : `${n} days`}</option>
          ))}
        </select>
      </label>
    </section>
  )
}

function Hub(props: { settings: Settings }): ReactNode {
  const { hub } = props.settings
  const [url, setUrl] = useState('')
  const [user, setUser] = useState('')
  const [secret, setSecret] = useState('')
  const [error, setError] = useState('')

  const connect = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setError('')
    try {
      await window.mail.connectHub(url, user, secret)
      setSecret('')
    } catch (e) {
      setError(problem(e))
    }
  }

  return (
    <section>
      <h3>xrnhub</h3>
      {hub.connected ? (
        <div className="line">
          <span className="grow">{hub.url}</span>
          <button className="quiet danger" onClick={() => void window.mail.disconnectHub()}>Disconnect</button>
        </div>
      ) : (
        <form className="add-account" onSubmit={(e) => void connect(e)}>
          <label>Address<input type="url" placeholder="https://…/xrnhub" required value={url} onChange={(e) => setUrl(e.target.value)} /></label>
          <label>Name<input autoComplete="off" required value={user} onChange={(e) => setUser(e.target.value)} /></label>
          <label>Password<input type="password" autoComplete="off" required value={secret} onChange={(e) => setSecret(e.target.value)} /></label>
          {error && <p className="error">{error}</p>}
          <div className="row-end"><span className="muted note">Sends counts only.</span><button type="submit" className="primary">Connect</button></div>
        </form>
      )}
    </section>
  )
}

export function SettingsDialog(props: { accounts: AccountView[]; close(): void; version: number }): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null)
  const [settings, setSettings] = useState<Settings | null>(null)

  useEffect(() => {
    void window.mail.settings().then(setSettings)
  }, [props.version])

  useEffect(() => {
    dialog.current?.showModal()
  }, [])

  const saveBatch = async (batch: BatchSettings): Promise<void> => {
    await window.mail.saveBatch(batch)
    setSettings(await window.mail.settings())
  }

  const saveKeep = async (days: number): Promise<void> => {
    await window.mail.saveBackfill(days)
    setSettings(await window.mail.settings())
  }

  return (
    <dialog ref={dialog} className="settings" onClose={props.close}>
      <header>
        <h2>Settings</h2>
        <button className="quiet" onClick={props.close}>Done</button>
      </header>
      {settings && (
        <>
          <Batches key={settings.batch.vip.join()} batch={settings.batch} save={(b) => void saveBatch(b)} />
          <Accounts accounts={props.accounts} settings={settings} saveKeep={(d) => void saveKeep(d)} />
          <Hub settings={settings} />
        </>
      )}
    </dialog>
  )
}
