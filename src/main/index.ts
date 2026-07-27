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
import { laneWork, mergeLaneBack, repoOf, returnToBase, sweepLanes, trackTyped } from './laneWork'
import { laneBoard, laneRetry } from './laneBoard'
import { which } from './which'
import { adminStatus, disableAdminMode, enableAdminMode, relaunchViaTask } from './admin'
import {
  cancelDeferred,
  checkNow as checkGameNow,
  deferredCount,
  gameState,
  isGameActive,
  onGameState,
  refreshGameWatch,
  startGameWatch,
  whenClear
} from './gameMode'
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
  setShelfHidden,
  placeShelf,
  setShelfExpanded,
  setShelfTall,
  shelfWindowOpen,
  toggleShelf,
  updateShelfConfig,
  updateShelfItems
} from './shelfWindow'
import { refreshPath, runCommand } from './install'
import {
  checkForUpdates,
  getUpdateState,
  initUpdater,
  installUpdate,
  setAutoCheck,
  updateLog
} from './updater'
import * as history from './history'
import { readBoard, writeMemory, writeTasks } from './board'
import * as voice from './voice'
import { installCommand } from '../shared/agents'
import { STASH_CONFIG_KEYS } from '../shared/types'
import type {
  Config,
  GameModeStatus,
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
    if (!installStarted) focusWindow(true)
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
    // A person double-clicked the app. That is not an interruption and is never held
    // back, game or no game.
    if (mode === 'normal') {
      updateLog('window', 'shown (normal launch)')
      return win?.show()
    }
    const reveal = (): void => {
      if (!alive()) return
      updateLog('window', `shown (${mode})`)
      // showInactive draws the window without pulling focus off the app you are typing
      // in. minimize() after it, rather than instead of it, because minimizing a window
      // that has never been shown leaves it in a state Windows will not restore from
      // the taskbar.
      win!.showInactive()
      if (mode === 'minimized') win!.minimize()
      // Back from an update: the window is there, on the taskbar, with the panes restored,
      // but it did not take the keyboard. Flash the taskbar button once so it is obvious
      // the app came back instead of silently dying.
      else if (isQuietRelaunch()) win!.flashFrame(true)
    }
    // With a game up, not even this runs: showInactive() measured as enough to drop CS2
    // out of exclusive fullscreen 5.3s into a `npm run try` launch, against a 20s idle
    // baseline that never moved. So the window stays built-but-never-shown until the
    // game exits, and appears on the taskbar then. Checked fresh rather than trusting
    // the poller, because a launch can easily beat the first poll to this line.
    // A reveal that never happens is an app with no window at all - running, on no
    // taskbar, looking exactly like an update that failed to restart. The game check is
    // allowed to hold it back; it is not allowed to lose it, so a failed check reveals
    // anyway and a deferred one says so in the log.
    void checkGameNow()
      .catch(() => undefined)
      .then(() => {
        if (!whenClear('window-reveal', reveal)) {
          updateLog('window', `held back until the game exits (${gameState().game ?? 'unknown'})`)
        }
      })
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

  /**
   * Tell the page whether anyone can see it.
   *
   * The page cannot work this out for itself: `backgroundThrottling: false` (above) also
   * stops Chromium ever moving the document to the hidden state, so `document.hidden` is
   * false on a minimised window and `visibilitychange` never fires. Measured, not
   * assumed - which also means the `if (document.hidden) return` guards the polling
   * badges carry had never skipped a single poll. This is the signal they use instead.
   */
  const pushVisible = (): void => send('app:visible', !win?.isMinimized() && !!win?.isVisible())
  win.on('minimize', pushVisible)
  win.on('restore', pushVisible)
  win.on('show', pushVisible)
  win.on('hide', pushVisible)
  win.webContents.on('did-finish-load', pushVisible)
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

/**
 * Bring the window up. `asked` marks the paths where a person deliberately reached for
 * the app (double-clicking the shortcut, clicking a toast); those still work mid-game.
 * Everything else - a hotkey that only wanted the microphone, the app deciding it has
 * something to say - is dropped while a game is on screen rather than queued, because
 * a window that pops up half an hour later, for a reason that has passed, is its own
 * kind of interruption.
 */
function focusWindow(asked = false): void {
  if (!asked && isGameActive()) return
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
  // A game is on screen: the chime above still plays (sound costs you nothing mid-round)
  // but the taskbar flash and the toast do not. Both are drawn by the shell on top of a
  // fullscreen game and both can take it off the display - the exact thing this is
  // meant to tell you about while you are busy with something else.
  if (isGameActive()) return
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
      .on('click', () => focusWindow(true))
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

  // Reopening a pane that was in a lane, when the lane turned out to hold nothing and
  // the project folder is free again: the lane was only ever there to keep two agents
  // apart, and there is no second agent now. Without this, one busy afternoon leaves a
  // project permanently worked on from `-w2` while its own folder sits empty.
  const home = returnToBase(req.cwd, taken)
  if (home) {
    return {
      ...req,
      cwd: home,
      lane: undefined,
      laneEnv: undefined,
      laneNote: `Lane was empty - back in ${basename(home)}`
    }
  }

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
/**
 * The sidebar was dragged into a new order. Only local panes can be moved here - a
 * mirrored pane belongs to the machine running it, and its place in that machine's
 * list is not this window's to change - so the ids are handed over as they come and
 * the manager keeps the ones it owns. The window that did the dragging holds the full
 * order (mirrors included) itself, so the drop looks the same either way.
 */
ipcMain.on('sessions:reorder', (_e, ids: string[]) => manager.reorder(ids))
ipcMain.on('sessions:attention-clear', (_e, id: string) =>
  remote.owns(id) ? remote.send(id, { t: 'ack' }) : manager.clearAttention(id)
)
ipcMain.on('pty:write', (_e, id: string, data: string) => {
  if (remote.owns(id)) return remote.send(id, { t: 'write', data })
  watchForClear(id, data)
  manager.write(id, data)
})

/** What each pane has typed since its last Enter - only ever used to spot `/clear`. */
const typedLine = new Map<string, string>()

/**
 * Notice when a pane's conversation is cleared, so a pointless lane can be handed back.
 *
 * A lane exists to keep two agents in one project from overwriting each other. After
 * /clear there is no conversation left to protect, and if the lane is also empty - no
 * commits, nothing uncommitted - then the pane is sitting in a second checkout, on a
 * branch nobody will merge, with its own dev port, for no reason at all. So it goes home
 * to the project folder, and the empty lane is deleted behind it.
 *
 * Read from the keystrokes rather than from the CLI's output because output is a moving
 * target across agents and versions, while `/clear` + Enter is what the person typed. A
 * pane with real work in its lane is never moved, whatever it types.
 */
function watchForClear(id: string, data: string): void {
  if (!data || !getConfig().autoLane) return
  const { line, submitted } = trackTyped(typedLine.get(id) ?? '', data)
  typedLine.set(id, line)
  if (submitted.some((l) => l === '/clear')) void laneWentQuiet(id)
}

/** Every folder a live pane is sitting in - what "this lane is in use" means. */
function busyDirs(): string[] {
  return allSessions()
    .filter((s) => s.status !== 'exited')
    .map((s) => s.cwd)
}

async function laneWentQuiet(id: string): Promise<void> {
  const before = manager.list().find((s) => s.id === id)
  if (!before?.lane) return
  // The CLI needs a moment to actually clear, and the lane needs to still be empty
  // after whatever that pane was doing has settled.
  await new Promise((r) => setTimeout(r, 2000))
  const s = manager.list().find((x) => x.id === id)
  if (!s || s.status === 'exited' || !s.lane || s.cwd !== before.cwd) return
  const home = returnToBase(
    s.cwd,
    busyDirs().filter((d) => d !== s.cwd)
  )
  if (!home) return

  const lane = s.lane
  const repo = home
  manager.moveTo(id, home, {
    lane: undefined,
    laneEnv: undefined,
    laneNote: `Cleared - back in ${basename(home)}`
  })
  send('lane:moved', id, `Cleared, and lane ${lane} was empty - this pane is back in ${basename(home)}`)
  // The pane has left, so the folder is free to go. Anything that was in it would have
  // stopped returnToBase() above.
  void sweepLanes(repo, busyDirs())
}
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
  if (patch.gameMode !== undefined) refreshGameWatch(next)
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

// A worktree lane of the user's own project: what is in it, and putting it back.
ipcMain.handle('lanes:work', (_e, cwd: string) => laneWork(cwd))
ipcMain.handle('lanes:merge', (_e, cwd: string) => {
  const result = mergeLaneBack(cwd, { busy: busyDirs() })
  // A lane that merged while its own pane was still in it is now empty, and will be
  // swept the moment that pane closes or is cleared.
  if (result.ok) send('sessions:changed', allSessions())
  return result
})

/**
 * Delete the lanes that hold nothing, everywhere the desk is currently working.
 *
 * Lanes are created without being asked, so they have to disappear the same way. A lane
 * whose commits went back into main passes the "holds nothing" test by itself, which
 * makes this the auto-delete for merged lanes as well as for the ones that were never
 * used. Anything with a commit, an uncommitted file or a session in it is skipped, so
 * the worst case is a folder that lives one sweep longer than it needed to.
 */
let sweptAt = 0
async function sweepEmptyLanes(): Promise<void> {
  const now = Date.now()
  if (now - sweptAt < 5 * 60_000) return
  sweptAt = now
  const busy = busyDirs()
  for (const repo of knownRepos()) {
    try {
      // A pane that ended in a lane keeps the folder on screen after the folder is
      // gone, and restarting it would fail on a path the user never typed. So each
      // removed lane hands its card back to the project it belongs to.
      for (const dir of await sweepLanes(repo, busy)) manager.relocate(dir, repo)
    } catch {
      /* a repo that vanished under us is not worth a crash on a tidy-up */
    }
  }
}
// A stuck lane is retried on a clock rather than only when some chat happens to run a
// lane command, so the ones that come unstuck by themselves do it overnight too. Both
// the interval and laneRetry are no-ops on a machine with no PaneForge checkout, and it
// returns immediately unless a lane is conflicted or waiting to go out.
setInterval(() => {
  laneRetry()
  // Same clock, different lanes: the user's own worktree lanes, tidied when they are
  // empty. Throttled to five minutes inside, and a no-op for a repo with no lanes.
  void sweepEmptyLanes()
}, 60_000).unref()

/**
 * Every project this window knows about, as repository roots: the panes on screen, the
 * workspaces, and the projects folder itself. A lane is created beside a repo and can
 * outlive every pane that ever opened it, so the sweep below cannot only look at what
 * is open right now or a project's last lane would never be cleared.
 */
function knownRepos(): string[] {
  const folders = [
    ...manager.list().map((s) => s.cwd),
    ...getConfig().presets.flatMap((p) => p.items.map((i) => i.path)),
    ...listProjects().map((p) => p.path)
  ]
  const repos = new Set<string>()
  for (const f of folders) {
    if (!f) continue
    const repo = repoOf(f)
    if (repo) repos.add(repo)
  }
  return [...repos]
}

// A pane ending is when a lane most often stops being needed, and waiting up to five
// minutes to notice leaves a folder on screen that has nothing in it. Deferred so the
// sweep's git calls are never on the path of the pane list redrawing.
manager.on('sessions', () => {
  if (laneSweepQueued) return
  laneSweepQueued = true
  setTimeout(() => {
    laneSweepQueued = false
    sweptAt = 0
    void sweepEmptyLanes()
  }, 3000).unref()
})
let laneSweepQueued = false

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
// Opening a pane on the other machine. The folder list has to come from there too -
// this machine's projects root says nothing about what is checked out over there.
ipcMain.handle('remote:projects', (_e, device: string) => remote.projectsOn(String(device)))
ipcMain.handle('remote:agents', (_e, device: string) => remote.agentsOn(String(device)))
ipcMain.handle('remote:start', (_e, device: string, req: StartSessionRequest) =>
  remote.startOn(String(device), req)
)
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
//
// Raising the window is opt-in. The overlay is deliberately unfocusable so a click can
// leave the keyboard exactly where it was - clicking a line and then pressing Ctrl+V in
// whatever you were already typing in is the reason it exists. Now that a plain click
// sends to the pane, doing that AND dragging PaneForge to the front would take the
// overlay's own point away from it. The pty does not care whether its window is in
// front: the text lands either way.
ipcMain.on('recents:toPane', (_e, id: string, focus = false) => {
  if (!getRecent(id)) return
  if (focus) focusWindow()
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

/**
 * The restart is the loudest thing this app does: the installer takes the window away,
 * the new exe starts, and Windows hands the display around twice on the way through.
 * Mid-game that is a dropped round, and it happens several times a day because the app
 * updates itself that often. The download is already on disk by this point, so waiting
 * for the game to end costs nothing at all except the restart being later.
 */
ipcMain.on('update:install', async () => {
  if (installStarted) return
  // Asked fresh rather than read off the poller: a game started ten seconds ago is
  // exactly the case where this must not go ahead.
  await checkGameNow()
  if (!whenClear('update-install', doInstall)) send('game:changed', gameStatus())
})

function doInstall(): void {
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
    // Same rule as every other reveal: with a game up, the window that failed to update
    // stays hidden until the screen is free rather than reappearing over it.
    if (alive()) whenClear('update-failed-reveal', restoreAfterFailedInstall)
    return
  }
  // The installer is already running and its first job is to wait for this exe to let go
  // of its own files, so every millisecond spent on a graceful teardown is a millisecond
  // the user spends looking at no app at all. Nothing is left to save.
  hardExit()
}

/** The update did not happen: put the window back, inactive, once the screen is free. */
function restoreAfterFailedInstall(): void {
  if (!alive()) return
  win!.setSkipTaskbar(false)
  win!.showInactive()
  win!.flashFrame(true)
}

// --- do not disturb while gaming -------------------------------------------

function gameStatus(): GameModeStatus {
  const s = gameState()
  return { active: s.active, game: s.game, manual: s.manual, waiting: deferredCount() }
}

ipcMain.handle('game:status', () => gameStatus())
// Asked once on load: the page can come up either before or after the window is shown,
// so the push alone is a race the page loses on a cold start.
ipcMain.handle('app:visibleNow', () => !!win && !win.isMinimized() && win.isVisible())
/** The Settings switch, kept out of the config write path so it applies instantly. */
ipcMain.handle('game:manual', (_e, on: boolean) => {
  const next = setConfig({ gameMode: { ...getConfig().gameMode, manual: on } })
  refreshGameWatch(next)
  send('config:changed', next)
  return gameStatus()
})
/** "Restart now anyway" - the one way past a held update without ending the game. */
ipcMain.on('game:installAnyway', () => {
  cancelDeferred('update-install')
  doInstall()
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
  // First line of this process's story: the one that was missing when an update came
  // back and nobody could tell whether it had.
  updateLog('launch', `v${app.getVersion()}`, `pid ${process.pid}`, `start=${startMode()}`)
  history.setHistoryEnabled(cfg.saveHistory)
  history.prune(cfg.historyDays)
  // Before the window: everything that opens, floats or flashes below asks this first,
  // and a launch that happens to land mid-game should be quiet on the way in rather
  // than one poll later.
  onGameState((s) => {
    setShelfHidden(s.active)
    send('game:changed', gameStatus())
  })
  startGameWatch(cfg)
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
  updateLog('exit', installStarted ? 'handing over to the installer' : 'window closed')
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
