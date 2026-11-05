import { safeStorage } from 'electron'
import type { Store } from './store'

export interface Secrets {
  available(): boolean
  get(key: string): string | null
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
  available = (): boolean => true
  get = (key: string): string | null => this.values.get(key) ?? null
  set = (key: string, value: string): void => void this.values.set(key, value)
  remove = (key: string): void => void this.values.delete(key)
}
