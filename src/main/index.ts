import { spawn } from 'node:child_process'
import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  screen,
  shell
} from 'electron'
import { SessionManager } from './sessions'
import { listProjects } from './projects'
import { getConfig, setConfig } from './config'
import { invalidateAgents, listAgents, specFor } from './agents'
import { gitInfo } from './git'
import { laneExtras, resolveLane } from './lanes'
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
  clearRecents,
  copyRecent,
  listRecents,
  recentPath,
  refreshRecents,
  startRecents,
  stopRecents
} from './recents'
import { refreshPath, runCommand } from './install'
import { checkForUpdates, getUpdateState, initUpdater, installUpdate, setAutoCheck } from './updater'
import * as history from './history'
import { readBoard, writeMemory, writeTasks } from './board'
import * as voice from './voice'
import { installCommand } from '../shared/agents'
import type {
  Config,
  Session,
  StartSessionRequest,
  SwarmRequest,
  TaskItem,
  UpdateState
} from '../shared/types'

const manager = new SessionManager()
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
      contextIsolation: true
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
  win.on('close', rememberBounds)
  // Without this the module keeps a destroyed BrowserWindow, and every later
  // `win?.` call throws "Object has been destroyed" instead of no-opping.
  win.on('closed', () => {
    win = null
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
manager.on('sessions', (sessions: Session[]) => {
  send('sessions:changed', sessions)
})
manager.on('attention', (s: Session) => {
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
      title: `${s.title} is waiting`,
      body: `${s.agent} finished or needs input.`,
      // Our own chime already played; the system ding on top of it is noise.
      silent: true
    })
      .on('click', focusWindow)
      .show()
  }
})

ipcMain.handle('projects:list', () => listProjects())
ipcMain.handle('agents:list', (_e, force?: boolean) => listAgents(force))
ipcMain.handle('sessions:list', () => manager.list())
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
ipcMain.handle('sessions:restart', (_e, id: string) => manager.restart(id))
ipcMain.handle('sessions:switchAgent', (_e, id: string, agent: string, model?: string) =>
  manager.switchAgent(id, agent, model)
)
ipcMain.handle('sessions:rename', (_e, id: string, title: string) => manager.rename(id, title))
ipcMain.handle('sessions:kill', (_e, id: string) => manager.kill(id))
ipcMain.handle('sessions:buffer', (_e, id: string) => manager.buffer(id))
ipcMain.on('sessions:attention-clear', (_e, id: string) => manager.clearAttention(id))
ipcMain.on('pty:write', (_e, id: string, data: string) => manager.write(id, data))
ipcMain.on('pty:broadcast', (_e, text: string) => manager.broadcast(text))
ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) =>
  manager.resize(id, cols, rows)
)
ipcMain.on('pty:redraw', (_e, id: string) => manager.redraw(id))
ipcMain.on('sessions:busy', (_e, id: string, busy: boolean) => manager.setBusyOnScreen(id, busy))

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
  send('config:changed', next)
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
// Dragging a shelf image into another app entirely. The renderer cannot start an OS drag
// with a real file in it - only the main process can, and only with a path it owns.
ipcMain.on('recents:drag', (e, id: string) => {
  const file = recentPath(id)
  if (!file) return
  try {
    e.sender.startDrag({ file, icon: nativeImage.createFromPath(file).resize({ width: 96 }) })
  } catch {
    /* the png was cleared between the click and the drag */
  }
})

/** Watch the clipboard, or stop watching, to match the setting. */
function applyClipboardShelf(cfg: Config): void {
  if (cfg.clipboardShelf) startRecents((items) => send('recents:changed', items))
  else stopRecents()
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
  // Remembered before the panes die, replayed by restoreSessions() on the next
  // launch: an update should feel like the app blinked, not like it wiped the desk.
  // Unless the user turned that off - the app updates itself several times a day, so
  // an always-on restore makes a set of panes impossible to be rid of by restarting.
  setConfig({ restoreSessions: getConfig().restoreAfterUpdate ? manager.snapshot() : [] })
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
 * Bring back the panes an update closed. Each one resumes the agent's own last
 * conversation (`claude --continue`), so the restart costs a redraw rather than the
 * thread you were in. Cleared first: a crash while restoring must not leave the app
 * re-opening the same panes on every launch.
 */
function restoreSessions(): void {
  const pending = getConfig().restoreSessions ?? []
  if (!pending.length) return
  setConfig({ restoreSessions: [] })
  for (const req of pending) {
    try {
      manager.start({ ...req, resume: true })
    } catch {
      // Folder moved or the agent is no longer installed - skip that pane only.
    }
  }
}

app.whenReady().then(() => {
  const cfg = getConfig()
  history.setHistoryEnabled(cfg.saveHistory)
  history.prune(cfg.historyDays)
  createWindow()
  applyVoiceHotkey(cfg)
  applyClipboardShelf(cfg)
  crashTestHook()
  initUpdater((s: UpdateState) => send('update:changed', s), cfg.autoUpdate)
  restoreSessions()
  openFromArgs(process.argv)
  if (process.env['PANEFORGE_OPEN']) openFromArgs(['--open', process.env['PANEFORGE_OPEN'] as string])
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Agents are child processes of this app: leaving them running after the window
// closes would strand invisible `claude` processes holding file locks.
app.on('window-all-closed', () => {
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
  // shutdown() also flushes buffered transcript output, which would otherwise lose the
  // last 1.5 seconds of every pane. It runs once, so the two quit paths cannot double
  // the work between them.
  manager.shutdown()
})
app.on('will-quit', () => globalShortcut.unregisterAll())
