/**
 * Mail rules: what a message has to say, and what's done with it when it does, kept on this laptop
 * and run as new mail is stored. Both sides read this file: the page to edit rules, the main process
 * to keep them, which cleans whatever the page sends with `cleanRule`.
 */

/** What a condition reads. `to` is any recipient, To or Cc; `attachment` any file's name. */
export type RuleField = 'from' | 'to' | 'subject' | 'body' | 'list' | 'hasAttachment' | 'attachment'
export type RuleOperator = 'contains' | 'excludes' | 'is' | 'starts' | 'ends' | 'matches'

export interface RuleCondition {
  field: RuleField
  op: RuleOperator
  /** Unused for `hasAttachment`. */
  value: string
}

/** `file` adds a label on Gmail and moves to the folder anywhere else. The rest change nothing on
 *  the server: `summary`, `straight` and `mute` are this laptop's own, and `stop` leaves the rules
 *  after this one out. */
export type RuleAction =
  | { kind: 'file'; to: string }
  | { kind: 'archive' | 'read' | 'flag' | 'trash' | 'important' | 'summary' | 'straight' | 'mute' | 'stop' }

export type RuleActionKind = RuleAction['kind']

export interface MailRule {
  id: number
  name: string
  /** The account it's for, or '' for every account. */
  account: string
  on: boolean
  /** Every condition has to hold, or any one of them. */
  match: 'all' | 'any'
  conditions: RuleCondition[]
  actions: RuleAction[]
}

/** A rule as the editor sends it: without an id, it's a new one. */
export type RuleEdit = Omit<MailRule, 'id'> & { id?: number }

/** What Apply now did: how many messages it changed, what undoes it, and the thing it did that the
 *  note names. */
export interface RuleApplied {
  count: number
  undo: number | null
  did: 'trash' | 'move' | 'label' | 'archive' | 'read' | 'flag' | 'important' | null
}

export const RULE_FIELDS: [RuleField, string][] = [
  ['from', 'From'], ['to', 'To or Cc'], ['subject', 'Subject'], ['body', 'Body'], ['list', 'List-Id'],
  ['hasAttachment', 'Has attachment'], ['attachment', 'Attachment name']
]

export const RULE_OPERATORS: [RuleOperator, string][] = [
  ['contains', 'contains'], ['excludes', "doesn't contain"], ['is', 'is'], ['starts', 'starts with'], ['ends', 'ends with'], ['matches', 'matches']
]

/** In the order they're offered. `file` is named for the account's kind where the page knows it. */
export const RULE_ACTIONS: [RuleActionKind, string][] = [
  ['file', 'Label or move to'], ['archive', 'Archive'], ['read', 'Mark as read'], ['flag', 'Flag'], ['trash', 'Delete'],
  ['important', 'Mark as important'], ['summary', 'Add to Summary'], ['straight', 'Let straight through'],
  ['mute', 'Mute notifications'], ['stop', 'Stop processing more rules']
]

/** What Apply now's note says it did, after the count. */
export const RULE_DONE: Record<Exclude<RuleApplied['did'], null>, string> = {
  trash: 'deleted', move: 'moved', label: 'labelled', archive: 'archived', read: 'marked read', flag: 'flagged', important: 'marked important'
}

export const MAX_RULES = 200
const MAX_CONDITIONS = 20
const MAX_ACTIONS = 12
const MAX_NAME = 100
const MAX_VALUE = 500
/** A pattern is kept short, as well as run with a time limit, so one can't take sync down with it. */
export const MAX_PATTERN = 200

const FIELDS = RULE_FIELDS.map(([field]) => field)
const OPERATORS = RULE_OPERATORS.map(([op]) => op)
const KINDS = RULE_ACTIONS.map(([kind]) => kind)

/** Why a pattern can't be used, or null. JavaScript's own syntax, read without regard to case. */
export function patternProblem(pattern: string): string | null {
  if (pattern.length > MAX_PATTERN) return 'That pattern is too long.'
  try {
    new RegExp(pattern, 'i')
    return null
  } catch {
    return "That pattern isn't valid."
  }
}

/** The conditions that say something: one with nothing to look for is left out. */
const said = (conditions: RuleCondition[]): RuleCondition[] =>
  conditions.filter((c) => c.field === 'hasAttachment' || c.value.trim() !== '')

/** The actions that do something, each once; Stop alone does nothing. */
const done = (actions: RuleAction[]): RuleAction[] => {
  const seen = new Set<string>()
  return actions.filter((a) => {
    if (a.kind === 'file' && !a.to.trim()) return false
    const key = a.kind === 'file' ? `file:${a.to}` : a.kind
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Why the editor can't save this yet, or null. */
export function ruleProblem(rule: Pick<MailRule, 'conditions' | 'actions'>): string | null {
  const conditions = said(rule.conditions)
  if (conditions.length === 0) return 'Add a condition.'
  if (!done(rule.actions).some((a) => a.kind !== 'stop')) return 'Add an action.'
  for (const c of conditions) {
    if (c.op === 'matches' && c.field !== 'hasAttachment') {
      const problem = patternProblem(c.value)
      if (problem) return problem
    }
  }
  return null
}

const bad = (): never => {
  throw new Error('Bad request')
}

const text = (value: unknown, max: number): string => (typeof value === 'string' && value.length <= max ? value : bad())

/** A rule from the page, or from the profile, made safe to keep and run: anything that isn't one
 *  is turned down, and what says nothing is left out. */
export function cleanRule(value: unknown): RuleEdit {
  const r = (value ?? {}) as Record<string, unknown>
  const conditions = (Array.isArray(r['conditions']) && r['conditions'].length <= MAX_CONDITIONS ? r['conditions'] : bad()).map((raw: unknown): RuleCondition => {
    const c = (raw ?? {}) as Record<string, unknown>
    const field = FIELDS.find((f) => f === c['field']) ?? bad()
    const op = OPERATORS.find((o) => o === c['op']) ?? bad()
    return { field, op, value: field === 'hasAttachment' ? '' : text(c['value'], MAX_VALUE).trim() }
  })
  const actions = (Array.isArray(r['actions']) && r['actions'].length <= MAX_ACTIONS ? r['actions'] : bad()).map((raw: unknown): RuleAction => {
    const a = (raw ?? {}) as Record<string, unknown>
    const kind = KINDS.find((k) => k === a['kind']) ?? bad()
    return kind === 'file' ? { kind, to: text(a['to'], 1000).trim() } : { kind }
  })
  const rule: RuleEdit = {
    name: text(r['name'] ?? '', MAX_NAME).trim(),
    account: text(r['account'] ?? '', 320).trim().toLowerCase(),
    on: r['on'] !== false,
    match: r['match'] === 'any' ? 'any' : 'all',
    conditions: said(conditions),
    actions: done(actions)
  }
  if (r['id'] !== undefined) {
    const id = r['id']
    rule.id = typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : bad()
  }
  const problem = ruleProblem(rule)
  if (problem) throw new Error(problem)
  return rule
}
