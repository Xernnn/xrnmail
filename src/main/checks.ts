import type { BatchSettings, Identity, ProfilePatch, QuickAction, Signature, SummarySettings, SwipeAction, Template } from '@shared/types'
import { QUICK_SLOTS } from '@shared/types'
import { cleanSidebar } from '@shared/sidebar'
import { DEFAULT_LATER, type LaterTimes } from '@shared/later'
import { cleanAllChanges, isKeySet } from '@shared/keys'

/** What the page sends, checked before the main process takes it: every value from the page, and
 *  every shared setting from the other device, is a stranger's until it has been through here. */

export const text = (value: unknown, max = 8192): string => {
  if (typeof value !== 'string' || value.length > max) throw new Error('Bad request')
  return value
}

export const number = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Bad request')
  return value
}

export const texts = (value: unknown, max: number, each: number): string[] => {
  if (!Array.isArray(value) || value.length > max) throw new Error('Bad request')
  return value.map((item) => text(item, each))
}

/** Only what's there: a change names what it changes, and the rest stays as saved. */
export function batchSettings(value: unknown): Partial<BatchSettings> {
  const b = (value ?? {}) as Record<string, unknown>
  const patch: Partial<BatchSettings> = {}
  if (b['live'] !== undefined) patch.live = b['live'] === true
  if (b['times'] !== undefined) patch.times = texts(b['times'], 50, 8)
  if (b['vip'] !== undefined) patch.vip = texts(b['vip'], 500, 320)
  if (b['earlyPerDay'] !== undefined) patch.earlyPerDay = number(b['earlyPerDay'])
  return patch
}

/** The main process decides what's allowed: `saveSummary` cleans the rest. */
export function summarySettings(value: unknown): Partial<SummarySettings> {
  const s = (value ?? {}) as Record<string, unknown>
  const patch: Partial<SummarySettings> = {}
  if (s['senders'] !== undefined) patch.senders = texts(s['senders'], 500, 320)
  if (s['every'] !== undefined) patch.every = s['every'] === 'weekly' ? 'weekly' : 'daily'
  if (s['time'] !== undefined) patch.time = text(s['time'], 8)
  if (s['day'] !== undefined) patch.day = number(s['day'])
  if (s['chosen'] !== undefined) patch.chosen = s['chosen'] === true
  return patch
}

const COLOR = /^#[0-9a-f]{6}$/i

export function identity(who: Partial<Identity> | undefined): Identity {
  const color = text(who?.color ?? '', 7)
  return {
    name: text(who?.name, 200),
    signature: text(who?.signature, 8192),
    aliases: (Array.isArray(who?.aliases) ? who.aliases : []).slice(0, 20).map((a) => text(a, 320)),
    color: COLOR.test(color) ? color : '',
    notify: who?.notify !== false
  }
}

/** A signature's words, with any picture in them, which is kept with it. */
const MAX_SIGNATURE = 2 * 1024 * 1024
const SIGNATURE_ID = /^[\w-]{1,64}$/

export function signature(value: unknown): Signature {
  const s = (value ?? {}) as Record<string, unknown>
  const id = text(s['id'], 64)
  if (!SIGNATURE_ID.test(id)) throw new Error('Bad request')
  return { id, name: text(s['name'], 200), html: text(s['html'], MAX_SIGNATURE), text: text(s['text'], 20_000) }
}

export function profile(value: unknown): ProfilePatch {
  const p = (value ?? {}) as Record<string, unknown>
  const patch: ProfilePatch = {}
  if (p['identities'] !== undefined) {
    patch.identities = Object.fromEntries(
      Object.entries(p['identities'] as Record<string, Identity>).map(([email, who]) => [
        text(email, 320), identity(who)
      ])
    )
  }
  if (Array.isArray(p['signatures'])) patch.signatures = p['signatures'].slice(0, 50).map(signature)
  if (p['signatureFor'] && typeof p['signatureFor'] === 'object') {
    patch.signatureFor = Object.fromEntries(Object.entries(p['signatureFor'] as Record<string, unknown>).slice(0, 500)
      .map(([address, id]) => [text(address, 320).toLowerCase(), text(id, 64)]))
  }
  if (Array.isArray(p['templates'])) {
    patch.templates = (p['templates'] as Template[]).map((t) => ({
      name: text(t?.name, 200), text: text(t?.text, 20_000), ...(t?.subject ? { subject: text(t.subject, 2000) } : {})
    }))
  }
  if (Array.isArray(p['blocked'])) patch.blocked = p['blocked'].map((b) => text(b, 320))
  if (Array.isArray(p['muted'])) patch.muted = p['muted'].map((b) => text(b, 320))
  if (p['sidebar'] && typeof p['sidebar'] === 'object') patch.sidebar = cleanSidebar(p['sidebar'])
  if (p['undoSeconds'] !== undefined) patch.undoSeconds = number(p['undoSeconds'])
  if (p['undoActionSeconds'] !== undefined) patch.undoActionSeconds = number(p['undoActionSeconds'])
  if (p['defaultReply'] === 'reply' || p['defaultReply'] === 'replyAll') patch.defaultReply = p['defaultReply']
  if (p['theme'] === 'system' || p['theme'] === 'light' || p['theme'] === 'dark') patch.theme = p['theme']
  if (p['focused'] !== undefined) patch.focused = p['focused'] === true
  if (p['layout'] === 'panes' || p['layout'] === 'below' || p['layout'] === 'list') patch.layout = p['layout']
  if (p['afterRemove'] === 'next' || p['afterRemove'] === 'previous' || p['afterRemove'] === 'list') patch.afterRemove = p['afterRemove']
  if (p['previewLines'] !== undefined) patch.previewLines = number(p['previewLines'])
  for (const key of ['attachmentCards', 'sidebarIcons', 'clock24', 'quickOn', 'swipes', 'notifyFocusedOnly', 'darkMail', 'quoteReplies', 'importanceMarks', 'faces', 'sound'] as const) {
    if (p[key] !== undefined) patch[key] = p[key] === true
  }
  if (isKeySet(p['keys'])) patch.keys = p['keys']
  if (p['keyChanges'] && typeof p['keyChanges'] === 'object') patch.keyChanges = cleanAllChanges(p['keyChanges'])
  if (Array.isArray(p['quickActions'])) patch.quickActions = p['quickActions'].slice(0, QUICK_SLOTS).map((a) => text(a, 16) as QuickAction)
  for (const key of ['swipeLeft', 'swipeLeftLong', 'swipeRight', 'swipeRightLong'] as const) {
    if (p[key] !== undefined) patch[key] = text(p[key], 16) as SwipeAction
  }
  if (p['background'] !== undefined) patch.background = p['background'] === true
  if (p['startAtLogin'] !== undefined) patch.startAtLogin = p['startAtLogin'] === true
  if (p['images'] === 'ask' || p['images'] === 'always') patch.images = p['images']
  if (p['readAfter'] !== undefined) patch.readAfter = number(p['readAfter'])
  if (p['threadOrder'] === 'oldest' || p['threadOrder'] === 'newest') patch.threadOrder = p['threadOrder']
  if (p['later'] && typeof p['later'] === 'object') {
    const later = p['later'] as Record<string, unknown>
    patch.later = Object.fromEntries(Object.entries(later).filter(([key]) => key in DEFAULT_LATER).map(([key, value]) => [key, number(value)])) as Partial<LaterTimes>
  }
  if (Array.isArray(p['imagesFrom'])) patch.imagesFrom = p['imagesFrom'].map((a) => text(a, 320))
  return patch
}
