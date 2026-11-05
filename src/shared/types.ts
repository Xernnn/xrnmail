/** What crosses between the app's two halves. Both sides read this file. */

export interface Address {
  name: string
  address: string
}

export interface AttachmentInfo {
  name: string
  type: string
  size: number
}

export interface AccountView {
  id: string
  email: string
  /** Last time a sync finished, in ms. */
  syncedAt: number | null
  syncing: boolean
  /** What went wrong last time, in words for the person reading it. */
  error: string | null
}

export interface BatchSettings {
  /** "HH:MM", when held mail lands. Empty turns batching off. */
  times: string[]
  /** Addresses or @domains that skip the wait. */
  vip: string[]
  /** How many times a day "Deliver now" works. */
  earlyPerDay: number
}

export interface Settings {
  batch: BatchSettings
  /** How far back to keep mail on this laptop. */
  backfillDays: number
  /** xrnhub, if used. It gets counts only, never who or what. */
  hub: { url: string; user: string; connected: boolean }
}

export interface ThreadRow {
  account: string
  thread: string
  subject: string
  fromName: string
  fromAddress: string
  snippet: string
  date: number
  count: number
  unread: number
  attachment: boolean
}

export interface MessageView {
  id: number
  account: string
  thread: string
  subject: string
  from: Address
  to: Address[]
  cc: Address[]
  date: number
  text: string
  html: string | null
  attachments: AttachmentInfo[]
  /** Too big to keep whole here: Gmail has the rest. */
  truncated: boolean
}

export interface LabelCount {
  account: string
  label: string
  count: number
}

export interface Overview {
  held: number
  nextBatch: number | null
  earlyLeft: number
  labels: LabelCount[]
}

export type ListQuery =
  | { kind: 'inbox'; account?: string }
  | { kind: 'label'; account: string; label: string }
  | { kind: 'search'; text: string }

/** What the page may ask for. The preload script exposes exactly this as `window.mail`. */
export interface MailApi {
  accounts(): Promise<AccountView[]>
  addAccount(email: string, appPassword: string): Promise<void>
  removeAccount(id: string): Promise<void>
  syncNow(): Promise<void>
  overview(): Promise<Overview>
  list(query: ListQuery): Promise<ThreadRow[]>
  thread(account: string, thread: string): Promise<MessageView[]>
  settings(): Promise<Settings>
  saveBatch(batch: BatchSettings): Promise<void>
  saveBackfill(days: number): Promise<void>
  connectHub(url: string, user: string, secret: string): Promise<void>
  disconnectHub(): Promise<void>
  /** Holding back a batch has a door: ask, wait, and only then does it open. */
  beginEarly(): Promise<number>
  finishEarly(): Promise<number>
  /** Lets remote images load, for the message on screen only. */
  allowRemoteImages(allow: boolean): Promise<void>
  openInGmail(email: string, thread: string): Promise<void>
  /** A link from a message or the app. Only web and mail addresses open. */
  openLink(url: string): Promise<void>
  onChanged(listener: () => void): () => void
}

declare global {
  interface Window {
    mail: MailApi
  }
}
