import { safeStorage } from 'electron'
import type { Store } from './store'

export interface Secrets {
  available(): boolean
  /** Null when it isn't kept, and also when it can't be read now. */
  get(key: string): string | null
  /** Whether it's kept at all, readable now or not. */
  has(key: string): boolean
  set(key: string, value: string): void
  remove(key: string): void
}

/** Encrypted by the system keyring, stored beside the mail. On Linux with no keyring Electron falls
 *  back to `basic_text`, a key built into every copy of Chromium, so that counts as no encryption. */
export class KeyringSecrets implements Secrets {
  constructor(private store: Store) {}

  available(): boolean {
    try {
      if (!safeStorage.isEncryptionAvailable()) return false
      return !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
    } catch {
      return false
    }
  }

  get(key: string): string | null {
    const stored = this.store.meta(`secret:${key}`)
    if (!stored || !this.available()) return null
    try {
      return safeStorage.decryptString(Buffer.from(stored, 'base64'))
    } catch {
      return null
    }
  }

  has(key: string): boolean {
    return this.store.meta(`secret:${key}`) !== null
  }

  set(key: string, value: string): void {
    if (!this.available()) throw new Error('Unlock your system keyring first.')
    this.store.setMeta(`secret:${key}`, safeStorage.encryptString(value).toString('base64'))
  }

  remove(key: string): void {
    this.store.deleteMeta(`secret:${key}`)
  }
}

/** For tests only: forgets everything on exit and never touches the real keyring. */
export class MemorySecrets implements Secrets {
  private values = new Map<string, string>()
  /** As a keyring that isn't open yet: everything is still there, and none of it can be read. */
  locked = false
  available = (): boolean => !this.locked
  get = (key: string): string | null => (this.locked ? null : (this.values.get(key) ?? null))
  has = (key: string): boolean => this.values.has(key)
  set = (key: string, value: string): void => {
    if (this.locked) throw new Error('Unlock your system keyring first.')
    this.values.set(key, value)
  }
  remove = (key: string): void => void this.values.delete(key)
}
