import type { Worker } from 'node:worker_threads'
import { parseMail, type ParsedMail } from './parse'

interface Job {
  source: Buffer
  resolve(mail: ParsedMail): void
  reject(e: Error): void
}

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

  constructor(private readonly start: () => Worker) {}

  readonly parse = (source: Buffer): Promise<ParsedMail> => {
    const worker = this.ready()
    if (!worker) return parseMail(source)
    const id = this.next++
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { source, resolve, reject })
      worker.postMessage({ id, source })
    })
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
      if (answer.mail) job.resolve(answer.mail)
      else job.reject(new Error(answer.error ?? "This message couldn't be read."))
    })
    const lost = (): void => {
      this.failed = true
      this.worker = null
      // What it hadn't answered yet is read here instead.
      const left = [...this.waiting.values()]
      this.waiting.clear()
      for (const job of left) parseMail(job.source).then(job.resolve, job.reject)
    }
    worker.on('error', lost)
    worker.on('exit', lost)
    this.worker = worker
    return worker
  }
}
