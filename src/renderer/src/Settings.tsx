import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  AtSign, Ban, Bell, Clock, Info, Keyboard, LayoutTemplate, MousePointerClick, Palette, Server, Signature, SlidersHorizontal, type LucideIcon
} from 'lucide-react'
import { QUICK_SLOTS, type AccountView, type BatchSettings, type Identity, type ProfilePatch, type QuickAction, type Settings, type SwipeAction, type Template } from '@shared/types'
import type { Question } from './Common'
import { problem } from './format'
import { KEY_LISTS, KEY_SETS } from '@shared/keys'
import { AddAccount } from './Setup'

const KEEP_DAYS = [30, 90, 365, 1095]

type Ask = (asking: Omit<Question, 'answer'>) => Promise<boolean>

export type Tab =
  'general' | 'notifications' | 'accounts' | 'appearance' | 'actions' | 'shortcuts' | 'signatures' | 'templates' | 'blocked' | 'batches' | 'hub' | 'about'

/** Edison's sections in its order, then what only xrnmail has. */
const TABS: [Tab, string, LucideIcon][] = [
  ['general', 'General', SlidersHorizontal], ['notifications', 'Notifications', Bell], ['accounts', 'Accounts', AtSign],
  ['appearance', 'Appearance', Palette], ['actions', 'Customize Actions', MousePointerClick], ['shortcuts', 'Shortcuts', Keyboard],
  ['signatures', 'Signatures', Signature], ['templates', 'Templates', LayoutTemplate], ['blocked', 'Blocked Senders', Ban],
  ['batches', 'Batches', Clock], ['hub', 'xrnhub', Server], ['about', 'About', Info]
]

/** What each page holds, for the search box. */
const TAB_WORDS: Record<Tab, string> = {
  general: 'focused other inbox layout undo send pictures images tray background start login',
  notifications: 'new mail tell account',
  accounts: 'add remove service name alias sends as colour color keep laptop days',
  appearance: 'theme look dark light icons sidebar preview lines clock 24-hour time',
  actions: 'quick actions hover pointer swipe left right short long archive flag delete read snooze',
  shortcuts: 'keys keyboard set edison gmail',
  signatures: 'signature sign',
  templates: 'template ready text',
  blocked: 'senders block unblock trash',
  batches: 'delivery times straight through vip early',
  hub: 'connect counts',
  about: 'version'
}

const SWIPE_NAMES: [SwipeAction, string][] = [
  ['archive', 'Archive'], ['star', 'Flag'], ['trash', 'Delete'], ['read', 'Read or unread'], ['snooze', 'Snooze'], ['none', 'Nothing']
]

const QUICK_NAMES: [QuickAction, string][] = [
  ['archive', 'Archive'], ['flag', 'Flag'], ['trash', 'Delete'], ['read', 'Read or unread'], ['snooze', 'Snooze'], ['spam', 'Report spam'], ['none', 'Nothing']
]

type Save = (patch: ProfilePatch) => void

/** A tick box with its words after it, as Edison's settings have them. */
function Check(props: { label: string; on: boolean; set(on: boolean): void }): ReactNode {
  // Ticked at once: the saved settings come back a moment later, and say the same.
  const [on, setOn] = useState(props.on)
  useEffect(() => setOn(props.on), [props.on])
  return (
    <label className="check">
      <input type="checkbox" checked={on} onChange={(e) => { setOn(e.target.checked); props.set(e.target.checked) }} />
      <span>{props.label}</span>
    </label>
  )
}

/** A choice from a short list, its name at the left. */
function Choice<T extends string | number>(props: { label: string; value: T; options: [T, string][]; set(value: T): void }): ReactNode {
  const pick = (raw: string): void => {
    const found = props.options.find(([value]) => String(value) === raw)
    if (found) props.set(found[0])
  }
  return (
    <label className="inline">
      {props.label}
      <select value={props.value} onChange={(e) => pick(e.target.value)}>
        {props.options.map(([value, name]) => <option key={value} value={value}>{name}</option>)}
      </select>
    </label>
  )
}

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
      <h3>Delivery times</h3>
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

interface Identities {
  who(email: string): Identity
  edit(email: string, patch: Partial<Identity>): void
  set(email: string, patch: Partial<Identity>): void
  flush(): void
}

/** Each account's own name, signature and the rest, edited in place and saved when a field is left.
 *  One copy serves every page: a page opened while a save is still on its way would otherwise start
 *  from the settings as they were, and write the old name back with its own first save. */
function useIdentities(settings: Settings, save: Save): Identities {
  const [drafts, setDrafts] = useState<Record<string, Identity>>(settings.identities)
  const who = (email: string): Identity => drafts[email] ?? { name: '', signature: '', aliases: [], color: '', notify: true }
  return {
    who,
    edit: (email, patch) => setDrafts({ ...drafts, [email]: { ...who(email), ...patch } }),
    set: (email, patch) => {
      const next = { ...drafts, [email]: { ...who(email), ...patch } }
      setDrafts(next)
      save({ identities: next })
    },
    flush: () => save({ identities: drafts })
  }
}

function General(props: { settings: Settings; save: Save }): ReactNode {
  const { settings, save } = props
  return (
    <>
      <section>
        <h3>Inbox</h3>
        <Check label="Split the inbox into Focused and Other" on={settings.focused} set={(focused) => save({ focused })} />
        <Choice label="Layout" value={settings.layout} set={(layout) => save({ layout })}
          options={[['panes', 'List and message side by side'], ['list', 'One thing at a time']]} />
      </section>
      <section>
        <h3>Sending</h3>
        <Choice label="Undo send for" value={settings.undoSeconds} set={(undoSeconds) => save({ undoSeconds })}
          options={[0, 5, 10, 20, 30].map((n) => [n, n === 0 ? 'Off' : `${n} seconds`])} />
      </section>
      <section>
        <h3>Reading</h3>
        <Check label="Load the pictures in a message without asking" on={settings.images === 'always'} set={(on) => save({ images: on ? 'always' : 'ask' })} />
      </section>
      <section>
        <h3>This laptop</h3>
        <Check label="Keep running in the tray when the window closes" on={settings.background} set={(background) => save({ background })} />
        <Check label="Start at login" on={settings.startAtLogin} set={(startAtLogin) => save({ startAtLogin })} />
      </section>
    </>
  )
}

function Notifications(props: { accounts: AccountView[]; ids: Identities }): ReactNode {
  const { ids } = props
  return (
    <section>
      <h3>New mail</h3>
      {props.accounts.map((a) => (
        <Check key={a.id} label={`Tell me about new mail in ${a.email}`} on={ids.who(a.email).notify} set={(notify) => ids.set(a.email, { notify })} />
      ))}
      <p className="muted note">Mail held for a delivery is announced when it lands, not before.</p>
    </section>
  )
}

function Accounts(props: { accounts: AccountView[]; settings: Settings; ids: Identities; saveKeep(days: number): void; ask: Ask }): ReactNode {
  const { accounts, settings, saveKeep, ask, ids } = props
  const [adding, setAdding] = useState(false)
  return (
    <>
      <section>
        <h3>Your accounts</h3>
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
      </section>
      {accounts.map((a) => (
        <section key={a.id} className="identity">
          <h3>{accounts.length > 1 ? a.email : 'Who you write as'}</h3>
          <label>
            Your name
            <input value={ids.who(a.email).name} onChange={(e) => ids.edit(a.email, { name: e.target.value })} onBlur={ids.flush} />
          </label>
          <label>
            Also sends as
            <input placeholder="other@example.com" value={ids.who(a.email).aliases.join(', ')}
              onChange={(e) => ids.edit(a.email, { aliases: e.target.value.split(/[\s,]+/) })}
              onBlur={() => ids.set(a.email, { aliases: ids.who(a.email).aliases.filter(Boolean) })} />
          </label>
          <label className="inline">
            Colour
            <input type="color" aria-label={`Colour for ${a.email}`} value={ids.who(a.email).color || a.color}
              onChange={(e) => ids.set(a.email, { color: e.target.value })} />
          </label>
        </section>
      ))}
      <section>
        <h3>On this laptop</h3>
        <Choice label="Keep mail from the last" value={settings.backfillDays} set={saveKeep}
          options={[...new Set([...KEEP_DAYS, settings.backfillDays])].sort((a, b) => a - b)
            .map((n) => [n, n >= 365 ? `${Math.round(n / 365)} year${n >= 730 ? 's' : ''}` : `${n} days`])} />
      </section>
    </>
  )
}

function Appearance(props: { settings: Settings; save: Save }): ReactNode {
  const { settings, save } = props
  return (
    <>
      <section>
        <h3>Theme</h3>
        <Choice label="Theme" value={settings.theme} set={(theme) => save({ theme })}
          options={[['light', 'Light'], ['dark', 'Dark'], ['system', 'Same as the system']]} />
      </section>
      <section>
        <h3>Sidebar</h3>
        <Check label="Show icons in the sidebar" on={settings.sidebarIcons} set={(sidebarIcons) => save({ sidebarIcons })} />
      </section>
      <section>
        <h3>List</h3>
        <Choice label="Preview lines" value={settings.previewLines} set={(previewLines) => save({ previewLines })}
          options={[[0, 'None'], [1, '1'], [2, '2'], [3, '3'], [4, '4']]} />
        <Check label="Use the 24-hour clock" on={settings.clock24} set={(clock24) => save({ clock24 })} />
      </section>
    </>
  )
}

function Actions(props: { settings: Settings; save: Save }): ReactNode {
  const { settings, save } = props
  const quick = Array.from({ length: QUICK_SLOTS }, (_, i) => settings.quickActions[i] ?? 'none')
  return (
    <>
      <section>
        <h3>Quick actions</h3>
        <Check label="Show quick actions when the pointer is over a thread in the list" on={settings.quickOn} set={(quickOn) => save({ quickOn })} />
        {quick.map((action, i) => (
          <Choice key={i} label={`Action ${i + 1}`} value={action} options={QUICK_NAMES}
            set={(next) => save({ quickActions: quick.map((old, at) => (at === i ? next : old)) })} />
        ))}
      </section>
      <section>
        <h3>Swipe actions</h3>
        <Check label="Swipe a thread sideways to act on it" on={settings.swipes} set={(swipes) => save({ swipes })} />
        <Choice label="Swipe left, short" value={settings.swipeLeft} options={SWIPE_NAMES} set={(swipeLeft) => save({ swipeLeft })} />
        <Choice label="Swipe left, long" value={settings.swipeLeftLong} options={SWIPE_NAMES} set={(swipeLeftLong) => save({ swipeLeftLong })} />
        <Choice label="Swipe right, short" value={settings.swipeRight} options={SWIPE_NAMES} set={(swipeRight) => save({ swipeRight })} />
        <Choice label="Swipe right, long" value={settings.swipeRightLong} options={SWIPE_NAMES} set={(swipeRightLong) => save({ swipeRightLong })} />
      </section>
    </>
  )
}

function About(): ReactNode {
  const [version, setVersion] = useState('')
  useEffect(() => {
    void window.mail.version().then(setVersion)
  }, [])
  return (
    <section>
      <p>xrnmail {version}</p>
      <p className="muted note">All your mail accounts in one place, delivered in batches.</p>
    </section>
  )
}

function Signatures(props: { accounts: AccountView[]; ids: Identities }): ReactNode {
  const { ids } = props
  const many = props.accounts.length > 1
  return (
    <section>
      <h3>{many ? 'One for each account' : 'Under what you write'}</h3>
      {props.accounts.map((a) => (
        <label key={a.id}>
          {many ? `Signature for ${a.email}` : 'Signature'}
          <textarea rows={4} value={ids.who(a.email).signature} onChange={(e) => ids.edit(a.email, { signature: e.target.value })} onBlur={ids.flush} />
        </label>
      ))}
    </section>
  )
}

function Blocked(props: { blocked: string[]; save: Save }): ReactNode {
  const [adding, setAdding] = useState('')
  const add = (): void => {
    const who = adding.trim()
    if (!who) return
    props.save({ blocked: [...props.blocked, who] })
    setAdding('')
  }
  return (
    <section>
      <h3>Their new mail goes straight to Trash</h3>
      {props.blocked.length === 0 && <p className="muted note">Nobody is blocked.</p>}
      {props.blocked.map((who) => (
        <div className="line" key={who}>
          <span className="grow">{who}</span>
          <button className="quiet" aria-label={`Unblock ${who}`} onClick={() => props.save({ blocked: props.blocked.filter((b) => b !== who) })}>Unblock</button>
        </div>
      ))}
      <form className="line" onSubmit={(e) => { e.preventDefault(); add() }}>
        <input className="grow" aria-label="Sender to block" placeholder="someone@example.com or @example.com" value={adding} onChange={(e) => setAdding(e.target.value)} />
        <button type="submit" className="quiet" disabled={!adding.trim()}>Block</button>
      </form>
    </section>
  )
}

function Templates(props: { templates: Template[]; save(templates: Template[]): void }): ReactNode {
  const { templates, save } = props
  const [name, setName] = useState('')
  const [text, setText] = useState('')
  return (
    <section>
      <h3>Ready-made text for the composer</h3>
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
      <h3>Counts for your day's page</h3>
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

/** The page chosen at the left. */
function Pages(props: {
  page: Tab
  accounts: AccountView[]
  settings: Settings
  ask: Ask
  save: Save
  saveBatch(batch: BatchSettings): void
  saveKeep(days: number): void
}): ReactNode {
  const { page, accounts, settings, save } = props
  const ids = useIdentities(settings, save)
  return (
    <div className="settings-page">
      {page === 'general' && <General settings={settings} save={save} />}
      {page === 'notifications' && <Notifications accounts={accounts} ids={ids} />}
      {page === 'accounts' && <Accounts accounts={accounts} settings={settings} ids={ids} ask={props.ask} saveKeep={props.saveKeep} />}
      {page === 'appearance' && <Appearance settings={settings} save={save} />}
      {page === 'actions' && <Actions settings={settings} save={save} />}
      {page === 'shortcuts' && (
        <section>
          <Choice label="Shortcut set" value={settings.keys} options={KEY_SETS} set={(keys) => save({ keys })} />
          <dl className="keys">
            {KEY_LISTS[settings.keys].map(([key, what]) => <div key={key}><dt><kbd>{key}</kbd></dt><dd>{what}</dd></div>)}
          </dl>
        </section>
      )}
      {page === 'signatures' && <Signatures accounts={accounts} ids={ids} />}
      {page === 'templates' && <Templates templates={settings.templates} save={(templates) => save({ templates })} />}
      {page === 'blocked' && <Blocked blocked={settings.blocked} save={save} />}
      {page === 'batches' && <Batches key={settings.batch.vip.join()} batch={settings.batch} save={props.saveBatch} />}
      {page === 'hub' && <Hub settings={settings} />}
      {page === 'about' && <About />}
    </div>
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
  const title = TABS.find(([id]) => id === page)?.[1] ?? 'Settings'

  return (
    <dialog ref={dialog} className="settings" aria-label="Settings" onClose={props.close}>
      <nav className="settings-tabs" aria-label="Settings">
        {tabs.map(([id, label, Icon]) => (
          <button key={id} className={page === id ? 'nav-item on' : 'nav-item'} aria-current={page === id ? 'page' : undefined} onClick={() => setTab(id)}>
            <Icon className="nav-icon" size={16} aria-hidden="true" />
            <span className="grow">{label}</span>
          </button>
        ))}
      </nav>
      <div className="settings-main">
        <header>
          <h2>{title}</h2>
          <input type="search" placeholder="Search settings" aria-label="Search settings" value={search} onChange={(e) => setSearch(e.target.value)} />
          <button className="quiet" onClick={props.close}>Done</button>
        </header>
        {settings && (
          <Pages page={page} accounts={props.accounts} settings={settings} ask={props.ask} save={save}
            saveBatch={(b) => void saveBatch(b)} saveKeep={(d) => void saveKeep(d)} />
        )}
      </div>
    </dialog>
  )
}
