// Background updates from GitHub Releases, with a Claude-desktop style prompt:
// the download happens quietly, and the only thing the user ever sees is
// "version X is ready - restart now?".
//
// The feed is the public releases of this repo, so no token ships in the app.
// In `npm run dev` there is no update metadata next to the binary, so the whole
// thing reports 'unsupported' instead of throwing on every launch.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { UpdateState } from '../shared/types'

type Emit = (s: UpdateState) => void

export const RELEASES_URL = 'https://github.com/robertiuoras/claude-orchestrator/releases'

let state: UpdateState = { phase: 'idle', current: app.getVersion() }
let emit: Emit = () => undefined
let wired = false
let timer: NodeJS.Timeout | null = null

// Typed loosely on purpose: electron-updater is a runtime dependency of the
// packaged app, and requiring it eagerly would break `electron-vite dev`.
type Updater = {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowPrerelease: boolean
  logger: unknown
  checkForUpdates: () => Promise<unknown>
  quitAndInstall: (silent?: boolean, forceRunAfter?: boolean) => void
  on: (event: string, cb: (...args: any[]) => void) => void
}

let updater: Updater | null = null

function load(): Updater | null {
  if (updater) return updater
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('electron-updater') as { autoUpdater: Updater }
    updater = mod.autoUpdater
    return updater
  } catch {
    return null
  }
}

function set(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch, current: app.getVersion() }
  emit(state)
}

export function getUpdateState(): UpdateState {
  return state
}

export function initUpdater(onChange: Emit, enabled: boolean): void {
  emit = onChange
  if (!app.isPackaged) {
    set({ phase: 'unsupported', error: 'Updates only run in the packaged app.' })
    return
  }
  const u = load()
  if (!u) {
    set({ phase: 'unsupported', error: 'electron-updater is not bundled in this build.' })
    return
  }
  // `electron-builder --dir` produces a runnable app with no app-update.yml, and
  // electron-updater's only reaction to that is an ENOENT it surfaces as a scary
  // error in Settings. A locally built folder simply has no feed to poll.
  if (!existsSync(join(process.resourcesPath, 'app-update.yml'))) {
    set({ phase: 'unsupported', error: 'Local build - no update feed. Installed builds update themselves.' })
    return
  }
  if (!wired) {
    wired = true
    // macOS refuses to swap in an unsigned update: Squirrel.Mac validates the code
    // signature, and this app ships unsigned. So on a Mac the app finds the new
    // version and hands you the release page instead of pretending it can self-update.
    u.autoDownload = process.platform !== 'darwin'
    // Installing on quit would swap the app out from under running agent panes.
    u.autoInstallOnAppQuit = false
    u.on('checking-for-update', () => set({ phase: 'checking', error: undefined }))
    u.on('update-available', (info: { version: string; releaseNotes?: string }) =>
      set({
        phase: process.platform === 'darwin' ? 'available' : 'downloading',
        version: info?.version,
        percent: 0,
        notes: notes(info?.releaseNotes),
        url: `${RELEASES_URL}/tag/v${info?.version ?? ''}`
      })
    )
    u.on('update-not-available', () => set({ phase: 'none', version: undefined, percent: undefined }))
    u.on('download-progress', (p: { percent: number }) =>
      set({ phase: 'downloading', percent: Math.round(p?.percent ?? 0) })
    )
    u.on('update-downloaded', (info: { version: string; releaseNotes?: string }) =>
      set({ phase: 'ready', version: info?.version, percent: 100, notes: notes(info?.releaseNotes) })
    )
    u.on('error', (e: Error) => set({ phase: 'error', error: e?.message ?? String(e) }))
  }
  setAutoCheck(enabled)
}

/** Turn the background poll on or off; a manual check still works either way. */
export function setAutoCheck(enabled: boolean): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  if (!enabled || !app.isPackaged) return
  // A few seconds after launch, then every 30 minutes: the app is edited several
  // times a day, so a once-a-day check would mean always running yesterday's build.
  setTimeout(() => void checkForUpdates(), 8_000)
  timer = setInterval(() => void checkForUpdates(), 30 * 60_000)
  timer.unref?.()
}

export async function checkForUpdates(): Promise<UpdateState> {
  const u = load()
  if (!app.isPackaged || !u) return state
  try {
    set({ phase: 'checking', error: undefined })
    await u.checkForUpdates()
  } catch (e) {
    set({ phase: 'error', error: (e as Error)?.message ?? String(e) })
  }
  return state
}

export function installUpdate(): void {
  const u = load()
  if (!u || state.phase !== 'ready') return
  // isSilent false on Windows shows the installer's own progress; forceRunAfter
  // brings the app back up so the user is not left staring at a closed window.
  u.quitAndInstall(false, true)
}

function notes(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw.replace(/<[^>]+>/g, '').trim().slice(0, 600)
  if (Array.isArray(raw)) {
    return raw
      .map((n: { note?: string }) => n?.note ?? '')
      .join('\n')
      .replace(/<[^>]+>/g, '')
      .trim()
      .slice(0, 600)
  }
  return undefined
}
