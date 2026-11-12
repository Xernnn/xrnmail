import { describe, expect, it } from 'vitest'
import { holdOf, isTime, isVip, nextBatchAfter, nextSummaryAfter, releaseAt, type BatchRules, type SummaryRules } from '@main/batches'

const at = (day: number, hour: number, minute = 0): number => new Date(2026, 10, day, hour, minute).getTime()
const TIMES = ['09:00', '13:00', '17:00']
const RULES: BatchRules = { times: TIMES, vip: [] }
const HOLD_FROM = at(1, 0)

describe('nextBatchAfter', () => {
  it('finds the next slot today', () => expect(nextBatchAfter(at(6, 10), TIMES)).toBe(at(6, 13)))
  it('rolls to tomorrow after the last slot', () => expect(nextBatchAfter(at(6, 18), TIMES)).toBe(at(7, 9)))
  it('is strictly after: exactly on a slot waits for the next', () => expect(nextBatchAfter(at(6, 13), TIMES)).toBe(at(6, 17)))
  it('sorts the times it is given', () => expect(nextBatchAfter(at(6, 10), ['17:00', '09:00', '13:00'])).toBe(at(6, 13)))
  it('skips times that make no sense', () => expect(nextBatchAfter(at(6, 10), ['25:00', 'noon', '13:00'])).toBe(at(6, 13)))
  it('no times means no batching', () => expect(nextBatchAfter(at(6, 10), [])).toBeNull())
  it('rolls over a month end', () => {
    expect(nextBatchAfter(new Date(2026, 10, 30, 22).getTime(), TIMES)).toBe(new Date(2026, 11, 1, 9).getTime())
  })
})

describe('isTime', () => {
  it('takes HH:MM only', () => {
    expect(['09:00', '23:59', '00:00'].every(isTime)).toBe(true)
    expect(['9:00', '24:00', '12:60', 'x', ''].some(isTime)).toBe(false)
  })
})

describe('isVip', () => {
  it('matches an address, any case', () => expect(isVip('Boss@Work.com', ['boss@work.com'])).toBe(true))
  it('matches a whole domain', () => expect(isVip('a@uts.edu.au', ['@uts.edu.au'])).toBe(true))
  it('a domain does not cover its subdomains', () => expect(isVip('a@student.uts.edu.au', ['@uts.edu.au'])).toBe(false))
  it('is not fooled by a lookalike domain', () => expect(isVip('a@evil-uts.edu.au', ['@uts.edu.au'])).toBe(false))
  it('ignores blanks', () => expect(isVip('a@b.c', ['', ' '])).toBe(false))
  it('an empty sender never passes', () => expect(isVip('', ['@'])).toBe(false))
})

describe('releaseAt', () => {
  const mail = (over = {}): { arrived: number; fromAddress: string; labels: string[] } => ({
    arrived: at(6, 10), fromAddress: 'ada@example.com', labels: ['\\Inbox'], ...over
  })

  it('new inbox mail waits for its batch', () => {
    expect(releaseAt(mail(), 'me@x.com', HOLD_FROM, RULES)).toBe(at(6, 13))
  })
  it('mail from before the account was added is there at once', () => {
    expect(releaseAt(mail({ arrived: at(1, 0) - 1000 }), 'me@x.com', HOLD_FROM, RULES)).toBe(at(1, 0) - 1000)
  })
  it('your own sent mail never waits', () => {
    expect(releaseAt(mail({ fromAddress: 'ME@x.com' }), 'me@x.com', HOLD_FROM, RULES)).toBe(at(6, 10))
  })
  it('mail a filter filed away never waits', () => {
    expect(releaseAt(mail({ labels: ['Receipts'] }), 'me@x.com', HOLD_FROM, RULES)).toBe(at(6, 10))
  })
  it('a VIP skips the wait', () => {
    expect(releaseAt(mail(), 'me@x.com', HOLD_FROM, { ...RULES, vip: ['@example.com'] })).toBe(at(6, 10))
  })
  it('batching off shows everything', () => {
    expect(releaseAt(mail(), 'me@x.com', HOLD_FROM, { times: [], vip: [] })).toBe(at(6, 10))
  })
})

describe('the Summary', () => {
  // 6 November 2026 is a Friday.
  const DAILY: SummaryRules = { senders: ['news@shop.example', '@letters.example'], every: 'daily', time: '08:00', day: 1 }
  const WEEKLY: SummaryRules = { ...DAILY, every: 'weekly', day: 1 }
  const mail = (from: string, over = {}): { arrived: number; fromAddress: string; labels: string[] } => ({
    arrived: at(6, 10), fromAddress: from, labels: ['\\Inbox'], ...over
  })

  it('lands daily at its time, strictly after', () => {
    expect(nextSummaryAfter(at(6, 10), DAILY)).toBe(at(7, 8))
    expect(nextSummaryAfter(at(6, 7, 59), DAILY)).toBe(at(6, 8))
    expect(nextSummaryAfter(at(6, 8), DAILY)).toBe(at(7, 8))
  })
  it('lands weekly on its day', () => {
    expect(nextSummaryAfter(at(6, 10), WEEKLY)).toBe(at(9, 8)) // the Monday after
    expect(nextSummaryAfter(at(9, 7), WEEKLY)).toBe(at(9, 8))
    expect(nextSummaryAfter(at(9, 8), WEEKLY)).toBe(at(16, 8))
    expect(nextSummaryAfter(at(6, 10), { ...WEEKLY, day: 5 })).toBe(at(13, 8)) // Friday's has gone: next Friday
  })
  it('falls back to the morning for a time that makes no sense', () => {
    expect(nextSummaryAfter(at(6, 10), { ...DAILY, time: '25:00' })).toBe(at(7, 8))
  })
  it('holds its senders for it, not for the next batch', () => {
    const rules = { ...RULES, summary: DAILY }
    expect(holdOf(mail('News@Shop.example'), 'me@x.com', HOLD_FROM, rules)).toEqual({ at: at(7, 8), summary: true })
    expect(holdOf(mail('a@letters.example'), 'me@x.com', HOLD_FROM, rules)).toEqual({ at: at(7, 8), summary: true })
    expect(holdOf(mail('ada@example.com'), 'me@x.com', HOLD_FROM, rules)).toEqual({ at: at(6, 13), summary: false })
  })
  it('holds them with batches off, and before a straight-through rule that covers them too', () => {
    expect(holdOf(mail('news@shop.example'), 'me@x.com', HOLD_FROM, { times: [], vip: [], summary: DAILY })).toEqual({ at: at(7, 8), summary: true })
    expect(holdOf(mail('news@shop.example'), 'me@x.com', HOLD_FROM, { ...RULES, vip: ['@shop.example'], summary: DAILY })).toEqual({ at: at(7, 8), summary: true })
  })
  it('never holds what never waits', () => {
    const rules = { ...RULES, summary: DAILY }
    expect(holdOf(mail('news@shop.example', { arrived: HOLD_FROM - 1 }), 'me@x.com', HOLD_FROM, rules)).toEqual({ at: HOLD_FROM - 1, summary: false })
    expect(holdOf(mail('news@shop.example', { labels: ['Receipts'] }), 'me@x.com', HOLD_FROM, rules)).toEqual({ at: at(6, 10), summary: false })
    expect(releaseAt(mail('news@shop.example'), 'news@shop.example', HOLD_FROM, rules)).toBe(at(6, 10))
  })
})
