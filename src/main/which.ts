// node-pty on Windows hands the command straight to ConPTY, which does NOT search
// PATH: spawning the bare name 'claude' fails with "File not found". So resolve the
// executable to an absolute path here before spawning.

import { existsSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

export function which(cmd: string): string {
  if (isAbsolute(cmd) && existsSync(cmd)) return cmd

  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : ['']

  // Extensions first on Windows: npm installs both `codex` (a bash script ConPTY
  // cannot execute) and `codex.cmd` next to each other, and picking the bare name
  // makes the session die instantly with a cryptic error.
  const order = process.platform === 'win32' ? [...exts, ''] : ['', ...exts]

  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    for (const ext of order) {
      const candidate = join(dir, cmd + ext)
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
      } catch {
        /* unreadable PATH entry */
      }
    }
  }
  // Let the caller fail with node-pty's own error rather than inventing one.
  return cmd
}
