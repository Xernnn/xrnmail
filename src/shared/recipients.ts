/** Reading a line of addresses as people, for the composer's chips. These walk by hand because a
 *  reply starts from headers a stranger wrote. */

export interface Recipient {
  /** What was typed or received, unchanged. It's what gets sent. */
  text: string
  name: string
  address: string
  valid: boolean
}

/** Commas and semicolons end an address, unless they're in a quoted name or between the brackets. */
export function splitRecipients(line: string): string[] {
  const found: string[] = []
  let quoted = false
  let bracketed = false
  let start = 0
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (char === '\\' && quoted) i++
    else if (char === '"') quoted = !quoted
    else if (char === '<' && !quoted) bracketed = true
    else if (char === '>' && !quoted) bracketed = false
    else if ((char === ',' || char === ';') && !quoted && !bracketed) {
      found.push(line.slice(start, i))
      start = i + 1
    }
  }
  found.push(line.slice(start))
  return found.map((part) => part.trim()).filter(Boolean)
}

export function readRecipient(text: string): Recipient {
  const open = text.lastIndexOf('<')
  const bracketed = open >= 0 && text.endsWith('>')
  const address = (bracketed ? text.slice(open + 1, -1) : text).trim()
  const name = bracketed ? text.slice(0, open).trim().replace(/^"|"$/g, '') : ''
  const at = address.indexOf('@')
  const valid = at > 0 && at < address.length - 1 && at === address.lastIndexOf('@') && !/\s/.test(address)
  return { text, name, address, valid }
}

/** What a chip says. A name that's written like an address shows the real one instead, because a
 *  stranger chose that name and a reply shouldn't appear to go somewhere it doesn't. */
export const chipLabel = (who: Recipient): string => (who.name && !who.name.includes('@') ? who.name : who.address)
