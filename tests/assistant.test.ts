import { describe, expect, it } from 'vitest'
import { factsOf, sortMail } from '@main/assistant'
import { inviteOf, replyIcs } from '@main/invite'
import { parseMail, senderWarnings } from '@main/parse'
import { rawMail } from './fake-gmail'

const OWN = ['me@example.com']
type Options = Parameters<typeof rawMail>[0]
const mail = (options: Options): ReturnType<typeof parseMail> => parseMail(Buffer.from(rawMail(options)))
const data = (value: unknown, type = 'application/ld+json'): string =>
  `<html><head><script type="${type}">${JSON.stringify(value)}</script></head><body><p>Hello</p></body></html>`
const facts = async (options: Options): Promise<ReturnType<typeof factsOf>> => factsOf(await mail(options), OWN)

describe('facts a sender put there on purpose', () => {
  it('reads a parcel', async () => {
    const found = await facts({ html: data({
      '@context': 'http://schema.org', '@type': 'ParcelDelivery', carrier: { name: 'ups' }, trackingNumber: '1Z999AA10123456784',
      expectedArrivalUntil: '2026-11-09T12:00:00Z'
    }) })
    expect(found).toMatchObject({ type: 'package', carrier: 'UPS', tracking: '1Z999AA10123456784', arrives: Date.parse('2026-11-09T12:00:00Z') })
    expect(found?.type === 'package' && found.url).toMatch(/^https:\/\/www\.ups\.com\//)
  })

  it('reads a flight', async () => {
    expect(await facts({ html: data({
      '@type': 'FlightReservation', reservationNumber: 'ABC123',
      reservationFor: {
        airline: { name: 'Vietnam Airlines', iataCode: 'VN' }, flightNumber: '245',
        departureAirport: { iataCode: 'HAN' }, arrivalAirport: { iataCode: 'SGN' }, departureTime: '2026-12-01T01:00:00Z'
      }
    }) })).toMatchObject({ type: 'travel', title: 'Vietnam Airlines VN245', code: 'ABC123', when: Date.parse('2026-12-01T01:00:00Z'), detail: 'HAN to SGN' })
  })

  it('reads a hotel, an order and a bill', async () => {
    expect(await facts({ html: data({ '@type': 'LodgingReservation', reservationNumber: 'H1', reservationFor: { name: 'Hotel Metropole' }, checkinDate: '2026-12-01' }) }))
      .toMatchObject({ type: 'travel', title: 'Hotel Metropole', code: 'H1' })
    expect(await facts({ from: 'Shop <shop@example.com>', html: data({ '@type': 'Order', priceCurrency: 'USD', price: 42.5 }) }))
      .toMatchObject({ type: 'money', what: 'receipt', merchant: 'Shop', amount: 'USD 42.5' })
    expect(await facts({ html: data({ '@type': 'Invoice', provider: { name: 'EVN' }, totalPaymentDue: { price: 120000, priceCurrency: 'VND' }, paymentDueDate: '2026-12-05' }) }))
      .toMatchObject({ type: 'money', what: 'bill', merchant: 'EVN', amount: 'VND 120000', due: Date.parse('2026-12-05') })
  })

  it('finds them inside a list or a graph', async () => {
    const parcel = { '@type': 'ParcelDelivery', trackingNumber: 'ABC12345', carrier: 'Viettel Post' }
    expect((await facts({ html: data([{ '@type': 'Thing' }, parcel]) }))?.type).toBe('package')
    expect((await facts({ html: data({ '@graph': [parcel] }) }))?.type).toBe('package')
  })

  it('counts them even in a newsletter, since they say what they mean', async () => {
    expect((await facts({
      headers: ['List-Unsubscribe: <https://x.example/u>'],
      html: data({ '@type': 'ParcelDelivery', trackingNumber: 'ABC12345', carrier: 'DHL' })
    }))?.type).toBe('package')
  })

  it('never takes a link from the message', async () => {
    const found = await facts({ html: data({
      '@type': 'ParcelDelivery', carrier: 'UPS', trackingNumber: 'x"><img src=x onerror=alert(1)>',
      trackingUrl: 'javascript:alert(1)', url: 'https://evil.example/'
    }) })
    expect(found).toMatchObject({ type: 'package', url: null })
    const unknown = await facts({ html: data({ '@type': 'ParcelDelivery', carrier: 'Evil Co', trackingNumber: 'ABC12345', trackingUrl: 'https://evil.example/' }) })
    expect(unknown).toMatchObject({ url: null })
  })

  it('keeps a stranger\'s words short', async () => {
    const found = await facts({ html: data({ '@type': 'LodgingReservation', reservationFor: { name: 'x'.repeat(9000) } }) })
    expect(found?.type === 'travel' && found.title.length).toBe(200)
  })

  it('takes nothing from broken data, odd shapes or real scripts', async () => {
    expect(await facts({ html: '<script type="application/ld+json">{ not json</script>' })).toBeNull()
    expect(await facts({ html: data(null) })).toBeNull()
    expect(await facts({ html: data([1, 'two', null, [3]]) })).toBeNull()
    expect(await facts({ html: data({ '@type': ['Order'], reservationFor: 7, trackingNumber: {} }) })).toBeNull()
    expect(await facts({ html: data({ '@type': 'ParcelDelivery', trackingNumber: 'ABC12345' }, 'text/javascript') })).toBeNull()
  })
})

describe('what can be worked out from the words', () => {
  it('finds a tracking number only in mail about shipping', async () => {
    expect(await facts({ subject: 'Your order has shipped', text: 'Number 1Z999AA10123456784' })).toMatchObject({ type: 'package', carrier: 'UPS' })
    expect(await facts({ subject: 'Your parcel', text: 'Sent by FedEx, number 123456789012' })).toMatchObject({ carrier: 'FedEx' })
    expect(await facts({ subject: 'Lunch', text: 'Number 1Z999AA10123456784' })).toBeNull()
    expect(await facts({ subject: 'Your parcel', text: 'Reference 123456789012' })).toBeNull()
  })

  it('reads Vietnamese', async () => {
    expect(await facts({ subject: 'Đơn hàng đang giao', text: 'Mã vận đơn: GHN12345678' })).toMatchObject({ type: 'package', tracking: 'GHN12345678' })
    expect(await facts({ subject: 'Xác nhận đơn hàng', text: 'Tổng cộng: 250.000₫' })).toMatchObject({ type: 'money', what: 'receipt', amount: '250.000₫' })
    expect(await facts({ subject: 'Vé máy bay của bạn', text: 'Mã đặt chỗ: XY12Z' })).toMatchObject({ type: 'travel', code: 'XY12Z' })
  })

  it('reads receipts and bills', async () => {
    expect(await facts({ subject: 'Your receipt', from: 'Cafe <hi@cafe.example>', text: 'Tip $1.00\nTotal: $42.50' })).toMatchObject({ what: 'receipt', merchant: 'Cafe', amount: '$42.50' })
    expect(await facts({ subject: 'Your bill is ready', text: 'Amount due 120.000 VND' })).toMatchObject({ what: 'bill', amount: '120.000 VND' })
    expect(await facts({ subject: 'Your receipt', text: 'No figures in here' })).toBeNull()
  })

  it('reads a booking', async () => {
    expect(await facts({ subject: 'Your flight VN245', text: 'Booking reference: ABC123' })).toMatchObject({ type: 'travel', title: 'VN245', code: 'ABC123' })
  })

  it('believes none of it from a newsletter', async () => {
    const options = { subject: 'Your order has shipped', text: '1Z999AA10123456784' }
    expect(await facts({ ...options, headers: ['List-Unsubscribe: <https://x.example/u>'] })).toBeNull()
    expect(await facts({ ...options, headers: ['Precedence: bulk'] })).toBeNull()
  })
})

describe('Focused and Other', () => {
  const sorted = async (options: Options, rule: boolean | null = null, known = false): Promise<boolean> =>
    sortMail(await mail(options), OWN, rule, known).focused
  const list = ['List-Unsubscribe: <https://x.example/u>']

  it('keeps people, and sets aside what\'s sent to everyone', async () => {
    expect(await sorted({})).toBe(true)
    expect(await sorted({ headers: list })).toBe(false)
    expect(await sorted({ headers: ['Precedence: list'] })).toBe(false)
    expect(await sorted({ from: 'Deals <no-reply@shop.example>' })).toBe(false)
    expect(await sorted({ from: 'Shop <newsletter@shop.example>' })).toBe(false)
  })

  it('keeps someone you\'ve written to, and anything the Assistant understood', async () => {
    expect(await sorted({ from: 'Bo <no-reply@bo.example>' }, null, true)).toBe(true)
    expect(await sorted({ from: 'Shop <no-reply@shop.example>', subject: 'Your receipt', text: 'Total: $4.00' })).toBe(true)
  })

  it('lets what you said win', async () => {
    expect(await sorted({ headers: list }, true)).toBe(true)
    expect(await sorted({}, false)).toBe(false)
    expect(await sorted({ subject: 'Your receipt', text: 'Total: $4.00' }, false)).toBe(false)
  })
})

describe('warnings about a sender', () => {
  const warned = async (options: Options): Promise<string[]> => (await mail(options)).warnings

  it('says nothing about ordinary mail, and never vouches for it', async () => {
    expect(await warned({ headers: ['Authentication-Results: mx.google.com; dkim=pass; spf=pass; dmarc=pass'] })).toEqual([])
    expect(await warned({})).toEqual([])
  })

  it('catches failed checks', async () => {
    expect(await warned({ headers: ['Authentication-Results: mx; dmarc=fail'] })).toEqual(['forged'])
    expect(await warned({ headers: ['Authentication-Results: mx; dkim=fail; spf=fail'] })).toEqual(['forged'])
    expect(await warned({ headers: ['Authentication-Results: mx; dkim=pass; spf=fail'] })).toEqual([])
  })

  it('trusts only the receiving server\'s line, which is on top', async () => {
    expect(await warned({ headers: ['Authentication-Results: mx; dmarc=pass', 'Authentication-Results: evil; dmarc=fail'] })).toEqual([])
    expect(await warned({ headers: ['Authentication-Results: mx; dmarc=fail', 'Authentication-Results: evil; dmarc=pass'] })).toEqual(['forged'])
  })

  it('catches a name showing another address', async () => {
    expect(await warned({ from: '"support@bigbank.example" <x@evil.example>' })).toEqual(['name-mismatch'])
    expect(await warned({ from: '"ada@example.com" <ADA@example.com>' })).toEqual([])
  })

  it('catches lookalike domains', async () => {
    expect(await warned({ from: 'Bank <x@xn--bgbank-9ya.example>' })).toEqual(['lookalike'])
  })

  it('catches replies going elsewhere, but not from lists or within a domain', async () => {
    expect(await warned({ from: 'Ada <ada@example.com>', headers: ['Reply-To: x@evil.example'] })).toEqual(['replies-elsewhere'])
    expect(await warned({ from: 'Ada <ada@example.com>', headers: ['Reply-To: x@help.example.com'] })).toEqual([])
    expect(await warned({ from: 'Ada <ada@example.com>', headers: ['Reply-To: x@evil.example', 'List-Id: <a.example>'] })).toEqual([])
  })

  it('is a pure reading of what it was given', () => {
    expect(senderWarnings({ from: { name: '', address: '' }, replyTo: [], authentication: '', bulk: false })).toEqual([])
  })
})

const ICS = [
  'BEGIN:VCALENDAR', 'METHOD:REQUEST', 'BEGIN:VEVENT', 'UID:abc@cal.example', 'SEQUENCE:2',
  'DTSTART:20261201T090000Z', 'DTEND:20261201T100000Z', 'SUMMARY:Budget\\, final', 'LOCATION:Room 1',
  'ORGANIZER;CN="Boss: Ada":mailto:Boss@cal.example', 'ATTENDEE;CN=Me;RSVP=TRUE:mailto:ME@example.com', 'END:VEVENT', 'END:VCALENDAR'
].join('\r\n')

describe('calendar invitations', () => {
  it('reads what matters, with quoted colons and escapes', () => {
    expect(inviteOf(ICS)).toEqual({
      method: 'REQUEST', uid: 'abc@cal.example', sequence: 2, summary: 'Budget, final', location: 'Room 1',
      organizer: 'boss@cal.example', organizerName: 'Boss: Ada', attendees: ['me@example.com'],
      start: Date.UTC(2026, 11, 1, 9), end: Date.UTC(2026, 11, 1, 10)
    })
  })

  it('joins folded lines', () => {
    expect(inviteOf(ICS.replace('SUMMARY:Budget', 'SUMMARY:Bud\r\n get'))?.summary).toBe('Budget, final')
  })

  it('reads a named zone and a whole day', () => {
    expect(inviteOf(ICS.replace('DTSTART:20261201T090000Z', 'DTSTART;TZID=Asia/Ho_Chi_Minh:20261201T090000'))?.start).toBe(Date.UTC(2026, 11, 1, 2))
    expect(inviteOf(ICS.replace('DTSTART:20261201T090000Z', 'DTSTART;TZID=America/New_York:20260701T090000'))?.start).toBe(Date.UTC(2026, 6, 1, 13))
    expect(inviteOf(ICS.replace('DTSTART:20261201T090000Z', 'DTSTART;VALUE=DATE:20261201'))?.start).toBe(new Date(2026, 11, 1).getTime())
  })

  it('survives nonsense', () => {
    expect(inviteOf('')).toBeNull()
    expect(inviteOf('garbage\nBEGIN:VCALENDAR')).toBeNull()
    expect(inviteOf('BEGIN:VEVENT')?.start).toBeNull()
    expect(inviteOf(ICS.replace('DTSTART:20261201T090000Z', 'DTSTART;TZID=Mars/Olympus:notatime'))?.start).toBeNull()
    expect(inviteOf(ICS.replace('DTSTART:20261201T090000Z', 'DTSTART;TZID=Mars/Olympus:20261201T090000'))?.start).toBeTypeOf('number')
    expect(inviteOf(ICS.replace('SEQUENCE:2', 'SEQUENCE:1e999'))?.sequence).toBe(0)
  })

  const invited = (ics: string): Options => ({ subject: 'Invitation', attachment: { name: 'invite.ics', type: 'text/calendar', body: ics } })

  it('turns one into an event that can be answered', async () => {
    expect(await facts(invited(ICS))).toMatchObject({
      type: 'event', title: 'Budget, final', location: 'Room 1', organizer: 'Boss: Ada',
      invite: { uid: 'abc@cal.example', sequence: 2, organizer: 'boss@cal.example', attendee: 'me@example.com' }
    })
  })

  it('finds one sent the way calendars send them: a part with no file name', async () => {
    const raw = [
      'From: Ada <ada@example.com>', 'To: me@example.com', 'Subject: Invitation', 'MIME-Version: 1.0',
      'Content-Type: multipart/alternative; boundary="b"', '', '--b', 'Content-Type: text/plain', '', 'See the invitation', '--b',
      'Content-Type: text/calendar; charset=UTF-8; method=REQUEST', '', ICS, '--b--', ''
    ].join('\r\n')
    expect(factsOf(await parseMail(Buffer.from(raw)), OWN)).toMatchObject({ type: 'event', invite: { organizer: 'boss@cal.example' } })
  })

  it('answers as the alias it was sent to', async () => {
    const found = factsOf(await mail(invited(ICS.replace('ME@example.com', 'alias@example.com'))), [...OWN, 'alias@example.com'])
    expect(found?.type === 'event' && found.invite?.attendee).toBe('alias@example.com')
  })

  it('shows one that asks nothing, without a way to answer', async () => {
    expect(await facts(invited(ICS.replace('METHOD:REQUEST', 'METHOD:PUBLISH')))).toMatchObject({ type: 'event', invite: null })
  })

  it('won\'t answer an organizer that is more than one plain address', async () => {
    expect(await facts(invited(ICS.replace('mailto:Boss@cal.example', 'mailto:a@x.example, b@y.example')))).toMatchObject({ invite: null })
    expect(await facts(invited(ICS.replace('mailto:Boss@cal.example', 'mailto:not an address')))).toMatchObject({ invite: null })
  })

  it('sends back only what it should, and a hostile field can\'t add a line', () => {
    const reply = replyIcs({ uid: 'x\r\nATTENDEE:mailto:evil@x.example', sequence: 2, summary: 'a;b,c\\d\nORGANIZER:evil', stamp: '20261201T090000Z' }, 'me@example.com', 'ACCEPTED', Date.UTC(2026, 10, 6))
    const lines = reply.split('\r\n')
    expect(lines).toContain('METHOD:REPLY')
    expect(lines).toContain('ATTENDEE;PARTSTAT=ACCEPTED:mailto:me@example.com')
    expect(lines.filter((l) => l.startsWith('ATTENDEE'))).toHaveLength(1)
    expect(lines.filter((l) => l.startsWith('ORGANIZER'))).toEqual([])
    const slash = '\\'
    expect(lines).toContain(`SUMMARY:a${slash};b${slash},c${slash}${slash}d ORGANIZER:evil`)
  })
})

describe('one message can\'t stall the app', () => {
  const quickly = async (work: () => unknown): Promise<void> => {
    const started = performance.now()
    await work()
    expect(performance.now() - started).toBeLessThan(8000) // each of these took minutes when it was quadratic
  }

  it('in its HTML', async () => {
    const parsed = await mail({ subject: 'x', text: 'x' })
    await quickly(() => factsOf({ ...parsed, html: '<script '.repeat(270_000) }, OWN))
    await quickly(() => factsOf({ ...parsed, html: `${'<script type="application/ld+json">'.repeat(60_000)}` }, OWN))
    await quickly(() => factsOf({ ...parsed, html: '<script type="application/ld+json">[]</script>'.repeat(40_000) }, OWN))
  })

  it('in an invitation', async () => {
    await quickly(() => inviteOf(`BEGIN:VEVENT\n${':'.repeat(255_000)}"\nEND:VEVENT`))
    await quickly(() => inviteOf(`BEGIN:VEVENT\nX${';a=b'.repeat(60_000)}:y\nEND:VEVENT`))
  })

  it('in a sender\'s name', async () => {
    await quickly(() => senderWarnings({ from: { name: 'a'.repeat(2_000_000), address: 'a@b.example' }, replyTo: [], authentication: '', bulk: false }))
  })

  it('in its words', async () => {
    const parsed = await mail({ subject: 'Your order has shipped: receipt, bill', text: 'x' })
    await quickly(() => factsOf({ ...parsed, subject: `Your receipt ${'1.'.repeat(1_000_000)}`, text: '1.'.repeat(250_000) }, OWN))
  })
})
