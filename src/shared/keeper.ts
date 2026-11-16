import type { BatchSettings, ProfilePatch, SenderList, Settings, SummarySettings } from './types'

/**
 * The settings as a page shows them while it changes them. Apart from the page so it can be tested
 * without one.
 *
 * Each change is worked out from the settings as they are here and now, its own earlier changes
 * included, and shown at once; the changes then go to the main process one after another, in the
 * order they were made. The settings read back from it are only shown once nothing is still on its
 * way, since a reading taken before a change arrived would put the old value back on screen, and
 * the next change worked out from that would save it. That's how two quick changes used to undo
 * each other: both were built from the settings read before either was saved.
 */

/** What one change saves: a part of the profile, of the batches or of the Summary, senders into one
 *  of the lists of them or out of it, or how long mail is kept. */
export type SettingsChange =
  | { profile: ProfilePatch }
  | { batch: Partial<BatchSettings> }
  | { summary: Partial<SummarySettings> }
  | { senders: SenderList; addresses: string[]; on: boolean }
  | { backfill: number }

/** One of the lists of senders with [addresses] put in or taken out, as the main process does it.
 *  One that's there already keeps its place. */
export function editedSenders(list: string[], addresses: string[], on: boolean): string[] {
  const who = addresses.map((a) => a.trim().toLowerCase()).filter(Boolean)
  const had = list.map((v) => v.trim().toLowerCase())
  if (on) return [...list, ...who.filter((v, i) => !had.includes(v) && who.indexOf(v) === i)]
  return list.filter((_, i) => !who.includes(had[i] ?? ''))
}

export interface SettingsDoor {
  read(): Promise<Settings>
  write(change: SettingsChange): Promise<void>
}

/** A change as it looks here, before the main process has cleaned it. Its reading afterwards says
 *  how it was really kept. */
export function applied(settings: Settings, change: SettingsChange): Settings {
  if ('batch' in change) return { ...settings, batch: { ...settings.batch, ...change.batch } }
  if ('summary' in change) return { ...settings, summary: { ...settings.summary, ...change.summary } }
  if ('backfill' in change) return { ...settings, backfillDays: change.backfill }
  if ('senders' in change) {
    const { senders: list, addresses, on } = change
    if (list === 'vip') return { ...settings, batch: { ...settings.batch, vip: editedSenders(settings.batch.vip, addresses, on) } }
    if (list === 'summary') return { ...settings, summary: { ...settings.summary, senders: editedSenders(settings.summary.senders, addresses, on) } }
    return { ...settings, [list]: editedSenders(settings[list], addresses, on) }
  }
  const { identities, later, ...rest } = change.profile
  return {
    ...settings, ...rest,
    identities: identities ? { ...settings.identities, ...identities } : settings.identities,
    later: later ? { ...settings.later, ...later } : settings.later
  }
}

export class SettingsKeeper {
  private latest: Settings | null = null
  private queue: Promise<unknown> = Promise.resolve()
  /** Changes made and not yet answered. */
  private waiting = 0
  private reads = 0

  constructor(
    private door: SettingsDoor,
    private show: (settings: Settings) => void,
    private failed: (error: unknown) => void = () => undefined
  ) {}

  get current(): Settings | null {
    return this.latest
  }

  /** Reads them again, and shows what's read unless a change has been made since it was asked for. */
  async refresh(): Promise<void> {
    const asked = ++this.reads
    const found = await this.door.read()
    if (this.waiting > 0 || asked !== this.reads) return
    this.latest = found
    this.show(found)
  }

  /** [make] is handed the settings with every change so far in them, and says what this one saves,
   *  or null for nothing. Before the first reading there's nothing to change. */
  change(make: (now: Settings) => SettingsChange | null): Promise<void> {
    if (!this.latest) return Promise.resolve()
    const change = make(this.latest)
    if (!change) return Promise.resolve()
    this.latest = applied(this.latest, change)
    this.show(this.latest)
    this.waiting++
    this.reads++ // a reading already on its way is from before this change
    const sent = this.queue.then(() => this.door.write(change))
    this.queue = sent.catch(() => undefined)
    return sent.catch((error: unknown) => this.failed(error)).finally(() => {
      this.waiting--
      if (this.waiting === 0) void this.refresh().catch((error: unknown) => this.failed(error))
    })
  }
}
