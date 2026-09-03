/**
 * The one list of what `window.api` is, as data.
 *
 * The renderer is pure UI over `window.api` - it imports nothing from Electron and
 * nothing from Node - so the same UI runs in a browser the moment something else
 * supplies that object. What stopped it was not the UI: it was that the mapping from
 * method name to IPC channel only existed as 141 hand-written closures inside the
 * preload, and a second transport would have had to repeat every one of them.
 *
 * So the mapping lives here and both transports are built from it: the preload over
 * `ipcRenderer` (src/preload/index.ts) and the phone/browser client over HTTP
 * (src/renderer/src/browserApi.ts). `Surface` is keyed by `keyof Api`, so a method
 * added to the interface without a channel here does not typecheck - the drift that
 * would otherwise be silent, and the reason this is not two lists.
 *
 * Modes, and why a method's kind is not guessable from its name:
 *  - `invoke` - request/response. Extra members are literal arguments the bridge itself
 *    adds ahead of the caller's (only `listAgents`, which always asks for the probe).
 *  - `send`   - fire and forget, and therefore ORDERED with respect to other sends: a
 *    keystroke followed by a resize must arrive that way round.
 *  - `on`     - main pushes, the method returns its own unsubscribe.
 *  - `local`  - not IPC at all. `pathForFile` reads Electron's webUtils, and a browser
 *    has no path for a dropped file, so it answers '' there rather than pretending.
 */

import type { Api } from './types'

export type SurfaceEntry =
  | readonly ['invoke', string, ...unknown[]]
  | readonly ['send', string]
  | readonly ['on', string]
  | readonly ['local']

/** Every method of `Api`, and nothing else. */
export type Surface = { readonly [K in keyof Api]: SurfaceEntry }

export const SURFACE: Surface = {
  listProjects: ['invoke', 'projects:list'],
  createProject: ['invoke', 'projects:create'],
  routeProjects: ['invoke', 'projects:route'],
  listAgents: ['invoke', 'agents:list', true],
  listSessions: ['invoke', 'sessions:list'],
  startSession: ['invoke', 'sessions:start'],
  startSessions: ['invoke', 'sessions:startMany'],
  restartSession: ['invoke', 'sessions:restart'],
  switchAgent: ['invoke', 'sessions:switchAgent'],
  renameSession: ['invoke', 'sessions:rename'],
  undoClientName: ['invoke', 'sessions:clientUndo'],
  killSession: ['invoke', 'sessions:kill'],
  sleepSession: ['invoke', 'sessions:sleep'],
  wakeSession: ['invoke', 'sessions:wake'],
  quitIdle: ['invoke', 'app:quitIdle'],
  getBuffer: ['invoke', 'sessions:buffer'],
  whatsNew: ['invoke', 'app:whatsNew'],
  paneLog: ['invoke', 'sessions:log'],
  pipePane: ['invoke', 'sessions:pipe'],
  reorderSessions: ['send', 'sessions:reorder'],
  logReclaim: ['send', 'reclaim:log'],
  logFix: ['send', 'pane:fixlog'],
  listActivity: ['invoke', 'activity:list'],
  taskBrief: ['invoke', 'backlog:task'],
  markActivitySeen: ['send', 'activity:seen'],
  clearAttention: ['send', 'sessions:attention-clear'],
  write: ['send', 'pty:write'],
  sendPrompt: ['send', 'pty:prompt'],
  resize: ['send', 'pty:resize'],
  returnSize: ['send', 'pty:return'],
  paneVisibility: ['send', 'pty:visible'],
  redraw: ['send', 'pty:redraw'],
  setBusy: ['send', 'sessions:busy'],
  setClosing: ['send', 'sessions:closing'],
  startSwarm: ['invoke', 'sessions:swarm'],
  getConfig: ['invoke', 'config:get'],
  setConfig: ['invoke', 'config:set'],
  pickRoot: ['invoke', 'config:pickRoot'],
  addSound: ['invoke', 'sounds:add'],
  soundData: ['invoke', 'sounds:data'],
  removeSound: ['invoke', 'sounds:remove'],
  renameSound: ['invoke', 'sounds:rename'],
  discordStatus: ['invoke', 'discord:status'],
  onDiscordStatus: ['on', 'discord:status'],
  reveal: ['send', 'shell:reveal'],
  revealProject: ['invoke', 'shell:revealProject'],
  revealPane: ['invoke', 'shell:revealPane'],
  pathKind: ['invoke', 'shell:pathKind'],
  openInEditor: ['invoke', 'shell:editor'],
  openExternal: ['send', 'shell:external'],
  copyText: ['send', 'clipboard:write'],
  readClipboard: ['invoke', 'clipboard:read'],
  chooseOption: ['invoke', 'pty:choose'],
  attachFiles: ['invoke', 'pty:attach'],
  attachPaths: ['invoke', 'pty:attachPaths'],
  attachClipboardImage: ['invoke', 'pty:attachClipboard'],
  putImageOnClipboard: ['invoke', 'clipboard:writeImage'],
  clipboardFixtureActive: ['invoke', 'clipboard:fixtureActive'],
  gitInfo: ['invoke', 'git:info'],
  diffFiles: ['invoke', 'git:diffFiles'],
  diffPatch: ['invoke', 'git:diffPatch'],
  laneBoard: ['invoke', 'lanes:board'],
  laneWork: ['invoke', 'lanes:work'],
  mergeLane: ['invoke', 'lanes:merge'],
  onLaneMoved: ['on', 'lane:moved'],
  onHandoffMoved: ['on', 'handoff:moved'],
  onOffloadSoon: ['on', 'offload:soon'],
  answerOffload: ['invoke', 'offload:answer'],
  pathForFile: ['local'],
  adminStatus: ['invoke', 'admin:status'],
  adminEnable: ['invoke', 'admin:enable'],
  adminDisable: ['invoke', 'admin:disable'],
  relaunchAsAdmin: ['send', 'app:relaunchAsAdmin'],
  profile: ['invoke', 'app:profile'],
  installAgent: ['invoke', 'agents:install'],
  uninstallAgent: ['invoke', 'agents:uninstall'],
  locateAgent: ['invoke', 'agents:locate'],
  updateState: ['invoke', 'update:state'],
  checkForUpdates: ['invoke', 'update:check'],
  installUpdate: ['invoke', 'update:install'],
  installUpdateAnyway: ['send', 'game:installAnyway'],
  gameStatus: ['invoke', 'game:status'],
  appVisibleNow: ['invoke', 'app:visibleNow'],
  appOnBatteryNow: ['invoke', 'app:batteryNow'],
  setGameManual: ['invoke', 'game:manual'],
  pendingRestore: ['invoke', 'restore:pending'],
  answerRestore: ['send', 'restore:answer'],
  board: ['invoke', 'board:get'],
  saveTasks: ['invoke', 'board:tasks'],
  saveMemory: ['invoke', 'board:memory'],
  listHistory: ['invoke', 'history:list'],
  searchHistory: ['invoke', 'history:search'],
  readHistory: ['invoke', 'history:read'],
  deleteHistory: ['invoke', 'history:delete'],
  listRecents: ['invoke', 'recents:list'],
  searchRecents: ['invoke', 'recents:search'],
  recentText: ['invoke', 'recents:text'],
  editRecent: ['send', 'recents:edit'],
  copyRecent: ['send', 'recents:copy'],
  dragRecent: ['send', 'recents:drag'],
  removeRecent: ['send', 'recents:remove'],
  clearRecents: ['send', 'recents:clear'],
  stashInWindow: ['send', 'recents:inWindow'],
  addStashFiles: ['invoke', 'stash:add'],
  pickStashFiles: ['invoke', 'stash:pick'],
  revealStash: ['send', 'stash:reveal'],
  toggleStash: ['send', 'shelf:toggle'],
  phoneState: ['invoke', 'phone:state'],
  setPhoneServing: ['invoke', 'phone:serve'],
  setPhonePort: ['invoke', 'phone:port'],
  rotatePhoneCode: ['invoke', 'phone:rotate'],
  setPhoneTunnel: ['invoke', 'phone:tunnel'],
  answerPhoneAsk: ['invoke', 'phone:answerAsk'],
  forgetPhoneDevice: ['invoke', 'phone:forget'],
  clearPhoneMark: ['invoke', 'phone:clearMark'],
  setPhoneAsking: ['invoke', 'phone:asking'],
  setPhoneTypeGate: ['invoke', 'phone:typeGate'],
  forgetPhoneKey: ['invoke', 'phone:forgetKey'],
  onPhone: ['on', 'phone:changed'],
  remoteState: ['invoke', 'remote:state'],
  setRemoteHost: ['invoke', 'remote:host'],
  setRemotePort: ['invoke', 'remote:port'],
  rotateRemoteCode: ['invoke', 'remote:rotate'],
  renameDevice: ['invoke', 'remote:rename'],
  pairRemote: ['invoke', 'remote:pair'],
  remoteInvite: ['invoke', 'remote:invite'],
  pairRemoteText: ['invoke', 'remote:pairText'],
  pairFromClipboard: ['invoke', 'remote:pairClipboard'],
  clipboardInvite: ['invoke', 'remote:clipboardInvite'],
  askToPair: ['invoke', 'remote:ask'],
  answerPair: ['invoke', 'remote:answer'],
  cancelAsk: ['invoke', 'remote:cancelAsk'],
  setPairByAsking: ['invoke', 'remote:pairByAsking'],
  forgetRemote: ['invoke', 'remote:forget'],
  connectRemote: ['invoke', 'remote:connect'],
  scanRemote: ['invoke', 'remote:scan'],
  watchRemote: ['invoke', 'remote:watch'],
  remoteProjects: ['invoke', 'remote:projects'],
  remoteAgents: ['invoke', 'remote:agents'],
  startRemote: ['invoke', 'remote:start'],
  handoffToDevice: ['invoke', 'remote:handoff'],
  bringPaneHere: ['invoke', 'remote:bringHere'],
  handoffPending: ['invoke', 'remote:handoffPending'],
  handoffReady: ['invoke', 'remote:handoffReady'],
  cancelHandoff: ['invoke', 'remote:handoffCancel'],
  // Signing in to a browser on another machine - see shared/remoteLogin.ts. The frames
  // are an `on`, so a phone watching the same desk gets the picture for free; the ack
  // that asks for the NEXT one is a send, and ordered with respect to the input, which
  // is what keeps a keystroke from overtaking the frame it was typed into.
  loginRequests: ['invoke', 'login:list'],
  needsLogin: ['invoke', 'login:need'],
  openLogin: ['invoke', 'login:open'],
  closeLogin: ['send', 'login:close'],
  dismissLogin: ['send', 'login:dismiss'],
  loginInput: ['send', 'login:input'],
  loginPainted: ['send', 'login:ack'],
  loginSize: ['send', 'login:size'],
  onLoginFrame: ['on', 'login:frame'],
  onLogins: ['on', 'login:changed'],
  askAutoClear: ['invoke', 'autoclear:ask'],
  cancelAutoClear: ['invoke', 'autoclear:cancel'],
  takeOverPane: ['invoke', 'autoclear:takeover'],
  priorPrompt: ['invoke', 'prompt:prior'],
  splitPrompt: ['invoke', 'prompt:split'],
  promptUsed: ['send', 'prompt:used'],
  voiceStatus: ['invoke', 'voice:status'],
  transcribe: ['invoke', 'voice:transcribe'],
  installVoice: ['invoke', 'voice:install'],
  onData: ['on', 'pty:data'],
  onSessions: ['on', 'sessions:changed'],
  onConfig: ['on', 'config:changed'],
  onInstall: ['on', 'agents:install-event'],
  onUpdate: ['on', 'update:changed'],
  onAppVisible: ['on', 'app:visible'],
  onBattery: ['on', 'app:battery'],
  // Answered by the phone's own transport, never sent by main: a window looking at its
  // own machine has no link to lose. See browserApi.ts `sayLink`.
  onLinkState: ['on', 'link:state'],
  onGameMode: ['on', 'game:changed'],
  onAttention: ['on', 'sessions:attention'],
  onStalled: ['on', 'sessions:stalled'],
  onBell: ['on', 'sessions:bell'],
  onAsk: ['on', 'sessions:ask'],
  onClientNamed: ['on', 'sessions:clientNamed'],
  onActivity: ['on', 'activity:changed'],
  paneBell: ['send', 'sessions:bell'],
  onRemote: ['on', 'remote:changed'],
  onCapacity: ['on', 'capacity:changed'],
  onAway: ['on', 'system:away'],
  onUsage: ['on', 'usage:changed'],
  usage: ['invoke', 'usage:get'],
  listDevServers: ['invoke', 'devs:list'],
  stopDevServer: ['invoke', 'devs:stop'],
  onStopSoon: ['on', 'devs:stopSoon'],
  keepDevServer: ['send', 'devs:keep'],
  stopDevNow: ['send', 'devs:stopNow'],
  listJobs: ['invoke', 'jobs:list'],
  listRemoteJobs: ['invoke', 'jobs:remote'],
  onPaneReset: ['on', 'pane:reset'],
  onPaneArmClear: ['on', 'pane:armClear'],
  onPaneTyped: ['on', 'pane:typed'],
  onPaneHandover: ['on', 'pane:handover'],
  onVoiceHotkey: ['on', 'voice:hotkey'],
  onRecents: ['on', 'recents:changed'],
  onStashSearch: ['on', 'recents:openSearch'],
  onRecentToPane: ['on', 'recents:toPane'],
  onAppError: ['on', 'app:error']
}

/** Every channel main is expected to answer, for a transport that has to allow-list them. */
export function surfaceChannels(): { invoke: string[]; send: string[]; on: string[] } {
  const out = { invoke: [] as string[], send: [] as string[], on: [] as string[] }
  for (const entry of Object.values(SURFACE) as SurfaceEntry[]) {
    if (entry[0] === 'local') continue
    const list = out[entry[0]]
    if (!list.includes(entry[1])) list.push(entry[1])
  }
  return out
}

/** What a transport has to be able to do. Nothing about Electron, nothing about HTTP. */
export interface Transport {
  invoke(channel: string, args: unknown[]): Promise<unknown>
  send(channel: string, args: unknown[]): void
  on(channel: string, handler: (...args: unknown[]) => void): () => void
}

/**
 * Turn a transport into the object the UI expects.
 *
 * `local` supplies the entries that are not IPC at all; anything the caller does not
 * supply answers with the neutral value rather than throwing, because a browser missing
 * one Electron-only affordance must not take the page down with it.
 */
export function buildApi(transport: Transport, local: Partial<Api> = {}): Api {
  const api = {} as Record<string, unknown>
  for (const [name, entry] of Object.entries(SURFACE) as [string, SurfaceEntry][]) {
    // A transport may answer a method ITSELF rather than sending it, and the clipboard is
    // why: `copyText` over HTTP wrote to the clipboard of the machine at the other end of
    // the wire - the desk - so every copy made on a phone landed on a device the person
    // was not holding. The channel stays declared above (this is still one list, and the
    // desk still uses it); a transport that has a better local answer supplies it here.
    const override = (local as Record<string, unknown>)[name]
    if (override && entry[0] !== 'on') {
      api[name] = override
      continue
    }
    if (entry[0] === 'local') {
      api[name] = (local as Record<string, unknown>)[name] ?? ((): string => '')
      continue
    }
    if (entry[0] === 'invoke') {
      const fixed = entry.slice(2)
      api[name] = (...args: unknown[]) => transport.invoke(entry[1], [...fixed, ...args])
      continue
    }
    if (entry[0] === 'send') {
      api[name] = (...args: unknown[]) => transport.send(entry[1], args)
      continue
    }
    api[name] = (cb: (...args: unknown[]) => void) => transport.on(entry[1], cb)
  }
  return api as unknown as Api
}
