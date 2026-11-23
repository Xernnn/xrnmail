import { execFile, type ChildProcess } from 'node:child_process'
import type { ThreadRef } from '@shared/types'

/**
 * New-mail notices on Linux with Archive and Mark read on them, and the sound. Electron's Notification
 * has no actions on Linux, so a notice for one message goes to the desktop's notification server
 * through notify-send, which waits on the bus for the button pressed and says which. It's the one
 * connection that asked, so servers that tell only that connection (dunst, Plasma) are heard as well
 * as those that tell everyone (mako, Quickshell). The server is asked first, over gdbus, whether it
 * shows actions at all. Anything else, and any desktop where these can't be run, keeps Electron's
 * notice as before. Nothing here runs through a shell: the words are a stranger's.
 */

/** Programs run without a shell. */
export interface Runner {
  /** Runs [file] to its end, [ms] at most: what it wrote, or a rejection. */
  run(file: string, args: string[], ms: number): Promise<string>
  /** Starts [file] and leaves it running: what it wrote once it ends, and a way to end it first. */
  start(file: string, args: string[]): { ended: Promise<string>; stop(): void }
}

export interface Preview extends ThreadRef {
  from: string
  subject: string
}

export interface NoticeDeps {
  runner: Runner
  platform: string
  /** The app's icon, as a file the notification server can read. */
  icon: string
  /** The chime, as a file a player can read. */
  chime: string
  /** Whether new mail makes a sound (Settings, Notifications). */
  sound(): boolean
  /** Electron's notice, as there always was: for several messages, or where actions can't be had. */
  plain(count: number, preview: Preview | undefined, open: () => void): void
  /** Electron's notice for a Summary that landed. */
  plainSummary(count: number, senders: string[], open: () => void): void
  /** Archive or Mark read, as the thread's own buttons do. */
  act(ref: ThreadRef, action: 'archive' | 'read'): void
  /** The window, with the thread open when there's one. */
  open(ref?: ThreadRef): void
  openSummary(): void
  now?: () => number
}

const NOTIFY_SEND = 'notify-send'
const GDBUS = 'gdbus'
/** How long a capabilities answer is trusted: the server can be restarted, or swapped for another. */
const CAPABILITIES_MS = 10 * 60_000
const ASK_MS = 2_000
/** A notice that failed this soon was never shown, so Electron's goes up in its place. */
const FAILED_AT_ONCE_MS = 1_500
/** Notices waiting on a button at once: a server that keeps them until they're dismissed would
 *  otherwise keep one waiting program for each. The oldest stops waiting. */
const MOST_WAITING = 6

const MARKUP: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }
/** A notification server may read the body as markup (mako and Quickshell's do, links and all), and a
 *  subject is a stranger's words. The title is always plain text. */
export const asText = (text: string): string => text.replace(/[&<>]/g, (c) => MARKUP[c] ?? c)

/** What notify-send is run with for one message: Open (a click on the notice), Archive and Mark read,
 *  and the words after `--`, so a subject starting with a dash is still words. */
export function noticeArgs(preview: Preview, icon: string): string[] {
  return [
    '--app-name=xrnmail', `--icon=${icon}`, '--category=email.arrived', '--hint=string:desktop-entry:xrnmail',
    '--action=default=Open', '--action=archive=Archive', '--action=read=Mark read',
    '--', preview.from || 'xrnmail', asText(preview.subject || 'No subject')
  ]
}

/** Whether the server's answer to GetCapabilities, `(['actions', 'body', …],)`, has actions. */
export const hasActions = (answer: string): boolean => /'actions'/.test(answer)

export class Notices {
  private capabilities: { at: number; actions: boolean } | null = null
  private waiting: { stop(): void }[] = []

  constructor(private readonly deps: NoticeDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /** New mail: one message's notice has Archive and Mark read where the desktop shows them. */
  landed(count: number, preview?: Preview): void {
    this.ring()
    const open = (): void => this.deps.open(preview && { account: preview.account, thread: preview.thread })
    if (!preview || count !== 1 || this.deps.platform !== 'linux') return this.deps.plain(count, preview, open)
    void this.withActions().then((yes) => {
      if (!yes) return this.deps.plain(count, preview, open)
      this.show(preview, () => this.deps.plain(count, preview, open))
    })
  }

  summarized(count: number, senders: string[]): void {
    this.ring()
    this.deps.plainSummary(count, senders, () => this.deps.openSummary())
  }

  /** No more waiting on buttons: the app is going. A notice still up stays, and does nothing. */
  stop(): void {
    for (const each of this.waiting.splice(0)) each.stop()
  }

  private ring(): void {
    if (!this.deps.sound() || this.deps.platform !== 'linux') return
    // PipeWire's player, or PulseAudio's where that's what there is.
    this.deps.runner.run('pw-play', [this.deps.chime], 5_000).catch(() =>
      this.deps.runner.run('paplay', [this.deps.chime], 5_000)).catch(() => undefined)
  }

  /** Whether the server shows actions, asked again once the last answer is old. */
  private async withActions(): Promise<boolean> {
    const known = this.capabilities
    if (known && this.now() - known.at < CAPABILITIES_MS) return known.actions
    let actions = false
    try {
      const answer = await this.deps.runner.run(GDBUS, [
        'call', '--session', '--dest', 'org.freedesktop.Notifications', '--object-path', '/org/freedesktop/Notifications',
        '--method', 'org.freedesktop.Notifications.GetCapabilities'
      ], ASK_MS)
      actions = hasActions(answer)
    } catch {
      actions = false // no gdbus, or no server answering: Electron's notice, as before
    }
    this.capabilities = { at: this.now(), actions }
    return actions
  }

  private show(preview: Preview, instead: () => void): void {
    const started = this.now()
    const ref = { account: preview.account, thread: preview.thread }
    const running = this.deps.runner.start(NOTIFY_SEND, noticeArgs(preview, this.deps.icon))
    let stopped = false
    const notice = { stop: () => { stopped = true; running.stop() } }
    this.waiting.push(notice)
    while (this.waiting.length > MOST_WAITING) this.waiting.shift()?.stop()
    running.ended.then((said) => {
      const chosen = said.trim().split('\n').at(-1)
      if (chosen === 'archive' || chosen === 'read') this.deps.act(ref, chosen)
      else if (chosen === 'default') this.deps.open(ref)
    }, () => {
      if (stopped) return
      // It didn't get as far as showing anything: no notify-send, or one too old for actions.
      this.capabilities = null
      if (this.now() - started < FAILED_AT_ONCE_MS) instead()
    }).finally(() => {
      this.waiting = this.waiting.filter((each) => each !== notice)
    })
  }
}

/** The system's own programs, run without a shell, with nothing of the app's environment they
 *  don't need changed. */
export const systemRunner: Runner = {
  run: (file, args, ms) => new Promise((resolve, reject) => {
    execFile(file, args, { timeout: ms, maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))))
  }),
  start: (file, args) => {
    let child: ChildProcess | null = null
    const ended = new Promise<string>((resolve, reject) => {
      child = execFile(file, args, { maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))))
    })
    return { ended, stop: () => void child?.kill() }
  }
}
