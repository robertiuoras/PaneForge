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
import { DEFAULT_AUTO_HANDOFF } from '../shared/autoHandoff'
import { DEFAULT_MASCOT } from '../shared/mascot'
import { DEFAULT_TIPS } from '../shared/tips'
import { DEFAULT_RECLAIM } from '../shared/reclaim'
import { DEFAULT_AUTO_ANSWER, type AutoAnswerConfig } from '../shared/autoAnswer'
import { DEFAULT_RECOVER } from '../shared/recover'
import { DEFAULT_SOUNDS } from '../shared/sounds'
import { DEFAULT_THEME } from '../shared/theme'
// wire.ts is pure crypto with no config import of its own, so the code generator can
// live where the protocol does without the two files importing each other.
import { newCode } from './remote/wire'
// Same reason: phone.ts is a plain HTTP server with no config import of its own.
import { newPhoneCode } from './phone'

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

/** The port the phone client is served on. Not 7311: that one speaks its own protocol. */
export const DEFAULT_PHONE_PORT = 7312

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
    // On, and what it grants is only the right to put a card on this screen: a request is
    // refused until somebody presses Approve, and approving means comparing six digits.
    pairByAsking: true,
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
    openrouterKey: '',
    providerKeys: {},
    fontSize: 13,
    copyOnSelect: true,
    clickMovesCursor: true,
    mouseSelect: true,
    autoFixUi: true,
    notifyOnIdle: true,
    soundOnIdle: true,
    // Silent with no credentials on the machine, so this default sends nothing anywhere it
    // was not already set up to send.
    telegramAsk: true,
    // Five minutes of a running turn printing NOTHING. Long enough that a slow test
    // suite or a big model round trip never trips it, short enough to catch the run
    // that died an hour ago while its clock kept ticking.
    silenceAlertMin: 5,
    bellAlert: true,
    sounds: { ...DEFAULT_SOUNDS, custom: [] },
    hiddenBlurbs: [],
    discordPresence: true,
    discordStyle: { ...DEFAULT_DISCORD_STYLE },
    clipboardShelf: true,
    clipboardOverlay: true,
    stashSummon: true,
    // 0: a copy lands on the Stash silently. The panel popping open for every copy was
    // the single most repeated complaint about it - "still really annoying" - and the
    // panel can be left open (pinned) by anyone who wants to watch copies arrive.
    stashPeekMs: 0,
    stashAutoCloseMs: 5000,
    stashMaxItems: 200,
    stashMaxImages: 24,
    stashFileHours: 24,
    stashMaxFileMb: 512,
    stashDeny: '',
    stashPos: null,
    stashSize: null,
    grid: false,
    gridSizes: {},
    gridLayout: 'tiled',
    // Off: the x closes the pane on the press. Closing one pane is not the dangerous
    // half - the conversation stays in history and `--resume` brings it back - and a
    // dialog in front of every close costs a click each time to prevent a mistake that
    // is already undoable. Closing them ALL still asks, and the switch is still there
    // for anyone who wants the question back.
    confirmClose: false,
    launchAtLogin: false,
    // Windows only, and on by default: the Desktop shortcut is the only thing on this desk
    // that opens PaneForge, so a launch that finds it missing puts it back. Off means "I
    // deleted it on purpose" - see src/shared/winShortcut.ts for what deletes it.
    desktopShortcut: true,
    adminMode: false,
    autoUpdate: true,
    // Stable channel. Every automatic release is cut as a GitHub prerelease first, and
    // an install only moves when one is promoted - so a broken build is a dev-channel
    // event, fixed by the next release, and never lands here unasked. Flipping this on
    // makes THIS install the dev copy that takes every build the moment it is cut.
    devUpdates: false,
    restoreAfterUpdate: true,
    askAfterUpdate: false,
    restoreAfterRestart: 'ask',
    saveHistory: true,
    historyDays: 30,
    autoLane: true,
    // On, because the alternative is thrashing: the capacity verdict only asks for this
    // once panes here already cost more than the machine has, and the launch says out
    // loud where the pane went. Off keeps every pane local whatever the machine is doing.
    offloadWhenFull: true,
    // Ask rather than move. See the field's note in shared/types.ts: the machine knows it
    // is full, it does not know that this pane is the one being worked in.
    // ON. It was moved to off on the reasoning that a local-pane budget IS the answer,
    // given once - which is true about the budget and false about the launch somebody is
    // making right now. Measured against the report that produced this: opening a session
    // on the laptop started it on the PC every time, with no way to say no in the moment,
    // and the only route back was a switch on a Settings page nobody knows to look at. A
    // silent move of the pane a person is opening reads as the app being broken, and the
    // cost of asking is one press remembered for ten minutes.
    offloadAsk: true,
    // `small` and `en`, not `base` and `auto`, both measured 2026-08-17 on an 11.9 s clip
    // through `whisper-ctranslate2` (int8, warm weights): `small` returned the sentence
    // verbatim with correct punctuation in 5.2 s, `base` dropped a word ("it so
    // inefficient") and emitted no terminal punctuation at all - which is the stray-`?`
    // and missing-full-stop complaint. `auto` also spends a language-detection pass on
    // every clip and can mis-detect on an accent; dictation here is always English.
    voice: { enabled: true, model: 'small', language: 'en', engine: 'auto' },
    // On, unlike promptImprove: this one spends nothing and starts nothing. No archive is
    // configured by default - the app's own history is what it runs on, and a second one is
    // only worth naming if the person already has prompts written down somewhere else.
    promptRecall: { enabled: true, extraArchives: [] },
    // On: it costs nothing until a turn is actually cut in half, it only ever fires on a
    // pane that is idle with an unfinished answer on it, and it stops after three in a row.
    // Off by default would ship a feature whose entire value is that nobody has to notice.
    recover: DEFAULT_RECOVER,
    // On, with a five-second countdown on the pane naming the option it is about to press.
    // The refusals are what make that safe: one plainly-yes option and nothing else, never
    // one that widens permission, never one that stops. Settings turns it off in one line.
    autoAnswer: DEFAULT_AUTO_ANSWER,
    // On, but it only ever acts on a machine the kernel says is out of memory, and never on
    // a pane that is working or waiting for a person. Closing keeps the History row, the
    // resume id and the scrollback, so it is a pane minimised rather than work thrown away.
    mascot: DEFAULT_MASCOT,
    tips: DEFAULT_TIPS,
    reclaim: DEFAULT_RECLAIM,
    autoHandoff: DEFAULT_AUTO_HANDOFF,
    // Off by default. Quitting the app takes every pane with it, so it ships as a number
    // somebody has to set rather than a behaviour that arrives with an update.
    idleQuitMinutes: 0,
    // Empty list means "use the built-in one" (gameMode.ts owns it), so a default
    // config does not freeze today's game list into every user's settings file.
    gameMode: { enabled: true, processes: [], manual: false },
    swarmRoles: DEFAULT_ROLES,
    remote: defaultRemote(),
    // Off, and it stays off until Settings says otherwise: serving the UI over HTTP hands
    // a browser a pane, and a pane runs commands on this machine.
    // `ask: true` is the ordinary way in and costs nothing while `on` is false: a browser
    // asking raises a card that grants nothing until somebody here presses Approve.
    // `typeGate` defaults ON. It costs nothing on a desk that never leaves the LAN - it is
    // armed only over TLS - so the only install it changes is one with a public address,
    // which is exactly the one that should have it.
    phone: {
      on: false,
      port: DEFAULT_PHONE_PORT,
      code: newPhoneCode(),
      devices: [],
      ask: true,
      typeGate: true,
      keys: []
    },
    theme: { ...DEFAULT_THEME },
    window: { width: 1500, height: 940, maximized: false }
  }
}

export function getConfig(): Config {
  if (cache) return cache
  const base = defaults()
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as Partial<Config>
    dropSavedDiscordId(raw as Record<string, unknown>)
    // Shallow merge only: a config written by an older version is missing whole
    // keys, and a nested merge would resurrect stale window bounds anyway.
    cache = {
      ...base,
      ...raw,
      // The one-time move BACK onto "ask before moving a pane", same shape as
      // `migrateAutoAnswer` and for the same reason: `defaults()` is WRITTEN at first
      // launch, so every config in existence carries `offloadAsk` explicitly and a flip in
      // the default alone would be read as somebody's own choice and never applied. Read
      // off the SAVED config, never off the merge, or the marker is set for everybody and
      // this runs on nothing. V2 - which forced it OFF - is superseded and must not also
      // run on the way here, or a config that never saw it is turned off and on in one
      // load. After V3, off stays off and on stays on.
      ...(raw.offloadDefaultsV3
        ? {}
        : { offloadAsk: true, offloadDefaultsV2: true, offloadDefaultsV3: true }),
      window: { ...base.window, ...(raw.window ?? {}) },
      voice: { ...base.voice, ...(raw.voice ?? {}) },
      promptRecall: { ...base.promptRecall, ...(raw.promptRecall ?? {}) },
      recover: { ...DEFAULT_RECOVER, ...(base.recover ?? {}), ...(raw.recover ?? {}) },
      autoAnswer: migrateAutoAnswer(base.autoAnswer, raw.autoAnswer),
      mascot: { ...DEFAULT_MASCOT, ...(base.mascot ?? {}), ...(raw.mascot ?? {}) },
      tips: { ...DEFAULT_TIPS, ...(base.tips ?? {}), ...(raw.tips ?? {}) },
      reclaim: { ...DEFAULT_RECLAIM, ...(base.reclaim ?? {}), ...(raw.reclaim ?? {}) },
      autoHandoff: {
        ...DEFAULT_AUTO_HANDOFF,
        ...(base.autoHandoff ?? {}),
        ...(raw.autoHandoff ?? {})
      },
      // Same reason: every config written before the Discord tab existed has no
      // `discordStyle` at all, and `buildActivity` would then read `undefined.details`.
      discordStyle: { ...base.discordStyle, ...(raw.discordStyle ?? {}) },
      // Merged so a config from before the sound picker existed lands on the three
      // sounds the app has always made, rather than on `undefined` and silence. The
      // uploads list is taken as-is: an empty one is a real answer, not a missing key.
      sounds: { ...base.sounds, ...(raw.sounds ?? {}), custom: raw.sounds?.custom ?? [] },
      // Merged rather than replaced so an upgrade keeps this device's identity and
      // its pairings while gaining any key added since the file was written.
      remote: { ...base.remote, ...(raw.remote ?? {}), peers: raw.remote?.peers ?? [] },
      // Merged, so an upgrade keeps the code a phone is already paired with rather than
      // rotating it - a new code signs every phone out, and nobody asked for that.
      phone: { ...base.phone!, ...(raw.phone ?? {}) },
      // An empty roles array in an old config would leave the swarm dialog blank.
      swarmRoles: raw.swarmRoles?.length ? raw.swarmRoles : base.swarmRoles,
      // Every config written before the Appearance tab existed has no theme at all, and a
      // missing `accent` reaches `paletteFor` as `undefined.trim()`. Merged, not replaced,
      // so a theme saved before a knob was added still gains that knob's default.
      theme: { ...base.theme!, ...(raw.theme ?? {}) },
      defaultModels: migrateModels(raw.defaultModels),
      providerKeys: migrateKeys(raw)
    }
  } catch {
    cache = base
  }
  return cache
}

/**
 * The provider keys, with the one that used to have a field of its own folded in.
 *
 * `openrouterKey` was a top-level string before there was more than one provider to
 * hold a key for. It is still written by every config on disk, and by an older build
 * anybody rolls back to, so it is read here rather than deleted - and `setConfig`
 * writes it back, which is what keeps a downgrade from losing the key silently. The
 * record wins when both carry something: it is the one the UI edits.
 */
/**
 * The one-time move onto autoAnswer's new defaults.
 *
 * A changed default cannot reach an existing desk on its own: `defaults()` is WRITTEN to
 * config.json at first launch, so every install carries `enabled: false` explicitly and a
 * flip in `DEFAULT_AUTO_ANSWER` would be read as somebody's own choice. `defaultsV2` is the
 * marker that separates the two, and it is applied once - after this, off stays off.
 */
function migrateAutoAnswer(
  base: AutoAnswerConfig | undefined,
  raw: AutoAnswerConfig | undefined
): AutoAnswerConfig {
  const merged: AutoAnswerConfig = { ...DEFAULT_AUTO_ANSWER, ...(base ?? {}), ...(raw ?? {}) }
  // The marker is read off the SAVED config, never off the merged one: `DEFAULT_AUTO_ANSWER`
  // carries it (so a config written from here already has it), and asking the merge whether
  // it is set therefore answers yes for every config in existence - which is how the first
  // version of this ran the migration on nothing at all and left this desk exactly as it was.
  if (raw?.defaultsV2) return merged
  merged.enabled = DEFAULT_AUTO_ANSWER.enabled
  // Only the wait nobody could have chosen: there was no control for it before this, so
  // the old default is a value written by the app and is safe to move. Anything else is a
  // number somebody typed.
  if (merged.waitMs === 1200) merged.waitMs = DEFAULT_AUTO_ANSWER.waitMs
  merged.defaultsV2 = true
  return merged
}

function migrateKeys(raw: Partial<Config>): Record<string, string> {
  const out: Record<string, string> = { ...(raw.providerKeys ?? {}) }
  if (!out.openrouter?.trim() && raw.openrouterKey?.trim()) out.openrouter = raw.openrouterKey.trim()
  return out
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
 * Forget any Discord application id a previous version wrote down.
 *
 * The id was a settings field for a while, and a saved value wins the merge forever - so
 * a config from the borrowed-application months ("Manic's Auction House", the author's
 * own bot) went on printing a stranger's brand, and a config where somebody had cleared
 * the field or fat-fingered a digit went on sending a presence Discord had nothing to
 * resolve. Both are silent: the profile simply shows nothing and nobody is told.
 *
 * `DISCORD_APP_ID` is the identity now, so the saved key is not migrated, it is DELETED -
 * left in place it would sit in config.json looking like a live setting for years.
 */
function dropSavedDiscordId(raw: Record<string, unknown>): void {
  delete raw.discordClientId
}

export function setConfig(patch: Partial<Config>): Config {
  const next = { ...getConfig(), ...patch }
  // The deprecated single field is kept in step with the record it became, so a build
  // rolled back to before `providerKeys` existed still finds the OpenRouter key where
  // it looks for it. One line, in the one place a key can change.
  next.openrouterKey = next.providerKeys?.openrouter ?? ''
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
