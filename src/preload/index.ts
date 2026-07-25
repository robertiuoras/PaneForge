// The only bridge between the renderer and Node. contextIsolation stays on, so the
// UI gets this narrow typed surface instead of ipcRenderer itself.

import { contextBridge, ipcRenderer } from 'electron'
import type {
  Api,
  Config,
  InstallEvent,
  Session,
  StartSessionRequest,
  SwarmRequest,
  TaskItem,
  UpdateState
} from '../shared/types'

const api: Api = {
  listProjects: () => ipcRenderer.invoke('projects:list'),
  listAgents: () => ipcRenderer.invoke('agents:list', true),
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  startSession: (req: StartSessionRequest) => ipcRenderer.invoke('sessions:start', req),
  startSessions: (reqs: StartSessionRequest[]) => ipcRenderer.invoke('sessions:startMany', reqs),
  restartSession: (id) => ipcRenderer.invoke('sessions:restart', id),
  switchAgent: (id, agent, model) => ipcRenderer.invoke('sessions:switchAgent', id, agent, model),
  renameSession: (id, title) => ipcRenderer.invoke('sessions:rename', id, title),
  killSession: (id) => ipcRenderer.invoke('sessions:kill', id),
  getBuffer: (id) => ipcRenderer.invoke('sessions:buffer', id),
  clearAttention: (id) => ipcRenderer.send('sessions:attention-clear', id),
  write: (id, data) => ipcRenderer.send('pty:write', id, data),
  broadcast: (text) => ipcRenderer.send('pty:broadcast', text),
  resize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
  startSwarm: (req: SwarmRequest) => ipcRenderer.invoke('sessions:swarm', req),

  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch: Partial<Config>) => ipcRenderer.invoke('config:set', patch),
  pickRoot: () => ipcRenderer.invoke('config:pickRoot'),

  reveal: (path) => ipcRenderer.send('shell:reveal', path),
  openInEditor: (path) => ipcRenderer.invoke('shell:editor', path),
  openExternal: (url) => ipcRenderer.send('shell:external', url),
  copyText: (text) => ipcRenderer.send('clipboard:write', text),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  gitInfo: (path) => ipcRenderer.invoke('git:info', path),

  adminStatus: () => ipcRenderer.invoke('admin:status'),
  adminEnable: () => ipcRenderer.invoke('admin:enable'),
  adminDisable: () => ipcRenderer.invoke('admin:disable'),
  relaunchAsAdmin: () => ipcRenderer.send('app:relaunchAsAdmin'),

  installAgent: (id) => ipcRenderer.invoke('agents:install', id),
  locateAgent: (id) => ipcRenderer.invoke('agents:locate', id),

  updateState: () => ipcRenderer.invoke('update:state'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.send('update:install'),

  board: (path) => ipcRenderer.invoke('board:get', path),
  saveTasks: (path, tasks: TaskItem[]) => ipcRenderer.invoke('board:tasks', path, tasks),
  saveMemory: (path, memory) => ipcRenderer.invoke('board:memory', path, memory),

  listHistory: () => ipcRenderer.invoke('history:list'),
  searchHistory: (q) => ipcRenderer.invoke('history:search', q),
  readHistory: (id) => ipcRenderer.invoke('history:read', id),
  deleteHistory: (id) => ipcRenderer.invoke('history:delete', id),

  voiceStatus: () => ipcRenderer.invoke('voice:status'),
  transcribe: (wav) => ipcRenderer.invoke('voice:transcribe', wav),
  installVoice: () => ipcRenderer.invoke('voice:install'),

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
  },
  onInstall: (cb) => {
    const h = (_e: unknown, event: InstallEvent) => cb(event)
    ipcRenderer.on('agents:install-event', h)
    return () => ipcRenderer.off('agents:install-event', h)
  },
  onUpdate: (cb) => {
    const h = (_e: unknown, state: UpdateState) => cb(state)
    ipcRenderer.on('update:changed', h)
    return () => ipcRenderer.off('update:changed', h)
  },
  onVoiceHotkey: (cb) => {
    const h = (): void => cb()
    ipcRenderer.on('voice:hotkey', h)
    return () => ipcRenderer.off('voice:hotkey', h)
  }
}

contextBridge.exposeInMainWorld('api', api)
