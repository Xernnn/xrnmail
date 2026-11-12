import { describe, expect, it } from 'vitest'
import { applied, editedSenders, SettingsKeeper, type SettingsChange } from '@shared/keeper'
import type { Settings } from '@shared/types'

/** Enough of the settings for these changes. */
const START = {
  batch: { live: false, times: ['09:00'], vip: [], earlyPerDay: 1 },
  summary: { senders: [], every: 'daily', time: '08:00', day: 1, chosen: true },
  identities: { 'me@example.com': { name: 'Me', signature: 'Regards', aliases: [], color: '', notify: true } },
  quickActions: ['archive', 'flag', 'trash', 'read'],
  muted: [],
  blocked: [],
  imagesFrom: [],
  theme: 'system',
  backfillDays: 90
} as unknown as Settings

const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** The main process as the page sees it: every answer is slow, and they can be let go of in any order. */
class SlowDoor {
  saved: Settings = START
  writes: SettingsChange[] = []
  private held: (() => void)[] = []

  read = (): Promise<Settings> => {
    const at = this.saved
    return new Promise((resolve) => this.held.push(() => resolve(at)))
  }

  write = (change: SettingsChange): Promise<void> => {
    this.writes.push(change)
    return new Promise((resolve) => this.held.push(() => {
      this.saved = applied(this.saved, change)
      resolve()
    }))
  }

  /** Answers everything asked so far, the oldest first, and what that asks in turn. */
  async answer(): Promise<void> {
    for (let rounds = 0; rounds < 20; rounds++) {
      await settled()
      for (const go of this.held.splice(0)) go()
    }
    await settled()
  }

  /** Answers the oldest question only, so a test can choose what comes back when. */
  async answerOne(): Promise<void> {
    await settled()
    this.held.shift()?.()
    await settled()
  }
}

async function started(door: SlowDoor): Promise<{ keeper: SettingsKeeper; shown: Settings[] }> {
  const shown: Settings[] = []
  const keeper = new SettingsKeeper(door, (s) => shown.push(s))
  const reading = keeper.refresh()
  await door.answer()
  await reading
  return { keeper, shown }
}

describe('the settings a page changes', () => {
  it('keeps both of two changes made one straight after the other', async () => {
    const door = new SlowDoor()
    const { keeper } = await started(door)
    const slot = (at: number, action: string) => (now: Settings): SettingsChange => ({
      profile: { quickActions: now.quickActions.map((old, i) => (i === at ? action : old)) as Settings['quickActions'] }
    })
    void keeper.change(slot(0, 'snooze'))
    void keeper.change(slot(3, 'none'))
    expect(keeper.current?.quickActions).toEqual(['snooze', 'flag', 'trash', 'none']) // shown at once, both
    await door.answer()
    expect(door.saved.quickActions).toEqual(['snooze', 'flag', 'trash', 'none'])
    expect(keeper.current?.quickActions).toEqual(['snooze', 'flag', 'trash', 'none'])
  })

  it('sends the changes in the order they were made, one at a time', async () => {
    const door = new SlowDoor()
    const { keeper } = await started(door)
    void keeper.change(() => ({ profile: { theme: 'dark' } }))
    void keeper.change(() => ({ profile: { theme: 'light' } }))
    await settled()
    expect(door.writes).toEqual([{ profile: { theme: 'dark' } }]) // the second waits for the first
    await door.answerOne()
    expect(door.writes).toHaveLength(2)
    await door.answer()
    expect(door.writes.map((w) => 'profile' in w && w.profile.theme)).toEqual(['dark', 'light'])
    expect(door.saved.theme).toBe('light')
  })

  it('never shows a reading taken before a change, which would put the old value back', async () => {
    const door = new SlowDoor()
    const { keeper, shown } = await started(door)
    const reading = keeper.refresh() // asked for before the change, answered after it
    void keeper.change(() => ({ profile: { theme: 'dark' } }))
    await door.answerOne() // the old reading comes back first
    await reading
    expect(keeper.current?.theme).toBe('dark')
    expect(shown.at(-1)?.theme).toBe('dark')
    await door.answer()
    expect(shown.map((s) => s.theme)).toEqual(['system', 'dark', 'dark']) // nothing old drawn after it, and the reading after it agrees
  })

  it('works out each change from the ones before it, not from what was drawn', async () => {
    const door = new SlowDoor()
    const { keeper } = await started(door)
    void keeper.change((now) => ({ batch: { times: [...now.batch.times, '13:00'] } }))
    void keeper.change((now) => ({ batch: { times: [...now.batch.times, '17:00'] } }))
    void keeper.change((now) => (now.batch.live ? null : { batch: { earlyPerDay: 3 } }))
    await door.answer()
    expect(door.saved.batch).toEqual({ live: false, times: ['09:00', '13:00', '17:00'], vip: [], earlyPerDay: 3 })
  })

  it('says when a change failed, and shows the settings as they were really kept', async () => {
    const door = new SlowDoor()
    const failures: unknown[] = []
    const shown: Settings[] = []
    door.write = () => Promise.reject(new Error('Bad request'))
    const keeper = new SettingsKeeper(door, (s) => shown.push(s), (e) => failures.push(e))
    void keeper.refresh()
    await door.answer()
    await keeper.change(() => ({ profile: { theme: 'dark' } }))
    await door.answer()
    expect(failures).toHaveLength(1)
    expect(keeper.current?.theme).toBe('system')
  })

  it('changes nothing before the settings have been read', async () => {
    const door = new SlowDoor()
    const keeper = new SettingsKeeper(door, () => undefined)
    await keeper.change(() => ({ profile: { theme: 'dark' } }))
    expect(door.writes).toEqual([])
  })
})

describe('a change as the page shows it', () => {
  it('replaces one account\'s identity and leaves the others', () => {
    const other = { name: 'Work', signature: '', aliases: [], color: '', notify: false }
    const next = applied(START, { profile: { identities: { 'work@example.com': other } } })
    expect(Object.keys(next.identities)).toEqual(['me@example.com', 'work@example.com'])
    expect(next.identities['me@example.com']?.signature).toBe('Regards')
  })

  it('puts senders into a list or takes them out, in one case, with the rest as they are', () => {
    expect(editedSenders(['a@x.example', 'B@x.example'], [' b@x.example ', 'c@x.example', 'C@x.example'], true)).toEqual(['a@x.example', 'B@x.example', 'c@x.example'])
    expect(editedSenders(['a@x.example', 'B@x.example'], ['b@x.example'], false)).toEqual(['a@x.example'])
    expect(applied(START, { senders: 'vip', addresses: ['ada@example.com'], on: true }).batch.vip).toEqual(['ada@example.com'])
    expect(applied(START, { senders: 'summary', addresses: ['news@shop.example'], on: true }).summary.senders).toEqual(['news@shop.example'])
    expect(applied(START, { senders: 'muted', addresses: ['x@y.example'], on: true }).muted).toEqual(['x@y.example'])
  })
})
