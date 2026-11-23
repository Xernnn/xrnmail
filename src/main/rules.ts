import { createContext, runInContext, type Context } from 'node:vm'
import type { Address, MailAction } from '@shared/types'
import { IMPORTANT } from '@shared/types'
import type { MailRule, RuleCondition, RuleField } from '@shared/rules'
import { MAX_PATTERN } from '@shared/rules'

/**
 * Whether a rule's conditions hold for a message, and what the rules that do hold ask for. Nothing
 * here touches the store or the network, so every field and operator is tested on its own.
 */

/** What a rule can look at in a message. */
export interface RuleMail {
  from: Address
  to: Address[]
  cc: Address[]
  subject: string
  text: string
  list: { id: string; name: string } | null
  attachments: string[]
}

/** What the rules that hold make of one message, gathered in their order until one says to stop. */
export interface Ruling {
  /** Labels on Gmail, a folder elsewhere: where the first one that names one says. */
  file: string[]
  archive: boolean
  read: boolean
  flag: boolean
  trash: boolean
  important: boolean
  /** The first rule to say whether it waits decides: the Summary, or straight through. */
  hold: 'summary' | 'straight' | null
  mute: boolean
  /** How many rules held. */
  matched: number
}

/** How long one pattern may take over one message. A pattern that takes longer is given up on for
 *  as long as the app runs, so a bad one costs this once, not once a message. */
export const PATTERN_MS = 50
/** How much of a message a pattern reads. */
const PATTERN_TEXT = 100_000

/** The same letters without their marks or case, so `lich thi` finds "Lịch thi", as search does. */
export const fold = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').replace(/[đĐ]/g, 'd').toLowerCase()

let sandbox: Context | null = null
/** Patterns that ran out of time, or wouldn't compile. They never hold again until the app restarts. */
const stuck = new Set<string>()

/** JavaScript's own patterns backtrack, and a pattern like `(a+)+$` can take years over a long
 *  message. Run in a context of their own with a time limit, a test can be stopped. */
export function patternHolds(pattern: string, texts: string[]): boolean {
  if (pattern.length > MAX_PATTERN || stuck.has(pattern)) return false
  if (!sandbox) {
    sandbox = createContext({})
    runInContext('globalThis.holds = (pattern, texts) => { const p = new RegExp(pattern, "i"); return texts.some((t) => p.test(t)) }', sandbox)
  }
  sandbox['pattern'] = pattern
  sandbox['texts'] = texts.map((t) => t.slice(0, PATTERN_TEXT))
  try {
    return runInContext('holds(pattern, texts)', sandbox, { timeout: PATTERN_MS }) === true
  } catch {
    stuck.add(pattern)
    return false
  } finally {
    sandbox['texts'] = null
  }
}

const people = (list: Address[]): string[] => list.flatMap((a) => [a.name, a.address])

function valuesOf(field: Exclude<RuleField, 'hasAttachment'>, mail: RuleMail): string[] {
  const values: Record<typeof field, () => string[]> = {
    from: () => people([mail.from]),
    to: () => people([...mail.to, ...mail.cc]),
    subject: () => [mail.subject],
    body: () => [mail.text],
    list: () => (mail.list ? [mail.list.id, mail.list.name] : []),
    attachment: () => mail.attachments
  }
  return values[field]().filter((v) => v !== '')
}

/** A field with several values (everyone it's to, each file) holds when any of them does, and
 *  "doesn't contain" only when none of them contains it. */
export function conditionHolds(condition: RuleCondition, mail: RuleMail): boolean {
  if (condition.field === 'hasAttachment') return mail.attachments.length > 0
  const values = valuesOf(condition.field, mail)
  if (condition.op === 'matches') return patternHolds(condition.value, values)
  const wanted = fold(condition.value)
  const folded = values.map(fold)
  switch (condition.op) {
    case 'contains':
      return folded.some((v) => v.includes(wanted))
    case 'excludes':
      return !folded.some((v) => v.includes(wanted))
    case 'is':
      return folded.some((v) => v === wanted)
    case 'starts':
      return folded.some((v) => v.startsWith(wanted))
    case 'ends':
      return folded.some((v) => v.endsWith(wanted))
  }
}

export function ruleHolds(rule: Pick<MailRule, 'match' | 'conditions'>, mail: RuleMail): boolean {
  if (rule.conditions.length === 0) return false
  return rule.match === 'any' ? rule.conditions.some((c) => conditionHolds(c, mail)) : rule.conditions.every((c) => conditionHolds(c, mail))
}

const NOTHING: Ruling = { file: [], archive: false, read: false, flag: false, trash: false, important: false, hold: null, mute: false, matched: 0 }

/** What one rule that holds adds to what the ones before it said. */
function gather(ruling: Ruling, rule: Pick<MailRule, 'actions'>): Ruling {
  ruling.matched++
  for (const action of rule.actions) {
    switch (action.kind) {
      case 'file':
        if (!ruling.file.includes(action.to)) ruling.file.push(action.to)
        break
      case 'summary':
      case 'straight':
        ruling.hold ??= action.kind
        break
      case 'stop':
        break
      default:
        ruling[action.kind] = true
    }
  }
  return ruling
}

/** What a rule asks for, whatever the message, as Apply now does it. */
export const rulingOf = (rule: Pick<MailRule, 'actions'>): Ruling => gather({ ...NOTHING, file: [] }, rule)

/** The rules, in order, that hold for a message, until one that holds says to stop. */
export function decide(rules: MailRule[], mail: RuleMail): Ruling {
  const ruling: Ruling = { ...NOTHING, file: [] }
  for (const rule of rules) {
    if (!ruleHolds(rule, mail)) continue
    gather(ruling, rule)
    if (rule.actions.some((a) => a.kind === 'stop')) break
  }
  return ruling
}

/** What a ruling asks of the server, in the order it's sent: labels and flags while the message is
 *  still in the inbox, then where it goes. On Gmail a message takes every label; anywhere else it
 *  lives in one folder, so Delete beats a folder, which beats Archive. Labels and folders the
 *  account doesn't have are left out, and so is importance, which only Gmail has. */
export function changesOf(ruling: Ruling, gmail: boolean, folders: string[]): MailAction[] {
  const changes: MailAction[] = []
  const known = ruling.file.filter((to) => folders.includes(to))
  if (gmail) for (const label of known) changes.push({ kind: 'label', label, add: true })
  if (ruling.read) changes.push({ kind: 'read' })
  if (ruling.flag) changes.push({ kind: 'star' })
  if (ruling.important && gmail) changes.push({ kind: 'label', label: IMPORTANT, add: true })
  if (ruling.trash) changes.push({ kind: 'trash' })
  else if (!gmail && known[0] !== undefined) changes.push({ kind: 'move', to: known[0] })
  else if (ruling.archive) changes.push({ kind: 'archive' })
  return changes
}
