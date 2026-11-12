import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AppCommand, Draft, MailApi } from '@shared/types'

const call = (channel: string, ...args: unknown[]): Promise<never> =>
  ipcRenderer.invoke(channel, ...args) as Promise<never>

const api: MailApi = {
  accounts: () => call('accounts'),
  addAccount: (account) => call('addAccount', account),
  startMicrosoft: (email, clientId) => call('startMicrosoft', email, clientId),
  finishMicrosoft: () => call('finishMicrosoft'),
  detectProvider: (email) => call('detectProvider', email),
  removeAccount: (id) => call('removeAccount', id),
  syncNow: () => call('syncNow'),
  overview: () => call('overview'),
  list: (query, limit) => call('list', query, limit),
  thread: (account, thread, bins, remember) => call('thread', account, thread, bins, remember),
  clearRecent: () => call('clearRecent'),
  settings: () => call('settings'),
  saveBatch: (batch) => call('saveBatch', batch),
  saveBackfill: (days) => call('saveBackfill', days),
  saveSummary: (summary) => call('saveSummary', summary),
  summarySenders: () => call('summarySenders'),
  connectHub: (url, user, secret) => call('connectHub', url, user, secret),
  disconnectHub: () => call('disconnectHub'),
  beginEarly: () => call('beginEarly'),
  finishEarly: () => call('finishEarly'),
  allowRemoteImages: (allow) => call('allowRemoteImages', allow),
  act: (targets, action) => call('act', targets, action),
  undo: (token) => call('undo', token),
  snooze: (targets, until) => call('snooze', targets, until),
  unsnooze: (targets) => call('unsnooze', targets),
  pin: (targets, on) => call('pin', targets, on),
  block: (address) => call('block', address),
  unsubscribe: (message) => call('unsubscribe', message),
  subscriptions: () => call('subscriptions'),
  unsubscribed: () => call('unsubscribed'),
  clearSender: (account, address) => call('clearSender', account, address),
  setFocus: (address, focused) => call('setFocus', address, focused),
  rsvp: (message, answer) => call('rsvp', message, answer),
  contacts: (text) => call('contacts', text),
  saveAttachment: (message, index) => call('saveAttachment', message, index),
  openAttachment: (message, index) => call('openAttachment', message, index),
  details: (message) => call('details', message),
  copyAddress: (address) => call('copyAddress', address),
  faces: (addresses, lookUp) => call('faces', addresses, lookUp),
  choosePhoto: (account) => call('choosePhoto', account),
  removePhoto: (account) => call('removePhoto', account),
  photos: () => call('photos'),
  drafts: () => call('drafts'),
  openThreadWindow: (account, thread, bins) => call('openThreadWindow', account, thread, bins),
  openDraftWindow: (id) => call('openDraftWindow', id),
  showDraftWindow: (id) => call('showDraftWindow', id),
  createFolder: (account, name) => call('createFolder', account, name),
  startDraft: (start) => call('startDraft', start),
  saveDraft: (id, edit) => call('saveDraft', id, edit),
  discardDraft: (id) => call('discardDraft', id),
  pickFiles: (id) => call('pickFiles', id),
  addFile: (id, name, type, bytes) => call('addFile', id, name, type, bytes),
  removeFile: (id, file) => call('removeFile', id, file),
  send: (id, at) => call('send', id, at),
  unsend: (id) => call('unsend', id),
  saveProfile: (patch) => call('saveProfile', patch),
  openInGmail: (email, thread) => call('openInGmail', email, thread),
  openLink: (url) => call('openLink', url),
  version: () => call('version'),
  onCommand: (listener) => {
    const relay = (_event: IpcRendererEvent, command: AppCommand): void => listener(command)
    ipcRenderer.on('command', relay)
    return () => ipcRenderer.removeListener('command', relay)
  },
  onChanged: (listener) => {
    const relay = (_event: IpcRendererEvent): void => listener()
    ipcRenderer.on('changed', relay)
    return () => ipcRenderer.removeListener('changed', relay)
  },
  onFaces: (listener) => {
    const relay = (_event: IpcRendererEvent): void => listener()
    ipcRenderer.on('faces', relay)
    return () => ipcRenderer.removeListener('faces', relay)
  },
  onLeaving: (listener) => {
    const relay = (_event: IpcRendererEvent): void => listener()
    ipcRenderer.on('leaving', relay)
    return () => ipcRenderer.removeListener('leaving', relay)
  },
  onCompose: (listener) => {
    const relay = (_event: IpcRendererEvent, draft: Draft): void => listener(draft)
    ipcRenderer.on('compose', relay)
    return () => ipcRenderer.removeListener('compose', relay)
  }
}

contextBridge.exposeInMainWorld('mail', api)
