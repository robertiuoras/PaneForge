// Auto-clear, for people who are not the person who built it.
//
// The clear itself has always been the app's (countdown card, `/clear`, resume prompt), but
// the decision to ask for one came from a Stop hook in a private notes repo, so on every
// other machine the feature was silently off. scripts/autoclear-hook.mjs is that hook,
// shipped; this puts it in ~/.claude/settings.json the way `laneHooks.ts` does its own:
// tagged `--installed-by=paneforge`, repointed after an upgrade, installed app only,
// never throwing, an unparseable file left alone.
//
// A machine that already runs an autoclear of its own (the owner's claude-config Stop
// hook, its stop-runner, its handoff injector) is left alone: two of them would ask twice
// and clear twice.

import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { hookCommands, hookRunner, isOurs, placeHooks, readSettings, writeSettings, type HookSpec } from './laneHooks'

const TAG = 'autoclear-hook.mjs'
const OURS = '--installed-by=paneforge'
const LABEL = 'autoclear hooks'

/** Somebody else's autoclear already on this machine. */
const FOREIGN = /autoclear|stop-runner|handoff-inject/i

const SPECS: HookSpec[] = [
  { event: 'Stop', arg: '--event=stop', timeout: 30 },
  { event: 'SessionStart', arg: '--event=start', timeout: 15 }
]

function hookScript(): string {
  const base = app.isPackaged ? process.resourcesPath : app.getAppPath()
  return join(base, 'scripts', TAG)
}

/**
 * Put the Stop and SessionStart hooks in place, or say why not. `stable` means what it
 * means for `installLaneHooks`: only the installed app writes, since a dev copy's script
 * path is a checkout that can vanish. Returns a line for the caller to log.
 */
export function installAutoClearHooks(stable: boolean): string {
  if (process.env.PANEFORGE_NO_LANE_HOOKS) return `${LABEL}: skipped (PANEFORGE_NO_LANE_HOOKS)`
  if (!stable) return `${LABEL}: skipped - a dev or test copy never rewires the machine`

  const script = hookScript()
  if (!existsSync(script)) return `${LABEL}: not installed - no ${TAG} at ${script}`

  const read = readSettings(LABEL)
  if ('refused' in read) return read.refused
  const settings = read.settings

  const foreign = hookCommands(settings).filter((c) => !isOurs(c) && FOREIGN.test(c))
  if (foreign.length) return `${LABEL}: this machine runs its own autoclear (${foreign.length}) - left alone`

  let userData: string
  try {
    userData = app.getPath('userData')
  } catch (e) {
    return `${LABEL}: no userData folder (${(e as Error).message})`
  }

  const runner = hookRunner()
  const changed = placeHooks(settings, TAG, SPECS, (spec) => runner.line(script, [spec.arg, `--user-data=${userData}`, OURS]), runner.shell)
  if (!changed) return `${LABEL}: already installed`
  const failed = writeSettings(LABEL, settings)
  if (failed) return failed
  return `${LABEL}: installed -> ${script} (${runner.note})`
}
