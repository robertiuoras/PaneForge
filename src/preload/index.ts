// The only bridge between the renderer and Node. contextIsolation stays on, so the
// UI gets this narrow typed surface instead of ipcRenderer itself.

import { contextBridge, ipcRenderer } from 'electron'
import type { Api, Config, Session, StartSessionRequest } from '../shared/types'

const api: Api = {
  listProjects: () => ipcRenderer.invoke('projects:list'),
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  startSession: (req: StartSessionRequest) => ipcRenderer.invoke('sessions:start', req),
  startSessions: (reqs: StartSessionRequest[]) => ipcRenderer.invoke('sessions:startMany', reqs),
  restartSession: (id) => ipcRenderer.invoke('sessions:restart', id),
  renameSession: (id, title) => ipcRenderer.invoke('sessions:rename', id, title),
  killSession: (id) => ipcRenderer.invoke('sessions:kill', id),
  getBuffer: (id) => ipcRenderer.invoke('sessions:buffer', id),
  clearAttention: (id) => ipcRenderer.send('sessions:attention-clear', id),
  write: (id, data) => ipcRenderer.send('pty:write', id, data),
  broadcast: (text) => ipcRenderer.send('pty:broadcast', text),
  resize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),

  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch: Partial<Config>) => ipcRenderer.invoke('config:set', patch),
  pickRoot: () => ipcRenderer.invoke('config:pickRoot'),

  reveal: (path) => ipcRenderer.send('shell:reveal', path),
  openInEditor: (path) => ipcRenderer.invoke('shell:editor', path),
  isAdmin: () => ipcRenderer.invoke('app:isAdmin'),
  relaunchAsAdmin: () => ipcRenderer.send('app:relaunchAsAdmin'),

  onData: (cb) => {
    const h = (_e: unknown, id: string, data: string) => cb(id, data)
    ipcRenderer.on('pty:data', h)
    return () => ipcRenderer.off('pty:data', h)
  },
  onSessions: (cb) => {
    const h = (_e: unknown, sessions: Session[]) => cb(sessions)
    ipcRenderer.on('sessions:changed', h)
    return () => ipcRenderer.off('sessions:changed', h)
  },
  onConfig: (cb) => {
    const h = (_e: unknown, config: Config) => cb(config)
    ipcRenderer.on('config:changed', h)
    return () => ipcRenderer.off('config:changed', h)
  }
}

contextBridge.exposeInMainWorld('api', api)
