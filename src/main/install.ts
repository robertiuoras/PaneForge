// One-click installs. The rule for this app is that nothing should require the
// user to open a terminal and paste a command, so every "not installed" agent
// gets a button that runs its install line here and streams the output back into
// a panel in Settings.
//
// The command runs through a pty rather than child_process because installers
// print progress bars and colour, and some (winget, pip) prompt; a real terminal
// keeps all of that working and lets the user watch it.

import { spawn } from 'node:child_process'
import * as pty from '@lydell/node-pty'
import { which } from './which'
import { prereqDocs, prereqFor, prereqInstall } from '../shared/agents'
import { spawnQuiet } from './spawnQuiet'

export interface RunHandle {
  /** kill the running install */
  cancel: () => void
}

/**
 * Installs that are still running.
 *
 * Nothing holds the handle these return - both callers await the promise and drop it -
 * so without this list an install survives the app that started it. Its output goes to a
 * renderer that no longer exists, its progress is unwatchable, and what is left on the
 * machine is a `powershell -Command "npm i -g ..."` nobody can see or stop. Closing the
 * window is meant to close everything.
 */
const running = new Set<pty.IPty>()
// Quitting is not an install result. node-pty reports a clean exit code for a shell that
// received SIGHUP on macOS, so remember the app stopped it before its exit handler runs.
const stopped = new WeakSet<pty.IPty>()

/** Shell that can run a one-liner containing pipes and &&, per platform. */
function shellFor(command: string): { bin: string; args: string[] } {
  if (process.platform === 'win32') {
    return { bin: which('powershell'), args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command] }
  }
  // Login shell: brew and pipx land in PATH entries only a login shell sources.
  return { bin: which('bash'), args: ['-lc', command] }
}

/**
 * Run one install command, streaming its terminal output. `onDone` fires with the
 * exit code once, and never fires after a cancel.
 */
export function runCommand(
  command: string,
  onData: (chunk: string) => void,
  onDone: (code: number) => void
): RunHandle {
  let finished = false
  let proc: pty.IPty
  try {
    const { bin, args } = shellFor(command)
    proc = pty.spawn(bin, args, {
      name: 'xterm-256color',
      cols: 100,
      rows: 24,
      cwd: process.env.HOME ?? process.env.USERPROFILE ?? process.cwd(),
      env: cleanEnv()
    })
  } catch (e) {
    onData(`\r\nCould not start a shell: ${String(e)}\r\n`)
    onDone(1)
    return { cancel: () => undefined }
  }

  running.add(proc)
  proc.onData(onData)
  proc.onExit(({ exitCode }) => {
    running.delete(proc)
    if (finished || stopped.has(proc)) return
    finished = true
    onDone(exitCode)
  })

  return {
    cancel: () => {
      finished = true
      running.delete(proc)
      try {
        proc.kill()
      } catch {
        /* already gone */
      }
    }
  }
}

/** The same run, awaited. Resolves with the exit code; never rejects. */
export function runOnce(command: string, onData: (chunk: string) => void): Promise<number> {
  return new Promise((resolve) => {
    runCommand(command, onData, resolve)
  })
}

/**
 * Stop every install still going, process tree and all. Called on the way out, beside
 * the pane teardown it mirrors.
 *
 * The tree is the point: the pty is a shell, and the thing actually downloading is npm or
 * winget two processes below it. ConPTY's own kill returns before anything has died and
 * the app does not wait around afterwards, so on Windows the taskkill is what makes this
 * true rather than merely asked for.
 */
export function stopInstalls(): void {
  const live = [...running]
  running.clear()
  if (!live.length) return
  if (process.platform === 'win32') {
    const args = live
      .map((p) => p.pid)
      .filter((pid) => typeof pid === 'number' && pid > 0)
      .flatMap((pid) => ['/PID', String(pid)])
    if (args.length) {
      // No taskkill on PATH - the kill below is still the real one. It is `spawnQuiet`
      // because a spawn that cannot start says so with an EVENT, so the try/catch this
      // replaces caught nothing and the miss it named would have crashed main.
      spawnQuiet(
        'taskkill',
        ['/F', '/T', ...args],
        { detached: true, stdio: 'ignore', windowsHide: true },
        'install taskkill'
      )
    }
  }
  for (const p of live) {
    stopped.add(p)
    try {
      p.kill()
    } catch {
      /* already gone */
    }
  }
}

/**
 * A freshly installed CLI usually lands in a folder that was already on PATH when
 * this process started (npm's global bin, ~/.local/bin), so re-scanning works. But
 * a brand new folder - the one winget or a first-ever npm -g creates - is only on
 * the PATH of *new* processes. Re-read the machine and user PATH from the registry
 * so the app sees it without a restart.
 */
export function refreshPath(): void {
  if (process.platform !== 'win32') {
    // Common install targets that a GUI-launched app misses.
    for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', `${process.env.HOME}/.local/bin`]) {
      if (!process.env.PATH?.split(':').includes(dir)) process.env.PATH = `${process.env.PATH}:${dir}`
    }
    return
  }
  try {
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process')
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"
      ],
      { encoding: 'utf8', windowsHide: true }
    ).trim()
    const seen = new Set((process.env.PATH ?? '').split(';').map((p) => p.toLowerCase()))
    const extra = out.split(';').filter((p) => p && !seen.has(p.toLowerCase()))
    if (extra.length) process.env.PATH = `${process.env.PATH};${extra.join(';')}`
  } catch {
    /* registry read failed - the user can still restart the app */
  }
}

/** Is this executable on PATH right now? `which` returns the input when it is not. */
export function onPath(bin: string): boolean {
  return which(bin) !== bin
}

/**
 * Make sure the toolchain an install line needs actually exists, installing it first
 * when it does not.
 *
 * Most of the catalogue is `npm i -g`, so a Windows machine with no Node could install
 * none of it: the console printed `npm is not recognized` and stopped, which tells a
 * person who is not a developer nothing they can act on. The button is meant to be the
 * whole answer, so it installs Node too.
 *
 * Returns false when the prerequisite is still missing afterwards - the caller stops
 * rather than running a command that cannot work.
 */
export async function ensurePrereq(
  command: string,
  say: (chunk: string) => void,
  platform: string = process.platform
): Promise<boolean> {
  const need = prereqFor(command)
  if (!need || onPath(need.bin)) return true

  const label = need.need === 'node' ? 'Node.js' : 'Python'
  const boot = prereqInstall(need.need, platform)
  // No scripted bootstrap (Linux, where the right package manager is anyone's guess),
  // or no winget on an older Windows: name the one thing to install, and where from.
  if (!boot || (platform === 'win32' && !onPath('winget'))) {
    say(
      `\r\nThis needs ${label}, and it is not on this machine.\r\n` +
        `Install it from ${prereqDocs(need.need)}, then reopen PaneForge and press Install again.\r\n`
    )
    return false
  }

  say(`${label} is needed first and is not installed. Getting it.\r\n> ${boot}\r\n\r\n`)
  const code = await runOnce(boot, say)
  // winget lands Node in a folder that is only on the PATH of new processes.
  refreshPath()
  if (!onPath(need.bin)) {
    say(
      `\r\nCould not install ${label} automatically (exit code ${code}).\r\n` +
        `Install it from ${prereqDocs(need.need)}, then press Install again.\r\n`
    )
    return false
  }
  say(`\r\n${label} is ready. Continuing.\r\n\r\n`)
  return true
}

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (k === 'ELECTRON_RUN_AS_NODE' || k.startsWith('ELECTRON_')) continue
    env[k] = v
  }
  env.TERM = 'xterm-256color'
  // npm prints a progress bar that redraws badly in a 24-row scrollback panel.
  env.npm_config_progress = 'false'
  return env
}
