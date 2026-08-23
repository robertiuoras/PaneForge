// What a shell pane is RUNNING, when nothing else in the app can tell.
//
// Every other "is this pane working" reading in the app is about an AGENT: `engaged` is a
// prompt this app watched being submitted, and `busyUntil` is the CLI's own footer saying
// it is running. A plain shell pane has neither. Type `npm run build` into one and the pty
// prints nothing for two minutes, so the pane reads `ready - type to start`, sorts into
// Ready with no clock, and the desk says a machine that is busy is idle. That was the
// report: a dispatch pane "still has a shell running, it should be in Running and show the
// runtime, otherwise we don't know".
//
// The reading is the pty's own FOREGROUND process, which the tty already knows -
// `tcgetpgrp` on POSIX, the console process list on Windows, both behind node-pty's
// `IPty.process`. It costs one syscall, needs no process table, and is exact: measured
// here against a real pty, `zsh` while the shell sits at its prompt and `sleep` a beat
// after `sleep 20` was typed.
//
// Narrow on purpose, because the expensive failure is a FALSE job: a pane wrongly marked
// working never goes quiet, so it is never closed by the idle sweep, never handed off, and
// its clock is a lie that ticks. Hence the two refusals below - a pane whose runner is an
// agent CLI is left entirely alone (its turn is already tracked, and a Node-based CLI can
// report its own foreground as `node`, which would read as a job for ever), and a
// foreground that is itself a shell is a subshell rather than a job.
//
// `npm run test:panejob`.

/**
 * The runners a foreground reading is trusted for, and the names a job may not have.
 *
 * One list doing both halves is deliberate: a pane whose runner is a shell is the only
 * pane this may speak about, and a foreground that is one of these is the shell itself
 * (or a subshell it spawned), which is not work anybody started.
 */
export const SHELLS = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'dash',
  'ksh',
  'csh',
  'tcsh',
  'nu',
  'xonsh',
  'cmd',
  'powershell',
  'pwsh',
  'conhost'
])

/**
 * `-zsh` (a login shell), `C:\Windows\System32\cmd.exe`, `/bin/bash`: all three name the
 * same program, and the comparison below is between two of these shapes.
 */
export function programName(raw: string | null | undefined): string {
  if (!raw) return ''
  let s = String(raw).trim()
  if (!s) return ''
  // A login shell reports itself with a leading dash. It is still that shell.
  if (s.startsWith('-')) s = s.slice(1)
  const cut = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  if (cut >= 0) s = s.slice(cut + 1)
  if (s.toLowerCase().endsWith('.exe')) s = s.slice(0, -4)
  return s.trim()
}

/**
 * The command running in a shell pane's foreground, or null when there is nothing to say.
 *
 * @param foreground what the pty reports is in the foreground of its tty right now.
 * @param runner the program this pane was spawned as.
 */
export function paneJob(
  foreground: string | null | undefined,
  runner: string | null | undefined
): string | null {
  const fg = programName(foreground)
  const run = programName(runner)
  if (!fg || !run) return null
  // Not a shell pane: an agent CLI's turn is tracked by its own footer and by the prompt
  // this app watched being submitted, and both of those know things this reading cannot.
  if (!SHELLS.has(run.toLowerCase())) return null
  if (fg.toLowerCase() === run.toLowerCase()) return null
  // A shell inside a shell is not a job somebody started - and on Windows the console
  // process list carries the host itself.
  if (SHELLS.has(fg.toLowerCase())) return null
  return fg
}
