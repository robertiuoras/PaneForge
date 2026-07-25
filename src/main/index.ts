import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { SessionManager } from './sessions'
import { listProjects } from './projects'
import type { StartSessionRequest } from '../shared/types'

const manager = new SessionManager()
let win: BrowserWindow | null = null

function createWindow(): void {
  win = new BrowserWindow({
    width: 1500,
    height: 940,
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

  win.on('ready-to-show', () => win?.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Fan pty output and session-list changes out to the renderer. Sent unconditionally;
// a destroyed window just drops them.
manager.on('data', (id: string, data: string) => {
  win?.webContents.send('pty:data', id, data)
})
manager.on('sessions', (sessions) => {
  win?.webContents.send('sessions:changed', sessions)
})

ipcMain.handle('projects:list', () => listProjects())
ipcMain.handle('sessions:list', () => manager.list())
ipcMain.handle('sessions:start', (_e, req: StartSessionRequest) => manager.start(req))
ipcMain.handle('sessions:kill', (_e, id: string) => manager.kill(id))
ipcMain.handle('sessions:buffer', (_e, id: string) => manager.buffer(id))
ipcMain.on('pty:write', (_e, id: string, data: string) => manager.write(id, data))
ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) =>
  manager.resize(id, cols, rows)
)

/** `PaneForge --open <path>` starts a session in that folder on launch. */
function autoOpen(): void {
  const i = process.argv.indexOf('--open')
  const dir = i >= 0 ? process.argv[i + 1] : process.env['PANEFORGE_OPEN']
  if (dir) manager.start({ cwd: dir })
}

app.whenReady().then(() => {
  createWindow()
  autoOpen()
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
