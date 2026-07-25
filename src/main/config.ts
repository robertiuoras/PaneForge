// Everything the app remembers between runs: projects root, saved workspaces,
// terminal size, window geometry. One small JSON file in the Electron userData
// folder - no database, and it stays hand-editable if something goes wrong.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import type { Config } from '../shared/types'

let cache: Config | null = null

function file(): string {
  return join(app.getPath('userData'), 'config.json')
}

function defaults(): Config {
  return {
    root: join(homedir(), 'Desktop', 'Projects'),
    presets: [],
    defaultAgent: 'claude',
    fontSize: 13,
    notifyOnIdle: true,
    grid: false,
    confirmClose: true,
    launchAtLogin: false,
    window: { width: 1500, height: 940, maximized: false }
  }
}

export function getConfig(): Config {
  if (cache) return cache
  const base = defaults()
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as Partial<Config>
    // Shallow merge only: a config written by an older version is missing whole
    // keys, and a nested merge would resurrect stale window bounds anyway.
    cache = { ...base, ...raw, window: { ...base.window, ...(raw.window ?? {}) } }
  } catch {
    cache = base
  }
  return cache
}

export function setConfig(patch: Partial<Config>): Config {
  const next = { ...getConfig(), ...patch }
  cache = next
  try {
    mkdirSync(dirname(file()), { recursive: true })
    // Write-then-rename: a crash mid-write would otherwise leave a truncated file
    // that throws on next launch and silently resets every setting.
    const tmp = file() + '.tmp'
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    renameSync(tmp, file())
  } catch {
    /* read-only profile - keep the in-memory value so the session still works */
  }
  if (patch.launchAtLogin !== undefined) applyLaunchAtLogin(patch.launchAtLogin)
  return next
}

/** Validated projects root: falls back to the default if the saved one vanished. */
export function projectsRoot(): string {
  const c = getConfig()
  if (c.root && existsSync(c.root)) return c.root
  return defaults().root
}

function applyLaunchAtLogin(enabled: boolean): void {
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      // Start hidden-ish: the window still shows, but Windows treats an autolaunched
      // app more gently and this keeps the flag explicit if it is ever needed.
      args: []
    })
  } catch {
    /* unsupported platform */
  }
}
