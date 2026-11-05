import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { MailApi } from '@shared/types'

const call = (channel: string, ...args: unknown[]): Promise<never> =>
  ipcRenderer.invoke(channel, ...args) as Promise<never>

const api: MailApi = {
  accounts: () => call('accounts'),
  addAccount: (email, secret) => call('addAccount', email, secret),
  removeAccount: (id) => call('removeAccount', id),
  syncNow: () => call('syncNow'),
  overview: () => call('overview'),
  list: (query) => call('list', query),
  thread: (account, thread) => call('thread', account, thread),
  settings: () => call('settings'),
  saveBatch: (batch) => call('saveBatch', batch),
  saveBackfill: (days) => call('saveBackfill', days),
  connectHub: (url, user, secret) => call('connectHub', url, user, secret),
  disconnectHub: () => call('disconnectHub'),
  beginEarly: () => call('beginEarly'),
  finishEarly: () => call('finishEarly'),
  allowRemoteImages: (allow) => call('allowRemoteImages', allow),
  openInGmail: (email, thread) => call('openInGmail', email, thread),
  openLink: (url) => call('openLink', url),
  onChanged: (listener) => {
    const relay = (_event: IpcRendererEvent): void => listener()
    ipcRenderer.on('changed', relay)
    return () => ipcRenderer.removeListener('changed', relay)
  }
}

contextBridge.exposeInMainWorld('mail', api)
