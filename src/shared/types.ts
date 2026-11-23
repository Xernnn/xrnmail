import type { KeyChanges, KeySet } from './keys'
import type { LaterTimes } from './later'
import type { MailRule, RuleApplied, RuleEdit } from './rules'
import type { AccountConfig, Server } from './providers'
import type { SidebarChoice } from './sidebar'

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
  /** Its own folders, or on Gmail its own labels: what mail can be filed under, empty ones too. */
  folders: string[]
  /** Unread in its inbox. */
  unread: number
  /** Of those, the ones on the Other side, for its inbox's Other tab. */
  otherUnread: number
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

/** The Subscription Summary: chosen senders, held and delivered together at a time of their own. */
export interface SummarySettings {
  /** Addresses or @domains whose new mail waits for the Summary. None, and there's no Summary. */
  senders: string[]
  every: 'daily' | 'weekly'
  /** "HH:MM". */
  time: string
  /** For a weekly Summary, the day: 0 is Sunday. */
  day: number
  /** Whether a time has been picked. Until one has, the first sender added asks for it. */
  chosen: boolean
}

export interface BatchSettings {
  /** New mail shows as it arrives, and nothing waits for a batch. The times are kept for switching
   *  back. Saved settings from before there was a switch are live when they have no times. */
  live: boolean
  /** "HH:MM", when held mail lands. Batches always have one: with none, mail is live. */
  times: string[]
  /** Addresses or @domains that skip the wait. */
  vip: string[]
  /** How many times a day "Deliver now" works. */
  earlyPerDay: number
}

/** Who you are when writing from an account. */
export interface Identity {
  name: string
  /** The plain signature of versions before there were several. It becomes one of `signatures` the
   *  first time settings are read, and is empty from then on. */
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
  /** The subject it gives a message that has none yet. */
  subject?: string
}

/** A signature, written with the composer's own toolbar. A picture in it is a data: image in its
 *  HTML, sent as a part of the message of its own, never fetched from anywhere. */
export interface Signature {
  id: string
  name: string
  html: string
  /** The same, as text, for the text part. */
  text: string
}

/** What a sideways swipe on a thread does. */
export type SwipeAction = 'archive' | 'trash' | 'read' | 'star' | 'snooze' | 'none'

/** A button a row of the list offers under the pointer, in the place of its date. */
export type QuickAction = 'archive' | 'flag' | 'trash' | 'read' | 'snooze' | 'spam' | 'none'
/** A row has room for this many. */
export const QUICK_SLOTS = 4

export interface Settings {
  batch: BatchSettings
  summary: SummarySettings
  /** How far back to keep mail on this laptop. */
  backfillDays: number
  /** xrnhub, if used. It gets counts only, never who or what. */
  hub: { url: string; user: string; connected: boolean }
  /** By account email. */
  identities: Record<string, Identity>
  /** Every signature, in the order Settings shows them. */
  signatures: Signature[]
  /** Which signature goes under mail from each of your addresses, an account's own or an alias, by
   *  address: a signature's id, or '' for none. An alias with nothing chosen takes its account's. */
  signatureFor: Record<string, string>
  templates: Template[]
  /** Addresses or @domains whose new mail goes straight to Trash. */
  blocked: string[]
  /** Senders whose new mail is never announced. It arrives all the same. An entry is an address, or @domain. */
  muted: string[]
  /** With the inbox split, only mail in Focused is announced. */
  notifyFocusedOnly: boolean
  /** New mail's notice comes with a short chime. */
  sound: boolean
  /** How long "Undo" stays possible after Send. */
  undoSeconds: number
  /** How long Undo is offered after archiving, deleting, moving and the rest, and how long the change
   *  waits here before it goes to the server. */
  undoActionSeconds: number
  /** What the reply button on a message does: answer its sender, or everyone on it. */
  defaultReply: 'reply' | 'replyAll'
  /** A reply starts with the message it answers quoted under it. A forward always has the message. */
  quoteReplies: boolean
  theme: 'system' | 'light' | 'dark'
  /** In dark mode, mail made for a white page is darkened to match. */
  darkMail: boolean
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
  /** `panes` reads beside the list, `below` under it, and `list` is one thing at a time. */
  layout: 'panes' | 'below' | 'list'
  /** What the reader opens once the open thread is archived, deleted or otherwise leaves the list:
   *  the thread below it, the one above, or nothing, back to the list. */
  afterRemove: 'next' | 'previous' | 'list'
  /** How many lines of a message a row of the list shows under its subject, none to four. */
  previewLines: number
  /** A thread's files as small cards under its row in the list. */
  attachmentCards: boolean
  /** Which of the sidebar's folders and Assistant lists show, and in what order. */
  sidebar: SidebarChoice
  /** Icons beside the sidebar's entries. */
  sidebarIcons: boolean
  /** Gmail's importance markers on rows of the list. */
  importanceMarks: boolean
  /** Times as 17:30, not 5:30 PM. */
  clock24: boolean
  /** Which set of keys the keyboard answers to: Edison Mail's, Gmail's as xrnmail had them, Apple
   *  Mail's, Outlook's or Inbox's. */
  keys: KeySet
  /** Keys the person changed, for each set. */
  keyChanges: Partial<Record<KeySet, KeyChanges>>
  /** Whether rows offer buttons under the pointer, and which, in order. */
  quickOn: boolean
  quickActions: QuickAction[]
  /** Whether a sideways swipe on a row does anything. A short one and a long one, each way. */
  swipes: boolean
  swipeLeft: SwipeAction
  swipeLeftLong: SwipeAction
  swipeRight: SwipeAction
  swipeRightLong: SwipeAction
  /** Stay in the tray with the window closed, for notifications and for mail set to go out later. */
  background: boolean
  startAtLogin: boolean
  /** Whether a message's pictures load without being asked for. Trackers are removed either way. */
  images: 'ask' | 'always'
  /** How many seconds a thread is open before it's marked read: 0 at once, -1 only when asked. */
  readAfter: number
  /** The messages of an open thread from the top down: the first one first, or the newest. */
  threadOrder: 'oldest' | 'newest'
  /** What Later today, This evening, Tomorrow, the weekend and Next week mean, for snoozing and sending later. */
  later: LaterTimes
  /** Senders whose pictures load without being asked for. */
  imagesFrom: string[]
  /** Faces are looked up: Gravatar photos, company logos and site icons. Off, everyone has initials. */
  faces: boolean
}

/** A picture for an address: a person's photo, or a company's logo, as a data: address. */
export interface Face {
  url: string
  /** A logo is drawn whole on white; a photo fills its circle. */
  logo: boolean
}

/** A thread comes back to the inbox at [at] if nobody else has written in it by then. [fired] once
 *  it has. */
export interface Reminder {
  at: number
  fired: boolean
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
  /** Gmail has marked it important (its \\Important label). Only Gmail does. */
  important: boolean
  /** Set while it's away, and for a while after it comes back. */
  snoozedUntil: number | null
  /** When it comes back to the inbox if nobody else writes, and whether it has. */
  remind?: Reminder | null
  facts: Facts | null
  /** Who wrote in it, oldest first, each once. */
  people: Address[]
  /** Its first file, to show under the preview, and how many there are in all. */
  file: string | null
  files: number
  /** The names of its first few files, for the cards under a row. */
  cards: string[]
  /** Kept under Pinned, on this laptop. */
  pinned: boolean
  /** When the Summary that brought it landed, if one did. */
  summaryAt: number | null
  /** Its newest message has a sender warning, so it's shown with initials whatever pictures there are. */
  warned: boolean
  /** Found on the server by a search, from before the mail kept here. */
  older?: boolean
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
export type SenderWarning = 'forged' | 'self' | 'unverified' | 'name-mismatch' | 'lookalike' | 'replies-elsewhere' | 'hidden'

export interface Subscription {
  account: string
  name: string
  address: string
  /** Messages from them kept here. */
  count: number
  latest: number
  /** The newest message, which holds the way out. */
  message: number
  /** Of those, the ones read, here or anywhere else: Edison's open rate is this over [count]. */
  read: number
  /** Of those, the ones that came in the last seven days. */
  week: number
}

export interface ThreadRef {
  account: string
  thread: string
}

/** What a message's headers say about where it came from and how, for its details. A receiving
 *  server wrote these, as far as anything here can tell, and they're shown as what it wrote down. */
export interface HeaderDetails {
  /** Known on your own copy of what you sent. */
  bcc: Address[]
  /** Which of your addresses the server delivered it to, when it says. */
  deliveredTo: string
  /** The top Authentication-Results line: who checked, and what SPF, DKIM and DMARC came to. */
  checks: { by: string; spf: string; dkim: string; dmarc: string } | null
  /** The envelope's domain, as Gmail's "mailed-by". */
  mailedBy: string
  /** Domains whose DKIM signatures passed, as Gmail's "signed-by". */
  signedBy: string[]
  /** How it reached your mail service, "TLS 1.3" or "TLS", or '' when that isn't recorded. */
  tls: string
  /** The mailing list it came through. */
  list: { id: string; name: string } | null
  /** The Date header: when the sender says they sent it. */
  sent: number | null
}

/** A message's details panel: its headers' details, and what's known here about its sender. */
export interface MessageDetails extends HeaderDetails {
  /** The headers could be read, now or when it arrived. */
  recorded: boolean
  /** Mail has gone from this account to the sender. */
  wroteTo: boolean
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
  /** A line or two of what's new in it, as the list shows: not what it quotes, nor its links. */
  snippet: string
  attachments: AttachmentInfo[]
  /** Too big to keep whole here, its source or its HTML: the server has the rest. */
  truncated: boolean
  labels: string[]
  seen: boolean
  flagged: boolean
  /** The sender offers a way out. */
  unsubscribe: boolean
  focused: boolean
  facts: Facts | null
  warnings: SenderWarning[]
  /** The account's server says it's from the domain on its From line (`authenticated` in images.ts). */
  authenticated: boolean
  /** Where replies go, when it's somewhere else. */
  replyTo: Address[]
  /** Its thread is kept under Pinned. */
  pinned: boolean
  /** Its thread's reminder. */
  remind?: Reminder | null
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
  /** Threads in the inbox with something unread that came today. */
  today: number
  spam: number
  /** Unread, by what the Assistant made of it. */
  assistant: Record<AssistantSection, number>
  summary: SummaryOverview
}

export interface SummaryOverview {
  /** When the next Summary lands, while it has senders. */
  next: number | null
  /** Messages waiting for it. */
  held: number
  /** Threads in Summary with something unread. */
  unread: number
  /** The Summary that landed last, and what of it is still unread in the inbox. */
  latest: { at: number; unread: number; senders: string[] } | null
}

export type ListQuery =
  | { kind: 'inbox'; account?: string; focus?: 'focused' | 'other' }
  | { kind: 'starred' | 'pinned' | 'snoozed' | 'reminders' | 'sent' | 'all' | 'archive' | 'trash' | 'spam' | 'attachments' | 'today' | 'recent' | 'summary'; account?: string }
  /** [keep] is the open thread, which stays listed while it's read. */
  | { kind: 'unread'; account?: string; keep?: ThreadRef }
  | { kind: 'label'; account: string; label: string }
  | { kind: 'search'; text: string }
  | { kind: 'assistant'; section: AssistantSection }
  /** A sender's page: their threads on one account. */
  | { kind: 'from'; account: string; address: string }

/** The signature that goes under mail from [from], an address of [account]'s: the one chosen for it,
 *  or for an alias with none chosen, the account's. */
export function signatureFor(settings: Pick<Settings, 'signatures' | 'signatureFor'>, account: string, from: string): Signature | null {
  const chosen = settings.signatureFor[(from || account).toLowerCase()] ?? settings.signatureFor[account.toLowerCase()] ?? ''
  return settings.signatures.find((s) => s.id === chosen) ?? null
}

/** Gmail's label for mail it thinks matters, which its importance markers show. It's added and taken
 *  off as any label is. */
export const IMPORTANT = '\\Important'

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
  /** A picture placed in the words, which name it by this Content-ID, rather than attached. */
  cid?: string
}

/** The pictures that go in a message's words when pasted or dropped there. Anything else is attached. */
export const INLINE_PICTURES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

/** The message being answered or passed on. Its HTML comes from a stranger, so the composer
 *  sanitises it before saving or sending, and it's never placed in the app's own page. */
export interface Quote {
  kind: 'reply' | 'forward'
  intro: string
  html: string | null
  text: string
  /** Quoted already, by the device that wrote the draft this came in with, so it goes as it is. */
  asIs?: boolean
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
  /** Where replies are to go, when not to the address it's from. */
  replyTo?: string
  subject: string
  /** What the person wrote. */
  html: string
  text: string
  quote: Quote | null
  inReplyTo: string
  references: string
  files: DraftFile[]
  /** The signature under it: a signature's id, '' for none, or, not chosen, its From address's. */
  signature?: string
  /** The thread a reply or forward was started from. */
  about?: ThreadRef
  /** Once it has gone, it comes back to the inbox at this time if nobody else has written. */
  remind?: number
  /** Not kept: that thread is in the inbox now, so Send & Archive is offered. */
  archivable?: boolean
  /** An answer to a calendar invitation, sent as one. */
  ical?: string
  state: DraftState
  sendAt: number | null
  error: string | null
  updated: number
}

export type DraftEdit = Pick<Draft, 'account' | 'from' | 'to' | 'cc' | 'bcc' | 'replyTo' | 'subject' | 'html' | 'text' | 'quote' | 'signature' | 'remind'>

export type DraftStart =
  | { kind: 'new'; account?: string; to?: string; cc?: string; bcc?: string; subject?: string; text?: string }
  | { kind: 'reply' | 'replyAll' | 'forward'; message: number }

/** `done`: the sender took it. `opened`: their page is in the browser. Or a mail to send. */
export type UnsubscribeResult = { kind: 'done' | 'opened' } | { kind: 'draft'; draft: Draft }

export type Rsvp = 'ACCEPTED' | 'TENTATIVE' | 'DECLINED'

/** The lists of senders that are added to and taken from one at a time: straight through, the
 *  Summary, muted, blocked, and those whose pictures load by themselves. */
export type SenderList = 'vip' | 'summary' | 'muted' | 'blocked' | 'imagesFrom'
export const SENDER_LISTS: readonly SenderList[] = ['vip', 'summary', 'muted', 'blocked', 'imagesFrom']

/** Only what's named changes. Each account named in `identities` has its identity replaced, and the
 *  others are left as they are. */
export type ProfilePatch = Partial<Pick<Settings,
  'identities' | 'signatures' | 'signatureFor' | 'templates' | 'blocked' | 'muted' | 'notifyFocusedOnly' | 'sound' | 'undoSeconds' | 'undoActionSeconds' | 'defaultReply' | 'quoteReplies' | 'theme' | 'darkMail' | 'focused' | 'layout' | 'afterRemove' | 'previewLines' | 'attachmentCards' | 'sidebar' | 'sidebarIcons' | 'importanceMarks' | 'clock24' | 'keys' | 'keyChanges' |
  'quickOn' | 'quickActions' | 'swipes' | 'swipeLeft' | 'swipeLeftLong' | 'swipeRight' | 'swipeRightLong' |
  'background' | 'startAtLogin' | 'images' | 'imagesFrom' | 'readAfter' | 'threadOrder' | 'faces'>> & {
  /** Only the times named. */
  later?: Partial<LaterTimes>
}

/** What the app's menu and the tray can ask the page to do. */
export type AppCommand = 'compose' | 'settings' | 'search' | 'help' | 'print' | 'about' | 'summary'

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
  /** [bins] is for reading what's in Trash or Spam. Opening a thread puts it at the top of Recently
   *  Seen, unless [remember] is false. */
  /** A thread's messages. Unless [read] is false, opening it reads it. */
  thread(account: string, thread: string, bins?: boolean, remember?: boolean, read?: boolean): Promise<MessageView[]>
  /** Recently Seen starts again, empty. */
  clearRecent(): Promise<void>
  /** The searches made lately, newest first. */
  searches(): Promise<string[]>
  /** A search was used, so it goes first; the list as it is now. */
  rememberSearch(search: string): Promise<string[]>
  /** One search let go of, or all of them with null; the list as it is now. */
  forgetSearch(search: string | null): Promise<string[]>
  settings(): Promise<Settings>
  /** Only what's named changes, so a page that's behind can't undo what it hasn't heard of. */
  saveBatch(batch: Partial<BatchSettings>): Promise<void>
  /** Who's in the Summary and when it lands. What it holds moves to the new time, or out to the
   *  batches. Only what's named changes. */
  saveSummary(summary: Partial<SummarySettings>): Promise<void>
  /** Senders into one of the lists of them, or out of it, with the rest of the list as it is then. */
  editSenders(list: SenderList, addresses: string[], on: boolean): Promise<void>
  /** The senders in the Summary, with what's here from each. Ones with no mail here come with a count of 0. */
  summarySenders(): Promise<Subscription[]>
  /** The mail rules, in their order. */
  mailRules(): Promise<MailRule[]>
  /** A rule kept, new without an id; it comes back as kept. */
  saveRule(rule: RuleEdit): Promise<MailRule>
  deleteRule(id: number): Promise<void>
  /** A rule to [to] in the order, counting from 0. */
  moveRule(id: number, to: number): Promise<void>
  /** Runs a rule over the inbox kept here now, with Undo. */
  applyRule(id: number): Promise<RuleApplied>
  saveBackfill(days: number): Promise<void>
  connectHub(url: string, user: string, secret: string): Promise<void>
  disconnectHub(): Promise<void>
  /** Holding back a batch has a door: ask, wait, and only then does it open. */
  beginEarly(): Promise<number>
  finishEarly(): Promise<number>
  /** Lets remote images load, for the message on screen only. */
  allowRemoteImages(allow: boolean): Promise<void>
  /** Applies at once here and reaches Gmail shortly after: with [undoable], once Undo has had its
   *  time, as what takes mail away always does. Returns what undoes it. */
  act(targets: ThreadRef[], action: MailAction, undoable?: boolean): Promise<number>
  undo(token: number): Promise<void>
  snooze(targets: ThreadRef[], until: number): Promise<void>
  unsnooze(targets: ThreadRef[]): Promise<void>
  /** Brings a message you sent, and its thread, back to the inbox at [until] if nobody else has
   *  written in it by then. */
  remind(message: number, until: number): Promise<void>
  unremind(targets: ThreadRef[]): Promise<void>
  /** Keeps threads under Pinned, or lets them go. It's kept on this laptop: mail servers have no such mark. */
  pin(targets: ThreadRef[], on: boolean): Promise<void>
  block(address: string): Promise<void>
  unsubscribe(message: number): Promise<UnsubscribeResult>
  subscriptions(): Promise<Subscription[]>
  /** Senders already unsubscribed from. Ones with no mail left here come with a count of 0 and no account. */
  unsubscribed(): Promise<Subscription[]>
  /** One sender on one account, for their page; null when nothing from them is here. */
  sender(account: string, address: string): Promise<Subscription | null>
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
  /** Everything about where a message came from and how. Mail stored before this was kept has its
   *  headers read from the server, once. */
  details(message: number): Promise<MessageDetails>
  /** A message as the server has it, as text, for View original: the first few megabytes, and how big
   *  it is in all. */
  original(message: number): Promise<{ text: string; size: number; cut: boolean }>
  /** The same, every byte, saved where the person picks. False when they didn't pick anywhere. */
  saveOriginal(message: number): Promise<boolean>
  /** Puts an email address, and nothing else, on the clipboard. */
  copyAddress(address: string): Promise<void>
  /** The faces known for these addresses. With [lookUp], ones not known are looked up behind the
   *  scenes, and `onFaces` says when there are more. Only lists look up; opening a message doesn't. */
  faces(addresses: string[], lookUp: boolean): Promise<Record<string, Face | null>>
  /** [again] says every face known so far is to be asked for again: Faces was turned off or on. */
  onFaces(listener: (again: boolean) => void): () => void
  /** A photo for one of your accounts, from the system's file picker, kept on this laptop. Says
   *  whether one was chosen. */
  choosePhoto(account: string): Promise<boolean>
  removePhoto(account: string): Promise<void>
  /** The accounts with a photo chosen here. */
  photos(): Promise<string[]>
  /** Opens a thread in a window of its own, or brings forward the one it already has. */
  openThreadWindow(account: string, thread: string, bins?: boolean): Promise<void>
  /** The same for a draft, in a composer of its own. */
  openDraftWindow(id: number): Promise<void>
  /** The message of a file opened in a window of its own, named by its token, read-only. Its id is
   *  below zero. Throws why when the file couldn't be read. */
  letter(token: string): Promise<MessageView>
  /** A reply to that message, or a forward, in a composer of its own. */
  replyToLetter(token: string, kind: 'reply' | 'replyAll' | 'forward'): Promise<void>
  /** Makes a folder, or on Gmail a label, on the server there and then. A slash puts it inside another.
   *  Returns its path as the server has it. */
  createFolder(account: string, name: string): Promise<string>
  /** Brings forward the window a draft is being written in, when it has one, and says whether it did. */
  showDraftWindow(id: number): Promise<boolean>
  /** A window of its own is about to close. It closes itself again once it's ready, and that time it does. */
  onLeaving(listener: () => void): () => void
  startDraft(start: DraftStart): Promise<Draft>
  saveDraft(id: number, edit: DraftEdit): Promise<void>
  /** A composer has this draft open, or has let it go. While one has, what the server says about the
   *  draft leaves it as it is here. */
  holdDraft(id: number, on: boolean): Promise<void>
  /** With [undoable], it waits out Undo before it goes for good, out of Drafts meanwhile. */
  discardDraft(id: number, undoable?: boolean): Promise<void>
  /** Undo for a draft thrown away. */
  undiscardDraft(id: number): Promise<void>
  /** Opens the system's file picker. Files only ever enter a draft through it, or by being dropped. */
  pickFiles(id: number): Promise<Draft>
  /** With [inline], a picture for the words, which the draft names by its `cid`; one that isn't a
   *  picture by its own bytes is attached. */
  addFile(id: number, name: string, type: string, bytes: ArrayBuffer, inline?: boolean): Promise<Draft>
  /** A picture in a draft's words, as a data: address for the composer to show. */
  draftPicture(id: number, file: string): Promise<string>
  removeFile(id: number, file: string): Promise<Draft>
  /** With [at], waits until then; otherwise it waits out the undo time. Returns when it will leave. */
  send(id: number, at?: number): Promise<number>
  /** Sends as `send` does, and archives the thread it answers or passes on, for as long as Undo of
   *  the send lasts before the server hears: [undo] undoes the archiving. */
  sendAndArchive(id: number): Promise<{ when: number; undo: number }>
  /** Calls a queued message back. */
  unsend(id: number): Promise<void>
  saveProfile(patch: ProfilePatch): Promise<void>
  openInGmail(email: string, thread: string): Promise<void>
  /** A link from a message or the app. Only web and mail addresses open. */
  openLink(url: string): Promise<void>
  /** Whether mail links open here ('default'), elsewhere ('other'), or can't be set here ('none'). */
  mailLinks(): Promise<'default' | 'other' | 'none'>
  /** Makes mail links open here, and says the same as mailLinks after. */
  useForMailLinks(): Promise<'default' | 'other' | 'none'>
  onChanged(listener: () => void): () => void
  /** A mail address was opened, from a message or the system, and here's the draft for it. */
  onCompose(listener: (draft: Draft) => void): () => void
  /** A notice for one new message was clicked, and this is its thread. */
  onOpenThread(listener: (ref: ThreadRef) => void): () => void
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
