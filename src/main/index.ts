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
  Notification,
  shell
} from 'electron'
import { SessionManager } from './sessions'
import { listProjects } from './projects'
import { getConfig, setConfig } from './config'
import { invalidateAgents, listAgents, specFor } from './agents'
import { gitInfo } from './git'
import { which } from './which'
import { adminStatus, disableAdminMode, enableAdminMode, relaunchViaTask } from './admin'
import { initProfile, profileName, startMode, titleSuffix } from './profile'
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
    focusWindow()
    openFromArgs(argv)
  })
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
  win = new BrowserWindow({
    width: cfg.window.width,
    height: cfg.window.height,
    x: cfg.window.x,
    y: cfg.window.y,
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

  if (cfg.window.maximized) win.maximize()
  win.on('ready-to-show', () => {
    const mode = startMode()
    if (mode === 'normal') return win?.show()
    // showInactive draws the window without pulling focus off the app you are typing
    // in. minimize() after it, rather than instead of it, because minimizing a window
    // that has never been shown leaves it in a state Windows will not restore from
    // the taskbar.
    win?.showInactive()
    if (mode === 'minimized') win?.minimize()
  })
  win.on('focus', () => win?.flashFrame(false))
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
  const maximized = w.isMaximized()
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
ipcMain.handle('sessions:start', (_e, req: StartSessionRequest) => manager.start(req))
ipcMain.handle('sessions:startMany', (_e, reqs: StartSessionRequest[]) => {
  const out: Session[] = []
  for (const r of reqs) {
    try {
      out.push(manager.start(r))
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
  manager.killAll()
  app.quit()
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
ipcMain.on('update:install', () => {
  // Remembered before the panes die, replayed by restoreSessions() on the next
  // launch: an update should feel like the app blinked, not like it wiped the desk.
  setConfig({ restoreSessions: manager.snapshot() })
  history.flush()
  manager.killAll()
  installUpdate()
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
  manager.killAll()
  app.quit()
})
app.on('before-quit', () => {
  manager.killAll()
  // Buffered transcript output would otherwise be lost on the last 1.5 seconds.
  history.flush()
})
app.on('will-quit', () => globalShortcut.unregisterAll())
