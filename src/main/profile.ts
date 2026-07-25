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

import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
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
 * Must run before `app.whenReady()` and before anything touches userData.
 * Returns the profile name, '' for the normal installed app.
 */
export function initProfile(): string {
  current = requested()
  if (!current) {
    app.setAppUserModelId(BASE_APP_ID)
    return ''
  }
  const base = app.getPath('userData')
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

/**
 * How the first window should appear.
 *
 * A test copy is started by an agent working in the live app, so it must never take
 * the keyboard away from whatever is being typed there: a named profile shows its
 * window without activating it, and `--minimized` keeps it off the screen entirely
 * until it is clicked. The installed app still opens normally - you launched it.
 */
export function startMode(): 'normal' | 'inactive' | 'minimized' {
  const flag = process.argv.includes('--minimized') || process.env.PANEFORGE_START === 'minimized'
  if (flag) return 'minimized'
  if (process.env.PANEFORGE_START === 'normal') return 'normal'
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
