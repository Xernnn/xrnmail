/** What a window of its own holds: one thread, or one draft in the composer. The main window holds
 *  neither. */
export type Solo =
  | { kind: 'thread'; account: string; thread: string; bins: boolean }
  | { kind: 'draft'; id: number }

/** What such a window's page is loaded with, after the `?`. */
export function soloQuery(solo: Solo): Record<string, string> {
  if (solo.kind === 'draft') return { solo: 'draft', draft: String(solo.id) }
  return { solo: 'thread', account: solo.account, thread: solo.thread, ...(solo.bins ? { bins: '1' } : {}) }
}

/** Reads it back in the page. Anything that isn't wholly one of the two is the main window. */
export function soloFrom(search: string): Solo | null {
  const query = new URLSearchParams(search)
  const kind = query.get('solo')
  if (kind === 'thread') {
    const account = query.get('account') ?? ''
    const thread = query.get('thread') ?? ''
    return account && thread ? { kind, account, thread, bins: query.get('bins') === '1' } : null
  }
  if (kind === 'draft') {
    const id = Number(query.get('draft') ?? '')
    return Number.isSafeInteger(id) && id > 0 ? { kind, id } : null
  }
  return null
}

/** A thread or a draft has one window: asking for it again brings that one forward. */
export const soloKey = (solo: Solo): string => (solo.kind === 'draft' ? `draft:${solo.id}` : `thread:${solo.account}/${solo.thread}`)
