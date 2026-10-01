/**
 * Every agent in a pane can find and drive PaneForge: `pf` on its PATH, and one line in its
 * instructions saying so.
 *
 * Robert, 2026-09-24: "make sure paneforge agent optimised/first so it can do lots of things
 * quickly and easily like closing opening session consolidating things". The same day a
 * Codex chat concluded "PaneForge's local control API appears disabled, and its available
 * launcher cannot select Codex" - on a desk where `pf list` answered and `pf open <dir>
 * --agent codex` existed. Nothing had told it `pf` was there: `~/.codex/AGENTS.md` never
 * named it, and `pf` itself was a symlink into Robert's own checkout, so an installed app on
 * anybody else's machine had no `pf` at all.
 *
 * Pure (no imports), so the test asks for the Windows shapes from a Mac.
 */

/** What an agent is told. Short: it rides every turn's system prompt. */
export const PF_PRIMER =
  'You are running inside PaneForge, a desktop app that holds many agent chats side by side as panes. ' +
  'The `pf` command controls it: list, open, close, tidy and move chats (to another agent too), ' +
  'and send a message to another pane. Run `pf help` before your first use; do not look for another API.'

/**
 * Extra argv that carries the primer, per agent. Only the two whose CLIs take added
 * instructions without replacing the person's own:
 * - Claude Code `--append-system-prompt` adds to its prompt.
 * - Codex `-c developer_instructions=...` is a per-process config override (checked in the
 *   0.156.1 binary). It REPLACES a `developer_instructions` the person set in config.toml,
 *   so the caller passes `ownCodexInstructions` and nothing is sent when they have one.
 * Every other agent: nothing - they still get `pf` on PATH.
 */
export function primerArgs(agentId: string, ownCodexInstructions = false): string[] {
  if (agentId === 'claude') return ['--append-system-prompt', PF_PRIMER]
  if (agentId === 'codex' && !ownCodexInstructions) return ['-c', `developer_instructions=${tomlString(PF_PRIMER)}`]
  return []
}

/** A TOML basic string: Codex parses the `-c` value as TOML. */
export function tomlString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** Does a Codex config.toml set its own developer_instructions (top level, not commented)? */
export function hasOwnCodexInstructions(configToml: string): boolean {
  for (const line of configToml.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) return false // first table header: top level is over
    if (/^\s*developer_instructions\s*=/.test(line)) return true
  }
  return false
}

export interface ShimFile {
  name: string
  body: string
  /** chmod +x */
  exec: boolean
}

/**
 * The files that make `pf` a command, for one machine.
 *
 * `node` is the absolute path of a Node on this machine, or null. Claude Code's native
 * installer does not bring Node, so without one the script runs on the app's own binary
 * (ELECTRON_RUN_AS_NODE=1), the same way the lane hooks do (`main/laneHooks.ts`
 * `runnerFor`). On Windows that binary is a GUI-subsystem exe: PowerShell only waits for it
 * and keeps its exit code when its output is piped (`| Write-Output`, measured on the PC
 * 2026-09-23 for the hooks), so the Node-less Windows shape goes through a pf.ps1 that
 * `pf.cmd` (cmd, PowerShell) and `pf` (Git Bash) both hand to.
 */
export function pfShimFiles(
  platform: string,
  node: string | null,
  execPath: string,
  script: string,
  binDir: string
): ShimFile[] {
  const sh = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
  if (platform !== 'win32') {
    const run = node ? `exec ${sh(node)} ${sh(script)} "$@"` : `ELECTRON_RUN_AS_NODE=1 exec ${sh(execPath)} ${sh(script)} "$@"`
    return [{ name: 'pf', body: `#!/bin/sh\n# PaneForge control command - written by the app, rewritten on every start.\n${run}\n`, exec: true }]
  }
  const fwd = (p: string): string => p.replace(/\\/g, '/')
  const cmdQ = (p: string): string => `"${p.replace(/"/g, '')}"`
  if (node) {
    return [
      { name: 'pf.cmd', body: `@${cmdQ(node)} ${cmdQ(script)} %*\r\n@exit /b %ERRORLEVEL%\r\n`, exec: false },
      { name: 'pf', body: `#!/bin/sh\nexec ${sh(fwd(node))} ${sh(fwd(script))} "$@"\n`, exec: true }
    ]
  }
  const psQ = (p: string): string => `'${p.replace(/'/g, "''")}'`
  const ps1 = `${binDir.replace(/[\\/]+$/, '')}\\pf.ps1`
  return [
    {
      name: 'pf.ps1',
      body: `$env:ELECTRON_RUN_AS_NODE='1'\r\n& ${psQ(execPath)} ${psQ(script)} @args | Write-Output\r\nexit $LASTEXITCODE\r\n`,
      exec: false
    },
    {
      name: 'pf.cmd',
      body: `@powershell -NoProfile -ExecutionPolicy Bypass -File ${cmdQ(ps1)} %*\r\n@exit /b %ERRORLEVEL%\r\n`,
      exec: false
    },
    {
      name: 'pf',
      body: `#!/bin/sh\nexec powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${sh(fwd(ps1))} "$@"\n`,
      exec: true
    }
  ]
}

/**
 * The pane's env with `binDir` at the END of its PATH: a `pf` the person already has (Robert's
 * own symlink into his checkout) keeps winning, and a machine with none finds this one.
 * Windows env keys are case-insensitive but a copied object is not, so the existing key
 * (`Path` there) is the one written - two keys would leave the child with either.
 */
export function withPfOnPath(env: Record<string, string | undefined>, binDir: string, platform: string): Record<string, string | undefined> {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  const sep = platform === 'win32' ? ';' : ':'
  const parts = (env[key] ?? '').split(sep).filter(Boolean)
  const norm = (p: string): string => (platform === 'win32' ? p.replace(/[\\/]+$/, '').toLowerCase() : p.replace(/\/+$/, ''))
  if (parts.some((p) => norm(p) === norm(binDir))) return env
  return { ...env, [key]: [...parts, binDir].join(sep) }
}
