import { describe, expect, it } from 'vitest'
import { headerDetails, readChecks, readList, readTls } from '@main/details'
import { parseMail } from '@main/parse'
import { rawMail } from './fake-gmail'

describe('what the receiving server wrote', () => {
  it('reads Gmail\'s checks, who mailed it and who signed it', () => {
    const line = 'mx.google.com; dkim=pass header.i=@shop.example header.s=s1 header.b=abc; dkim=pass header.i=@esp.example header.s=k; ' +
      'spf=pass (google.com: domain of bounce@mail.shop.example designates 1.2.3.4 as permitted sender) smtp.mailfrom=bounce@mail.shop.example; ' +
      'dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=shop.example'
    expect(readChecks(line)).toEqual({
      checks: { by: 'mx.google.com', spf: 'pass', dkim: 'pass', dmarc: 'pass' },
      mailedBy: 'mail.shop.example',
      signedBy: ['shop.example', 'esp.example']
    })
  })

  it('reads Microsoft\'s, which name no server', () => {
    const line = 'spf=pass (sender IP is 1.2.3.4) smtp.mailfrom=shop.example; dkim=pass (signature was verified) header.d=shop.example;dmarc=pass action=none header.from=shop.example;compauth=pass reason=100'
    expect(readChecks(line)).toEqual({ checks: { by: '', spf: 'pass', dkim: 'pass', dmarc: 'pass' }, mailedBy: 'shop.example', signedBy: ['shop.example'] })
  })

  it('counts a signature that failed as no signer, and says it failed', () => {
    expect(readChecks('mx.example; dkim=fail header.d=bank.example; spf=softfail smtp.mailfrom=x@cheap.example; dmarc=fail header.from=bank.example')).toEqual({
      checks: { by: 'mx.example', spf: 'softfail', dkim: 'fail', dmarc: 'fail' }, mailedBy: 'cheap.example', signedBy: []
    })
  })

  it('is not fooled by results a sender put in comments or quoted strings', () => {
    const line = 'mx.example; spf=fail (dmarc=pass dkim=pass header.d=bank.example) smtp.mailfrom=x@cheap.example; dkim=none "dkim=pass header.d=bank.example"'
    expect(readChecks(line)).toEqual({ checks: { by: 'mx.example', spf: 'fail', dkim: 'none', dmarc: '' }, mailedBy: 'cheap.example', signedBy: [] })
  })

  it('has nothing to say about a line with no results, or none at all', () => {
    expect(readChecks('')).toEqual({ checks: null, mailedBy: '', signedBy: [] })
    expect(readChecks('mx.example; none')).toEqual({ checks: null, mailedBy: '', signedBy: [] })
  })

  it('reads TLS from the topmost hop that came from somewhere, not from what the sender added below', () => {
    expect(readTls([
      'by 2002:a05:6a10:1234 with SMTP id abc; Tue, 11 Nov 2026 10:00:00 -0800',
      'from mail.shop.example (mail.shop.example. [1.2.3.4]) by mx.google.com with ESMTPS id x for <me@example.com> (version=TLS1_3 cipher=TLS_AES_256_GCM_SHA384 bits=256/256); Tue, 11 Nov 2026',
      'from fake (fake [5.6.7.8]) by mail.shop.example with SMTP'
    ])).toBe('TLS 1.3')
    expect(readTls(['from a.example (a.example [1.2.3.4]) by mx.example (Postfix) with ESMTPS id 1 (using TLSv1.2 with cipher ECDHE)'])).toBe('TLS 1.2')
    expect(readTls(['from a.example by b.example with ESMTPSA id 1'])).toBe('TLS')
    expect(readTls(['from a.example by b.example with SMTP id 1'])).toBe('')
    expect(readTls([])).toBe('')
  })

  it('reads a list\'s name and id', () => {
    expect(readList('"Small Tools" <news.smalltools.example>')).toEqual({ id: 'news.smalltools.example', name: 'Small Tools' })
    expect(readList('<digest.news.example>')).toEqual({ id: 'digest.news.example', name: '' })
    expect(readList('no brackets')).toBeNull()
  })
})

describe('a message\'s facts, from its headers', () => {
  it('takes the top lines, Bcc on your own copy, the address it was delivered to and the date it says', async () => {
    const raw = rawMail({
      from: 'Me <me@example.com>',
      to: 'Ada <ada@example.com>',
      subject: 'Plans',
      date: new Date(Date.UTC(2026, 10, 11, 9, 30)),
      headers: [
        'Bcc: Linh <linh@example.com>',
        'List-Id: "Team" <team.example.com>'
      ]
    })
    const top = [
      'Delivered-To: alias@example.net',
      'Received: from mail.example.com (mail.example.com [1.2.3.4]) by mx.example.net with ESMTPS (version=TLS1_2 cipher=x)',
      'Authentication-Results: mx.example.net; spf=pass smtp.mailfrom=me@example.com; dkim=pass header.d=example.com; dmarc=pass header.from=example.com',
      'Authentication-Results: forged.example; dmarc=fail'
    ].join('\n')
    const parsed = await parseMail(Buffer.from(`${top}\n${raw}`.replace(/\r?\n/g, '\r\n')))
    expect(parsed.details).toEqual({
      bcc: [{ name: 'Linh', address: 'linh@example.com' }],
      deliveredTo: 'alias@example.net',
      checks: { by: 'mx.example.net', spf: 'pass', dkim: 'pass', dmarc: 'pass' },
      mailedBy: 'example.com',
      signedBy: ['example.com'],
      tls: 'TLS 1.2',
      list: { id: 'team.example.com', name: 'Team' },
      sent: Date.UTC(2026, 10, 11, 9, 30)
    })
  })

  it('keeps what it can show to a sensible length, and strips what could disguise it', () => {
    const facts = headerDetails([{ key: 'list-id', line: `List-Id: "Shop\u202e${'x'.repeat(500)}" <list.shop.example>` }], [], undefined)
    expect(facts.list?.name).toHaveLength(120)
    expect(facts.list?.name).not.toContain('\u202e')
    expect(facts.sent).toBeNull()
  })
})
