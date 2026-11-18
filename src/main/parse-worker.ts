import { parentPort } from 'node:worker_threads'
import { parseMail } from './parse'

/** Reads mail on a thread of its own (see parser.ts). Each message comes with its number, and its
 *  answer goes back with the same number. */
parentPort?.on('message', (job: { id: number; source: Uint8Array }) => {
  parseMail(Buffer.from(job.source.buffer, job.source.byteOffset, job.source.byteLength)).then(
    (mail) => parentPort?.postMessage({ id: job.id, mail }),
    (e: unknown) => parentPort?.postMessage({ id: job.id, error: e instanceof Error ? e.message : String(e) })
  )
})
