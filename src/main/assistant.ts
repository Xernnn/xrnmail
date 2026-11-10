import type { Facts } from '@shared/types'
import { icsStampOf } from './invite'
import type { ParsedMail } from './parse'
import { trackingUrl } from './safe-url'

/**
 * Sorting and finding, from what's in a message and nothing else: no server of ours reads your mail,
 * and that's the difference from the apps this replaces. Airlines, hotels and shops often put
 * machine-readable facts in their mail for inboxes to use, so those come first. Patterns come after,
 * kept strict, because a wrong entry in the Assistant is worse than a missing one.
 *
 * A stranger can write anything here, so all of it is only ever shown as text. It can't open a link:
 * "Track" goes to an address built here.
 */

type Json = Record<string, unknown>

const MAX_BLOCKS = 8
const FIELD = 200

const str = (value: unknown): string => (typeof value === 'string' || typeof value === 'number' ? String(value).trim().slice(0, FIELD) : '')
const obj = (value: unknown): Json => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {})

/** A schema.org name, which may be a plain string or an object with a name. */
const nameIn = (value: unknown): string => (typeof value === 'string' ? str(value) : str(obj(value)['name']))

function time(value: unknown): number | null {
  const at = Date.parse(str(value))
  return Number.isNaN(at) ? null : at
}

/** Script blocks that say they're schema.org data. A stranger writes this HTML, so each pattern is
 *  bounded and the walk only goes forward: anything that backtracks over two megabytes of it would
 *  let one message hang the whole app. */
function dataBlocks(html: string): string[] {
  const blocks: string[] = []
  const open = /<script\b[^>]{0,200}>/gi
  const close = /<\/script/gi
  for (let tag = open.exec(html); tag && blocks.length < MAX_BLOCKS; tag = open.exec(html)) {
    close.lastIndex = open.lastIndex
    const end = close.exec(html)
    if (!end) break
    if (/application\/ld\+json/i.test(tag[0])) blocks.push(html.slice(open.lastIndex, end.index))
    open.lastIndex = close.lastIndex
  }
  return blocks
}

/** Every schema.org object in a message's HTML. It's data: parsed, never run. */
export function linkedData(html: string | null): Json[] {
  if (!html) return []
  const found: Json[] = []
  for (const body of dataBlocks(html)) {
    try {
      const parsed = JSON.parse(body.trim()) as unknown
      const graph = obj(parsed)['@graph']
      found.push(...[Array.isArray(parsed) ? parsed : Array.isArray(graph) ? graph : [parsed]].flat().map(obj))
    } catch {
      // Not valid, so not there.
    }
  }
  return found
}

const typeOf = (item: Json): string => str(item['@type']).replace(/^.*[/:]/, '')

function fromLinkedData(items: Json[], merchantHint: string): Facts | null {
  for (const item of items) {
    const type = typeOf(item)
    const about = obj(item['reservationFor'])
    const code = str(item['reservationNumber'])
    if (type === 'ParcelDelivery') {
      const carrier = nameIn(item['carrier']) || nameIn(item['provider'])
      const tracking = str(item['trackingNumber'])
      if (tracking) {
        const known = ['UPS', 'USPS', 'FedEx', 'DHL'].find((c) => c.toLowerCase() === carrier.toLowerCase()) ?? carrier
        return { type: 'package', carrier: known, tracking, arrives: time(item['expectedArrivalUntil'] ?? item['expectedArrivalFrom']), url: trackingUrl(known, tracking) }
      }
    }
    if (type === 'FlightReservation') {
      const airline = obj(about['airline'])
      const flight = `${str(airline['iataCode'])}${str(about['flightNumber'])}`
      const from = str(obj(about['departureAirport'])['iataCode'])
      const to = str(obj(about['arrivalAirport'])['iataCode'])
      return { type: 'travel', title: [str(airline['name']), flight].filter(Boolean).join(' ') || 'Flight', code, when: time(about['departureTime']), detail: from && to ? `${from} to ${to}` : '' }
    }
    if (type === 'LodgingReservation') {
      return { type: 'travel', title: nameIn(about) || 'Hotel', code, when: time(item['checkinTime'] ?? item['checkinDate']), detail: '' }
    }
    if (type === 'TrainReservation' || type === 'BusReservation' || type === 'RentalCarReservation') {
      return { type: 'travel', title: nameIn(about) || 'Trip', code, when: time(about['departureTime'] ?? item['pickupTime']), detail: '' }
    }
    if (type === 'EventReservation' || type === 'FoodEstablishmentReservation') {
      return { type: 'event', title: nameIn(about) || 'Reservation', start: time(about['startDate'] ?? item['startTime']), end: time(about['endDate']), location: nameIn(about['location']), organizer: '', invite: null }
    }
    if (type === 'Invoice') {
      const due = obj(item['totalPaymentDue'])
      return { type: 'money', what: 'bill', merchant: nameIn(item['provider']) || merchantHint, amount: [str(due['priceCurrency']), str(due['price'])].filter(Boolean).join(' '), due: time(item['paymentDueDate']) }
    }
    if (type === 'Order') {
      return { type: 'money', what: 'receipt', merchant: nameIn(item['merchant'] ?? item['seller']) || merchantHint, amount: [str(item['priceCurrency']), str(item['price'])].filter(Boolean).join(' '), due: null }
    }
  }
  return null
}

const SHIPPING = /\b(shipped|shipment|on its way|out for delivery|delivered|delivery|tracking|package|parcel)\b|đang giao|giao hàng|vận đơn/i
const TRAVEL = /\b(flight|itinerary|e-?ticket|boarding pass|booking confirmation|reservation confirmation|hotel|check-?in)\b|vé máy bay|đặt phòng|hành trình|mã đặt chỗ/i
const RECEIPT = /\b(receipt|invoice|order confirmation|your order|payment (received|confirmation)|thanks for your (order|purchase))\b|hóa đơn|biên lai|xác nhận đơn hàng/i
const BILL = /\b(bill|statement|amount due|payment due)\b|đến hạn thanh toán/i

const CARRIERS: { name: string; number: RegExp; needs?: RegExp }[] = [
  { name: 'UPS', number: /\b1Z[0-9A-Z]{16}\b/ },
  { name: 'USPS', number: /\b9[2-5]\d{20}\b/ },
  { name: 'Amazon', number: /\bTBA\d{12}\b/ },
  { name: 'FedEx', number: /\b\d{12}(?:\d{3})?\b/, needs: /fedex/i },
  { name: 'DHL', number: /\b\d{10}\b/, needs: /\bdhl\b/i }
]
const LABELLED_TRACKING = /(?:tracking (?:number|no\.?|code|id)|tracking #|mã vận đơn|mã theo dõi)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{7,30})/i
const BOOKING_CODE = /(?:confirmation|booking|reservation)\s*(?:code|number|no\.?|#|reference)\s*[:#]?\s*([A-Z0-9]{5,8})\b|(?:mã đặt chỗ|PNR)\s*[:#]?\s*([A-Z0-9]{5,8})\b/i
const FLIGHT = /\b([A-Z]{2}|[A-Z]\d|\d[A-Z])\s?(\d{2,4})\b/
const MONEY = /(?:[$€£₫]\s?\d[\d.,]*|\b\d[\d.,]*\s?(?:USD|EUR|GBP|VND|₫|đ)(?![\p{L}]))/u
const TOTAL = /(?:total|amount due|amount|balance|tổng cộng|thành tiền|số tiền)[^\d$€£₫\n]{0,24}/i

const merchantOf = (mail: ParsedMail): string => mail.from.name || (mail.from.address.split('@')[1] ?? '')

function amountIn(text: string): string {
  const total = TOTAL.exec(text)
  const after = total ? MONEY.exec(text.slice(total.index, total.index + 80)) : null
  return (after ?? MONEY.exec(text))?.[0]?.trim() ?? ''
}

function fromText(mail: ParsedMail): Facts | null {
  const both = `${mail.subject.slice(0, 500)}\n${mail.text.slice(0, 6000)}`
  if (SHIPPING.test(mail.subject)) {
    for (const carrier of CARRIERS) {
      const number = carrier.number.exec(both)?.[0]
      if (number && (!carrier.needs || carrier.needs.test(both))) {
        return { type: 'package', carrier: carrier.name, tracking: number, arrives: null, url: trackingUrl(carrier.name, number) }
      }
    }
    const labelled = LABELLED_TRACKING.exec(both)?.[1]
    if (labelled) return { type: 'package', carrier: merchantOf(mail), tracking: labelled, arrives: null, url: null }
  }
  if (TRAVEL.test(mail.subject)) {
    const booking = BOOKING_CODE.exec(both)
    const code = booking?.[1] ?? booking?.[2] ?? ''
    const flight = FLIGHT.exec(mail.subject)
    if (code || flight) return { type: 'travel', title: flight ? `${flight[1]}${flight[2]}` : mail.subject.slice(0, 80), code, when: null, detail: merchantOf(mail) }
  }
  if (BILL.test(mail.subject)) {
    const amount = amountIn(both)
    if (amount) return { type: 'money', what: 'bill', merchant: merchantOf(mail), amount, due: null }
  }
  if (RECEIPT.test(mail.subject)) {
    const amount = amountIn(both)
    if (amount) return { type: 'money', what: 'receipt', merchant: merchantOf(mail), amount, due: null }
  }
  return null
}

/** One plain address and nothing else, since the answer is sent to it. */
const PLAIN_ADDRESS = /^[^@\s<>,;"]+@[^@\s<>,;"]+\.[^@\s<>,;"]+$/

function fromInvite(mail: ParsedMail, own: string[]): Facts | null {
  const invite = mail.invite
  if (!invite || invite.start === null) return null
  const asked = invite.method === 'REQUEST' && Boolean(invite.uid) && PLAIN_ADDRESS.test(invite.organizer)
  const attendee = invite.attendees.find((a) => own.includes(a)) ?? own[0] ?? ''
  return {
    type: 'event',
    title: invite.summary || mail.subject,
    start: invite.start,
    end: invite.end,
    location: invite.location,
    organizer: invite.organizerName || invite.organizer,
    invite: asked ? { uid: invite.uid, sequence: invite.sequence, organizer: invite.organizer, attendee, summary: invite.summary, stamp: icsStampOf(invite.start) } : null
  }
}

/** Mail with these headers is a broadcast, so its words prove nothing about you. Facts a sender put
 *  there on purpose still count: they say what they mean. [own] is every address of the account. */
export function factsOf(mail: ParsedMail, own: string[]): Facts | null {
  const fromInviteOrData = fromInvite(mail, own) ?? fromLinkedData(linkedData(mail.html), merchantOf(mail))
  if (fromInviteOrData) return fromInviteOrData
  return mail.bulk || mail.unsubscribe ? null : fromText(mail)
}

const ROBOT = /^(no-?reply|do-?not-?reply|notifications?|newsletters?|marketing|mailer-daemon|updates?|news|promo(tions?)?|offers?|deals?|bounces?)\b/i

export interface Sorted {
  focused: boolean
  facts: Facts | null
}

/** Edison's split of the inbox, decided here instead of on a server. [rule] is what the person said
 *  about this sender, and [known] is someone they've written to. */
export function sortMail(mail: ParsedMail, own: string[], rule: boolean | null, known: boolean): Sorted {
  const facts = factsOf(mail, own)
  const robot = mail.bulk || mail.unsubscribe !== null || ROBOT.test(mail.from.address)
  return { facts, focused: rule ?? (Boolean(facts) || known || !robot) }
}
