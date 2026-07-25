// The only bridge between the renderer and Node. contextIsolation stays on, so the
// UI gets this narrow typed surface instead of ipcRenderer itself.

import { contextBridge, ipcRenderer } from 'electron'
import type { Api, Session, StartSessionRequest } from '../shared/types'

const api: Api = {
  listProjects: () => ipcRenderer.invoke('projects:list'),
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  startSession: (req: StartSessionRequest) => ipcRenderer.invoke('sessions:start', req),
  killSession: (id: string) => ipcRenderer.invoke('sessions:kill', id),
  getBuffer: (id: string) => ipcRenderer.invoke('sessions:buffer', id),
  write: (id, data) => ipcRenderer.send('pty:write', id, data),
  resize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
  onData: (cb) => {
    const h = (_e: unknown, id: string, data: string) => cb(id, data)
    ipcRenderer.on('pty:data', h)
    return () => ipcRenderer.off('pty:data', h)
  },
  onSessions: (cb) => {
    const h = (_e: unknown, sessions: Session[]) => cb(sessions)
    ipcRenderer.on('sessions:changed', h)
    return () => ipcRenderer.off('sessions:changed', h)
  }
}

contextBridge.exposeInMainWorld('api', api)
