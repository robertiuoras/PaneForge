// Lanes, for people who are not the person who built them.
//
// The lane system (scripts/lane.mjs) has always worked, and has always been switched on
// by hand: three hook entries typed into one machine's ~/.claude/settings.json, pointing
// at a script that lived in a private notes repo. So on that machine several chats could
// edit one project safely, and everywhere else - every other user, and this machine after
// a reinstall - the whole thing was simply off, with nothing to say so. Two chats shared
// one checkout, two `npm run build` runs wrote the same out/, and the first sign of it was
// an app that launched half-written.
//
// Two things had to be true for the app to do it itself, and now both are:
//
//   1. the engine ships. scripts/*.mjs is packaged as an extraResource, so an installed
//      copy has scripts/lane.mjs and scripts/lane-hook.mjs beside each other. The hook
//      resolves the engine as its own sibling, so it needs no checkout to exist anywhere.
//   2. the hooks install themselves, here, on every start - which also repoints them after
//      an upgrade moves the app.
//
// What this deliberately does NOT do is take over a machine that already has lane hooks
// wired by hand. Registering a second copy would claim a lane twice per prompt and release
// it twice at session end. A foreign registration wins and this stays out of the way.

import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { which } from './which'

/** Any lane hook at all, whoever installed it - our file name is a substring of the older
 * hand-wired one (`paneforge-lane-hook.mjs`) on purpose, so this finds both. */
const TAG = 'lane-hook.mjs'

/**
 * Marks the entries this file owns. It has to be part of the COMMAND, not the path: the
 * first version told ours apart by comparing paths, which works until the thing that
 * moves the path happens - an upgrade. Then our own stale entries read as somebody else's
 * wiring, the install backed off out of politeness, and lanes stayed off for good on
 * exactly the machines that had them working. Caught by scripts/lane-hooks-test.mjs.
 */
const OURS = '--installed-by=paneforge'

/** The three hooks the lane system needs, in the shape Claude Code reads them. */
const SPECS = [
  {
    event: 'UserPromptSubmit',
    matcher: undefined as string | undefined,
    arg: '--event=prompt',
    timeout: 30,
    statusMessage: 'Assigning lane...'
  },
  {
    event: 'PreToolUse',
    matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell',
    arg: '--event=pretool',
    timeout: 20,
    statusMessage: undefined as string | undefined
  },
  { event: 'SessionEnd', matcher: undefined, arg: '--event=end', timeout: 30, statusMessage: undefined },
  // The turn ended: park this chat's clean holds so a chat that needs one takes it in
  // minutes instead of waiting out the hour-long silence sweep.
  { event: 'Stop', matcher: undefined, arg: '--event=stop', timeout: 30, statusMessage: undefined }
]

/**
 * Where the shipped hook is. Packaged builds get it from resources/, a dev run from the
 * checkout - the same file either way, because packaging copies it rather than building it.
 */
export function hookScript(): string {
  const base = app.isPackaged ? process.resourcesPath : app.getAppPath()
  return join(base, 'scripts', 'lane-hook.mjs')
}

/** Claude Code's settings file for this user. */
function settingsPath(): string {
  return join(homedir(), '.claude', 'settings.json')
}

type Entry = { type: string; command: string; timeout?: number; statusMessage?: string; shell?: string }
type Group = { matcher?: string; hooks?: Entry[] }
export type Settings = { hooks?: Record<string, Group[]> } & Record<string, unknown>
export type HookSpec = { event: string; matcher?: string; arg: string; timeout: number; statusMessage?: string }

/** Every hook command already registered, whatever installed it. */
export function hookCommands(settings: Settings): string[] {
  const out: string[] = []
  for (const groups of Object.values(settings.hooks ?? {}))
    for (const g of groups ?? []) for (const h of g.hooks ?? []) if (typeof h.command === 'string') out.push(h.command)
  return out
}

/** Ours, wherever the app has since been moved to. */
export const isOurs = (command: string): boolean => command.includes(OURS)

/**
 * How a hook command starts the shipped script.
 *
 * `node` when it is on PATH. Claude Code's native installer does not bring Node, so a
 * machine without it runs the script on the app's own binary as Node
 * (ELECTRON_RUN_AS_NODE=1). Windows is the awkward one: hook commands run in Git Bash, and
 * in PowerShell when Git for Windows is not installed (https://code.claude.com/docs/en/hooks,
 * `shell` field) - and Git is optional for Claude Code there. `VAR=1 cmd` is bash only, so
 * the Windows fallback pins `shell: "powershell"`, which every Windows has. Proven on the
 * PC 2026-09-23 with powershell.exe and pwsh.exe: stdin reaches the script, the env var is
 * set, exit 2 survives, and a quote and a space in the path hold.
 *
 * Pure, so the test can ask for the Windows shape from a Mac.
 */
export type HookRunner = { line: (script: string, args: string[]) => string; shell?: 'powershell'; note: string }

export function runnerFor(platform: string, hasNode: boolean, execPath: string): HookRunner {
  const fwd = (p: string): string => p.replace(/\\/g, '/')
  const bare = (a: string): string => (/^[A-Za-z0-9_=.:\/-]+$/.test(a) ? a : `"${a}"`)
  if (hasNode)
    return { line: (script, args) => [`node "${fwd(script)}"`, ...args.map((a) => bare(fwd(a)))].join(' '), note: 'node' }
  if (platform === 'win32') {
    const sq = (a: string): string => `'${fwd(a).replace(/'/g, "''")}'`
    return {
      // `| Write-Output` is what makes PowerShell WAIT: the app is a GUI-subsystem exe, and
      // without a pipe PowerShell returns at once with $LASTEXITCODE unset - every exit 2
      // became 0 (measured on the PC 2026-09-23, electron.exe under both PowerShells).
      line: (script, args) => `$env:ELECTRON_RUN_AS_NODE='1'; & ${sq(execPath)} ${[script, ...args].map(sq).join(' ')} | Write-Output; exit $LASTEXITCODE`,
      shell: 'powershell',
      note: 'no node on PATH - hooks run on the app itself, in PowerShell'
    }
  }
  return {
    line: (script, args) => [`ELECTRON_RUN_AS_NODE=1 "${fwd(execPath)}" "${fwd(script)}"`, ...args.map((a) => bare(fwd(a)))].join(' '),
    note: 'no node on PATH - hooks run on the app itself'
  }
}

/** The runner for this machine, now. */
export function hookRunner(): HookRunner {
  const node = which('node')
  return runnerFor(process.platform, node !== 'node', process.execPath)
}

/** settings.json as an object, or the line saying why it is left alone. */
export function readSettings(label: string): { settings: Settings } | { refused: string } {
  const file = settingsPath()
  if (!existsSync(file)) return { settings: {} }
  let settings: Settings
  try {
    settings = JSON.parse(readFileSync(file, 'utf8')) as Settings
  } catch {
    // Hand-edited into invalid JSON. Rewriting it would throw the rest away.
    return { refused: `${label}: settings.json is not valid JSON - left alone` }
  }
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings))
    return { refused: `${label}: settings.json is not an object - left alone` }
  return { settings }
}

/**
 * Put `specs` in place for the script named `tag`, repointing our own older entries FOR
 * THAT SCRIPT only - two installers share the `--installed-by` marker and a Stop group, and
 * a filter on the marker alone had each one delete the other's entry on every start.
 * Returns whether anything changed.
 */
export function placeHooks(settings: Settings, tag: string, specs: HookSpec[], commandFor: (spec: HookSpec) => string, shell?: string): boolean {
  settings.hooks ??= {}
  let changed = false
  const mine = (h: Entry): boolean => isOurs(h.command ?? '') && (h.command ?? '').includes(tag)
  for (const spec of specs) {
    const command = commandFor(spec)
    const same = (h: Entry): boolean => h.command === command && h.shell === shell
    const groups = (settings.hooks[spec.event] ??= [])

    // Drop our own previous entries wherever they sit, so a moved app repoints instead of
    // stacking a second copy on every upgrade.
    for (const g of groups) {
      const before = g.hooks?.length ?? 0
      if (g.hooks) g.hooks = g.hooks.filter((h) => !mine(h) || (same(h) && g.matcher === spec.matcher))
      if ((g.hooks?.length ?? 0) !== before) changed = true
    }

    const already = groups.some((g) => (g.hooks ?? []).some((h) => same(h) && g.matcher === spec.matcher))
    if (already) continue

    const entry: Entry = { type: 'command', command, timeout: spec.timeout }
    if (shell) entry.shell = shell
    if (spec.statusMessage) entry.statusMessage = spec.statusMessage

    // Join the group with the same matcher rather than making a second one - Claude Code
    // runs both, but a settings file that grows a group per launch is unreadable.
    const group = groups.find((g) => g.matcher === spec.matcher)
    if (group) (group.hooks ??= []).push(entry)
    else groups.push(spec.matcher ? { matcher: spec.matcher, hooks: [entry] } : { hooks: [entry] })
    changed = true
  }

  // Empty groups left by the filter above are noise in a file the user reads.
  for (const [event, groups] of Object.entries(settings.hooks))
    settings.hooks[event] = (groups ?? []).filter((g) => (g.hooks?.length ?? 0) > 0)
  return changed
}

/** Write then rename: a half-written settings.json disables every hook on the machine. */
export function writeSettings(label: string, settings: Settings): string | null {
  const file = settingsPath()
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.paneforge-tmp`
    writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf8')
    renameSync(tmp, file)
    return null
  } catch (e) {
    return `${label}: could not write settings.json (${(e as Error).message})`
  }
}

/** Every lane-hook command already registered, whatever installed it. */
function registered(settings: Settings): string[] {
  return hookCommands(settings).filter((c) => c.includes(TAG))
}

/**
 * Put the three hooks in place, or explain why not. Never throws: a bad settings file is
 * the user's, and breaking the app over it would be a worse bug than lanes being off.
 *
 * `stable` is true only for the installed app (packaged, no test profile). A dev or `npm
 * run try` copy resolves hookScript() inside the checkout it was built in, and that is
 * usually a lane folder: on 2026-09-23 every Claude session on the Mac ran its hooks from
 * PaneForge-d/scripts, so a sweep of that folder, or a half-saved edit in it, would have
 * broken every chat at once. Such a copy never writes; the installed app's next start
 * puts the entries back on its own resources/ path, which only an update changes.
 *
 * Returns a line worth logging - callers log it, this stays quiet on its own.
 */
export function installLaneHooks(stable: boolean): string {
  if (process.env.PANEFORGE_NO_LANE_HOOKS) return 'lane hooks: skipped (PANEFORGE_NO_LANE_HOOKS)'
  if (!stable) return 'lane hooks: skipped - a dev or test copy never rewires the machine'

  const script = hookScript()
  if (!existsSync(script)) return `lane hooks: not installed - no ${TAG} at ${script}`

  const read = readSettings('lane hooks')
  if ('refused' in read) return read.refused
  const settings = read.settings

  // Someone else's registration owns this machine. Adding ours would double every claim
  // and every release; the existing one already does the job.
  const foreign = registered(settings).filter((c) => !isOurs(c))
  if (foreign.length) return `lane hooks: already wired elsewhere (${foreign.length}) - left alone`

  const runner = hookRunner()
  const changed = placeHooks(settings, TAG, SPECS, (spec) => runner.line(script, [spec.arg, OURS]), runner.shell)
  if (!changed) return 'lane hooks: already installed'
  const failed = writeSettings('lane hooks', settings)
  if (failed) return failed
  return `lane hooks: installed -> ${script} (${runner.note})`
}
