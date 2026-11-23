import { useEffect, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import type { AccountView } from '@shared/types'
import {
  patternProblem, RULE_ACTIONS, RULE_DONE, RULE_FIELDS, RULE_OPERATORS, ruleProblem,
  type MailRule, type RuleAction, type RuleActionKind, type RuleApplied, type RuleCondition, type RuleEdit, type RuleField, type RuleOperator
} from '@shared/rules'
import type { Question } from './Common'
import { problem } from './format'

/** Settings, Rules: the rules in their order, each on or off, and one at a time in the editor. The
 *  rules are the main process's: each change is one call, and the list is read again after it. */

type Ask = (asking: Omit<Question, 'answer'>) => Promise<boolean>

const NOTE_MS = 5000

const fresh = (account: string): RuleEdit => ({
  name: '', account, on: true, match: 'all',
  conditions: [{ field: 'from', op: 'contains', value: '' }],
  actions: [{ kind: 'read' }]
})

/** What Apply now's note says: "12 moved". */
export const appliedWords = (done: RuleApplied): string => (done.count === 0 || !done.did ? 'None matched' : `${done.count} ${RULE_DONE[done.did]}`)

/** The accounts a rule is for. */
const scope = (accounts: AccountView[], account: string): AccountView[] => accounts.filter((a) => !account || a.email === account)

function Editor(props: { rule: RuleEdit; accounts: AccountView[]; done(saved: boolean): void; ask: Ask }): ReactNode {
  const [rule, setRule] = useState(props.rule)
  const [error, setError] = useState('')
  const set = (change: Partial<RuleEdit>): void => setRule((now) => ({ ...now, ...change }))
  const setCondition = (at: number, change: Partial<RuleCondition>): void =>
    set({ conditions: rule.conditions.map((c, i) => (i === at ? { ...c, ...change } : c)) })
  const setAction = (at: number, next: RuleAction): void => set({ actions: rule.actions.map((a, i) => (i === at ? next : a)) })

  const accounts = scope(props.accounts, rule.account)
  const gmail = accounts.some((a) => a.labels)
  const folders = [...new Set(accounts.flatMap((a) => a.folders))]
  const fileWord = accounts.every((a) => a.labels) ? 'Add label' : accounts.every((a) => !a.labels) ? 'Move to' : 'Label or move to'
  const offered = RULE_ACTIONS.filter(([kind]) => (kind !== 'file' || folders.length > 0) && (kind !== 'important' || gmail))
    .map(([kind, name]): [RuleActionKind, string] => [kind, kind === 'file' ? fileWord : name])
  const actionOf = (kind: RuleActionKind, was: RuleAction): RuleAction =>
    kind === 'file' ? { kind, to: was.kind === 'file' ? was.to : folders[0] ?? '' } : { kind }
  const stuck = ruleProblem(rule)
  const badPattern = rule.conditions.map((c) => (c.op === 'matches' && c.field !== 'hasAttachment' && c.value ? patternProblem(c.value) : null))

  const save = async (): Promise<void> => {
    setError('')
    try {
      await window.mail.saveRule(rule)
      props.done(true)
    } catch (e) {
      setError(problem(e))
    }
  }
  const remove = async (): Promise<void> => {
    if (rule.id === undefined) return props.done(false)
    if (!(await props.ask({ title: `Delete ${rule.name || 'this rule'}?`, action: 'Delete', danger: true }))) return
    await window.mail.deleteRule(rule.id)
    props.done(true)
  }

  return (
    <div className="rule-editor" role="group" aria-label={rule.id === undefined ? 'New rule' : 'Edit rule'}>
      <section>
        <h3>{rule.id === undefined ? 'New rule' : 'Edit rule'}</h3>
        <label>Name<input value={rule.name} onChange={(e) => set({ name: e.target.value })} /></label>
        <label className="inline">
          Account
          <select value={rule.account} onChange={(e) => set({ account: e.target.value })}>
            <option value="">All accounts</option>
            {[...new Set([...props.accounts.map((a) => a.email), ...(rule.account ? [rule.account] : [])])].map((email) => <option key={email} value={email}>{email}</option>)}
          </select>
        </label>
        <label className="inline">
          Match
          <select value={rule.match} onChange={(e) => set({ match: e.target.value === 'any' ? 'any' : 'all' })}>
            <option value="all">All conditions</option>
            <option value="any">Any condition</option>
          </select>
        </label>
      </section>
      <section>
        <h3>Conditions</h3>
        {rule.conditions.map((c, i) => (
          <div className="line rule-part" key={i}>
            <select aria-label={`Condition ${i + 1}, field`} value={c.field} onChange={(e) => setCondition(i, { field: e.target.value as RuleField })}>
              {RULE_FIELDS.map(([field, name]) => <option key={field} value={field}>{name}</option>)}
            </select>
            {c.field !== 'hasAttachment' && (
              <>
                <select aria-label={`Condition ${i + 1}, test`} value={c.op} onChange={(e) => setCondition(i, { op: e.target.value as RuleOperator })}>
                  {RULE_OPERATORS.map(([op, name]) => <option key={op} value={op}>{name}</option>)}
                </select>
                <input className="grow" aria-label={`Condition ${i + 1}, value`} aria-invalid={badPattern[i] ? true : undefined}
                  value={c.value} onChange={(e) => setCondition(i, { value: e.target.value })} />
              </>
            )}
            {c.field === 'hasAttachment' && <span className="grow" />}
            <button className="icon" aria-label={`Remove condition ${i + 1}`} disabled={rule.conditions.length === 1}
              onClick={() => set({ conditions: rule.conditions.filter((_, at) => at !== i) })}><X size={15} aria-hidden="true" /></button>
          </div>
        ))}
        {badPattern.find(Boolean) && <p className="error">{badPattern.find(Boolean)}</p>}
        <button className="quiet" onClick={() => set({ conditions: [...rule.conditions, { field: 'subject', op: 'contains', value: '' }] })}>Add condition</button>
      </section>
      <section>
        <h3>Actions</h3>
        {rule.actions.map((a, i) => (
          <div className="line rule-part" key={i}>
            <select aria-label={`Action ${i + 1}`} value={a.kind} onChange={(e) => setAction(i, actionOf(e.target.value as RuleActionKind, a))}>
              {offered.map(([kind, name]) => <option key={kind} value={kind}>{name}</option>)}
              {!offered.some(([kind]) => kind === a.kind) && <option value={a.kind}>{RULE_ACTIONS.find(([kind]) => kind === a.kind)?.[1]}</option>}
            </select>
            {a.kind === 'file' ? (
              <select className="grow" aria-label={`Action ${i + 1}, ${gmail ? 'label' : 'folder'}`} value={a.to} onChange={(e) => setAction(i, { kind: 'file', to: e.target.value })}>
                {[...new Set([...folders, ...(a.to ? [a.to] : [])])].map((path) => <option key={path} value={path}>{path}</option>)}
              </select>
            ) : <span className="grow" />}
            <button className="icon" aria-label={`Remove action ${i + 1}`} disabled={rule.actions.length === 1}
              onClick={() => set({ actions: rule.actions.filter((_, at) => at !== i) })}><X size={15} aria-hidden="true" /></button>
          </div>
        ))}
        <button className="quiet" onClick={() => set({ actions: [...rule.actions, { kind: rule.actions.some((x) => x.kind === 'archive') ? 'flag' : 'archive' }] })}>Add action</button>
      </section>
      {error && <p className="error">{error}</p>}
      <div className="row-end rule-buttons">
        {rule.id !== undefined ? <button className="quiet danger" onClick={() => void remove()}>Delete</button> : <span />}
        <span className="rule-buttons">
          <button className="quiet" onClick={() => props.done(false)}>Cancel</button>
          <button className="primary" disabled={stuck !== null} onClick={() => void save()}>Save</button>
        </span>
      </div>
    </div>
  )
}

export function Rules(props: { accounts: AccountView[]; version: number; undoSeconds: number; ask: Ask }): ReactNode {
  const [rules, setRules] = useState<MailRule[] | null>(null)
  const [editing, setEditing] = useState<RuleEdit | null>(null)
  const [note, setNote] = useState<{ text: string; undo: number | null } | null>(null)
  const [error, setError] = useState('')
  const read = (): void => void window.mail.mailRules().then(setRules)
  useEffect(read, [props.version])
  useEffect(() => {
    if (!note) return undefined
    const timer = setTimeout(() => setNote(null), note.undo === null ? NOTE_MS : props.undoSeconds * 1000)
    return () => clearTimeout(timer)
  }, [note])

  /** One call, and the list as it is afterwards, or what went wrong. */
  const run = async (work: () => Promise<unknown>): Promise<void> => {
    setError('')
    try {
      await work()
    } catch (e) {
      setError(problem(e))
    }
    read()
  }
  const apply = (rule: MailRule): Promise<void> => run(async () => {
    const done = await window.mail.applyRule(rule.id)
    setNote({ text: appliedWords(done), undo: done.undo })
  })
  /** Ticked at once: the list read back a moment later says the same. */
  const switchRule = (rule: MailRule, on: boolean): void => {
    setRules((now) => now?.map((r) => (r.id === rule.id ? { ...r, on } : r)) ?? null)
    void run(() => window.mail.saveRule({ ...rule, on }))
  }
  const undo = (token: number): void => {
    setNote(null)
    void window.mail.undo(token)
  }

  if (editing) {
    return <Editor rule={editing} accounts={props.accounts} ask={props.ask} done={() => { setEditing(null); read() }} />
  }
  const list = rules ?? []
  return (
    <section>
      {rules && list.length === 0 && <p className="muted note">None</p>}
      {list.map((rule, i) => (
        <div className="line rule-row" key={rule.id} role="group" aria-label={rule.name}>
          <label className="check grow">
            <input type="checkbox" checked={rule.on}
              onChange={(e) => switchRule(rule, e.target.checked)} />
            <span>{rule.name}</span>
          </label>
          {rule.account && <span className="muted note">{rule.account}</span>}
          <span className="rule-move">
            <button className="icon" aria-label={`Move ${rule.name} up`} disabled={i === 0} onClick={() => void run(() => window.mail.moveRule(rule.id, i - 1))}>
              <ChevronUp size={15} aria-hidden="true" />
            </button>
            <button className="icon" aria-label={`Move ${rule.name} down`} disabled={i === list.length - 1} onClick={() => void run(() => window.mail.moveRule(rule.id, i + 1))}>
              <ChevronDown size={15} aria-hidden="true" />
            </button>
          </span>
          <button className="quiet" aria-label={`Apply ${rule.name} now`} onClick={() => void apply(rule)}>Apply now</button>
          <button className="quiet" aria-label={`Edit ${rule.name}`} onClick={() => setEditing(rule)}>Edit</button>
        </div>
      ))}
      {error && <p className="error">{error}</p>}
      <button className="quiet" onClick={() => setEditing(fresh(props.accounts.length === 1 ? props.accounts[0]?.email ?? '' : ''))}>New rule</button>
      {note && (
        <div className="toast" role="status">
          <span>{note.text}</span>
          {note.undo !== null && <button className="link" onClick={() => undo(note.undo as number)}>Undo</button>}
        </div>
      )}
    </section>
  )
}
