import type { AccountConfig, Server } from './providers'

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
  provider: string
  providerName: string
  /** Gmail labels can be added and removed; anywhere else, a message lives in one folder. */
  labels: boolean
  /** Folders and labels to file mail under, including empty ones. */
  folders: string[]
  /** Unread in its inbox. */
  unread: number
  /** How its mail is marked in shared views. */
  color: string
  /** How far it is through reading what's new, while there's a lot to read. */
  progress: { done: number; total: number } | null
}

/** What the add-account form sends. */
export interface NewAccount {
  email: string
  secret: string
  provider: string
  user?: string
  imap?: Server
  smtp?: Server
}

export interface BatchSettings {
  /** "HH:MM", when held mail lands. Empty turns batching off. */
  times: string[]
  /** Addresses or @domains that skip the wait. */
  vip: string[]
  /** How many times a day "Deliver now" works. */
  earlyPerDay: number
}

/** Who you are when writing from an account. */
export interface Identity {
  name: string
  signature: string
  /** Other addresses this account can send from. */
  aliases: string[]
  /** How its mail is marked in shared views. */
  color: string
  /** Tell about new mail in this account. */
  notify: boolean
}

export interface Template {
  name: string
  text: string
}

/** What a sideways swipe on a thread does. */
export type SwipeAction = 'archive' | 'trash' | 'read' | 'star' | 'snooze' | 'none'

export interface Settings {
  batch: BatchSettings
  /** How far back to keep mail on this laptop. */
  backfillDays: number
  /** xrnhub, if used. It gets counts only, never who or what. */
  hub: { url: string; user: string; connected: boolean }
  /** By account email. */
  identities: Record<string, Identity>
  templates: Template[]
  /** Addresses or @domains whose new mail goes straight to Trash. */
  blocked: string[]
  /** How long "Undo" stays possible after Send. */
  undoSeconds: number
  theme: 'system' | 'light' | 'dark'
  /** Split the inbox into Focused and Other. */
  focused: boolean
  /** Senders kept on one side whatever they look like. */
  alwaysFocused: string[]
  alwaysOther: string[]
  /** Senders left behind, so the list of subscriptions shrinks as it's worked through. */
  unsubscribed: string[]
  /** The application ID Outlook accounts added before each kept its own renew with. Left as it is:
   *  a renewal only works with the ID its account signed in with. */
  microsoftClientId: string
  /** `panes` reads beside the list, `list` is one thing at a time. */
  layout: 'panes' | 'list'
  density: 'comfortable' | 'compact'
  swipeLeft: SwipeAction
  swipeRight: SwipeAction
  /** Stay in the tray with the window closed, for notifications and for mail set to go out later. */
  background: boolean
  startAtLogin: boolean
  /** Whether a message's pictures load without being asked for. Trackers are removed either way. */
  images: 'ask' | 'always'
  /** Senders whose pictures load without being asked for. */
  imagesFrom: string[]
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
  starred: boolean
  /** Set while it's away, and for a while after it comes back. */
  snoozedUntil: number | null
  facts: Facts | null
  /** Who wrote in it, oldest first, each once. */
  people: Address[]
  /** Its first file, to show under the preview, and how many there are in all. */
  file: string | null
  files: number
}

/** What the Assistant found in a message, on this laptop, from what's in the message alone. */
export type Facts =
  | { type: 'package'; carrier: string; tracking: string; arrives: number | null; url: string | null }
  | { type: 'travel'; title: string; code: string; when: number | null; detail: string }
  | { type: 'money'; what: 'receipt' | 'bill'; merchant: string; amount: string; due: number | null }
  | {
      type: 'event'; title: string; start: number | null; end: number | null; location: string; organizer: string
      /** Present when the sender asked for an answer. */
      invite: { uid: string; sequence: number; organizer: string; attendee: string; summary: string; stamp: string } | null
    }

export type AssistantSection = 'packages' | 'travel' | 'money' | 'events'

/** Why a sender may not be who they say. Words for each are in the page; a server's are never shown. */
export type SenderWarning = 'forged' | 'name-mismatch' | 'lookalike' | 'replies-elsewhere'

export interface Subscription {
  account: string
  name: string
  address: string
  count: number
  latest: number
  /** The newest message, which holds the way out. */
  message: number
}

export interface ThreadRef {
  account: string
  thread: string
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
  labels: string[]
  seen: boolean
  flagged: boolean
  /** The sender offers a way out. */
  unsubscribe: boolean
  focused: boolean
  facts: Facts | null
  warnings: SenderWarning[]
  /** Where replies go, when it's somewhere else. */
  replyTo: Address[]
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
  /** Threads waiting to be read on the Other side. */
  otherUnread: number
  spam: number
  /** Unread, by what the Assistant made of it. */
  assistant: Record<AssistantSection, number>
}

export type ListQuery =
  | { kind: 'inbox'; account?: string; focus?: 'focused' | 'other' }
  | { kind: 'starred' | 'snoozed' | 'sent' | 'all' | 'trash' | 'spam' | 'unread' | 'attachments' | 'today'; account?: string }
  | { kind: 'label'; account: string; label: string }
  | { kind: 'search'; text: string }
  | { kind: 'assistant'; section: AssistantSection }

/** A change to mail in Gmail, made because the person asked for it. */
export type MailAction =
  | { kind: 'archive' | 'inbox' | 'trash' | 'spam' | 'read' | 'unread' | 'star' | 'unstar' | 'forever' }
  | { kind: 'label'; label: string; add: boolean }
  | { kind: 'move'; to: string }

export interface DraftFile {
  id: string
  name: string
  size: number
  type: string
}

/** The message being answered or passed on. Its HTML comes from a stranger, so the composer
 *  sanitises it before saving or sending, and it's never placed in the app's own page. */
export interface Quote {
  kind: 'reply' | 'forward'
  intro: string
  html: string | null
  text: string
}

export type DraftState = 'draft' | 'queued' | 'sending' | 'failed'

export interface Draft {
  id: number
  account: string
  /** The address it goes out from: the account's own, or one of its aliases. */
  from: string
  to: string
  cc: string
  bcc: string
  subject: string
  /** What the person wrote. */
  html: string
  text: string
  quote: Quote | null
  inReplyTo: string
  references: string
  files: DraftFile[]
  /** An answer to a calendar invitation, sent as one. */
  ical?: string
  state: DraftState
  sendAt: number | null
  error: string | null
  updated: number
}

export type DraftEdit = Pick<Draft, 'account' | 'from' | 'to' | 'cc' | 'bcc' | 'subject' | 'html' | 'text' | 'quote'>

export type DraftStart =
  | { kind: 'new'; account?: string; to?: string; cc?: string; bcc?: string; subject?: string; text?: string }
  | { kind: 'reply' | 'replyAll' | 'forward'; message: number }

/** `done`: the sender took it. `opened`: their page is in the browser. Or a mail to send. */
export type UnsubscribeResult = { kind: 'done' | 'opened' } | { kind: 'draft'; draft: Draft }

export type Rsvp = 'ACCEPTED' | 'TENTATIVE' | 'DECLINED'

export type ProfilePatch = Partial<Pick<Settings,
  'identities' | 'templates' | 'blocked' | 'undoSeconds' | 'theme' | 'focused' | 'layout' | 'density' | 'swipeLeft' | 'swipeRight' |
  'background' | 'startAtLogin' | 'images' | 'imagesFrom'>>

/** What the app's menu and the tray can ask the page to do. */
export type AppCommand = 'compose' | 'settings' | 'search' | 'help' | 'print' | 'about'

export interface Detected {
  provider: string
  imap?: Server
  smtp?: Server
}

/** What the page may ask for. The preload script exposes exactly this as `window.mail`. */
export interface MailApi {
  accounts(): Promise<AccountView[]>
  addAccount(account: NewAccount): Promise<void>
  /** Starts Microsoft's sign-in: the person enters [code] at [url], and `finishMicrosoft` waits. */
  startMicrosoft(email: string, clientId: string): Promise<{ code: string; url: string }>
  finishMicrosoft(): Promise<void>
  /** A guess at the service behind an address, from its domain's public records. */
  detectProvider(email: string): Promise<Detected>
  removeAccount(id: string): Promise<void>
  syncNow(): Promise<void>
  overview(): Promise<Overview>
  list(query: ListQuery, limit?: number): Promise<ThreadRow[]>
  /** [bins] is for reading what's in Trash or Spam. */
  thread(account: string, thread: string, bins?: boolean): Promise<MessageView[]>
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
  /** Applies at once here and reaches Gmail shortly after. Returns what undoes it. */
  act(targets: ThreadRef[], action: MailAction): Promise<number>
  undo(token: number): Promise<void>
  snooze(targets: ThreadRef[], until: number): Promise<void>
  unsnooze(targets: ThreadRef[]): Promise<void>
  block(address: string): Promise<void>
  unsubscribe(message: number): Promise<UnsubscribeResult>
  subscriptions(): Promise<Subscription[]>
  /** Everything from a sender goes to Trash. Returns what undoes it. */
  clearSender(account: string, address: string): Promise<number>
  /** Keeps a sender on one side of the inbox, for what they've sent and will send. */
  setFocus(address: string, focused: boolean): Promise<void>
  /** Answers a calendar invitation. It waits out the undo time like anything else sent. */
  rsvp(message: number, answer: Rsvp): Promise<{ id: number; when: number }>
  contacts(text: string): Promise<Address[]>
  saveAttachment(message: number, index: number): Promise<boolean>
  openAttachment(message: number, index: number): Promise<void>
  drafts(): Promise<Draft[]>
  startDraft(start: DraftStart): Promise<Draft>
  saveDraft(id: number, edit: DraftEdit): Promise<void>
  discardDraft(id: number): Promise<void>
  /** Opens the system's file picker. Files only ever enter a draft through it, or by being dropped. */
  pickFiles(id: number): Promise<Draft>
  addFile(id: number, name: string, type: string, bytes: ArrayBuffer): Promise<Draft>
  removeFile(id: number, file: string): Promise<Draft>
  /** With [at], waits until then; otherwise it waits out the undo time. Returns when it will leave. */
  send(id: number, at?: number): Promise<number>
  /** Calls a queued message back. */
  unsend(id: number): Promise<void>
  saveProfile(patch: ProfilePatch): Promise<void>
  openInGmail(email: string, thread: string): Promise<void>
  /** A link from a message or the app. Only web and mail addresses open. */
  openLink(url: string): Promise<void>
  onChanged(listener: () => void): () => void
  /** A mail address was opened, from a message or the system, and here's the draft for it. */
  onCompose(listener: (draft: Draft) => void): () => void
  onCommand(listener: (command: AppCommand) => void): () => void
  version(): Promise<string>
}

export type { AccountConfig, Server }
export type { Security } from './providers'

declare global {
  interface Window {
    mail: MailApi
  }
}
