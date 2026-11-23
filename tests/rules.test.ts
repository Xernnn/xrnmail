import { describe, expect, it } from 'vitest'
import { changesOf, conditionHolds, decide, fold, patternHolds, PATTERN_MS, ruleHolds, type RuleMail } from '@main/rules'
import { cleanRule, ruleProblem, type MailRule, type RuleCondition } from '@shared/rules'

const MAIL: RuleMail = {
  from: { name: 'Shop News', address: 'news@shop.example' },
  to: [{ name: 'Alex', address: 'alex@example.com' }],
  cc: [{ name: 'Mai Trần', address: 'mai@example.org' }],
  subject: 'Lịch thi: your receipt #4521',
  text: 'Thanks for your order. Total 42.00',
  list: { id: 'deals.shop.example', name: 'Shop deals' },
  attachments: ['receipt-4521.pdf', 'logo.png']
}

const holds = (field: RuleCondition['field'], op: RuleCondition['op'], value: string, mail = MAIL): boolean =>
  conditionHolds({ field, op, value }, mail)

const rule = (over: Partial<MailRule> = {}): MailRule => ({
  id: 1, name: 'R', account: '', on: true, match: 'all',
  conditions: [{ field: 'from', op: 'contains', value: 'shop.example' }],
  actions: [{ kind: 'archive' }],
  ...over
})

describe('a condition', () => {
  it('reads From by name or address', () => {
    expect(holds('from', 'contains', 'SHOP.example')).toBe(true)
    expect(holds('from', 'contains', 'news')).toBe(true)
    expect(holds('from', 'is', 'news@shop.example')).toBe(true)
    expect(holds('from', 'is', 'shop news')).toBe(true)
    expect(holds('from', 'is', 'shop')).toBe(false)
    expect(holds('from', 'starts', 'news@')).toBe(true)
    expect(holds('from', 'ends', '@shop.example')).toBe(true)
    expect(holds('from', 'ends', 'shop')).toBe(false)
    expect(holds('from', 'excludes', 'bank')).toBe(true)
    expect(holds('from', 'excludes', 'news')).toBe(false)
  })

  it('reads To or Cc as anyone it is to, and "doesn\'t contain" means none of them', () => {
    expect(holds('to', 'is', 'alex@example.com')).toBe(true)
    expect(holds('to', 'ends', '@example.org')).toBe(true)
    expect(holds('to', 'contains', 'mai tran')).toBe(true) // without its marks, as search reads it
    expect(holds('to', 'excludes', 'example.org')).toBe(false)
    expect(holds('to', 'excludes', 'nobody')).toBe(true)
  })

  it('reads the subject and the body', () => {
    expect(holds('subject', 'starts', 'lich thi')).toBe(true)
    expect(holds('subject', 'contains', 'Receipt')).toBe(true)
    expect(holds('subject', 'is', 'receipt')).toBe(false)
    expect(holds('body', 'contains', 'total 42')).toBe(true)
    expect(holds('body', 'excludes', 'unsubscribe')).toBe(true)
    expect(holds('body', 'ends', '42.00')).toBe(true)
  })

  it('reads List-Id by its id or its name, and a message from no list contains nothing', () => {
    expect(holds('list', 'is', 'deals.shop.example')).toBe(true)
    expect(holds('list', 'contains', 'shop deals')).toBe(true)
    const none = { ...MAIL, list: null }
    expect(holds('list', 'contains', 'shop', none)).toBe(false)
    expect(holds('list', 'excludes', 'shop', none)).toBe(true)
  })

  it('reads attachments: whether there is one, and their names', () => {
    expect(holds('hasAttachment', 'is', '')).toBe(true)
    expect(holds('hasAttachment', 'is', '', { ...MAIL, attachments: [] })).toBe(false)
    expect(holds('attachment', 'ends', '.pdf')).toBe(true)
    expect(holds('attachment', 'is', 'logo.png')).toBe(true)
    expect(holds('attachment', 'excludes', '.zip')).toBe(true)
    expect(holds('attachment', 'contains', 'invoice')).toBe(false)
  })

  it('matches a pattern, whatever the case', () => {
    expect(holds('subject', 'matches', 'receipt #\\d{4}')).toBe(true)
    expect(holds('from', 'matches', '^NEWS@')).toBe(true)
    expect(holds('subject', 'matches', '^receipt')).toBe(false)
    expect(holds('attachment', 'matches', '\\.(pdf|docx)$')).toBe(true)
  })
})

describe('a pattern that would take forever', () => {
  it('is given up on in moments, and then never tried again', () => {
    const evil = '(a+)+$'
    const long = `${'a'.repeat(40)}!`
    const started = performance.now()
    expect(patternHolds(evil, [long])).toBe(false)
    expect(performance.now() - started).toBeLessThan(PATTERN_MS * 20)
    const again = performance.now()
    for (let i = 0; i < 100; i++) expect(patternHolds(evil, [long])).toBe(false)
    expect(performance.now() - again).toBeLessThan(PATTERN_MS) // a hundred messages more, and it isn't run once
  })

  it('reads only so much of a message, and none of a pattern too long or broken', () => {
    expect(patternHolds('needle', [`${'x'.repeat(200_000)}needle`])).toBe(false)
    expect(patternHolds('needle', [`${'x'.repeat(1000)}needle`])).toBe(true)
    expect(patternHolds('a'.repeat(201), ['a'.repeat(300)])).toBe(false)
    expect(patternHolds('(', ['('])).toBe(false)
  })
})

describe('a rule', () => {
  const two: RuleCondition[] = [{ field: 'from', op: 'contains', value: 'shop' }, { field: 'subject', op: 'contains', value: 'invoice' }]

  it('holds when all its conditions do, or any of them', () => {
    expect(ruleHolds({ match: 'all', conditions: two }, MAIL)).toBe(false)
    expect(ruleHolds({ match: 'any', conditions: two }, MAIL)).toBe(true)
    expect(ruleHolds({ match: 'any', conditions: [] }, MAIL)).toBe(false)
  })

  it('gathers what every rule that holds asks for, until one says to stop', () => {
    const rules = [
      rule({ actions: [{ kind: 'file', to: 'Receipts' }, { kind: 'read' }] }),
      rule({ conditions: [{ field: 'subject', op: 'contains', value: 'nothing like it' }], actions: [{ kind: 'trash' }] }),
      rule({ actions: [{ kind: 'summary' }, { kind: 'stop' }] }),
      rule({ actions: [{ kind: 'straight' }, { kind: 'flag' }] })
    ]
    expect(decide(rules, MAIL)).toEqual({
      file: ['Receipts'], archive: false, read: true, flag: false, trash: false, important: false, hold: 'summary', mute: false, matched: 2
    })
    const without = decide(rules.filter((_, i) => i !== 2), MAIL)
    expect(without).toMatchObject({ hold: 'straight', flag: true, matched: 2 })
  })

  it('asks the server for labels and flags first, then where the message goes', () => {
    const ruling = decide([rule({ actions: [{ kind: 'archive' }, { kind: 'file', to: 'Receipts' }, { kind: 'file', to: 'Gone' }, { kind: 'important' }, { kind: 'read' }] })], MAIL)
    expect(changesOf(ruling, true, ['Receipts'])).toEqual([
      { kind: 'label', label: 'Receipts', add: true }, { kind: 'read' }, { kind: 'label', label: '\\Important', add: true }, { kind: 'archive' }
    ])
    // A folder is where a message lives: one move, and there's no importance off Gmail.
    expect(changesOf(ruling, false, ['Receipts'])).toEqual([{ kind: 'read' }, { kind: 'move', to: 'Receipts' }])
    expect(changesOf(ruling, false, [])).toEqual([{ kind: 'read' }, { kind: 'archive' }])
    expect(changesOf({ ...ruling, trash: true }, false, ['Receipts'])).toEqual([{ kind: 'read' }, { kind: 'trash' }])
  })
})

describe('a rule from the page', () => {
  const raw = {
    name: ' Receipts ', account: 'Alex@Example.com', on: true, match: 'any',
    conditions: [{ field: 'subject', op: 'contains', value: ' receipt ' }, { field: 'body', op: 'is', value: '  ' }, { field: 'hasAttachment', op: 'is', value: 'x' }],
    actions: [{ kind: 'read' }, { kind: 'read' }, { kind: 'file', to: 'Receipts' }, { kind: 'file', to: ' ' }]
  }

  it('is kept as it says, without what says nothing', () => {
    expect(cleanRule(raw)).toEqual({
      name: 'Receipts', account: 'alex@example.com', on: true, match: 'any',
      conditions: [{ field: 'subject', op: 'contains', value: 'receipt' }, { field: 'hasAttachment', op: 'is', value: '' }],
      actions: [{ kind: 'read' }, { kind: 'file', to: 'Receipts' }]
    })
  })

  it('needs a condition and something to do, and a pattern that reads', () => {
    expect(ruleProblem({ conditions: [], actions: [{ kind: 'read' }] })).toBe('Add a condition.')
    expect(ruleProblem({ conditions: raw.conditions as RuleCondition[], actions: [{ kind: 'stop' }] })).toBe('Add an action.')
    expect(() => cleanRule({ ...raw, conditions: [{ field: 'subject', op: 'matches', value: '(' }] })).toThrow("That pattern isn't valid.")
    expect(() => cleanRule({ ...raw, conditions: [{ field: 'subject', op: 'matches', value: 'a'.repeat(201) }] })).toThrow('too long')
  })

  it('turns down what isn\'t a rule', () => {
    expect(() => cleanRule({ ...raw, conditions: [{ field: 'cookies', op: 'is', value: 'x' }] })).toThrow('Bad request')
    expect(() => cleanRule({ ...raw, actions: [{ kind: 'forward', to: 'someone@example.net' }] })).toThrow('Bad request')
    expect(() => cleanRule({ ...raw, id: -1 })).toThrow('Bad request')
    expect(() => cleanRule('rule')).toThrow('Bad request')
  })
})

describe('fold', () => {
  it('drops marks and case', () => expect(fold('Đặng Lịch THI')).toBe('dang lich thi'))
})
