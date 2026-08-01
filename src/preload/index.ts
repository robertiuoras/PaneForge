// The only bridge between the renderer and Node. contextIsolation stays on, so the
// UI gets this narrow typed surface instead of ipcRenderer itself.

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  Api,
  Config,
  GameModeStatus,
  InstallEvent,
  RecentItem,
  RemoteState,
  RestoreAnswer,
  Session,
  SplitRequest,
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
  pipePane: (id, opts) => ipcRenderer.invoke('sessions:pipe', id, opts),
  reorderSessions: (ids) => ipcRenderer.send('sessions:reorder', ids),
  clearAttention: (id) => ipcRenderer.send('sessions:attention-clear', id),
  write: (id, data) => ipcRenderer.send('pty:write', id, data),
  resize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
  redraw: (id) => ipcRenderer.send('pty:redraw', id),
  setBusy: (id, busy, tail, clock) => ipcRenderer.send('sessions:busy', id, busy, tail, clock),
  startSwarm: (req: SwarmRequest) => ipcRenderer.invoke('sessions:swarm', req),
  planSplit: (req: { cwd: string; mission: string; agent?: string }) =>
    ipcRenderer.invoke('sessions:planSplit', req),
  startSplit: (req: SplitRequest) => ipcRenderer.invoke('sessions:split', req),

  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch: Partial<Config>) => ipcRenderer.invoke('config:set', patch),
  pickRoot: () => ipcRenderer.invoke('config:pickRoot'),

  reveal: (path) => ipcRenderer.send('shell:reveal', path),
  openInEditor: (path) => ipcRenderer.invoke('shell:editor', path),
  openExternal: (url) => ipcRenderer.send('shell:external', url),
  copyText: (text) => ipcRenderer.send('clipboard:write', text),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  gitInfo: (path) => ipcRenderer.invoke('git:info', path),
  laneBoard: () => ipcRenderer.invoke('lanes:board'),
  laneWork: (cwd) => ipcRenderer.invoke('lanes:work', cwd),
  mergeLane: (cwd) => ipcRenderer.invoke('lanes:merge', cwd),
  onLaneMoved: (cb) => {
    const h = (_e: unknown, id: string, message: string) => cb(id, message)
    ipcRenderer.on('lane:moved', h)
    return () => ipcRenderer.off('lane:moved', h)
  },
  // File.path was removed from Electron's File objects; webUtils is the only way
  // a dropped file's real path reaches the renderer.
  pathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },

  adminStatus: () => ipcRenderer.invoke('admin:status'),
  adminEnable: () => ipcRenderer.invoke('admin:enable'),
  adminDisable: () => ipcRenderer.invoke('admin:disable'),
  relaunchAsAdmin: () => ipcRenderer.send('app:relaunchAsAdmin'),
  profile: () => ipcRenderer.invoke('app:profile'),

  installAgent: (id) => ipcRenderer.invoke('agents:install', id),
  uninstallAgent: (id) => ipcRenderer.invoke('agents:uninstall', id),
  locateAgent: (id) => ipcRenderer.invoke('agents:locate', id),

  updateState: () => ipcRenderer.invoke('update:state'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  installUpdateAnyway: () => ipcRenderer.send('game:installAnyway'),

  gameStatus: () => ipcRenderer.invoke('game:status'),
  appVisibleNow: () => ipcRenderer.invoke('app:visibleNow'),
  setGameManual: (on: boolean) => ipcRenderer.invoke('game:manual', on),

  pendingRestore: () => ipcRenderer.invoke('restore:pending'),
  answerRestore: (answer: RestoreAnswer) => ipcRenderer.send('restore:answer', answer),

  board: (path) => ipcRenderer.invoke('board:get', path),
  saveTasks: (path, tasks: TaskItem[]) => ipcRenderer.invoke('board:tasks', path, tasks),
  saveMemory: (path, memory) => ipcRenderer.invoke('board:memory', path, memory),

  listHistory: () => ipcRenderer.invoke('history:list'),
  searchHistory: (q) => ipcRenderer.invoke('history:search', q),
  readHistory: (id) => ipcRenderer.invoke('history:read', id),
  deleteHistory: (id) => ipcRenderer.invoke('history:delete', id),

  listRecents: () => ipcRenderer.invoke('recents:list'),
  recentText: (id) => ipcRenderer.invoke('recents:text', id),
  copyRecent: (id) => ipcRenderer.send('recents:copy', id),
  dragRecent: (id) => ipcRenderer.send('recents:drag', id),
  removeRecent: (id) => ipcRenderer.send('recents:remove', id),
  clearRecents: () => ipcRenderer.send('recents:clear'),
  addStashFiles: (paths) => ipcRenderer.invoke('stash:add', paths),
  pickStashFiles: () => ipcRenderer.invoke('stash:pick'),
  revealStash: () => ipcRenderer.send('stash:reveal'),
  toggleStash: () => ipcRenderer.send('shelf:toggle'),

  remoteState: () => ipcRenderer.invoke('remote:state'),
  setRemoteHost: (on) => ipcRenderer.invoke('remote:host', on),
  setRemotePort: (port) => ipcRenderer.invoke('remote:port', port),
  rotateRemoteCode: () => ipcRenderer.invoke('remote:rotate'),
  renameDevice: (name) => ipcRenderer.invoke('remote:rename', name),
  pairRemote: (peer) => ipcRenderer.invoke('remote:pair', peer),
  remoteInvite: () => ipcRenderer.invoke('remote:invite'),
  pairRemoteText: (text) => ipcRenderer.invoke('remote:pairText', text),
  pairFromClipboard: () => ipcRenderer.invoke('remote:pairClipboard'),
  clipboardInvite: () => ipcRenderer.invoke('remote:clipboardInvite'),
  forgetRemote: (id) => ipcRenderer.invoke('remote:forget', id),
  connectRemote: (id, on) => ipcRenderer.invoke('remote:connect', id, on),
  scanRemote: () => ipcRenderer.invoke('remote:scan'),
  remoteProjects: (device) => ipcRenderer.invoke('remote:projects', device),
  remoteAgents: (device) => ipcRenderer.invoke('remote:agents', device),
  startRemote: (device, req: StartSessionRequest) => ipcRenderer.invoke('remote:start', device, req),

  improveStatus: () => ipcRenderer.invoke('improve:status'),
  improvePrompt: (id, draft, options) => ipcRenderer.invoke('improve:run', id, draft, options),
  answerImprove: (id, draft, answers, options) =>
    ipcRenderer.invoke('improve:answer', id, draft, answers, options),
  cancelImprove: (id) => ipcRenderer.send('improve:cancel', id),
  researchRequest: (id, draft) => ipcRenderer.invoke('research:run', id, draft),
  cancelResearch: (id) => ipcRenderer.send('research:cancel', id),
  applyImproved: (id, text) => ipcRenderer.invoke('improve:apply', id, text),
  recordImprove: (outcome, metrics, editedChars) =>
    ipcRenderer.send('improve:record', outcome, metrics, editedChars),

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
  onAppVisible: (cb) => {
    const h = (_e: unknown, visible: boolean) => cb(visible)
    ipcRenderer.on('app:visible', h)
    return () => ipcRenderer.off('app:visible', h)
  },
  onGameMode: (cb) => {
    const h = (_e: unknown, status: GameModeStatus) => cb(status)
    ipcRenderer.on('game:changed', h)
    return () => ipcRenderer.off('game:changed', h)
  },
  onAttention: (cb) => {
    const h = (_e: unknown, s: Session) => cb(s)
    ipcRenderer.on('sessions:attention', h)
    return () => ipcRenderer.off('sessions:attention', h)
  },
  onStalled: (cb) => {
    const h = (_e: unknown, s: Session) => cb(s)
    ipcRenderer.on('sessions:stalled', h)
    return () => ipcRenderer.off('sessions:stalled', h)
  },
  onBell: (cb) => {
    const h = (_e: unknown, s: Session) => cb(s)
    ipcRenderer.on('sessions:bell', h)
    return () => ipcRenderer.off('sessions:bell', h)
  },
  paneBell: (id) => ipcRenderer.send('sessions:bell', id),
  onRemote: (cb) => {
    const h = (_e: unknown, state: RemoteState) => cb(state)
    ipcRenderer.on('remote:changed', h)
    return () => ipcRenderer.off('remote:changed', h)
  },
  onPaneReset: (cb) => {
    const h = (_e: unknown, id: string) => cb(id)
    ipcRenderer.on('pane:reset', h)
    return () => ipcRenderer.off('pane:reset', h)
  },
  onVoiceHotkey: (cb) => {
    const h = (): void => cb()
    ipcRenderer.on('voice:hotkey', h)
    return () => ipcRenderer.off('voice:hotkey', h)
  },
  onRecents: (cb) => {
    const h = (_e: unknown, items: RecentItem[]) => cb(items)
    ipcRenderer.on('recents:changed', h)
    return () => ipcRenderer.off('recents:changed', h)
  },
  onRecentToPane: (cb) => {
    const h = (_e: unknown, id: string): void => cb(id)
    ipcRenderer.on('recents:toPane', h)
    return () => ipcRenderer.off('recents:toPane', h)
  },
  onAppError: (cb) => {
    const h = (_e: unknown, message: string) => cb(message)
    ipcRenderer.on('app:error', h)
    return () => ipcRenderer.off('app:error', h)
  }
}

contextBridge.exposeInMainWorld('api', api)
