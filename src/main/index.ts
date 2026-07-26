import { spawn } from 'node:child_process'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  net,
  Notification,
  protocol,
  screen,
  shell
} from 'electron'
import { SessionManager } from './sessions'
import { listProjects } from './projects'
import { getConfig, setConfig } from './config'
import { Remote } from './remote'
import { invalidateAgents, listAgents, specFor } from './agents'
import { gitInfo } from './git'
import { laneExtras, resolveLane } from './lanes'
import { laneBoard } from './laneBoard'
import { which } from './which'
import { adminStatus, disableAdminMode, enableAdminMode, relaunchViaTask } from './admin'
import {
  initProfile,
  isQuietRelaunch,
  markQuietRelaunch,
  profileName,
  startMode,
  titleSuffix
} from './profile'
import { crashTestHook, installCrashGuard, onCrashReport } from './crash'
import {
  clearDesk,
  MAX_DESK_AGE_MS,
  MAX_RESTORE,
  paneMissing,
  readDesk,
  saveDesk,
  saveDeskOnExit,
  setDeskHold,
  startDeskAutosave
} from './restore'
import {
  addRecentFiles,
  clearRecents,
  configureRecents,
  copyRecent,
  getRecent,
  listRecents,
  pinRecent,
  recentPath,
  recentsDir,
  refreshRecents,
  removeRecent,
  startRecents,
  stopRecents
} from './recents'
import {
  beginShelfDrag,
  closeShelfWindow,
  endShelfDrag,
  moveShelfDrag,
  openShelfWindow,
  placeShelf,
  setShelfExpanded,
  setShelfTall,
  shelfWindowOpen,
  toggleShelf,
  updateShelfConfig,
  updateShelfItems
} from './shelfWindow'
import { refreshPath, runCommand } from './install'
import { checkForUpdates, getUpdateState, initUpdater, installUpdate, setAutoCheck } from './updater'
import * as history from './history'
import { readBoard, writeMemory, writeTasks } from './board'
import * as voice from './voice'
import { installCommand } from '../shared/agents'
import { STASH_CONFIG_KEYS } from '../shared/types'
import type {
  Config,
  RemoteState,
  RestoreAnswer,
  RestoreOffer,
  RestorePane,
  Session,
  StartSessionRequest,
  StashConfig,
  SwarmRequest,
  TaskItem,
  UpdateState
} from '../shared/types'

const manager = new SessionManager()
/** Keeps userData/desk.json in step with the panes on screen. See restore.ts. */
const noteDesk = startDeskAutosave(() => manager.snapshot())
let win: BrowserWindow | null = null
// True while the window is standing in for a maximized one: sized to the work area
// because a real maximize() would have taken focus. See createWindow.
let pseudoMax = false

// First thing in the process: an uncaught error in the main process otherwise opens a
// modal message box that steals focus from whatever you are typing in. Logged instead.
installCrashGuard()
onCrashReport((message) => send('app:error', message))

// Runs before anything reads userData: a named profile (`--profile=dev`) moves the
// whole profile aside so a second PaneForge can run beside the live one. It also sets
// the Windows app id, which ties notifications and the taskbar entry to this app -
// without it the toasts show up as "electron.app.Electron".
const profile = initProfile()

// A second launch (double-clicked shortcut) should raise the window we already have,
// not start a second app with its own set of agents.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    // Mid-update the installer launches the new exe while this one is still holding the
    // lock, so that launch arrives here as a second instance. Raising the window then
    // would undo the whole point of the silent update: it pops a dying app to the front
    // over whatever the user is doing. Take the args, leave the focus alone.
    if (!installStarted) focusWindow()
    openFromArgs(argv)
  })
}

/** The usable area of whichever display the window was last on. */
function workAreaFor(cfg: Config): Electron.Rectangle {
  const { x, y, width, height } = cfg.window
  const display =
    x === undefined || y === undefined
      ? screen.getPrimaryDisplay()
      : screen.getDisplayMatching({ x, y, width, height })
  return display.workArea
}

function createWindow(): void {
  // Windows and Linux get no application menu: its default accelerators (Ctrl+R reload,
  // Ctrl+W close) fire before the app's own shortcuts and would reload the UI out from
  // under the agents; clipboard keys work in text fields there without one. macOS has no
  // clipboard at all without a menu, and Cmd there cannot collide with the terminal's
  // Ctrl+C, so it gets the standard edit menu.
  Menu.setApplicationMenu(
    process.platform === 'darwin'
      ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }])
      : null
  )
  const cfg = getConfig()
  const mode = startMode()
  // maximize() shows the window as a side effect, and on Windows that show *activates* it:
  // it ends up as a ShowWindow(SW_MAXIMIZE), the exact focus steal showInactive exists to
  // avoid. So a launch that must not take the keyboard (the test copy an agent starts, an
  // update coming back) stands in for a maximized window by filling the display's work
  // area, and becomes a real maximized one the first time it is clicked.
  //
  // The size goes in the constructor, not a setBounds() after: sizing a window that has
  // never been shown makes Windows show and activate it, which measured as a focus steal
  // even with no maximize() left in the path.
  pseudoMax = cfg.window.maximized && mode !== 'normal'
  const area = pseudoMax ? workAreaFor(cfg) : null
  win = new BrowserWindow({
    width: area?.width ?? cfg.window.width,
    height: area?.height ?? cfg.window.height,
    x: area?.x ?? cfg.window.x,
    y: area?.y ?? cfg.window.y,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#101014',
    // The suffix is the only thing separating two identical windows on the taskbar
    // when a test build is running next to the live one.
    title: `PaneForge${titleSuffix()}`,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      // Chromium slows a hidden window's timers to about once a minute. Here that is the
      // timer that keeps saying "this agent is still running", and minimised is exactly
      // when the app is deciding whether to interrupt you - so the one state where the
      // status has to be right is the one Chromium was degrading. A terminal keeps
      // rendering pty output while minimised regardless, so there is little to save.
      backgroundThrottling: false
    }
  })

  // The page title wins over the BrowserWindow one the moment the renderer loads, so
  // a profile has to re-apply its suffix each time the document title changes.
  if (profile) {
    win.on('page-title-updated', (e, title) => {
      e.preventDefault()
      win?.setTitle(title.includes(titleSuffix()) ? title : `${title}${titleSuffix()}`)
    })
  }

  if (cfg.window.maximized && !pseudoMax) win.maximize()
  // Clicking it is permission to behave like a normal maximized window.
  if (pseudoMax)
    win.once('focus', () => {
      pseudoMax = false
      if (!win?.isMaximized()) win?.maximize()
    })
  win.on('ready-to-show', () => {
    if (mode === 'normal') return win?.show()
    // showInactive draws the window without pulling focus off the app you are typing
    // in. minimize() after it, rather than instead of it, because minimizing a window
    // that has never been shown leaves it in a state Windows will not restore from
    // the taskbar.
    win?.showInactive()
    if (mode === 'minimized') win?.minimize()
    // Back from an update: the window is there, on the taskbar, with the panes restored,
    // but it did not take the keyboard. Flash the taskbar button once so it is obvious
    // the app came back instead of silently dying.
    else if (isQuietRelaunch()) win?.flashFrame(true)
  })
  // Coming back to the window is when the image you copied in another app matters, and
  // reading the clipboard on focus is what keeps the shelf's polling cheap the rest of
  // the time. See recents.ts.
  win.on('focus', () => {
    win?.flashFrame(false)
    refreshRecents()
  })
  // The clipboard overlay lives in the corner of the display this window is on, so it
  // moves with it - to the second monitor, or back.
  win.on('move', placeShelf)
  win.on('restore', placeShelf)
  // A test copy nobody ever looked at closes itself.
  //
  // An agent starts one minimized, measures something, and does not always get to run
  // `--close` - a session ends, a command fails, the turn moves on. What is left is a
  // second PaneForge sitting in alt-tab for the rest of the day, showing whatever state
  // the test left it in (including, once, a deliberate crash-drill message that read
  // exactly like the real app had broken). Only ever applies to a named profile that
  // was launched out of sight, and any sign of a human - showing it, focusing it,
  // restoring it - cancels it for good.
  if (profile && mode === 'minimized') {
    const idleQuit = setTimeout(() => {
      console.log('Test copy was never opened - closing itself so it does not linger.')
      app.quit()
    }, 30 * 60_000)
    // Not the `show` event: the launch itself calls showInactive() before minimizing,
    // so that fires for every test copy and would cancel this immediately.
    const keepAlive = (): void => clearTimeout(idleQuit)
    win.once('focus', keepAlive)
    win.once('restore', keepAlive)
  }
  win.on('close', rememberBounds)
  // Without this the module keeps a destroyed BrowserWindow, and every later
  // `win?.` call throws "Object has been destroyed" instead of no-opping.
  win.on('closed', () => {
    win = null
    // The overlay is a window too, so leaving it open would make `window-all-closed`
    // never fire and the app would stay alive with nothing on screen but a pill.
    closeShelfWindow()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  // The menu is gone, so devtools needs its own key.
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win?.webContents.toggleDevTools()
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// The window can be gone (quit) or destroyed-but-still-referenced (teardown order)
// while pty output and session events are still in flight.
function alive(): boolean {
  return !!win && !win.isDestroyed() && !win.webContents.isDestroyed()
}

function send(channel: string, ...args: unknown[]): void {
  if (!alive()) return
  win!.webContents.send(channel, ...args)
}

function rememberBounds(): void {
  if (!alive()) return
  const w = win!
  // A window still standing in for a maximized one (shown without focus, never clicked)
  // must save itself as maximized, or the next launch opens at work-area size instead.
  const maximized = w.isMaximized() || pseudoMax
  // getBounds() on a maximized window returns the screen size, which would make the
  // restored window unrestorable, so keep the normal bounds instead.
  const b = maximized ? w.getNormalBounds() : w.getBounds()
  setConfig({ window: { x: b.x, y: b.y, width: b.width, height: b.height, maximized } })
}

function focusWindow(): void {
  if (!alive()) return createWindow()
  const w = win!
  if (w.isMinimized()) w.restore()
  w.focus()
}

// Fan pty output and session-list changes out to the renderer. A dead window drops
// them: send() checks first, because webContents.send() on a destroyed window throws.
manager.on('data', (id: string, data: string) => {
  send('pty:data', id, data)
})
manager.on('sessions', () => {
  send('sessions:changed', allSessions())
  // Every pane start, exit, rename and agent switch arrives here, which is the
  // whole of "the desk changed". Debounced inside: a swarm launch is six of these
  // in a second and they are worth one write.
  noteDesk()
})
manager.on('attention', (s: Session) => raiseAttention(s))

function raiseAttention(s: Session): void {
  // The chime is the renderer's job (Web Audio gives a far nicer sound than the
  // Windows toast ding) and it plays whether or not the app has focus: the point
  // is to tell you a turn ended while you were reading something else on screen.
  send('sessions:attention', s)
  if (!getConfig().notifyOnIdle) return
  // The toast and the taskbar flash only make sense when you are elsewhere.
  if (!alive() || win!.isFocused()) return
  win!.flashFrame(true)
  if (Notification.isSupported()) {
    new Notification({
      // A pane finishing on the other machine is the whole point of the feature, so
      // it gets told the same way - with the device named, because "which machine"
      // is the one thing you cannot tell from the pane title.
      title: s.remote ? `${s.title} is waiting on ${s.remote.name}` : `${s.title} is waiting`,
      body: `${s.agent} finished or needs input.`,
      // Our own chime already played; the system ding on top of it is noise.
      silent: true
    })
      .on('click', focusWindow)
      .show()
  }
}

// ---------------------------------------------------------------------------
// Other devices
//
// A paired device's panes are mirrored into this window and behave like local ones.
// The seam is the session id: anything namespaced `@device/id` is forwarded over the
// link instead of being handed to the pty manager, so every path above this line -
// the sidebar, the palette, the shortcuts, the grid - stays unaware there are two
// machines involved.

const remote = new Remote({
  list: () => manager.list(),
  buffer: (id) => manager.buffer(id),
  write: (id, data) => manager.write(id, data),
  resize: (id, cols, rows) => manager.resize(id, cols, rows),
  redraw: (id) => manager.redraw(id),
  setBusy: (id, busy, tail) => manager.setBusyOnScreen(id, busy, tail),
  clearAttention: (id) => manager.clearAttention(id),
  kill: (id) => manager.kill(id),
  restart: (id) => manager.restart(id),
  rename: (id, title) => manager.rename(id, title),
  switchAgent: (id, agent, model) => manager.switchAgent(id, agent, model),
  // A guest's launch goes through the same lane split a local one does: two agents
  // in one repo must not share a checkout just because one of them is remote.
  startSession: (req) => manager.start(laneFor(req)),
  projects: () => Promise.resolve(listProjects()),
  agents: () => Promise.resolve(listAgents()),
  onData: (cb) => {
    manager.on('data', cb)
    return () => manager.off('data', cb)
  },
  onSessions: (cb) => {
    manager.on('sessions', cb)
    return () => manager.off('sessions', cb)
  },
  onAttention: (cb) => {
    manager.on('attention', cb)
    return () => manager.off('attention', cb)
  }
})

/** Local panes and mirrored ones, as one list. This is what the renderer ever sees. */
function allSessions(): Session[] {
  return [...manager.list(), ...remote.sessions()]
}

remote.on('data', (id: string, data: string) => send('pty:data', id, data))
// The link came back and the whole scrollback arrived again: the pane has to start
// from scratch rather than append a second copy of what it was already showing.
remote.on('reset', (id: string) => send('pane:reset', id))
remote.on('sessions', () => send('sessions:changed', allSessions()))
remote.on('attention', (s: Session) => raiseAttention(s))
remote.on('changed', (state: RemoteState) => send('remote:changed', state))

ipcMain.handle('projects:list', () => listProjects())
ipcMain.handle('agents:list', (_e, force?: boolean) => listAgents(force))
ipcMain.handle('sessions:list', () => allSessions())
/**
 * Move a second session in the same folder into its own git worktree, so two
 * agents in one project cannot overwrite each other's edits or race the index.
 * Folders already held by live sessions are what "in use" means, so a lane freed
 * by a closed session gets reused instead of a new one piling up.
 *
 * A swarm is deliberately exempt: its roles are briefed to share one checkout.
 */
function laneFor(req: StartSessionRequest, extraTaken: string[] = []): StartSessionRequest {
  if (!getConfig().autoLane) return req
  const taken = [
    ...manager
      .list()
      .filter((s) => s.status !== 'exited')
      .map((s) => s.cwd),
    ...extraTaken
  ]
  const lane = resolveLane(req.cwd, taken)
  if (lane.cwd === req.cwd) {
    // Reopening a pane that is already in its lane (workspace restore, or after an
    // update): nothing to move, but it still needs its port and its shared memory.
    if (req.lane) return { ...req, laneEnv: req.laneEnv ?? laneExtras(req.cwd, req.lane).env }
    return lane.note ? { ...req, laneNote: lane.note } : req
  }
  const memory = lane.sharedMemory ? ', sharing this project’s Claude memory' : ''
  return {
    ...req,
    cwd: lane.cwd,
    lane: lane.lane,
    laneEnv: lane.env,
    laneNote: `Opened lane ${lane.lane} on ${lane.branch} - PORT=${lane.port}${memory}`
  }
}

ipcMain.handle('sessions:start', (_e, req: StartSessionRequest) => manager.start(laneFor(req)))
ipcMain.handle('sessions:startMany', (_e, reqs: StartSessionRequest[]) => {
  const out: Session[] = []
  // Folders claimed earlier in this same batch count as taken: two panes launched
  // together for one project must land in different lanes, and the session list
  // has not caught up mid-loop.
  const claimed: string[] = []
  for (const r of reqs) {
    try {
      const req = laneFor(r, claimed)
      claimed.push(req.cwd)
      out.push(manager.start(req))
    } catch {
      // One missing folder should not abort the rest of a workspace launch.
    }
  }
  return out
})
ipcMain.handle('sessions:restart', (_e, id: string) => {
  if (remote.owns(id)) return remote.send(id, { t: 'restart' }), null
  return manager.restart(id)
})
ipcMain.handle('sessions:switchAgent', (_e, id: string, agent: string, model?: string) => {
  if (remote.owns(id)) return remote.send(id, { t: 'switch', agent, model }), null
  return manager.switchAgent(id, agent, model)
})
ipcMain.handle('sessions:rename', (_e, id: string, title: string) =>
  remote.owns(id) ? remote.send(id, { t: 'rename', title }) : manager.rename(id, title)
)
ipcMain.handle('sessions:kill', (_e, id: string) =>
  remote.owns(id) ? remote.send(id, { t: 'kill' }) : manager.kill(id)
)
ipcMain.handle('sessions:buffer', (_e, id: string) =>
  remote.owns(id) ? remote.buffer(id) : manager.buffer(id)
)
ipcMain.on('sessions:attention-clear', (_e, id: string) =>
  remote.owns(id) ? remote.send(id, { t: 'ack' }) : manager.clearAttention(id)
)
ipcMain.on('pty:write', (_e, id: string, data: string) =>
  remote.owns(id) ? remote.send(id, { t: 'write', data }) : manager.write(id, data)
)
ipcMain.on('pty:broadcast', (_e, text: string) => {
  manager.broadcast(text)
  // "Send this to everything" means everything on the desk, and half the desk can be
  // on the other machine. A pane that has already exited is skipped there as here.
  for (const s of remote.sessions()) {
    if (s.status !== 'exited') remote.send(s.id, { t: 'write', data: text + '\r' })
  }
})
/**
 * A mirrored pane is never resized from here.
 *
 * Two windows on two machines cannot both own one pty's size: whichever resized last
 * would win, the other would refit, and the two would trade SIGWINCHes at each other
 * for as long as both were open - with a full-screen CLI redrawing its entire frame
 * every round. The device the agent runs on owns the size; the mirror is drawn at the
 * host's own cols/rows and scaled to fit whatever window is watching it.
 */
ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) => {
  if (!remote.owns(id)) manager.resize(id, cols, rows)
})
ipcMain.on('pty:redraw', (_e, id: string) =>
  remote.owns(id) ? remote.send(id, { t: 'redraw' }) : manager.redraw(id)
)
/**
 * Same reasoning: "is the agent still running" is read off the rendered frame, and the
 * device the agent runs on is already reading it in its own window. A second opinion
 * arriving from a mirror that is a few frames behind could only ever contradict the
 * first one, and a false "finished" is the chime going off mid-turn.
 */
ipcMain.on('sessions:busy', (_e, id: string, busy: boolean, tail?: string) => {
  if (!remote.owns(id)) manager.setBusyOnScreen(id, busy, tail)
})

ipcMain.handle('sessions:swarm', (_e, req: SwarmRequest) => manager.startSwarm(req))

ipcMain.handle('config:get', () => getConfig())
ipcMain.handle('config:set', (_e, patch: Partial<Config>) => {
  const next = setConfig(patch)
  // An edited custom agent changes what is launchable, so the availability cache
  // must not outlive the edit.
  if (patch.customAgents) invalidateAgents()
  if (patch.saveHistory !== undefined) history.setHistoryEnabled(patch.saveHistory)
  if (patch.autoUpdate !== undefined) setAutoCheck(patch.autoUpdate)
  if (patch.voice !== undefined) applyVoiceHotkey(next)
  if (patch.clipboardShelf !== undefined) applyClipboardShelf(next)
  else if (patch.clipboardOverlay !== undefined) applyShelfOverlay(next)
  // The Stash caps apply to what is already on it, not only to the next thing added, so
  // they go through even when the watcher itself was not touched.
  if (
    patch.stashMaxItems !== undefined ||
    patch.stashMaxImages !== undefined ||
    patch.stashFileHours !== undefined ||
    patch.stashMaxFileMb !== undefined
  ) {
    applyStashCaps(next)
  }
  send('config:changed', next)
  // The overlay draws the same settings behind its gear, so it hears about them too.
  updateShelfConfig(stashConfig(next))
  return next
})
ipcMain.handle('config:pickRoot', async () => {
  const r = await dialog.showOpenDialog({
    title: 'Choose the folder that holds your projects',
    defaultPath: getConfig().root,
    properties: ['openDirectory']
  })
  return r.canceled ? null : r.filePaths[0]
})

ipcMain.on('shell:reveal', (_e, path: string) => {
  shell.openPath(path)
})
ipcMain.handle('shell:editor', (_e, path: string) => {
  // VS Code / Cursor ship a `code`-style launcher on PATH; without one, fall back to
  // Explorer so the button still does something useful.
  for (const bin of ['cursor', 'code']) {
    const exe = which(bin)
    if (exe === bin) continue
    try {
      spawn(exe, [path], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
      return null
    } catch {
      /* try the next one */
    }
  }
  shell.openPath(path)
  return 'No `cursor` or `code` on PATH - opened the folder instead.'
})

ipcMain.handle('git:info', (_e, path: string) => gitInfo(path))
ipcMain.handle('lanes:board', () => laneBoard())

// Other devices. Every one of these answers with the whole state, so the dialog never
// has to guess what a change did - it just redraws what it is handed.
ipcMain.handle('remote:state', () => remote.state())
ipcMain.handle('remote:host', (_e, on: boolean) => {
  remote.setHosting(!!on)
  return remote.state()
})
ipcMain.handle('remote:port', (_e, port: number) => {
  remote.setPort(Number(port))
  return remote.state()
})
ipcMain.handle('remote:rotate', () => {
  remote.rotateCode()
  return remote.state()
})
ipcMain.handle('remote:rename', (_e, name: string) => {
  remote.rename(String(name ?? ''))
  return remote.state()
})
ipcMain.handle(
  'remote:pair',
  async (_e, input: { address: string; port: number; code: string; name?: string }) => {
    const error = await remote.pair(input)
    return { ok: !error, error: error || undefined, state: remote.state() }
  }
)
ipcMain.handle('remote:forget', (_e, id: string) => {
  remote.forget(String(id))
  return remote.state()
})
ipcMain.handle('remote:connect', (_e, id: string, on: boolean) => {
  remote.setConnected(String(id), !!on)
  return remote.state()
})
ipcMain.handle('remote:scan', () => {
  remote.scan()
  return remote.state()
})
// The renderer runs from file:// in production, which is not a secure context, so
// navigator.clipboard is unavailable there. Terminal copy/paste goes through here.
ipcMain.on('clipboard:write', (_e, text: string) => {
  if (typeof text === 'string' && text.length) clipboard.writeText(text)
})
ipcMain.handle('clipboard:read', () => clipboard.readText())

// The clipboard shelf: the last things copied, one click from the focused pane.
ipcMain.handle('recents:list', () => listRecents())
ipcMain.on('recents:copy', (_e, id: string) => copyRecent(id))
ipcMain.on('recents:clear', () => clearRecents())
ipcMain.on('recents:remove', (_e, id: string) => removeRecent(id))
ipcMain.on('recents:pin', (_e, id: string, on: boolean) => pinRecent(id, !!on))
// The overlay floats over other apps and has no idea which pane is focused, so "send it
// to the pane" is asked of the window that does know.
ipcMain.on('recents:toPane', (_e, id: string) => {
  if (!getRecent(id)) return
  focusWindow()
  send('recents:toPane', id)
})
ipcMain.on('shelf:focusApp', () => focusWindow())
ipcMain.on('shelf:setExpanded', (_e, open: boolean) => setShelfExpanded(!!open))
ipcMain.on('shelf:setTall', (_e, tall: boolean) => setShelfTall(!!tall))
// Dragged by its own header. The overlay cannot move its window itself, and a pointer
// that leaves the window mid-drag stops sending it events, so it sends the screen point
// and main does the arithmetic against where the drag started.
ipcMain.on('shelf:dragStart', () => beginShelfDrag())
ipcMain.on('shelf:dragMove', (_e, x: number, y: number) => moveShelfDrag(x, y))
ipcMain.on('shelf:dragEnd', () => endShelfDrag())

/** Just the Stash's own knobs, which is all of the config the overlay ever sees. */
function stashConfig(cfg: Config): StashConfig {
  return {
    stashPeekMs: cfg.stashPeekMs,
    stashMaxItems: cfg.stashMaxItems,
    stashMaxImages: cfg.stashMaxImages,
    stashFileHours: cfg.stashFileHours,
    stashMaxFileMb: cfg.stashMaxFileMb,
    clipboardOverlay: cfg.clipboardOverlay
  }
}

ipcMain.handle('shelf:config', () => stashConfig(getConfig()))
/**
 * The overlay's own settings panel. This window floats over every other app, so its
 * bridge writes through an allowlist rather than the whole config: a key that is not one
 * of the Stash's own is dropped here, not merged.
 */
ipcMain.handle('shelf:setConfig', (_e, patch: Partial<StashConfig>) => {
  const clean: Record<string, unknown> = {}
  const raw = (patch ?? {}) as Record<string, unknown>
  for (const k of STASH_CONFIG_KEYS) {
    const v = raw[k]
    if (k === 'clipboardOverlay') {
      if (typeof v === 'boolean') clean[k] = v
    } else if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
      clean[k] = v
    }
  }
  const next = setConfig(clean as Partial<Config>)
  applyStashCaps(next)
  if (clean.clipboardOverlay !== undefined) applyShelfOverlay(next)
  // Settings is a different window looking at the same numbers; it must not go stale.
  send('config:changed', next)
  const out = stashConfig(next)
  updateShelfConfig(out)
  return out
})
// Files dropped on the Stash, or chosen in its picker. The renderer only ever sees paths
// (webUtils in the preloads); the copying is main's, because it owns the folder.
ipcMain.handle('stash:add', (_e, paths: string[]) =>
  Array.isArray(paths) ? addRecentFiles(paths) : 0
)
ipcMain.handle('stash:pick', async () => {
  // A picker is a foreground dialog, which the app is not allowed to raise on its own -
  // this one only ever runs from a click, so it is the user asking for it.
  const r = await dialog.showOpenDialog({
    title: 'Add to the Stash',
    properties: ['openFile', 'multiSelections'],
    buttonLabel: 'Add'
  })
  return r.canceled ? 0 : addRecentFiles(r.filePaths)
})
ipcMain.on('stash:reveal', () => shell.openPath(recentsDir()))
// Ctrl+Shift+V from inside the app. There is one Stash, so this opens the floating one
// rather than a second list in the window.
ipcMain.on('shelf:toggle', () => toggleShelf())
// Dragging a shelf item into another app entirely. The renderer cannot start an OS drag
// with a real file in it - only the main process can, and only with a path it owns.
ipcMain.on('recents:drag', async (e, id: string) => {
  const file = recentPath(id)
  if (!file) return
  // A video or a zip has no bitmap to shrink, and startDrag with an empty icon throws,
  // which would leave the row looking broken rather than undraggable. Ask the OS for the
  // file's own shell icon and fall back to the app's.
  let icon = nativeImage.createFromPath(file)
  if (icon.isEmpty()) {
    try {
      icon = await app.getFileIcon(file, { size: 'normal' })
    } catch {
      /* handled by the emptiness check below */
    }
  }
  try {
    e.sender.startDrag({ file, icon: icon.isEmpty() ? appIcon() : icon.resize({ width: 96 }) })
  } catch {
    /* the file was cleared between the click and the drag */
  }
})

/**
 * A last-resort drag icon. Windows refuses a drag with no image at all, so a 1x1 is still
 * better than the drag never starting.
 */
function appIcon(): Electron.NativeImage {
  return nativeImage.createFromBuffer(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64'
    )
  )
}

/** How much the Stash keeps, and for how long. Settings owns these. */
function applyStashCaps(cfg: Config): void {
  configureRecents({
    maxItems: Math.max(1, cfg.stashMaxItems),
    maxImages: Math.max(0, cfg.stashMaxImages),
    fileHours: Math.max(0, cfg.stashFileHours),
    maxFileMb: Math.max(0, cfg.stashMaxFileMb)
  })
}

/** Watch the clipboard, or stop watching, to match the setting. */
function applyClipboardShelf(cfg: Config): void {
  applyStashCaps(cfg)
  if (cfg.clipboardShelf) {
    startRecents((items) => {
      send('recents:changed', items)
      updateShelfItems(items)
    })
  } else {
    stopRecents()
  }
  applyShelfOverlay(cfg)
}

/**
 * The floating overlay follows the shelf setting: watching the clipboard is what fills
 * it, so an overlay with the watcher off would be a permanently empty window on top of
 * everything.
 */
function applyShelfOverlay(cfg: Config): void {
  const wanted = cfg.clipboardShelf && cfg.clipboardOverlay
  if (wanted && !shelfWindowOpen()) {
    openShelfWindow(() => win)
    updateShelfItems(listRecents())
  } else if (!wanted && shelfWindowOpen()) {
    closeShelfWindow()
  }
  applyShelfHotkey(cfg)
}

/**
 * Ctrl+Alt+V opens the overlay from inside any application. Not Ctrl+Shift+V, which is
 * paste in every terminal on the machine (including PaneForge's own panes) and would be
 * taken away from all of them by a global registration - that combo stays as the
 * in-window shelf's key, where it only applies while the app has focus.
 */
function applyShelfHotkey(cfg: Config): void {
  const accel = 'CommandOrControl+Alt+V'
  globalShortcut.unregister(accel)
  // Registered whenever the clipboard is being watched at all, not only while the overlay
  // is showing: the overlay has a "hide" button on it, and a hidden window with no taskbar
  // entry and no tray icon would otherwise have no way back.
  if (!cfg.clipboardShelf) return
  try {
    globalShortcut.register(accel, () => {
      if (shelfWindowOpen()) return toggleShelf()
      // Hidden: bring it back, on the list rather than as a pill, since asking for it is
      // asking to look at it.
      const next = setConfig({ clipboardOverlay: true })
      applyShelfOverlay(next)
      send('config:changed', next)
      setShelfExpanded(true)
    })
  } catch {
    /* another app owns the combo - the pill in the corner still opens on hover */
  }
}

ipcMain.on('shell:external', (_e, url: string) => {
  // Only ever open real web links: a file:// or custom scheme from the renderer
  // would be a way to launch arbitrary local programs.
  if (/^https?:\/\//i.test(url)) shell.openExternal(url)
})

// --- elevation -------------------------------------------------------------

ipcMain.handle('admin:status', () => adminStatus())
ipcMain.handle('admin:enable', () => {
  const r = enableAdminMode()
  if (r.ok) setConfig({ adminMode: true })
  return r
})
ipcMain.handle('admin:disable', () => {
  const r = disableAdminMode()
  setConfig({ adminMode: false })
  return r
})
ipcMain.handle('app:profile', () => profileName())
ipcMain.on('app:relaunchAsAdmin', () => {
  // With admin mode set up, the scheduled task starts an elevated instance with no
  // prompt. Without it, fall back to the one-off UAC dialog.
  if (!relaunchViaTask()) {
    const args = process.argv.slice(1).filter((a) => !a.startsWith('--remote-debugging'))
    const list = args.length
      ? ` -ArgumentList ${args.map((a) => `'${a.replace(/'/g, "''")}'`).join(',')}`
      : ''
    try {
      spawn(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Start-Process -Verb RunAs -FilePath '${process.execPath.replace(/'/g, "''")}'${list}`
        ],
        { detached: true, stdio: 'ignore', windowsHide: true }
      ).unref()
    } catch {
      return // user declined UAC - stay as we are
    }
  }
  // Same reasoning as the update restart: the elevated copy is already starting, so
  // getting this one out of the way quickly is the whole user-visible difference.
  rememberBounds()
  manager.shutdown()
  hardExit()
})

// --- one-click agent installs ---------------------------------------------

/** One install at a time per agent, so a double-click cannot run npm twice. */
const installing = new Set<string>()

ipcMain.handle('agents:install', async (_e, id: string) => {
  if (installing.has(id)) return
  const spec = specFor(id)
  const command = installCommand(spec)
  if (!command) {
    send('agents:install-event', {
      agentId: id,
      chunk: `${spec.label} has no scripted installer. Open its docs and install it, then hit Rescan.\r\n`,
      done: true,
      ok: false
    })
    return
  }
  installing.add(id)
  send('agents:install-event', { agentId: id, chunk: `> ${command}\r\n\r\n` })
  await new Promise<void>((resolve) => {
    runCommand(
      command,
      (chunk) => send('agents:install-event', { agentId: id, chunk }),
      (code) => {
        installing.delete(id)
        // A brand new install folder is only on the PATH of new processes, so pull
        // the current PATH out of the registry before deciding it failed.
        refreshPath()
        invalidateAgents()
        const found = which(spec.bin) !== spec.bin
        send('agents:install-event', {
          agentId: id,
          chunk: found
            ? `\r\n${spec.label} is ready.\r\n`
            : `\r\nInstaller exited with code ${code} and ${spec.bin} is still not on PATH.\r\n`,
          done: true,
          ok: found
        })
        resolve()
      }
    )
  })
})

ipcMain.handle('agents:locate', async (_e, id: string) => {
  const spec = specFor(id)
  const r = await dialog.showOpenDialog({
    title: `Where is ${spec.label}?`,
    properties: ['openFile'],
    filters:
      process.platform === 'win32'
        ? [{ name: 'Programs', extensions: ['exe', 'cmd', 'bat', 'ps1'] }]
        : [{ name: 'All files', extensions: ['*'] }]
  })
  if (r.canceled || !r.filePaths[0]) return null
  const bin = r.filePaths[0]
  // Stored as a custom override of the same id, so the agent keeps its colour,
  // model list and resume flags and only the binary changes.
  const cfg = getConfig()
  const next = [...cfg.customAgents.filter((c) => c.id !== id), { ...spec, bin, custom: true }]
  setConfig({ customAgents: next })
  invalidateAgents()
  send('config:changed', getConfig())
  return bin
})

// --- updates ---------------------------------------------------------------

ipcMain.handle('update:state', () => getUpdateState())
ipcMain.handle('update:check', () => checkForUpdates())
/** One restart is one restart: a second click must not run the teardown twice. */
let installStarted = false

ipcMain.on('update:install', () => {
  if (installStarted) return
  installStarted = true

  // Get off the screen FIRST. Everything below is unavoidable work - snapshotting the
  // workspace, flushing transcripts, killing N ptys - and on Windows it adds up to a
  // moment during which the window sits there ignoring the mouse. That reads as
  // "Restart now hung, then crashed". Hiding is instant, so the app vanishes on the
  // click and does the teardown with nothing left to look at.
  if (alive()) {
    try {
      // Saved here rather than on the window's own close event: this path never gets
      // one, because the process is exited outright below.
      rememberBounds()
      win!.setSkipTaskbar(true)
      win!.hide()
    } catch {
      /* window already going away */
    }
  }
  // Remembered before the panes die, replayed on the next launch: an update should
  // feel like the app blinked, not like it wiped the desk. Unless the user turned
  // that off - the app updates itself several times a day, so an always-on restore
  // makes a set of panes impossible to be rid of by restarting. `update` is the one
  // reason that reopens without asking; every other restart asks.
  saveDeskOnExit(getConfig().restoreAfterUpdate ? manager.snapshot() : [], 'update')
  // Flushes transcripts, ends their metadata in one pass and hard-kills every agent
  // tree in a single taskkill instead of one blocking ConPTY teardown per pane.
  manager.shutdown()
  // Set before the installer starts, because once quitAndInstall() runs this process can
  // be gone before the next line. The new exe reads it and comes back without activating.
  markQuietRelaunch()
  if (!installUpdate()) {
    // Nothing was installable after all (state moved on, feed unsupported). Put the
    // window back rather than leaving an invisible app with no panes - inactive, since
    // by now the user has looked away and a failed update is no reason to interrupt.
    installStarted = false
    markQuietRelaunch(false)
    if (alive()) {
      win!.setSkipTaskbar(false)
      win!.showInactive()
      win!.flashFrame(true)
    }
    return
  }
  // The installer is already running and its first job is to wait for this exe to let go
  // of its own files, so every millisecond spent on a graceful teardown is a millisecond
  // the user spends looking at no app at all. Nothing is left to save.
  hardExit()
})

// --- task board + shared memory -------------------------------------------

ipcMain.handle('board:get', (_e, path: string) => readBoard(path))
ipcMain.handle('board:tasks', (_e, path: string, tasks: TaskItem[]) => writeTasks(path, tasks))
ipcMain.handle('board:memory', (_e, path: string, memory: string) => writeMemory(path, memory))

// --- history ---------------------------------------------------------------

ipcMain.handle('history:list', () => history.list())
ipcMain.handle('history:search', (_e, q: string) => history.search(q))
ipcMain.handle('history:read', (_e, id: string) => history.read(id))
ipcMain.handle('history:delete', (_e, id: string) => history.remove(id))

// --- voice -----------------------------------------------------------------

ipcMain.handle('voice:status', () => voice.voiceStatus())
ipcMain.handle('voice:transcribe', (_e, wav: ArrayBuffer) => {
  const cfg = getConfig().voice
  return voice.transcribe(Buffer.from(wav), { model: cfg.model, language: cfg.language })
})
ipcMain.handle('voice:install', async () => {
  const command = voice.installCommand()
  send('agents:install-event', { agentId: '__voice__', chunk: `> ${command}\r\n\r\n` })
  await new Promise<void>((resolve) => {
    runCommand(
      command,
      (chunk) => send('agents:install-event', { agentId: '__voice__', chunk }),
      () => {
        refreshPath()
        const ok = voice.voiceStatus().available
        send('agents:install-event', {
          agentId: '__voice__',
          chunk: ok ? '\r\nVoice is ready.\r\n' : '\r\nStill no whisper binary on PATH.\r\n',
          done: true,
          ok
        })
        resolve()
      }
    )
  })
})

/** Push-to-talk works even when another window has focus, so it needs a global key. */
function applyVoiceHotkey(cfg: Config): void {
  const accel = 'CommandOrControl+Shift+Space'
  globalShortcut.unregister(accel)
  if (!cfg.voice.enabled) return
  try {
    globalShortcut.register(accel, () => {
      focusWindow()
      send('voice:hotkey')
    })
  } catch {
    /* another app owns the combo - the in-app mic button still works */
  }
}

/** `PaneForge --open <path>` starts a session in that folder on launch. */
function openFromArgs(argv: string[]): void {
  const i = argv.indexOf('--open')
  const dir = i >= 0 ? argv[i + 1] : undefined
  if (dir) {
    try {
      manager.start({ cwd: dir })
    } catch {
      /* bad path on the command line - ignore rather than crash the launch */
    }
  }
}

/**
 * Bring panes back. Each one resumes the agent's own last conversation
 * (`claude --continue`), so a restart costs a redraw rather than the thread you were
 * in. Nothing is typed into them: a pane that comes back mid-turn must sit there
 * with the cursor in its prompt box, not re-send work the agent already did.
 *
 * The desk is dropped before the first pane starts, never after. A crash while
 * restoring would otherwise leave the app reopening the same panes on every launch,
 * for ever, with no way in the UI to say no.
 */
let restoredThisRun = false

function restorePanes(specs: StartSessionRequest[]): void {
  // One restore per launch. A second answer from a dialog that somehow sent twice
  // would otherwise open every pane again beside the first set.
  if (restoredThisRun) return
  clearDesk()
  restoredThisRun = true
  for (const req of specs.slice(0, MAX_RESTORE)) {
    try {
      manager.start({ ...req, resume: true, prompt: undefined })
    } catch {
      // Folder moved or the agent is no longer installed - skip that pane only.
    }
  }
}

/**
 * The panes waiting to be offered back, pulled by the renderer once it is up. Held
 * in memory rather than pushed at launch, because the decision below happens while
 * the window is still loading its own JavaScript.
 */
let offer: RestoreOffer | null = null

/** A saved pane described for the dialog, with the reasons it cannot come back. */
function describe(spec: StartSessionRequest, i: number): RestorePane {
  const agent = spec.agent ?? 'claude'
  const installed = listAgents().find((a) => a.id === agent)?.available ?? false
  return {
    id: String(i),
    cwd: spec.cwd,
    title: spec.title || basename(spec.cwd),
    agent,
    model: spec.model,
    gone: paneMissing(spec) ? 'folder' : installed ? undefined : 'agent'
  }
}

/**
 * What a launch does with the last run's panes.
 *
 * An update restart reopens silently: the app decided on that restart, so being
 * handed the same desk back is the whole point. Every other restart asks, because a
 * cold boot is often a deliberate fresh start and a desk that reappears whatever you
 * do is a set of panes you cannot get rid of.
 */
function offerRestore(): void {
  const cfg = getConfig()
  // One launch only: the first run after updating from a version that wrote the
  // snapshot into config.json, which is exactly the launch that would lose it.
  const legacy = cfg.restoreSessions ?? []
  if (legacy.length) setConfig({ restoreSessions: [] })
  const desk = readDesk() ?? (legacy.length ? { specs: legacy, at: Date.now(), clean: true, reason: 'update' as const } : null)
  if (!desk?.specs.length) return
  // Panes from last week are not the desk anyone remembers leaving.
  if (desk.at && Date.now() - desk.at > MAX_DESK_AGE_MS) {
    clearDesk()
    return
  }
  if (desk.reason === 'update') {
    if (cfg.restoreAfterUpdate) restorePanes(desk.specs)
    else clearDesk()
    return
  }
  if (cfg.restoreAfterRestart === 'never') {
    clearDesk()
    return
  }
  if (cfg.restoreAfterRestart === 'always') {
    restorePanes(desk.specs)
    return
  }
  const all = desk.specs.map(describe)
  offer = {
    panes: all.slice(0, MAX_RESTORE),
    extra: all.slice(MAX_RESTORE),
    at: desk.at,
    clean: desk.clean
  }
  // Until the question is answered the desk stands, even though the app currently
  // has no panes: an unanswered offer must survive a second restart, and a mis-click
  // that closes the dialog must not delete the panes it was offering.
  setDeskHold(true)
}

ipcMain.handle('restore:pending', () => offer)

ipcMain.on('restore:answer', (_e, answer: RestoreAnswer) => {
  const pending = offer
  offer = null
  setDeskHold(false)
  if (answer?.always) setConfig({ restoreAfterRestart: 'always' })
  if (!pending) return
  if (!answer?.accept) {
    // Turned down on purpose - the desk goes. Dismissing the dialog instead sends
    // nothing at all, so those panes are offered again next launch.
    clearDesk()
    saveDesk(manager.snapshot(), 'live')
    return
  }
  const wanted = new Set(answer.ids ?? [])
  const specs = pending.panes
    .filter((p) => wanted.has(p.id) && !p.gone)
    .map((p) => ({ cwd: p.cwd, title: p.title, agent: p.agent, model: p.model }))
  // `--open` and a restore are both allowed to have happened: whatever is already on
  // screen stays, the restored panes join it.
  restorePanes(specs)
})

/**
 * `stash://<id>` serves one Stash file to the two windows that draw it, and nothing else
 * on the machine. It exists so a dropped video can show its own first frame in the tile
 * instead of a generic film icon: a `<video>` needs a URL, and both windows load over
 * `file://` in a packaged build, where a second `file://` is blocked.
 *
 * The only thing it will hand over is a path already on the Stash list, looked up by id -
 * never a path from the URL. A renderer that asked for `stash://../../id_rsa` gets a 404,
 * because the id does not resolve.
 */
protocol.registerSchemesAsPrivileged([
  // `stream` is what lets the video element seek; without it Chromium has to download the
  // whole clip before it will draw a frame.
  { scheme: 'stash', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }
])

app.whenReady().then(() => {
  protocol.handle('stash', (req) => {
    const id = decodeURIComponent(new URL(req.url).hostname || new URL(req.url).pathname.slice(1))
    const file = id ? recentPath(id) : ''
    if (!file) return new Response('', { status: 404 })
    return net.fetch(pathToFileURL(file).toString(), { headers: req.headers, method: req.method })
  })
  const cfg = getConfig()
  history.setHistoryEnabled(cfg.saveHistory)
  history.prune(cfg.historyDays)
  createWindow()
  applyVoiceHotkey(cfg)
  applyClipboardShelf(cfg)
  crashTestHook()
  // After the window exists: a device that reconnects immediately would otherwise
  // push its session list at a renderer that is not listening yet.
  remote.start()
  initUpdater((s: UpdateState) => send('update:changed', s), cfg.autoUpdate)
  offerRestore()
  openFromArgs(process.argv)
  if (process.env['PANEFORGE_OPEN']) openFromArgs(['--open', process.env['PANEFORGE_OPEN'] as string])
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Agents are child processes of this app: leaving them running after the window
// closes would strand invisible `claude` processes holding file locks.
app.on('window-all-closed', () => {
  // Before shutdown(), which is what kills the panes this is a record of.
  saveDeskOnExit(manager.snapshot())
  // Guests get their sockets closed rather than left to time out, so the other
  // device says "went away" straight away instead of a minute later.
  remote.stop()
  manager.shutdown()
  hardExit()
})

/**
 * Leave, now, and mean it.
 *
 * This is what "PaneForge takes a while to close" actually was, and it was not the
 * teardown above being slow - that measures at 80-120ms with eight panes open. Every
 * ConPTY session runs a worker thread draining the console output socket, and node-pty
 * only disposes that worker when one more byte arrives after the kill. A pane that goes
 * quiet at the wrong moment leaves the thread alive, a live worker thread keeps the Node
 * environment from finishing, and the process then sat there with no window and nothing
 * to do. Measured over ten quits with five panes: usually ~300ms, but 2 in 10 took four
 * to five seconds. On the update path those seconds are worse than wasted, because the
 * NSIS installer is already running and waiting for this exe to release its own files
 * before it can replace them.
 *
 * Everything worth keeping - window bounds, the session snapshot, transcripts - is
 * written synchronously before this is called, and the agent process trees are killed
 * outright by shutdown(), so there is nothing left for a graceful exit to do. Same ten
 * quits after this change: 250ms to 1.1s, no stalls, no orphaned agents.
 */
function hardExit(): void {
  process.exit(0)
}

app.on('before-quit', () => {
  // Quitting by any other route than the last window closing - the tray, Cmd-Q, the
  // OS asking everyone to leave before a restart. Same record, same order: the desk
  // is written while the panes are still alive to be read.
  saveDeskOnExit(manager.snapshot())
  remote.stop()
  // shutdown() also flushes buffered transcript output, which would otherwise lose the
  // last 1.5 seconds of every pane. It runs once, so the two quit paths cannot double
  // the work between them.
  manager.shutdown()
})
app.on('will-quit', () => globalShortcut.unregisterAll())
