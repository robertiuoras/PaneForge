// Everything the app remembers between runs: projects root, saved workspaces,
// terminal size, window geometry. One small JSON file in the Electron userData
// folder - no database, and it stays hand-editable if something goes wrong.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import type { Config, SwarmRole } from '../shared/types'

let cache: Config | null = null

function file(): string {
  return join(app.getPath('userData'), 'config.json')
}

/**
 * Roles a swarm launch offers out of the box. Deliberately few and deliberately
 * about ownership rather than skill: the failure mode of several agents in one
 * repo is two of them editing the same file, not one of them being bad at tests.
 */
export const DEFAULT_ROLES: SwarmRole[] = [
  {
    id: 'planner',
    name: 'Planner',
    agent: 'claude',
    brief:
      'You own the plan and nothing else. Read the code, write the step-by-step plan into .paneforge/MEMORY.md, then stop and let the others build.',
    enabled: true
  },
  {
    id: 'builder',
    name: 'Builder',
    agent: 'claude',
    brief: 'You own the implementation. Follow the plan in .paneforge/MEMORY.md and write the code.',
    enabled: true
  },
  {
    id: 'reviewer',
    name: 'Reviewer',
    agent: 'codex',
    brief:
      'You own review. Do not write features. Read the diff, find real bugs, and append findings to .paneforge/MEMORY.md.',
    enabled: true
  },
  {
    id: 'tester',
    name: 'Tester',
    agent: 'claude',
    brief: 'You own tests and verification. Run the build and the test suite, then report what actually failed.',
    enabled: false
  }
]

function defaults(): Config {
  return {
    root: join(homedir(), 'Desktop', 'Projects'),
    presets: [],
    defaultAgent: 'claude',
    defaultModels: {},
    customAgents: [],
    fontSize: 13,
    copyOnSelect: true,
    mouseSelect: true,
    autoFixUi: true,
    notifyOnIdle: true,
    soundOnIdle: true,
    grid: false,
    confirmClose: true,
    launchAtLogin: false,
    adminMode: false,
    autoUpdate: true,
    saveHistory: true,
    historyDays: 30,
    voice: { enabled: true, model: 'base', language: 'auto' },
    swarmRoles: DEFAULT_ROLES,
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
    cache = {
      ...base,
      ...raw,
      window: { ...base.window, ...(raw.window ?? {}) },
      voice: { ...base.voice, ...(raw.voice ?? {}) },
      // An empty roles array in an old config would leave the swarm dialog blank.
      swarmRoles: raw.swarmRoles?.length ? raw.swarmRoles : base.swarmRoles
    }
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
