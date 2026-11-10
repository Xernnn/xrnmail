import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { AccountView, BatchSettings, Identity, ProfilePatch, Settings, SwipeAction, Template } from '@shared/types'
import type { Question } from './Common'
import { problem } from './format'
import { AddAccount } from './Setup'

const KEEP_DAYS = [30, 90, 365, 1095]

type Ask = (asking: Omit<Question, 'answer'>) => Promise<boolean>

export type Tab = 'general' | 'accounts' | 'reading' | 'batches' | 'writing' | 'blocked' | 'keyboard' | 'hub' | 'about'

const TABS: [Tab, string][] = [
  ['general', 'General'], ['accounts', 'Accounts'], ['reading', 'Reading'], ['batches', 'Batches'],
  ['writing', 'Writing'], ['blocked', 'Blocked'], ['keyboard', 'Keyboard'], ['hub', 'xrnhub'], ['about', 'About']
]

/** What each page holds, for the search box. */
const TAB_WORDS: Record<Tab, string> = {
  general: 'look theme dark light layout density compact focused other tray background start login',
  accounts: 'add remove service keep laptop days',
  reading: 'pictures images swipe left right trackers',
  batches: 'delivery times straight through vip early',
  writing: 'name signature alias sends as colour color notifications undo send templates',
  blocked: 'senders block spam',
  keyboard: 'keys shortcuts',
  hub: 'connect counts',
  about: 'version'
}

export const SHORTCUTS: [string, string][] = [
  ['c', 'New message'], ['/', 'Search'], ['j / k', 'Next and previous'], ['Esc', 'Close'],
  ['r', 'Reply'], ['a', 'Reply all'], ['f', 'Forward'], ['e', 'Archive'], ['#', 'Delete'], ['!', 'Report spam'],
  ['s', 'Star'], ['Shift+U', 'Mark unread'], ['b', 'Snooze'], ['l', 'Labels'], ['x', 'Select'], ['Ctrl+A', 'Select all'],
  ['z', 'Undo'], ['Ctrl+Enter', 'Send'], ['F5', 'Check for mail'], ['?', 'These keys']
]

const SWIPE_NAMES: [SwipeAction, string][] = [
  ['archive', 'Archive'], ['trash', 'Delete'], ['read', 'Read or unread'], ['star', 'Star'], ['snooze', 'Snooze'], ['none', 'Nothing']
]

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

function Accounts(props: { accounts: AccountView[]; settings: Settings; saveKeep(days: number): void; ask: Ask }): ReactNode {
  const { accounts, settings, saveKeep, ask } = props
  const [adding, setAdding] = useState(false)
  return (
    <section>
      <h3>Accounts</h3>
      {accounts.map((a) => (
        <div className="line" key={a.id}>
          <span className="dot" style={{ background: a.color }} aria-hidden="true" />
          <span className="grow">{a.email} <span className="muted">{a.providerName}</span></span>
          <button className="quiet danger"
            onClick={() => void ask({ title: `Remove ${a.email} from this laptop?`, note: 'The mail stays on the server.', action: 'Remove', danger: true }).then((yes) => { if (yes) void window.mail.removeAccount(a.id) })}>
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

function Appearance(props: { settings: Settings; save(patch: ProfilePatch): void }): ReactNode {
  const { settings, save } = props
  return (
    <section>
      <h3>General</h3>
      <label className="inline">
        Look
        <select value={settings.theme} onChange={(e) => save({ theme: e.target.value as Settings['theme'] })}>
          <option value="system">Same as the system</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>
      <label className="inline">
        Layout
        <select value={settings.layout} onChange={(e) => save({ layout: e.target.value as Settings['layout'] })}>
          <option value="panes">List and message side by side</option>
          <option value="list">One thing at a time</option>
        </select>
      </label>
      <label className="inline">
        Density
        <select value={settings.density} onChange={(e) => save({ density: e.target.value as Settings['density'] })}>
          <option value="comfortable">Comfortable</option>
          <option value="compact">Compact</option>
        </select>
      </label>
      <label className="inline check">
        Split the inbox into Focused and Other
        <input type="checkbox" checked={settings.focused} onChange={(e) => save({ focused: e.target.checked })} />
      </label>
      <label className="inline check">
        Keep running in the tray when the window closes
        <input type="checkbox" checked={settings.background} onChange={(e) => save({ background: e.target.checked })} />
      </label>
      <label className="inline check">
        Start at login
        <input type="checkbox" checked={settings.startAtLogin} onChange={(e) => save({ startAtLogin: e.target.checked })} />
      </label>
    </section>
  )
}

function Reading(props: { settings: Settings; save(patch: ProfilePatch): void }): ReactNode {
  const { settings, save } = props
  const swipe = (label: string, value: SwipeAction, key: 'swipeLeft' | 'swipeRight'): ReactNode => (
    <label className="inline">
      {label}
      <select value={value} onChange={(e) => save({ [key]: e.target.value as SwipeAction })}>
        {SWIPE_NAMES.map(([action, name]) => <option key={action} value={action}>{name}</option>)}
      </select>
    </label>
  )
  return (
    <section>
      <h3>Reading</h3>
      <label className="inline">
        Pictures in mail
        <select value={settings.images} onChange={(e) => save({ images: e.target.value as Settings['images'] })}>
          <option value="ask">Ask first</option>
          <option value="always">Always show</option>
        </select>
      </label>
      {swipe('Swipe left', settings.swipeLeft, 'swipeLeft')}
      {swipe('Swipe right', settings.swipeRight, 'swipeRight')}
    </section>
  )
}

function About(): ReactNode {
  const [version, setVersion] = useState('')
  useEffect(() => {
    void window.mail.version().then(setVersion)
  }, [])
  return (
    <section>
      <h3>About</h3>
      <p>xrnmail {version}</p>
      <p className="muted note">All your mail accounts in one place, delivered in batches.</p>
    </section>
  )
}

function Writing(props: { accounts: AccountView[]; settings: Settings; save(patch: ProfilePatch): void }): ReactNode {
  const { accounts, settings, save } = props
  const [drafts, setDrafts] = useState<Record<string, Identity>>(settings.identities)
  const who = (email: string): Identity => drafts[email] ?? { name: '', signature: '', aliases: [], color: '', notify: true }
  const edit = (email: string, patch: Partial<Identity>): void => setDrafts({ ...drafts, [email]: { ...who(email), ...patch } })
  const set = (email: string, patch: Partial<Identity>): void => {
    const next = { ...drafts, [email]: { ...who(email), ...patch } }
    setDrafts(next)
    save({ identities: next })
  }
  return (
    <section>
      <h3>Writing</h3>
      {accounts.map((a) => (
        <div key={a.id} className="identity">
          {accounts.length > 1 && <div className="muted note">{a.email}</div>}
          <label>
            Your name
            <input value={who(a.email).name} onChange={(e) => edit(a.email, { name: e.target.value })}
              onBlur={() => save({ identities: drafts })} />
          </label>
          <label>
            Signature
            <textarea rows={2} value={who(a.email).signature} onChange={(e) => edit(a.email, { signature: e.target.value })}
              onBlur={() => save({ identities: drafts })} />
          </label>
          <label>
            Also sends as
            <input placeholder="other@example.com" value={who(a.email).aliases.join(', ')}
              onChange={(e) => edit(a.email, { aliases: e.target.value.split(/[\s,]+/) })}
              onBlur={() => set(a.email, { aliases: who(a.email).aliases.filter(Boolean) })} />
          </label>
          <label className="inline">
            Colour
            <input type="color" aria-label={`Colour for ${a.email}`} value={who(a.email).color || a.color}
              onChange={(e) => set(a.email, { color: e.target.value })} />
          </label>
          <label className="inline check">
            Tell me about new mail here
            <input type="checkbox" checked={who(a.email).notify} onChange={(e) => set(a.email, { notify: e.target.checked })} />
          </label>
        </div>
      ))}
      <label className="inline">
        Undo send for
        <select value={settings.undoSeconds} onChange={(e) => save({ undoSeconds: Number(e.target.value) })}>
          {[0, 5, 10, 20, 30].map((n) => <option key={n} value={n}>{n === 0 ? 'Off' : `${n} seconds`}</option>)}
        </select>
      </label>
    </section>
  )
}

function Blocked(props: { blocked: string[]; save(patch: ProfilePatch): void }): ReactNode {
  const [blocked, setBlocked] = useState(props.blocked.join('\n'))
  return (
    <section>
      <h3>Blocked senders</h3>
      <label>
        One address or @domain on each line. Their new mail goes straight to Trash.
        <textarea rows={8} placeholder="someone@example.com&#10;@example.com" value={blocked}
          onChange={(e) => setBlocked(e.target.value)} onBlur={() => props.save({ blocked: blocked.split(/\s+/).filter(Boolean) })} />
      </label>
    </section>
  )
}

function Templates(props: { templates: Template[]; save(templates: Template[]): void }): ReactNode {
  const { templates, save } = props
  const [name, setName] = useState('')
  const [text, setText] = useState('')
  return (
    <section>
      <h3>Templates</h3>
      {templates.map((t) => (
        <div className="line" key={t.name}>
          <span className="grow">{t.name}</span>
          <button className="quiet danger" onClick={() => save(templates.filter((x) => x !== t))}>Remove</button>
        </div>
      ))}
      <label>Name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label>Text<textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} /></label>
      <button className="quiet" disabled={!name.trim() || !text.trim()}
        onClick={() => {
          save([...templates.filter((t) => t.name !== name.trim()), { name: name.trim(), text }])
          setName('')
          setText('')
        }}>
        Add template
      </button>
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

export function SettingsDialog(props: { accounts: AccountView[]; close(): void; version: number; tab: Tab; ask: Ask }): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [tab, setTab] = useState<Tab>(props.tab)
  const [search, setSearch] = useState('')

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

  const saveProfile = async (patch: ProfilePatch): Promise<void> => {
    await window.mail.saveProfile(patch)
    setSettings(await window.mail.settings())
  }

  const save = (patch: ProfilePatch): void => void saveProfile(patch)
  const looking = search.trim().toLowerCase()
  const tabs = TABS.filter(([id, label]) => `${label} ${TAB_WORDS[id]}`.toLowerCase().includes(looking))
  const page = tabs.some(([id]) => id === tab) ? tab : tabs[0]?.[0] ?? tab

  return (
    <dialog ref={dialog} className="settings" onClose={props.close}>
      <header>
        <h2>Settings</h2>
        <button className="quiet" onClick={props.close}>Done</button>
      </header>
      <div className="settings-body">
        <nav className="settings-tabs" aria-label="Settings">
          <input type="search" placeholder="Search settings" aria-label="Search settings" value={search} onChange={(e) => setSearch(e.target.value)} />
          {tabs.map(([id, label]) => (
            <button key={id} className={page === id ? 'nav-item on' : 'nav-item'} onClick={() => setTab(id)}>{label}</button>
          ))}
        </nav>
        {settings && (
          <div className="settings-page">
            {page === 'general' && <Appearance settings={settings} save={save} />}
            {page === 'accounts' && <Accounts accounts={props.accounts} settings={settings} ask={props.ask} saveKeep={(d) => void saveKeep(d)} />}
            {page === 'reading' && <Reading settings={settings} save={save} />}
            {page === 'batches' && <Batches key={settings.batch.vip.join()} batch={settings.batch} save={(b) => void saveBatch(b)} />}
            {page === 'writing' && (
              <>
                <Writing accounts={props.accounts} settings={settings} save={save} />
                <Templates templates={settings.templates} save={(templates) => save({ templates })} />
              </>
            )}
            {page === 'blocked' && <Blocked key={settings.blocked.join()} blocked={settings.blocked} save={save} />}
            {page === 'keyboard' && (
              <section>
                <h3>Keyboard</h3>
                <dl className="keys">
                  {SHORTCUTS.map(([key, what]) => <div key={key}><dt><kbd>{key}</kbd></dt><dd>{what}</dd></div>)}
                </dl>
              </section>
            )}
            {page === 'hub' && <Hub settings={settings} />}
            {page === 'about' && <About />}
          </div>
        )}
      </div>
    </dialog>
  )
}
