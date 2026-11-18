import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { imagesLoad } from '@shared/images'
import type { MessageView, Settings } from '@shared/types'
import { ImapSource } from '@main/source'
import { Store } from '@main/store'
import { syncAccount } from '@main/sync'
import { FakeGmail, rawMail } from './fake-gmail'

const ACCOUNT = 'acct'
const SENDER = 'news@shop.example'
const TRUSTED: Pick<Settings, 'images' | 'imagesFrom'> = { images: 'ask', imagesFrom: [SENDER] }

/** Each is from the trusted sender, its pictures remote. [top] is what the account's own server
 *  wrote above the message; [own] is what the sender wrote among their own headers. */
const MAIL: Record<string, { top: string[]; own?: string[] }> = {
  dmarc: { top: ['Authentication-Results: mx.example.net; spf=pass smtp.mailfrom=bounce@mail.shop.example; dkim=pass header.d=shop.example; dmarc=pass header.from=shop.example'] },
  signed: { top: ['Authentication-Results: mx.example.net; spf=none; dkim=pass header.d=mail.shop.example'] },
  failed: { top: ['Authentication-Results: mx.example.net; spf=fail smtp.mailfrom=x@cheap.example; dkim=fail header.d=shop.example; dmarc=fail header.from=shop.example'] },
  unstamped: { top: ['Received: from cheap.example (cheap.example [192.0.2.7]) by mail.example.net with ESMTPS'] },
  forgedBelow: {
    top: ['Authentication-Results: mx.example.net; spf=softfail smtp.mailfrom=x@cheap.example; dkim=none'],
    own: ['Authentication-Results: mx.example.net; spf=pass smtp.mailfrom=news@shop.example; dkim=pass header.d=shop.example; dmarc=pass header.from=shop.example']
  },
  otherSigner: { top: ['Authentication-Results: mx.example.net; spf=pass smtp.mailfrom=bounce@esp.example; dkim=pass header.d=esp.example; dkim=pass header.d=myshop.example'] }
}

let gmail: FakeGmail
let store: Store
const now = Date.now()

/** A message as the reader gets it, after a real sync into the store. */
const shown = (subject: string): MessageView => {
  const row = store.list({ kind: 'inbox' }, now + 1000).find((r) => r.subject === subject)
  const message = store.thread(ACCOUNT, row?.thread ?? '', now + 1000)[0]
  if (!message) throw new Error(`${subject} wasn't synced`)
  return message
}

beforeAll(async () => {
  gmail = new FakeGmail()
  const port = await gmail.listen()
  store = new Store(':memory:')
  for (const [subject, { top, own = [] }] of Object.entries(MAIL)) {
    const raw = rawMail({ subject, from: `Small Shop <${SENDER}>`, html: '<p>Sale</p><img src="https://cdn.shop.example/sale.png" width="300">', headers: own })
    gmail.add(`${top.join('\n')}\n${raw}`, { arrived: new Date(now - 1000) })
  }
  const source = new ImapSource({ host: '127.0.0.1', port, security: 'none', user: 'me@example.com', secret: gmail.secret })
  await source.connect()
  try {
    await syncAccount(source, store, { account: ACCOUNT, email: 'me@example.com', backfillDays: 30, rules: { times: [], vip: [] }, now })
  } finally {
    await source.close()
  }
})

afterAll(async () => {
  store.close()
  await gmail.stop()
})

describe('pictures from a sender they always load from', () => {
  it('load by themselves when the account\'s server says DMARC passed, or the sender\'s domain signed it', () => {
    expect(imagesLoad(shown('dmarc'), TRUSTED, false)).toBe(true)
    expect(imagesLoad(shown('signed'), TRUSTED, false)).toBe(true)
  })

  it('wait to be asked for when the checks failed', () => {
    expect(imagesLoad(shown('failed'), TRUSTED, false)).toBe(false)
  })

  // A custom server that adds no Authentication-Results: a stranger's From line naming a trusted
  // sender raised no warning, so their pictures loaded, telling them the mail was opened, and where.
  it('wait to be asked for when the server checked nothing', () => {
    expect(imagesLoad(shown('unstamped'), TRUSTED, false)).toBe(false)
  })

  it('wait when only a line the sender wrote, below the server\'s, says it passed', () => {
    expect(imagesLoad(shown('forgedBelow'), TRUSTED, false)).toBe(false)
  })

  it('wait when what passed was a signature by some other domain', () => {
    expect(imagesLoad(shown('otherSigner'), TRUSTED, false)).toBe(false)
  })

  it('load for anyone when Settings say always, and never in Trash or Spam', () => {
    expect(imagesLoad(shown('unstamped'), { images: 'always', imagesFrom: [] }, false)).toBe(true)
    expect(imagesLoad(shown('dmarc'), TRUSTED, true)).toBe(false)
    expect(imagesLoad(shown('dmarc'), { images: 'ask', imagesFrom: [] }, false)).toBe(false)
  })
})
