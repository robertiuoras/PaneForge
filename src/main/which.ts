// node-pty on Windows hands the command straight to ConPTY, which does NOT search
// PATH: spawning the bare name 'claude' fails with "File not found". So resolve the
// executable to an absolute path here before spawning.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

/**
 * GUI apps launched by Finder, `open`, or an updater do not inherit the user's shell
 * profile. Keep the standard user-level CLI folders in PATH so an already-installed
 * agent does not look missing merely because PaneForge was not started from Terminal.
 */
export function hydrateUserPath(): string {
  const current = process.env.PATH ?? ''
  // Narrow test escape hatch: production PaneForge never sets this, but it lets the
  // installer prerequisite test model a machine that genuinely has no Node anywhere.
  if (process.env.PANEFORGE_NO_USER_PATHS === '1') return current
  const parts = current.split(delimiter).filter(Boolean)
  const seen = new Set(parts.map((p) => (process.platform === 'win32' ? p.toLowerCase() : p)))
  const add = (dir: string | undefined): void => {
    if (!dir) return
    const key = process.platform === 'win32' ? dir.toLowerCase() : dir
    if (seen.has(key)) return
    seen.add(key)
    parts.push(dir)
  }

  const home = process.env.HOME ?? process.env.USERPROFILE
  if (process.platform === 'win32') {
    add(process.env.APPDATA && join(process.env.APPDATA, 'npm'))
    add(process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'pnpm'))
    add(home && join(home, '.local', 'bin'))
  } else {
    add('/opt/homebrew/bin')
    add('/usr/local/bin')
    add(home && join(home, '.local', 'bin'))
    add(home && join(home, '.npm-global', 'bin'))
    add(home && join(home, '.local', 'share', 'pnpm'))
    add(home && join(home, '.bun', 'bin'))
    // x.ai's installer puts `grok` here and only THEN tries to symlink it somewhere
    // already on PATH, so a machine where that symlink could not be made has the CLI
    // installed and invisible - which the agent list reports as "grok not on PATH".
    add(home && join(home, '.grok', 'bin'))
    add(home && join(home, '.volta', 'bin'))
    // nvm keeps one bin folder per installed Node version. Keeping all of them means
    // a GUI launch finds the same global CLIs as a normal shell, without sourcing
    // arbitrary shell startup files inside PaneForge.
    const nvm = home && join(home, '.nvm', 'versions', 'node')
    if (nvm) {
      try {
        const versions = readdirSync(nvm).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
        try {
          const preferred = readFileSync(join(home!, '.nvm', 'alias', 'default'), 'utf8').trim()
          const i = versions.indexOf(preferred.startsWith('v') ? preferred : `v${preferred}`)
          if (i > 0) versions.unshift(versions.splice(i, 1)[0])
        } catch {
          /* no explicit nvm default: the newest version is the best fallback */
        }
        for (const version of versions) add(join(nvm, version, 'bin'))
      } catch {
        /* nvm is optional or unreadable */
      }
    }
  }

  const next = parts.join(delimiter)
  process.env.PATH = next
  return next
}

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

  for (const dir of hydrateUserPath().split(delimiter)) {
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
