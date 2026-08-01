// The console hosts that survive the app.
//
// Every ConPTY pane is drawn by a `conhost.exe --headless` that Windows spawns as a
// CHILD OF THIS PROCESS, not of the agent. shutdown() kills the agent process trees -
// `taskkill /F /T` on each pty's pid - and that is the part that matters for locks and
// for the installer. It cannot reach the console hosts: they are siblings of the agents,
// not descendants, so nothing in that sweep names them.
//
// Normally they notice their pipes close and leave with us. Sometimes one does not:
// ClosePseudoConsole is asked to finish while nobody is draining the conout pipe, and
// hardExit() does not wait to find out. What is left is a headless conhost with a dead
// parent, holding a handle on the folder its pane was opened in - which is precisely the
// EBUSY that stopped the checkout rename for two days, on a machine where no process had
// that folder as its working directory.
//
// So the app names them itself. Every launch writes its own pid down; the next launch
// kills any headless conhost still parented to a pid that is gone, and quitting fires the
// same sweep for this run's pid a moment after we exit. Both are one detached PowerShell
// that runs when this process no longer exists, and both refuse to touch a console whose
// parent is still alive - that is somebody else's terminal, or a PaneForge still running.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'

/** Enough history to cover the runs a crash loop leaves behind, and no more. */
export const MAX_REMEMBERED = 24

/**
 * The pid list this launch should keep, given what the last launches wrote.
 *
 * Pure so it can be tested: the file is the only part that needs Electron.
 */
export function rollPids(previous: number[], pid: number): number[] {
  const clean = previous.filter((p) => Number.isInteger(p) && p > 0 && p !== pid)
  return [...clean, pid].slice(-MAX_REMEMBERED)
}

/**
 * The sweep, as PowerShell. Kept as a function of the pid list so a test can read what
 * would run without a Windows box and without killing anything.
 *
 * Three conditions, all required: it is a console host, its parent is one of ours, and
 * that parent is gone. The last one is what makes this safe against pid reuse - if the
 * number has been handed to a live process, its console is that process's business.
 */
export function reapScript(pids: number[], delayMs: number): string {
  return [
    `Start-Sleep -Milliseconds ${Math.max(0, Math.round(delayMs))}`,
    `$own = @(${pids.join(',')})`,
    // The sweep now reaches its shell through a wrapper (see spawnDetachedNoWindow),
    // so its own console host could one day match the kill conditions - our pid as
    // parent, parent gone, headless. Killing that drops this script's console mid-run,
    // so whatever this PowerShell sits under - its direct parent - is exempt by pid.
    '$me = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID" -ErrorAction SilentlyContinue).ParentProcessId',
    '$live = @((Get-Process -ErrorAction SilentlyContinue).Id)',
    "Get-CimInstance Win32_Process -Filter \"Name='conhost.exe'\" -ErrorAction SilentlyContinue |",
    '  Where-Object { $_.ProcessId -ne $me -and $own -contains $_.ParentProcessId -and $live -notcontains $_.ParentProcessId -and $_.CommandLine -like "*--headless*" } |',
    '  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'
  ].join('\n')
}

// What wscript runs for spawnDetachedNoWindow. WScript.Shell.Run with window style 0
// gives the child real SW_HIDE semantics, and wscript.exe itself is a GUI binary, so no
// layer of the chain ever owns a console window. Arguments are quote-wrapped, so they
// must not themselves contain double quotes - ours are paths and base64.
const HIDDEN_VBS = [
  "' Written by PaneForge (consoles.ts). Runs the given command hidden, without waiting.",
  'Dim sh, cmd, i',
  'Set sh = CreateObject("WScript.Shell")',
  'cmd = ""',
  'For i = 0 To WScript.Arguments.Count - 1',
  '  If i > 0 Then cmd = cmd & " "',
  '  cmd = cmd & """" & WScript.Arguments(i) & """"',
  'Next',
  'If cmd <> "" Then sh.Run cmd, 0, False'
].join('\r\n')

function hiddenLauncher(): string {
  const file = join(app.getPath('userData'), 'run-hidden.vbs')
  try {
    if (readFileSync(file, 'utf8') === HIDDEN_VBS) return file
  } catch {
    /* missing or unreadable - write it fresh */
  }
  writeFileSync(file, HIDDEN_VBS, 'utf8')
  return file
}

/**
 * A detached console child with no window at all.
 *
 * `windowsHide: true` is not enough once Windows Terminal is the default terminal:
 * Windows 11 delegates a detached console app to a visible Terminal window regardless
 * of CREATE_NO_WINDOW. Measured 2026-08-01 on this machine - the sweep below popped a
 * "Terminal" window on every app open. `conhost --headless <cmd>` pops nothing but
 * also silently never RUNS the child on this build (26200) - proven with marker files -
 * so the working shape is wscript + Shell.Run window-style 0, the same fix the
 * TaskdriverBrainSync task needed for this exact problem class.
 */
export function spawnDetachedNoWindow(bin: string, args: string[]): void {
  const win = process.platform === 'win32'
  spawn(win ? 'wscript.exe' : bin, win ? ['//B', '//Nologo', hiddenLauncher(), bin, ...args] : args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  }).unref()
}

function file(): string {
  return join(app.getPath('userData'), 'consoles.json')
}

/** The pids of previous runs, newest last. */
function readPids(): number[] {
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as { pids?: unknown }
    return Array.isArray(raw.pids) ? raw.pids.filter((p): p is number => typeof p === 'number') : []
  } catch {
    return []
  }
}

function writePids(pids: number[]): void {
  try {
    mkdirSync(dirname(file()), { recursive: true })
    writeFileSync(file(), JSON.stringify({ pids }), 'utf8')
  } catch {
    /* read-only profile: the sweep is a tidy-up, never a requirement */
  }
}

/**
 * Run the sweep for `pids`, once, in a process that outlives this one.
 *
 * Detached and unref'd on purpose: it has to still be running after we exit, because
 * every condition it checks is only true once we are gone.
 */
function reap(pids: number[], delayMs: number): void {
  if (process.platform !== 'win32' || !pids.length) return
  try {
    // -EncodedCommand rather than -Command: the script contains quotes and braces, and
    // Windows argument escaping through a spawn() array is where that goes wrong.
    const encoded = Buffer.from(reapScript(pids, delayMs), 'utf16le').toString('base64')
    spawnDetachedNoWindow('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded])
  } catch {
    /* no PowerShell on PATH - the leak is a tidy-up, not a correctness problem */
  }
}

/**
 * Write this run's pid down and hand back the runs before it, so the caller can sweep
 * what they left. Called once, at startup.
 */
export function rememberAppPid(): number[] {
  if (process.platform !== 'win32') return []
  const previous = readPids()
  writePids(rollPids(previous, process.pid))
  return previous.filter((p) => p !== process.pid)
}

/**
 * Kill the console hosts earlier runs left behind. Delayed, because a launch has better
 * things to do with its first seconds than enumerate every process on the machine.
 */
export function sweepOldConsoles(previous: number[]): void {
  if (!previous.length) return
  const t = setTimeout(() => reap(previous, 0), 4000)
  t.unref?.()
}

/**
 * The same sweep for this run, fired on the way out. The delay is what lets our own exit
 * happen first: until this process is gone, every console it owns still has a live parent
 * and is correctly left alone.
 */
export function sweepOwnConsolesOnExit(): void {
  reap([process.pid], 900)
}
