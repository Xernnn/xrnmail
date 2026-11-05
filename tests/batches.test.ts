import { describe, expect, it } from 'vitest'
import { isTime, isVip, nextBatchAfter, releaseAt, type BatchRules } from '@main/batches'

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
