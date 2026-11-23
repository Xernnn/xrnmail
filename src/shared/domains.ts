/** Second levels that are bought under, as in example.co.uk or example.edu.vn. */
const SHARED_SECOND = /^(co|com|net|org|edu|gov|ac|or|ne|go|gob|mil|nic|ltd|plc|sch|info|biz|id)$/

/** The part of a domain that's bought: mail.example.com and example.com are the same company. */
export function organization(domain: string): string {
  const parts = domain.toLowerCase().replace(/\.$/, '').split('.').filter(Boolean)
  if (parts.length <= 2) return parts.join('.')
  const second = parts.at(-2) ?? ''
  const keep = SHARED_SECOND.test(second) && (parts.at(-1)?.length ?? 0) === 2 ? 3 : 2
  return parts.slice(-keep).join('.')
}
