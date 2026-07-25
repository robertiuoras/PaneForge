// One-click installs. The rule for this app is that nothing should require the
// user to open a terminal and paste a command, so every "not installed" agent
// gets a button that runs its install line here and streams the output back into
// a panel in Settings.
//
// The command runs through a pty rather than child_process because installers
// print progress bars and colour, and some (winget, pip) prompt; a real terminal
// keeps all of that working and lets the user watch it.

import * as pty from '@lydell/node-pty'
import { which } from './which'

export interface RunHandle {
  /** kill the running install */
  cancel: () => void
}

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

  proc.onData(onData)
  proc.onExit(({ exitCode }) => {
    if (finished) return
    finished = true
    onDone(exitCode)
  })

  return {
    cancel: () => {
      finished = true
      try {
        proc.kill()
      } catch {
        /* already gone */
      }
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
