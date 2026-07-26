// Lets more than one PaneForge run at once.
//
// Electron keys both its single-instance lock and its saved state on the userData
// folder, so two copies of the app fight over one profile: the second launch just
// raises the first window and quits. That makes PaneForge impossible to develop from
// a session running inside PaneForge - testing a change means closing the app that
// hosts the agent doing the work.
//
// A named profile moves userData aside (`claude-orchestrator` -> `-dev`), which gives
// the second copy its own lock, its own config and its own taskbar identity. The live
// app keeps running untouched.
//
//   PANEFORGE_PROFILE=dev  or  --profile=dev
//
// Unpackaged runs (`npm run dev`, `npm run try`) default to the `dev` profile so they
// can never collide with the installed app by accident.

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { app } from 'electron'

const BASE_APP_ID = 'com.robert.paneforge'

let current = ''

function requested(): string {
  const flag = process.argv.find((a) => a.startsWith('--profile='))
  const raw = (flag ? flag.slice('--profile='.length) : process.env.PANEFORGE_PROFILE) ?? ''
  const clean = raw.trim().toLowerCase().replace(/[^a-z0-9-]/g, '')
  if (clean && clean !== 'default') return clean
  // An unpackaged run is by definition a build under test, never the daily driver.
  return app.isPackaged ? '' : 'dev'
}

/**
 * Where this app keeps its data, without the crash.
 *
 * `app.getPath('userData')` is not a lookup: Electron builds the folder as part of
 * answering, and when that fails it throws `Failed to get 'userData' path`. That happens
 * at module scope, before any window exists, so Electron's own handler puts up the "A
 * JavaScript error occurred in the main process" box - a modal that takes the keyboard
 * off whatever you were typing - and the app never starts at all. Seen on this machine
 * while a session was running inside the live app.
 *
 * Recomputing the same path by hand and handing it back through setPath fixes it for
 * every later caller too (config, history, the updater log all ask Electron for it).
 */
function userDataDir(): string {
  try {
    return app.getPath('userData')
  } catch {
    const roaming =
      process.env.APPDATA ||
      (process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support')
        : join(homedir(), 'AppData', 'Roaming'))
    const dir = join(roaming, app.getName() || 'claude-orchestrator')
    try {
      mkdirSync(dir, { recursive: true })
      app.setPath('userData', dir)
      app.setPath('sessionData', dir)
    } catch {
      /* nothing left to try - the caller still gets a usable path string */
    }
    return dir
  }
}

/**
 * Must run before `app.whenReady()` and before anything touches userData.
 * Returns the profile name, '' for the normal installed app.
 */
export function initProfile(): string {
  current = requested()
  // Unconditional, even for the installed app: it is what repairs a userData path
  // Electron itself could not resolve, and every later getPath call depends on it.
  const base = userDataDir()
  if (!current) {
    app.setAppUserModelId(BASE_APP_ID)
    return ''
  }
  const dir = join(dirname(base), `${basename(base)}-${current}`)
  mkdirSync(dir, { recursive: true })
  app.setPath('userData', dir)
  // Sessions and caches follow userData or they end up shared again.
  app.setPath('sessionData', dir)
  // A separate app id keeps the test copy off the live app's taskbar button, so the
  // two windows can sit side by side and its notifications say which one spoke.
  app.setAppUserModelId(`${BASE_APP_ID}.${current}`)
  seed(base, dir)
  return current
}

/** Profile name, '' when this is the normal installed app. */
export function profileName(): string {
  return current
}

// A launch the app asked for itself - the updater restarting into a new version, or
// the admin relaunch. Nobody double-clicked anything, so the returning window must not
// take the keyboard off whatever the user moved on to. The old process drops a marker
// in userData just before it exits and the new one consumes it on the way up.
const QUIET_MARKER = 'quiet-relaunch'
// A stale marker (install died, machine rebooted) must not silence a genuine launch
// days later, so it only counts while it is fresh.
const QUIET_MAX_AGE_MS = 5 * 60 * 1000

function quietPath(): string {
  return join(userDataDir(), QUIET_MARKER)
}

/** Called by the process that is about to exit and come back on its own. */
export function markQuietRelaunch(on = true): void {
  try {
    if (on) writeFileSync(quietPath(), String(Date.now()))
    else rmSync(quietPath(), { force: true })
  } catch {
    /* worst case the relaunch activates, which is what it did before */
  }
}

let quiet: boolean | null = null

/**
 * True when this process is the far side of a self-restart. Reads the marker once and
 * deletes it, so the very next launch after that is a normal one again.
 */
export function isQuietRelaunch(): boolean {
  if (quiet !== null) return quiet
  quiet = false
  try {
    const p = quietPath()
    if (existsSync(p)) {
      const age = Date.now() - Number(readFileSync(p, 'utf8'))
      rmSync(p, { force: true })
      quiet = age >= 0 && age < QUIET_MAX_AGE_MS
    }
  } catch {
    /* no marker, normal launch */
  }
  return quiet
}

/**
 * How the first window should appear.
 *
 * A test copy is started by an agent working in the live app, so it must never take
 * the keyboard away from whatever is being typed there: a named profile shows its
 * window without activating it, and `--minimized` keeps it off the screen entirely
 * until it is clicked. The installed app still opens normally - you launched it,
 * unless it restarted itself to finish an update.
 */
export function startMode(): 'normal' | 'inactive' | 'minimized' {
  const flag = process.argv.includes('--minimized') || process.env.PANEFORGE_START === 'minimized'
  if (flag) return 'minimized'
  if (process.env.PANEFORGE_START === 'normal') return 'normal'
  if (isQuietRelaunch()) return 'inactive'
  return current ? 'inactive' : 'normal'
}

/** " - dev" for window titles, '' for the normal app. */
export function titleSuffix(): string {
  return current ? ` - ${current}` : ''
}

// First launch of a profile copies the live config once, so the test copy opens with
// the same projects root, workspaces and settings instead of a blank first-run app.
// Only once: after that the two drift apart on purpose, and an experiment in the test
// copy must never be able to corrupt the real one.
function seed(from: string, to: string): void {
  const dst = join(to, 'config.json')
  const src = join(from, 'config.json')
  if (existsSync(dst) || !existsSync(src)) return
  try {
    copyFileSync(src, dst)
  } catch {
    /* first run just starts from defaults */
  }
}
