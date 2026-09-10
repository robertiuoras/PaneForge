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
/** The PATH this last built, keyed by the PATH it was built FROM. */
let hydrated: { from: string; to: string } | null = null

export function hydrateUserPath(): string {
  const current = process.env.PATH ?? ''
  // Called once per `which`, and it reads nvm's version folder every time. The answer is a
  // pure function of the PATH it starts from, so the second call with the same input is the
  // first call's answer.
  if (hydrated && hydrated.from === current) return hydrated.to
  const startedFrom = current
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
    // Google's Antigravity installer puts `agy` here, and nothing else on this machine
    // does - a GUI launch that does not read the shell profile would report it missing.
    add(process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'agy', 'bin'))
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
  hydrated = { from: startedFrom, to: next }
  return next
}

/**
 * What `which` already answered, and when.
 *
 * Every pane spawn asked this from scratch, and the answer costs a stat for every PATH
 * entry times every extension until it hits: on this Mac, with nvm's per-version bin
 * folders in PATH, resolving one CLI is dozens of stats, and a pane resolves more than one
 * before it prints a byte. Nothing on PATH changes between two panes opened a second apart.
 *
 * Kept short and re-checked: an entry is only believed while the file it names is still
 * there (one stat, not the walk), and it expires anyway so a CLI installed while PaneForge
 * is open is found within the minute rather than after a restart.
 */
const answers = new Map<string, { path: string; at: number }>()
const WHICH_TTL_MS = 60_000

/** Test seam and a way out: `which.forget()` after anything that changes PATH. */
export function forgetWhich(): void {
  answers.clear()
  hydrated = null
}

export function which(cmd: string): string {
  if (isAbsolute(cmd) && existsSync(cmd)) return cmd

  const key = `${process.platform}\u0000${cmd}`
  const had = answers.get(key)
  if (had && Date.now() - had.at < WHICH_TTL_MS) {
    // A miss is cached too - a machine without `grok` should not re-walk PATH for it on
    // every spawn - and a miss has no file to re-check.
    if (had.path === cmd) return cmd
    try {
      if (existsSync(had.path)) return had.path
    } catch {
      /* fall through and resolve again */
    }
    answers.delete(key)
  }

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
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          answers.set(key, { path: candidate, at: Date.now() })
          return candidate
        }
      } catch {
        /* unreadable PATH entry */
      }
    }
  }
  // Let the caller fail with node-pty's own error rather than inventing one.
  answers.set(key, { path: cmd, at: Date.now() })
  return cmd
}
