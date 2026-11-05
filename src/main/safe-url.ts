/** What may be handed to the operating system. A link in an email can say anything, and
 *  shell.openExternal launches whatever handles the scheme, including file: and smb:. */
const ALLOWED = new Set(['https:', 'http:', 'mailto:'])

export function isSafeExternalUrl(raw: string): boolean {
  try {
    return ALLOWED.has(new URL(raw).protocol)
  } catch {
    return false
  }
}

/** Basic auth goes in the clear over plain http, so that's only for this machine. */
export function isSafeHubUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    if (url.username || url.password) return false
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
  } catch {
    return false
  }
}

/** Gmail's own page for a thread. IMAP gives the id in decimal; the web address wants hex. */
export function gmailThreadUrl(email: string, thread: string): string {
  const id = /^\d+$/.test(thread) ? BigInt(thread).toString(16) : ''
  return `https://mail.google.com/mail/?authuser=${encodeURIComponent(email)}#all/${id}`
}
