import { Worker } from 'node:worker_threads'
import { describe, expect, it } from 'vitest'
import { parseMail } from '@main/parse'
import { Parser } from '@main/parser'
import { rawMail } from './fake-gmail'

const RAW = Buffer.from(rawMail({
  from: 'Mai Tran <mai@example.com>',
  subject: 'Plans',
  html: '<p>Thursday works.</p>',
  attachment: { name: 'plan.pdf', type: 'application/pdf', body: 'x'.repeat(100) },
  headers: ['List-Unsubscribe: <https://shop.example/u>', 'Authentication-Results: mx.example.net; dmarc=fail']
}).replace(/\r?\n/g, '\r\n'))

/** A thread that answers as the real one does, with what it's told to. */
const answering = (mail: unknown): Worker => new Worker(
  `const { parentPort } = require('node:worker_threads')
   parentPort.on('message', (job) => parentPort.postMessage({ id: job.id, mail: ${JSON.stringify(mail)} }))`,
  { eval: true }
)

/** A thread that hangs on the first message it's given, as on one built to trip the parser. */
const hanging = (): Worker => new Worker(
  `const { parentPort } = require('node:worker_threads')
   parentPort.on('message', () => { for (;;) {} })`,
  { eval: true }
)

describe('reading mail off the main process', () => {
  it('gives what the thread read, for each message asked for', async () => {
    const parser = new Parser(() => answering({ subject: 'From the thread' }))
    const [one, two] = await Promise.all([parser.parse(RAW), parser.parse(RAW)])
    expect(one.subject).toBe('From the thread')
    expect(two.subject).toBe('From the thread')
    await parser.close()
  })

  it('reads here instead when the thread stops, without losing what it had been given', async () => {
    const parser = new Parser(() => new Worker('process.exit(1)', { eval: true }))
    const read = await Promise.all([parser.parse(RAW), parser.parse(RAW)])
    const here = await parseMail(RAW)
    expect(read).toEqual([here, here])
    expect((await parser.parse(RAW)).subject).toBe('Plans')
  })

  it('gives up on a message that takes too long, as one that can\'t be read, and reads the rest on a new thread', async () => {
    let started = 0
    const parser = new Parser(() => (++started === 1 ? hanging() : answering({ subject: 'From the thread' })), 300)
    const [stuck, behind] = [parser.parse(RAW), parser.parse(RAW)]
    await expect(stuck).rejects.toThrow()
    expect((await behind).subject).toBe('From the thread')
    expect((await parser.parse(RAW)).subject).toBe('From the thread')
    expect(started).toBe(2)
    await parser.close()
  })

  it('reads here when no thread can be started', async () => {
    const parser = new Parser(() => {
      throw new Error('no threads')
    })
    expect((await parser.parse(RAW)).subject).toBe('Plans')
  })

  // The thread hands back a copy, so what it read must come through copying whole.
  it('reads mail into what a copy between threads keeps whole', async () => {
    const mail = await parseMail(RAW)
    expect(mail.warnings).toEqual(['forged'])
    expect(structuredClone(mail)).toEqual(mail)
  })
})
