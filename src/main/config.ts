// Everything the app remembers between runs: projects root, saved workspaces,
// terminal size, window geometry. One small JSON file in the Electron userData
// folder - no database, and it stays hand-editable if something goes wrong.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import type { Config, RemoteConfig, SwarmRole } from '../shared/types'
import { DEFAULT_DISCORD_STYLE } from '../shared/discordRpc'
import { DEFAULT_THEME } from '../shared/theme'
// wire.ts is pure crypto with no config import of its own, so the code generator can
// live where the protocol does without the two files importing each other.
import { newCode } from './remote/wire'

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

/**
 * Where someone else's code probably lives.
 *
 * This used to be a single hardcoded `~/Desktop/Projects`, which is exactly right for
 * one machine and wrong for most. On a fresh install anywhere else the project picker
 * came up empty with nothing to explain why, and an empty picker on first run reads as
 * a broken app rather than a setting nobody had chosen yet.
 *
 * So: take the first of the usual homes that exists and actually has folders in it.
 * `~/source/repos` is Visual Studio's default, `~/Developer` is Xcode's, and the
 * OneDrive pair matters because a redirected Desktop is normal on Windows now. If none
 * of them exist the conventional path is still returned, and the picker offers a
 * "choose your projects folder" button instead of an unexplained empty list.
 */
export function defaultRoot(): string {
  const home = homedir()
  /**
   * macOS gates Desktop, Documents, Downloads and anything under iCloud Drive behind
   * TCC, and the prompt fires on the first `stat` inside them - not on a read. Probing
   * this list at first launch therefore opened three or four system dialogs at once,
   * before the window was even up, with no way to tell which of them was PaneForge
   * asking for what. Nothing here is worth that: the folders below it find the same
   * checkouts on every Mac that has them, and a Desktop full of projects is one press
   * of Browse away - a prompt the person asked for, in answer to a click.
   *
   * Windows has no equivalent gate, so it keeps the full list. `~/OneDrive/Desktop` is
   * on it because a redirected Desktop is the normal Windows setup now.
   */
  const gated = process.platform === 'darwin'
  const candidates = [
    ...(gated ? [] : [['Desktop', 'Projects']]),
    ['Projects'],
    ['projects'],
    ['source', 'repos'],
    ['Developer'],
    ['dev'],
    ['code'],
    ['src'],
    ['repos'],
    ['git'],
    ...(gated
      ? []
      : [
          ['Documents', 'Projects'],
          ['OneDrive', 'Desktop', 'Projects'],
          ['OneDrive', 'Documents', 'Projects']
        ])
  ].map((parts) => join(home, ...parts))

  for (const dir of candidates) {
    try {
      if (!existsSync(dir)) continue
      // An existing but empty folder is not evidence: `~/code` left behind by some
      // installer must not win over a `~/Projects` full of real work further down.
      if (readdirSync(dir).some((name) => !name.startsWith('.'))) return dir
    } catch {
      /* unreadable - try the next one */
    }
  }
  return join(home, process.platform === 'darwin' ? 'Projects' : join('Desktop', 'Projects'))
}

/** The port this device listens on for its other devices, when hosting is on. */
export const DEFAULT_REMOTE_PORT = 7311

/**
 * Remote defaults for a config written before the feature existed.
 *
 * The id and the code are generated once and then persisted for the life of the
 * install: an id that changed per launch would make every pairing on the other
 * device point at a machine that no longer exists, and a new code would lock it out.
 * Hosting itself starts off - an open port is something you turn on deliberately.
 */
export function defaultRemote(): RemoteConfig {
  return {
    host: false,
    port: DEFAULT_REMOTE_PORT,
    code: newCode(),
    name: deviceName(),
    id: randomBytes(8).toString('hex'),
    discoverable: true,
    peers: []
  }
}

function deviceName(): string {
  const raw = hostname().replace(/\.local$/i, '').trim()
  return (raw || (process.platform === 'darwin' ? 'Mac' : 'PC')).slice(0, 40)
}

function defaults(): Config {
  return {
    root: defaultRoot(),
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
    // Five minutes of a running turn printing NOTHING. Long enough that a slow test
    // suite or a big model round trip never trips it, short enough to catch the run
    // that died an hour ago while its clock kept ticking.
    silenceAlertMin: 5,
    bellAlert: true,
    discordPresence: true,
    discordClientId: '1533054088454082601',
    discordStyle: { ...DEFAULT_DISCORD_STYLE },
    clipboardShelf: true,
    clipboardOverlay: true,
    stashPeekMs: 5000,
    stashAutoCloseMs: 5000,
    stashMaxItems: 200,
    stashMaxImages: 24,
    stashFileHours: 24,
    stashMaxFileMb: 512,
    stashPos: null,
    grid: false,
    gridSizes: {},
    gridLayout: 'tiled',
    confirmClose: true,
    launchAtLogin: false,
    adminMode: false,
    autoUpdate: true,
    restoreAfterUpdate: true,
    restoreAfterRestart: 'ask',
    saveHistory: true,
    historyDays: 30,
    autoLane: true,
    voice: { enabled: true, model: 'base', language: 'auto' },
    // Off, and every other default chosen so that turning it on once changes as little as
    // possible: the pane's own agent, one question at most, balanced budget, no telemetry,
    // and no knowledge source configured until the user points at one.
    promptImprove: {
      mode: 'off',
      engine: '',
      model: '',
      clarify: 'minimal',
      optimise: 'balanced',
      capabilities: true,
      idleMs: 1200,
      vaultPath: '',
      indexScript: '',
      telemetry: false,
      telemetryText: false
    },
    // Empty list means "use the built-in one" (gameMode.ts owns it), so a default
    // config does not freeze today's game list into every user's settings file.
    gameMode: { enabled: true, processes: [], manual: false },
    swarmRoles: DEFAULT_ROLES,
    remote: defaultRemote(),
    theme: { ...DEFAULT_THEME },
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
      // Merged rather than replaced: a config written before this feature existed has the
      // key missing entirely, and an upgrade must land on `mode: 'off'` rather than on
      // `undefined`, which every read below would then have to guard.
      promptImprove: { ...base.promptImprove, ...(raw.promptImprove ?? {}) },
      // Same reason: every config written before the Discord tab existed has no
      // `discordStyle` at all, and `buildActivity` would then read `undefined.details`.
      discordStyle: { ...base.discordStyle, ...(raw.discordStyle ?? {}) },
      // Merged rather than replaced so an upgrade keeps this device's identity and
      // its pairings while gaining any key added since the file was written.
      remote: { ...base.remote, ...(raw.remote ?? {}), peers: raw.remote?.peers ?? [] },
      // An empty roles array in an old config would leave the swarm dialog blank.
      swarmRoles: raw.swarmRoles?.length ? raw.swarmRoles : base.swarmRoles,
      // Every config written before the Appearance tab existed has no theme at all, and a
      // missing `accent` reaches `paletteFor` as `undefined.trim()`. Merged, not replaced,
      // so a theme saved before a knob was added still gains that knob's default.
      theme: { ...base.theme!, ...(raw.theme ?? {}) },
      defaultModels: migrateModels(raw.defaultModels),
      discordClientId: migrateDiscordId(raw.discordClientId, base.discordClientId)
    }
  } catch {
    cache = base
  }
  return cache
}

/**
 * Rewrite model ids that no longer exist as separate models.
 *
 * `claude-opus-5[1m]` was listed beside `claude-opus-5` as if the 1M context window
 * were a different model to pick. It is not: plain Opus 5 already has it. Anyone who
 * picked the old id has it saved as their default for the claude agent, and without
 * this it keeps launching under a name the picker no longer shows.
 */
function migrateModels(saved?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...(saved ?? {}) }
  for (const [agent, model] of Object.entries(out)) {
    if (model === 'claude-opus-5[1m]') out[agent] = 'claude-opus-5'
  }
  return out
}

/**
 * The application whose NAME Discord prints above the presence.
 *
 * This shipped for months as a borrowed id - "Manic's Auction House", the author's own
 * Discord bot - because creating an application needs a portal login and a captcha. Every
 * user who ran PaneForge in that time has those 19 digits written into their config.json,
 * so changing the default alone reaches nobody who has ever launched the app: the saved
 * value wins the merge, forever, and they go on advertising a stranger's brand.
 *
 * Only the exact borrowed id is rewritten. Anyone who typed their own into Settings -
 * including anyone who deliberately points at a different application - keeps it, because
 * a saved value that is not the one we know to be wrong is a choice, not a leftover.
 */
const BORROWED_DISCORD_ID = '1494887437367771276'

export function migrateDiscordId(saved: string | undefined, fallback: string): string {
  if (!saved) return fallback
  return saved === BORROWED_DISCORD_ID ? fallback : saved
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
