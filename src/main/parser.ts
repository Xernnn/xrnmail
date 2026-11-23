import type { Worker } from 'node:worker_threads'
import { parseMail, type ParsedMail } from './parse'

interface Job {
  source: Buffer
  resolve(mail: ParsedMail): void
  reject(e: Error): void
  timer: NodeJS.Timeout | null
}

/** How long a message may take to be read on the thread. A large newsletter takes a fraction of a
 *  second; past this the thread is taken to be stuck on it. */
export const PARSE_MS = 20_000

/**
 * Mail read on a thread of its own. The main process answers every request the windows make, and
 * reading a large newsletter there took a tenth of a second or more, so a first sync or a long
 * backfill, reading thousands, made typing and scrolling stutter. If the thread can't be started,
 * or stops, mail is read on the main process again, as it always was, so nothing is lost by it.
 */
export class Parser {
  private worker: Worker | null = null
  private failed = false
  private next = 0
  private readonly waiting = new Map<number, Job>()

  constructor(private readonly start: () => Worker, private readonly limit = PARSE_MS) {}

  readonly parse = (source: Buffer): Promise<ParsedMail> => {
    const worker = this.ready()
    if (!worker) return parseMail(source)
    const id = this.next++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.stuck(id), this.limit)
      timer.unref?.()
      this.waiting.set(id, { source, resolve, reject, timer })
      worker.postMessage({ id, source })
    })
  }

  /** A message read for too long has the thread stuck on it, and every message after it waiting,
   *  which held its account's sync, and everything behind that, until the app was restarted. It's
   *  given up on, so it's kept as one that can't be read, as other failures are, and isn't tried
   *  here on the main process, where it would hang the app. The thread goes, and what it had left
   *  goes to a new one. */
  private stuck(id: number): void {
    const job = this.waiting.get(id)
    if (!job) return
    this.waiting.delete(id)
    job.reject(new Error('This message took too long to read.'))
    const worker = this.worker
    this.worker = null
    const left = [...this.waiting.values()]
    this.waiting.clear()
    if (worker) {
      worker.removeAllListeners()
      worker.on('error', () => undefined)
      void worker.terminate()
    }
    for (const other of left) {
      if (other.timer) clearTimeout(other.timer)
      this.parse(other.source).then(other.resolve, other.reject)
    }
  }

  /** Lets the thread go, at quit. */
  async close(): Promise<void> {
    const worker = this.worker
    this.failed = true
    if (worker) await worker.terminate()
  }

  private ready(): Worker | null {
    if (this.failed) return null
    if (this.worker) return this.worker
    let worker: Worker
    try {
      worker = this.start()
    } catch {
      this.failed = true
      return null
    }
    // It never keeps the app open by itself.
    worker.unref()
    worker.on('message', (answer: { id: number; mail?: ParsedMail; error?: string }) => {
      const job = this.waiting.get(answer.id)
      if (!job) return
      this.waiting.delete(answer.id)
      if (job.timer) clearTimeout(job.timer)
      if (answer.mail) job.resolve(answer.mail)
      else job.reject(new Error(answer.error ?? "This message couldn't be read."))
    })
    const lost = (): void => {
      this.failed = true
      this.worker = null
      // What it hadn't answered yet is read here instead.
      const left = [...this.waiting.values()]
      this.waiting.clear()
      for (const job of left) {
        if (job.timer) clearTimeout(job.timer)
        parseMail(job.source).then(job.resolve, job.reject)
      }
    }
    worker.on('error', lost)
    worker.on('exit', lost)
    this.worker = worker
    return worker
  }
}
