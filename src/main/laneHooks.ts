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
  { event: 'SessionEnd', matcher: undefined, arg: '--event=end', timeout: 30, statusMessage: undefined }
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

type Entry = { type: string; command: string; timeout?: number; statusMessage?: string }
type Group = { matcher?: string; hooks?: Entry[] }
type Settings = { hooks?: Record<string, Group[]> } & Record<string, unknown>

/** Every lane-hook command already registered, whatever installed it. */
function registered(settings: Settings): string[] {
  const out: string[] = []
  for (const groups of Object.values(settings.hooks ?? {}))
    for (const g of groups ?? []) for (const h of g.hooks ?? []) if (h.command?.includes(TAG)) out.push(h.command)
  return out
}

/** Ours, wherever the app has since been moved to. */
const isOurs = (command: string): boolean => command.includes(OURS)

/**
 * Put the three hooks in place, or explain why not. Never throws: a bad settings file is
 * the user's, and breaking the app over it would be a worse bug than lanes being off.
 *
 * Returns a line worth logging - callers log it, this stays quiet on its own.
 */
export function installLaneHooks(): string {
  if (process.env.PANEFORGE_NO_LANE_HOOKS) return 'lane hooks: skipped (PANEFORGE_NO_LANE_HOOKS)'

  const script = hookScript()
  if (!existsSync(script)) return `lane hooks: not installed - no ${TAG} at ${script}`

  const file = settingsPath()
  let settings: Settings = {}
  if (existsSync(file)) {
    try {
      settings = JSON.parse(readFileSync(file, 'utf8')) as Settings
    } catch {
      // Hand-edited into invalid JSON. Rewriting it would throw the rest away.
      return 'lane hooks: settings.json is not valid JSON - left alone'
    }
    if (typeof settings !== 'object' || settings === null) return 'lane hooks: settings.json is not an object - left alone'
  }

  // Someone else's registration owns this machine. Adding ours would double every claim
  // and every release; the existing one already does the job.
  const foreign = registered(settings).filter((c) => !isOurs(c))
  if (foreign.length) return `lane hooks: already wired elsewhere (${foreign.length}) - left alone`

  settings.hooks ??= {}
  let changed = false

  for (const spec of SPECS) {
    const command = `node "${script.replace(/\\/g, '/')}" ${spec.arg} ${OURS}`
    const groups = (settings.hooks[spec.event] ??= [])

    // Drop our own previous entries wherever they sit, so a moved app repoints instead of
    // stacking a second copy on every upgrade.
    for (const g of groups) {
      const before = g.hooks?.length ?? 0
      if (g.hooks) g.hooks = g.hooks.filter((h) => !isOurs(h.command ?? '') || h.command === command)
      if ((g.hooks?.length ?? 0) !== before) changed = true
    }

    const already = groups.some((g) => (g.hooks ?? []).some((h) => h.command === command && g.matcher === spec.matcher))
    if (already) continue

    const entry: Entry = { type: 'command', command, timeout: spec.timeout }
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

  if (!changed) return 'lane hooks: already installed'

  try {
    mkdirSync(dirname(file), { recursive: true })
    // Write then rename: a half-written settings.json disables every hook on the machine,
    // including the ones that have nothing to do with lanes.
    const tmp = `${file}.paneforge-tmp`
    writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf8')
    renameSync(tmp, file)
  } catch (e) {
    return `lane hooks: could not write settings.json (${(e as Error).message})`
  }
  return `lane hooks: installed -> ${script}`
}
