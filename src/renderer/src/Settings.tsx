import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  AtSign, Ban, Bell, Clock, Info, Keyboard, LayoutTemplate, MousePointerClick, Newspaper, Palette, Server, Signature, SlidersHorizontal, type LucideIcon
} from 'lucide-react'
import {
  QUICK_SLOTS, type AccountView, type Identity, type ProfilePatch, type QuickAction, type SenderList, type Settings, type SummarySettings, type SwipeAction, type Template
} from '@shared/types'
import { SettingsKeeper, type SettingsChange } from '@shared/keeper'
import type { Question } from './Common'
import { clock, problem } from './format'
import type { LaterTimes } from '@shared/later'
import {
  COMMANDS, FIXED, holder, KEY_SETS, keyName, keysOf, rebound, reset, spell, unbindable, type KeyChanges, type KeyCommand, type KeySet
} from '@shared/keys'
import { forgetFaces } from './pictures'
import { AddAccount } from './Setup'
import { AccountFace } from './Sidebar'
import { SummarySchedule } from './Summary'

const KEEP_DAYS = [30, 90, 365, 1095]

type Ask = (asking: Omit<Question, 'answer'>) => Promise<boolean>

export type Tab =
  'general' | 'notifications' | 'accounts' | 'appearance' | 'actions' | 'shortcuts' | 'signatures' | 'templates' | 'summary' | 'blocked' | 'batches' | 'hub' | 'about'

/** Edison's sections in its order, then what only xrnmail has. */
const TABS: [Tab, string, LucideIcon][] = [
  ['general', 'General', SlidersHorizontal], ['notifications', 'Notifications', Bell], ['accounts', 'Accounts', AtSign],
  ['appearance', 'Appearance', Palette], ['actions', 'Customize Actions', MousePointerClick], ['shortcuts', 'Shortcuts', Keyboard],
  ['signatures', 'Signatures', Signature], ['templates', 'Templates', LayoutTemplate], ['summary', 'Summary', Newspaper], ['blocked', 'Blocked Senders', Ban],
  ['batches', 'Batches', Clock], ['hub', 'xrnhub', Server], ['about', 'About', Info]
]

/** What each page holds, for the search box. */
const TAB_WORDS: Record<Tab, string> = {
  general: 'focused other inbox layout archived deleted next previous back list undo send default reply all mark read seen snooze send later today evening tomorrow weekend next week pictures images tray background start login',
  notifications: 'new mail tell account focused other only mute muted senders unmute quiet',
  accounts: 'add remove service name alias sends as colour color keep laptop days photo picture avatar gravatar face',
  appearance: 'theme look dark light darken mail colours colors white page icons sidebar edit menu entries order hide show preview lines attachment cards files clock 24-hour time',
  actions: 'quick actions hover pointer swipe left right short long archive flag delete read snooze',
  shortcuts: 'keys keyboard set edison gmail apple mail outlook inbox change press reset',
  signatures: 'signature sign',
  templates: 'template ready text',
  summary: 'subscription summary digest newsletters daily weekly schedule time turn off',
  blocked: 'senders block unblock trash',
  batches: 'new mail as it arrives live real time instantly push idle in batches delivery times straight through vip early deliver now',
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
/** A change worked out from the settings with every change before it in them, never from what a
 *  page was last drawn with: two made in quick succession would otherwise both start from the same
 *  old settings, and the second would undo the first. */
type Change = (make: (now: Settings) => SettingsChange | null) => void
/** Senders into one of the lists of them, or out of it. */
type Senders = (list: SenderList, address: string, on: boolean) => void

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

/** A key being chosen for a command: waiting for the press, or holding one that another command has. */
type Choosing = { command: KeyCommand; key?: string; taken?: KeyCommand; problem?: string }

const WORDS = Object.fromEntries(COMMANDS) as Record<KeyCommand, string>

/** Edison's Shortcuts page: a set to start from, then each action with its keys, any of which can
 *  be changed by pressing the new one. A key another action has is offered to take over, and each
 *  change can go back to the set's own. */
function Shortcuts(props: { set: KeySet; changes: KeyChanges; change: Change }): ReactNode {
  const { set, changes } = props
  const [choosing, setChoosing] = useState<Choosing | null>(null)
  const name = KEY_SETS.find(([id]) => id === set)?.[1] ?? 'Edison'
  /** [edit] is given this set's changes as they are by then. */
  const saveChanges = (edit: (changes: KeyChanges) => KeyChanges): void => {
    setChoosing(null)
    props.change((now) => ({ profile: { keyChanges: { ...now.keyChanges, [set]: edit(now.keyChanges[set] ?? {}) } } }))
  }

  // While a key is being chosen, the next press is it. Esc calls it off instead of closing Settings.
  useEffect(() => {
    if (!choosing || choosing.key) return undefined
    const onKey = (event: KeyboardEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') return setChoosing(null)
      const pressed = keyName(event)
      const problem = unbindable(pressed, event.key)
      if (problem) return setChoosing({ command: choosing.command, problem })
      const taken = holder(set, changes, pressed, choosing.command)
      if (taken) return setChoosing({ command: choosing.command, key: pressed, taken })
      saveChanges((now) => rebound(now, choosing.command, pressed))
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [choosing, set, changes])

  return (
    <>
      <section>
        <Choice label="Shortcut set" value={set} options={KEY_SETS} set={(keys) => { setChoosing(null); props.change(() => ({ profile: { keys } })) }} />
        <p className="muted note">Press Change beside an action, then the key you want for it.</p>
      </section>
      <section className="shortcuts" aria-label="Shortcuts">
        {COMMANDS.map(([command, what]) => {
          const keys = keysOf(set, changes, command)
          const here = choosing?.command === command
          return (
            <div className={here ? 'shortcut choosing' : 'shortcut'} key={command} role="group" aria-label={what}>
              <span className="shortcut-what">{what}</span>
              <span className="shortcut-keys">
                {here && !choosing.key && <span className="shortcut-press">{choosing.problem ?? 'Press the new key…'}</span>}
                {here && choosing.key && choosing.taken && (
                  <span className="shortcut-press">{spell(choosing.key)} is {WORDS[choosing.taken]}'s.</span>
                )}
                {!here && (keys.length > 0 ? keys.map((key) => <kbd key={key}>{spell(key)}</kbd>) : <span className="muted">None</span>)}
              </span>
              <span className="shortcut-actions">
                {here && choosing.key && (
                  <button className="quiet" onClick={() => saveChanges((now) => rebound(now, command, choosing.key ?? ''))}>Use it here</button>
                )}
                {here && !choosing.key && keys.length > 0 && <button className="quiet" onClick={() => saveChanges((now) => rebound(now, command, ''))}>No key</button>}
                {here
                  ? <button className="quiet" onClick={() => setChoosing(null)}>Cancel</button>
                  : <button className="quiet" aria-label={`Change the key for ${what}`} onClick={() => setChoosing({ command })}>Change</button>}
                {!here && command in changes && (
                  <button className="link" aria-label={`Reset ${what} to the ${name} set`} onClick={() => saveChanges((now) => reset(now, command))}>Reset</button>
                )}
              </span>
            </div>
          )
        })}
        {FIXED.map(([key, what]) => (
          <div className="shortcut fixed" key={key}>
            <span className="shortcut-what">{what}</span>
            <span className="shortcut-keys"><kbd>{key}</kbd></span>
            <span className="shortcut-actions muted note">Always</span>
          </div>
        ))}
        {Object.keys(changes).length > 0 && (
          <button className="quiet" onClick={() => saveChanges(() => ({}))}>Reset all to the {name} set</button>
        )}
      </section>
    </>
  )
}

/** When the Summary lands, as Edison's page has it: the schedule, and a way to turn it off. */
function Summary(props: { summary: SummarySettings; save(summary: Partial<SummarySettings>): void; ask: Ask }): ReactNode {
  const { summary, save } = props
  const senders = summary.senders.length
  const off = async (): Promise<void> => {
    const note = `${senders === 1 ? 'Its sender goes' : `Its ${senders} senders go`} back to the deliveries, with what's waiting for it.`
    if (await props.ask({ title: 'Turn off Summary?', note, action: 'Turn off', danger: true })) save({ senders: [], chosen: false })
  }
  return (
    <section>
      <p className="muted note">Senders chosen in Subscriptions are held, and delivered together at a time you pick.</p>
      <SummarySchedule summary={summary} set={(next) => save({ ...next, chosen: true })} />
      <p className="muted note">
        {senders === 0 ? 'Nobody is in it yet. Add senders from Subscriptions.' : `${senders === 1 ? '1 sender is' : `${senders} senders are`} in it. Subscriptions has them, on its Summary side.`}
      </p>
      {senders > 0 && <button className="quiet danger outline" onClick={() => void off()}>Turn off Summary</button>}
    </section>
  )
}

/** The times batches start from when there were none to go back to. */
const FIRST_TIMES = ['09:00', '13:00', '17:00']

const MODES: [boolean, string, string][] = [
  [true, 'As it arrives', 'New mail shows the moment your mail service has it.'],
  [false, 'In batches', 'New mail waits for the times you set, apart from the people let straight through.']
]

/** How mail arrives: live, or in batches at set times. Switching keeps the times for coming back. */
function Batches(props: { batch: Settings['batch']; change: Change }): ReactNode {
  const { batch, change } = props
  const [time, setTime] = useState('')
  const [vip, setVip] = useState(batch.vip.join('\n'))

  const add = (): void => {
    if (!time) return
    change((now) => ({ batch: { times: [...now.batch.times, time] } }))
    setTime('')
  }
  const choose = (live: boolean): void => {
    change((now) => {
      if (live === now.batch.live) return null
      return { batch: !live && now.batch.times.length === 0 ? { live, times: FIRST_TIMES } : { live } }
    })
  }

  return (
    <>
      <section>
        <h3>New mail</h3>
        <div className="tiles modes" role="radiogroup" aria-label="How new mail arrives">
          {MODES.map(([live, name, note]) => (
            <label key={name} className={batch.live === live ? 'tile mode on' : 'tile mode'}>
              <input type="radio" name="delivery" checked={batch.live === live} onChange={() => choose(live)} />
              <span className="mode-name">{name}</span>
              <span className="muted mode-note">{note}</span>
            </label>
          ))}
        </div>
        {batch.live && (
          <p className="muted note">
            Your inbox is watched, so mail and changes made on your other devices show within seconds.
            {batch.times.length > 0 && ` Your times (${batch.times.join(', ')}) are kept for switching back.`}
            {' '}Senders in your Summary still wait for its time.
          </p>
        )}
      </section>
      {!batch.live && (
        <section>
          <h3>Delivery times</h3>
          <div className="chips">
            {batch.times.map((t) => (
              <button key={t} className="chip" aria-label={`Remove ${t}`}
                onClick={() => change((now) => ({ batch: { times: now.batch.times.filter((x) => x !== t) } }))}>
                {t} <span aria-hidden="true">×</span>
              </button>
            ))}
            <input type="time" aria-label="New time" value={time} onChange={(e) => setTime(e.target.value)} />
            <button className="quiet" onClick={add} disabled={!time}>Add</button>
          </div>
          {batch.times.length === 1 && <p className="muted note">Taking the last time away makes mail arrive as it comes.</p>}
          <label>
            Straight through
            <textarea rows={3} placeholder="boss@work.com&#10;@school.edu" value={vip}
              onChange={(e) => setVip(e.target.value)}
              onBlur={() => change(() => ({ batch: { vip: vip.split(/\s+/).filter(Boolean) } }))} />
          </label>
          <label className="inline">
            Early deliveries a day
            <select value={batch.earlyPerDay} onChange={(e) => change(() => ({ batch: { earlyPerDay: Number(e.target.value) } }))}>
              {[0, 1, 2, 3, 5].map((n) => <option key={n}>{n}</option>)}
            </select>
          </label>
        </section>
      )}
    </>
  )
}

interface Identities {
  who(email: string): Identity
  edit(email: string, patch: Partial<Identity>): void
  set(email: string, patch: Partial<Identity>): void
  /** Saves what's been typed for this account. */
  flush(email: string): void
}

const NO_IDENTITY: Identity = { name: '', signature: '', aliases: [], color: '', notify: true }

/** Each account's own name, signature and the rest, edited in place and saved when a field is left.
 *  What's typed and not yet saved is held once for every page, over the settings as they stand, and
 *  a save sends that one account's identity alone: sending them all sent another account's as it
 *  was when the page opened, and brought back one removed meanwhile. */
function useIdentities(settings: Settings, change: Change): Identities {
  const [typed, setTyped] = useState<Record<string, Partial<Identity>>>({})
  const who = (email: string): Identity => ({ ...NO_IDENTITY, ...settings.identities[email], ...typed[email] })
  const save = (email: string, patch: Partial<Identity>): void => {
    const held = typed[email] ?? {}
    setTyped(({ [email]: _saved, ...rest }) => rest)
    change((now) => ({ profile: { identities: { [email]: { ...NO_IDENTITY, ...now.identities[email], ...held, ...patch } } } }))
  }
  return {
    who,
    edit: (email, patch) => setTyped((now) => ({ ...now, [email]: { ...now[email], ...patch } })),
    set: save,
    flush: (email) => { if (typed[email]) save(email, {}) }
  }
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
/** An hour of the day as the clock setting writes it: 07:00, or 7:00 AM. */
const hourName = (hour: number): string => clock(new Date(2000, 0, 1, hour).getTime())
const hours = (from: number, to: number): [number, string][] => Array.from({ length: to - from + 1 }, (_, i) => [from + i, hourName(from + i)])

/** One of the snooze times: a day for those that have one, and an hour. */
function When(props: { label: string; day?: [number, number[]]; hour: [number, [number, string][]]; set(change: Partial<{ day: number; hour: number }>): void }): ReactNode {
  return (
    <div className="inline when">
      <span>{props.label}</span>
      {props.day && (
        <select aria-label={`${props.label}, day`} value={props.day[0]} onChange={(e) => props.set({ day: Number(e.target.value) })}>
          {props.day[1].map((day) => <option key={day} value={day}>{DAY_NAMES[day]}</option>)}
        </select>
      )}
      <select aria-label={`${props.label}, time`} value={props.hour[0]} onChange={(e) => props.set({ hour: Number(e.target.value) })}>
        {props.hour[1].map(([hour, name]) => <option key={hour} value={hour}>{name}</option>)}
      </select>
    </div>
  )
}

function General(props: { settings: Settings; save: Save }): ReactNode {
  const { settings, save } = props
  const later = settings.later
  const setLater = (change: Partial<LaterTimes>): void => save({ later: change })
  return (
    <>
      <section>
        <h3>Inbox</h3>
        <Check label="Split the inbox into Focused and Other" on={settings.focused} set={(focused) => save({ focused })} />
        <Choice label="Layout" value={settings.layout} set={(layout) => save({ layout })}
          options={[['panes', 'List and message side by side'], ['below', 'Message under the list'], ['list', 'One thing at a time']]} />
        <Choice label="When a thread is archived or deleted" value={settings.afterRemove} set={(afterRemove) => save({ afterRemove })}
          options={[['next', 'Open the next one'], ['previous', 'Open the one before'], ['list', 'Go back to the list']]} />
      </section>
      <section>
        <h3>Sending</h3>
        <Choice label="Undo send for" value={settings.undoSeconds} set={(undoSeconds) => save({ undoSeconds })}
          options={[0, 5, 10, 20, 30].map((n) => [n, n === 0 ? 'Off' : `${n} seconds`])} />
        <Choice label="Default reply" value={settings.defaultReply} set={(defaultReply) => save({ defaultReply })}
          options={[['reply', 'Reply'], ['replyAll', 'Reply All']]} />
      </section>
      <section>
        <h3>Reading</h3>
        <Check label="Load the pictures in a message without asking" on={settings.images === 'always'} set={(on) => save({ images: on ? 'always' : 'ask' })} />
        <Choice label="Mark a thread read" value={settings.readAfter} set={(readAfter) => save({ readAfter })}
          options={[[0, 'As soon as it opens'], [1, 'After 1 second'], [2, 'After 2 seconds'], [5, 'After 5 seconds'], [-1, 'Only when I mark it read']]} />
      </section>
      <section>
        <h3>Snooze and send later</h3>
        <Choice label="Later today" value={later.laterHours} set={(laterHours) => setLater({ laterHours })}
          options={Array.from({ length: 8 }, (_, i): [number, string] => [i + 1, i === 0 ? '1 hour from now' : `${i + 1} hours from now`])} />
        <When label="This evening" hour={[later.evening, hours(15, 23)]} set={({ hour }) => setLater({ evening: hour })} />
        <When label="Tomorrow" hour={[later.tomorrow, hours(5, 13)]} set={({ hour }) => setLater({ tomorrow: hour })} />
        <When label="This weekend" day={[later.weekendDay, [6, 0]]} hour={[later.weekend, hours(5, 14)]}
          set={({ day, hour }) => setLater(day === undefined ? { weekend: hour } : { weekendDay: day })} />
        <When label="Next week" day={[later.weekDay, [1, 2, 3, 4, 5, 6, 0]]} hour={[later.week, hours(5, 14)]}
          set={({ day, hour }) => setLater(day === undefined ? { week: hour } : { weekDay: day })} />
      </section>
      <section>
        <h3>This laptop</h3>
        <Check label="Keep running in the tray when the window closes" on={settings.background} set={(background) => save({ background })} />
        <Check label="Start at login" on={settings.startAtLogin} set={(startAtLogin) => save({ startAtLogin })} />
      </section>
    </>
  )
}

function Notifications(props: { accounts: AccountView[]; ids: Identities; settings: Settings; save: Save; senders: Senders }): ReactNode {
  const { ids, settings, save } = props
  const { muted } = settings
  const [adding, setAdding] = useState('')
  const add = (): void => {
    const who = adding.trim()
    if (!who) return
    props.senders('muted', who, true)
    setAdding('')
  }
  return (
    <>
      <section>
        <h3>New mail</h3>
        {props.accounts.map((a) => (
          <Check key={a.id} label={`Tell me about new mail in ${a.email}`} on={ids.who(a.email).notify} set={(notify) => ids.set(a.email, { notify })} />
        ))}
        {settings.focused && (
          <Check label="Only mail in Focused" on={settings.notifyFocusedOnly} set={(notifyFocusedOnly) => save({ notifyFocusedOnly })} />
        )}
        <p className="muted note">Mail held for a delivery is announced when it lands, not before.</p>
      </section>
      <section>
        <h3>Muted senders</h3>
        <p className="muted note">Their mail arrives as usual, and nothing announces it.</p>
        {muted.length === 0 && <p className="muted note">Nobody is muted.</p>}
        {muted.map((who) => (
          <div className="line" key={who}>
            <span className="grow">{who}</span>
            <button className="quiet" aria-label={`Unmute ${who}`} onClick={() => props.senders('muted', who, false)}>Unmute</button>
          </div>
        ))}
        <form className="line" onSubmit={(e) => { e.preventDefault(); add() }}>
          <input className="grow" aria-label="Sender to mute" placeholder="someone@example.com or @example.com" value={adding} onChange={(e) => setAdding(e.target.value)} />
          <button type="submit" className="quiet" disabled={!adding.trim()}>Mute</button>
        </form>
      </section>
    </>
  )
}

function Accounts(props: { accounts: AccountView[]; settings: Settings; ids: Identities; saveKeep(days: number): void; ask: Ask }): ReactNode {
  const { accounts, settings, saveKeep, ask, ids } = props
  const [adding, setAdding] = useState(false)
  /** The accounts with a photo chosen here, rather than their Gravatar or none. */
  const [photos, setPhotos] = useState<string[]>([])
  const [error, setError] = useState('')
  useEffect(() => {
    void window.mail.photos().then(setPhotos)
  }, [accounts])
  const photo = async (account: string, choose: boolean): Promise<void> => {
    setError('')
    try {
      if (choose) await window.mail.choosePhoto(account)
      else await window.mail.removePhoto(account)
      forgetFaces()
      setPhotos(await window.mail.photos())
    } catch (e) {
      setError(problem(e))
    }
  }
  return (
    <>
      <section>
        <h3>Your accounts</h3>
        {accounts.map((a) => (
          <div className="line" key={a.id}>
            <AccountFace account={a} size={28} />
            <span className="grow">{a.email} <span className="muted">{a.providerName}</span></span>
            {photos.includes(a.email)
              ? <button className="quiet" aria-label={`Remove the photo of ${a.email}`} onClick={() => void photo(a.email, false)}>Remove photo</button>
              : <button className="quiet" aria-label={`Choose a photo for ${a.email}`} onClick={() => void photo(a.email, true)}>Choose photo…</button>}
            <button className="quiet danger"
              onClick={() => void ask({ title: `Remove ${a.email} from this laptop?`, note: 'The mail stays on the server.', action: 'Remove', danger: true }).then((yes) => { if (yes) void window.mail.removeAccount(a.id) })}>
              Remove
            </button>
          </div>
        ))}
        {error && <p className="error">{error}</p>}
        <p className="muted note">Your photo is your Gravatar, or one chosen here, which stays on this laptop.</p>
        {adding ? <AddAccount done={() => setAdding(false)} /> : <button className="quiet" onClick={() => setAdding(true)}>Add account</button>}
      </section>
      {accounts.map((a) => (
        <section key={a.id} className="identity">
          <h3>{accounts.length > 1 ? a.email : 'Who you write as'}</h3>
          <label>
            Your name
            <input value={ids.who(a.email).name} onChange={(e) => ids.edit(a.email, { name: e.target.value })} onBlur={() => ids.flush(a.email)} />
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

function Appearance(props: { settings: Settings; save: Save; editMenu?: () => void }): ReactNode {
  const { settings, save } = props
  return (
    <>
      <section>
        <h3>Theme</h3>
        <Choice label="Theme" value={settings.theme} set={(theme) => save({ theme })}
          options={[['light', 'Light'], ['dark', 'Dark'], ['system', 'Same as the system']]} />
        <Check label="Darken mail made for a white page, when the look is dark" on={settings.darkMail} set={(darkMail) => save({ darkMail })} />
      </section>
      <section>
        <h3>Sidebar</h3>
        <Check label="Show icons in the sidebar" on={settings.sidebarIcons} set={(sidebarIcons) => save({ sidebarIcons })} />
        {props.editMenu && (
          <div className="line">
            <span className="grow muted">Which entries it shows, and in what order. Right-clicking the sidebar does the same.</span>
            <button className="quiet" onClick={props.editMenu}>Edit Menu</button>
          </div>
        )}
      </section>
      <section>
        <h3>List</h3>
        <Choice label="Preview lines" value={settings.previewLines} set={(previewLines) => save({ previewLines })}
          options={[[0, 'None'], [1, '1'], [2, '2'], [3, '3'], [4, '4']]} />
        <Check label="Show a thread's files as cards under its row" on={settings.attachmentCards} set={(attachmentCards) => save({ attachmentCards })} />
        <Check label="Use the 24-hour clock" on={settings.clock24} set={(clock24) => save({ clock24 })} />
      </section>
    </>
  )
}

/** Every slot a row has, with nothing in the ones not chosen. */
const slots = (actions: QuickAction[]): QuickAction[] => Array.from({ length: QUICK_SLOTS }, (_, i) => actions[i] ?? 'none')

function Actions(props: { settings: Settings; save: Save; change: Change }): ReactNode {
  const { settings, save, change } = props
  const quick = slots(settings.quickActions)
  return (
    <>
      <section>
        <h3>Quick actions</h3>
        <Check label="Show quick actions when the pointer is over a thread in the list" on={settings.quickOn} set={(quickOn) => save({ quickOn })} />
        {quick.map((action, i) => (
          <Choice key={i} label={`Action ${i + 1}`} value={action} options={QUICK_NAMES}
            set={(next) => change((now) => ({ profile: { quickActions: slots(now.quickActions).map((old, at) => (at === i ? next : old)) } }))} />
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
          <textarea rows={4} value={ids.who(a.email).signature} onChange={(e) => ids.edit(a.email, { signature: e.target.value })} onBlur={() => ids.flush(a.email)} />
        </label>
      ))}
    </section>
  )
}

function Blocked(props: { blocked: string[]; senders: Senders }): ReactNode {
  const [adding, setAdding] = useState('')
  const add = (): void => {
    const who = adding.trim()
    if (!who) return
    props.senders('blocked', who, true)
    setAdding('')
  }
  return (
    <section>
      <h3>Their new mail goes straight to Trash</h3>
      {props.blocked.length === 0 && <p className="muted note">Nobody is blocked.</p>}
      {props.blocked.map((who) => (
        <div className="line" key={who}>
          <span className="grow">{who}</span>
          <button className="quiet" aria-label={`Unblock ${who}`} onClick={() => props.senders('blocked', who, false)}>Unblock</button>
        </div>
      ))}
      <form className="line" onSubmit={(e) => { e.preventDefault(); add() }}>
        <input className="grow" aria-label="Sender to block" placeholder="someone@example.com or @example.com" value={adding} onChange={(e) => setAdding(e.target.value)} />
        <button type="submit" className="quiet" disabled={!adding.trim()}>Block</button>
      </form>
    </section>
  )
}

function Templates(props: { templates: Template[]; save(edit: (templates: Template[]) => Template[]): void }): ReactNode {
  const { templates, save } = props
  const [name, setName] = useState('')
  const [text, setText] = useState('')
  return (
    <section>
      <h3>Ready-made text for the composer</h3>
      {templates.map((t) => (
        <div className="line" key={t.name}>
          <span className="grow">{t.name}</span>
          <button className="quiet danger" onClick={() => save((now) => now.filter((x) => x.name !== t.name))}>Remove</button>
        </div>
      ))}
      <label>Name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label>Text<textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} /></label>
      <button className="quiet" disabled={!name.trim() || !text.trim()}
        onClick={() => {
          const made = { name: name.trim(), text }
          save((now) => [...now.filter((t) => t.name !== made.name), made])
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
  change: Change
  editMenu?: () => void
}): ReactNode {
  const { page, accounts, settings, change } = props
  const save: Save = (patch) => change(() => ({ profile: patch }))
  const senders: Senders = (list, address, on) => change(() => ({ senders: list, addresses: [address], on }))
  const ids = useIdentities(settings, change)
  return (
    <div className="settings-page">
      {page === 'general' && <General settings={settings} save={save} />}
      {page === 'notifications' && <Notifications accounts={accounts} ids={ids} settings={settings} save={save} senders={senders} />}
      {page === 'accounts' && <Accounts accounts={accounts} settings={settings} ids={ids} ask={props.ask} saveKeep={(days) => change(() => ({ backfill: days }))} />}
      {page === 'appearance' && <Appearance settings={settings} save={save} editMenu={props.editMenu} />}
      {page === 'actions' && <Actions settings={settings} save={save} change={change} />}
      {page === 'shortcuts' && <Shortcuts set={settings.keys} changes={settings.keyChanges[settings.keys] ?? {}} change={change} />}
      {page === 'signatures' && <Signatures accounts={accounts} ids={ids} />}
      {page === 'templates' && <Templates templates={settings.templates} save={(edit) => change((now) => ({ profile: { templates: edit(now.templates) } }))} />}
      {page === 'summary' && <Summary summary={settings.summary} save={(summary) => change(() => ({ summary }))} ask={props.ask} />}
      {page === 'blocked' && <Blocked blocked={settings.blocked} senders={senders} />}
      {page === 'batches' && <Batches key={settings.batch.vip.join()} batch={settings.batch} change={change} />}
      {page === 'hub' && <Hub settings={settings} />}
      {page === 'about' && <About />}
    </div>
  )
}

export function SettingsDialog(props: {
  accounts: AccountView[]; close(): void; version: number; tab: Tab; ask: Ask
  /** Leaves Settings for the sidebar, with its entries ready to be chosen and moved. */
  editMenu?: () => void
}): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [tab, setTab] = useState<Tab>(props.tab)
  const [search, setSearch] = useState('')
  const [failure, setFailure] = useState('')
  // Shown at once, and saved one after another in the order they were made.
  const [keeper] = useState(() => new SettingsKeeper({
    read: () => window.mail.settings(),
    write: (change) => {
      if ('profile' in change) return window.mail.saveProfile(change.profile)
      if ('batch' in change) return window.mail.saveBatch(change.batch)
      if ('summary' in change) return window.mail.saveSummary(change.summary)
      if ('senders' in change) return window.mail.editSenders(change.senders, change.addresses, change.on)
      return window.mail.saveBackfill(change.backfill)
    }
  }, setSettings, (e) => setFailure(problem(e))))

  useEffect(() => {
    void keeper.refresh()
  }, [props.version])

  useEffect(() => {
    dialog.current?.showModal()
  }, [])

  const change: Change = (make) => {
    setFailure('')
    void keeper.change(make)
  }
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
        {failure && <p className="error settings-failure" role="alert">{failure}</p>}
        {settings && <Pages page={page} accounts={props.accounts} settings={settings} ask={props.ask} change={change} editMenu={props.editMenu} />}
      </div>
    </dialog>
  )
}
