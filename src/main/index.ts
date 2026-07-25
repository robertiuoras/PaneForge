import { spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, shell } from 'electron'
import { SessionManager } from './sessions'
import { listProjects } from './projects'
import { getConfig, setConfig } from './config'
import { invalidateAgents, listAgents } from './agents'
import { which } from './which'
import type { Config, Session, StartSessionRequest } from '../shared/types'

const manager = new SessionManager()
let win: BrowserWindow | null = null

// Windows ties notifications and the taskbar entry to this id; without it the
// toasts show up as "electron.app.Electron" and get grouped with other Electron apps.
app.setAppUserModelId('com.robert.paneforge')

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
  // No application menu: its default accelerators (Ctrl+R reload, Ctrl+W close) would
  // fire before the app's own shortcuts and reload the UI out from under the agents.
  Menu.setApplicationMenu(null)
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
    title: 'PaneForge',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  if (cfg.window.maximized) win.maximize()
  win.on('ready-to-show', () => win?.show())
  win.on('focus', () => win?.flashFrame(false))
  win.on('close', rememberBounds)
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

function rememberBounds(): void {
  if (!win) return
  const maximized = win.isMaximized()
  // getBounds() on a maximized window returns the screen size, which would make the
  // restored window unrestorable, so keep the normal bounds instead.
  const b = maximized ? win.getNormalBounds() : win.getBounds()
  setConfig({ window: { x: b.x, y: b.y, width: b.width, height: b.height, maximized } })
}

function focusWindow(): void {
  if (!win) return createWindow()
  if (win.isMinimized()) win.restore()
  win.focus()
}

// Fan pty output and session-list changes out to the renderer. Sent unconditionally;
// a destroyed window just drops them.
manager.on('data', (id: string, data: string) => {
  win?.webContents.send('pty:data', id, data)
})
manager.on('sessions', (sessions: Session[]) => {
  win?.webContents.send('sessions:changed', sessions)
})
manager.on('attention', (s: Session) => {
  if (!getConfig().notifyOnIdle) return
  // Only nag when you are not already looking at the app.
  if (win?.isFocused()) return
  win?.flashFrame(true)
  if (Notification.isSupported()) {
    new Notification({ title: `${s.title} is waiting`, body: `${s.agent} finished or needs input.` })
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

ipcMain.handle('config:get', () => getConfig())
ipcMain.handle('config:set', (_e, patch: Partial<Config>) => {
  const next = setConfig(patch)
  // An edited custom agent changes what is launchable, so the availability cache
  // must not outlive the edit.
  if (patch.customAgents) invalidateAgents()
  win?.webContents.send('config:changed', next)
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

ipcMain.handle('app:isAdmin', () => isAdmin())
ipcMain.on('app:relaunchAsAdmin', () => {
  // Electron cannot elevate a single child process on Windows, so the whole app
  // restarts elevated and every agent it spawns inherits admin - the same trade-off
  // the old self-elevating .bat made.
  const args = process.argv.slice(1).filter((a) => !a.startsWith('--remote-debugging'))
  const list = args.length ? ` -ArgumentList ${args.map((a) => `'${a.replace(/'/g, "''")}'`).join(',')}` : ''
  try {
    spawn(
      'powershell',
      ['-NoProfile', '-Command', `Start-Process -Verb RunAs -FilePath '${process.execPath.replace(/'/g, "''")}'${list}`],
      { detached: true, stdio: 'ignore', windowsHide: true }
    ).unref()
    manager.killAll()
    app.quit()
  } catch {
    /* user declined UAC - stay as we are */
  }
})

let adminCache: boolean | null = null
function isAdmin(): boolean {
  if (adminCache !== null) return adminCache
  if (process.platform !== 'win32') {
    adminCache = typeof process.getuid === 'function' && process.getuid() === 0
    return adminCache
  }
  // `fltmc` is a stock Windows tool that refuses to run without elevation, which
  // makes its exit code the cheapest admin probe that needs no extra dependency.
  try {
    adminCache = spawnSync('fltmc', [], { windowsHide: true }).status === 0
  } catch {
    adminCache = false
  }
  return adminCache
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

app.whenReady().then(() => {
  createWindow()
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
app.on('before-quit', () => manager.killAll())
