// Running an agent CLI once, headlessly, to get a one-shot answer with no TUI.
//
// This is the only place in the app that starts an agent OUTSIDE a pane. Everything about
// it is written to be refusable: a CLI with no headless flag is named and refused rather
// than launched with a guess, every run has a budget, and a caller that needs to walk away
// from a run early (a newer ask superseding an older one) gets a real `kill()`, not a hope
// that the timeout will do it in time.
//
// The flags are keyed by agent id and are deliberately short: `HEADLESS` here holds only
// the CLIs measured answering a one-shot prompt on a subscription login. Grok is absent
// for the reason it is absent from `shared/agents.ts`' own headless table - its flags are
// unverified, and refusing beats a guess that opens a window nobody asked for.
//
// Split off `main/splitPrompt.ts` on 2026-09-23 so `main/promptExpand.ts` could run its own
// one-shot CLI (`haiku`, same flags) without a second copy of the flag table or the exec.

import { execFile, type ChildProcess } from 'node:child_process'
import { specFor } from './agents'
import { which } from './which'

/**
 * How each CLI is asked one question with no TUI. The prompt is appended as one arg.
 *
 * Claude Code's flags carry the thing this feature could not work without: a headless run
 * started from this machine loads the DESK's own settings - its hooks, its output style,
 * its CLAUDE.md. Measured here, the first working split answered `Noted. Next reply
 * shorter.`, which is this user's reply-length Stop hook answering on the model's behalf.
 * `--settings` with empty hooks and the default style is what makes the answer be about
 * the prompt; `--strict-mcp-config` keeps a dozen MCP servers from being started for a
 * question that needs no tools. The login stays in `~/.claude`, which is why this is NOT
 * done with `CLAUDE_CONFIG_DIR` - pointing that elsewhere answers `Not logged in`.
 */
export const HEADLESS: Record<string, string[]> = {
  claude: [
    '-p',
    // `--settings` is not enough on its own, and the proof is a measurement rather than a
    // reading of the flag: with only `--settings '{"hooks":{}}'` this desk answered the
    // very split brief below with `Noted. JSON above stands - 2 parallel tasks, no file
    // overlap.` and `JSON delivered above. No further output needed.` Two `iterations` in
    // the run's own usage block, 57k of cache read: the JSON WAS written, a Stop hook then
    // blocked, and `-p` prints only the last message - so the plan was thrown away and the
    // app reported "did not answer with a plan". `--settings` merges INTO the user's
    // settings; it does not replace them, and it never covered CLAUDE.md at all.
    //
    // `--setting-sources ""` loads none of user, project or local, which is the only flag
    // that stops both. `--bare` also stops them and cannot be used: it answers `Not logged
    // in - Please run /login`, because the subscription login is part of what it skips.
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--settings',
    '{"hooks":{},"outputStyle":"default"}'
  ],
  codex: ['exec']
}

/**
 * Which INSTALLED agent can answer a one-shot ask, given the one Settings prefers.
 *
 * The preference is a preference: a desk defaulted to a CLI with no headless mode still
 * gets an answer, from one that has both the mode and a binary on this machine. `installed`
 * is passed in rather than probed here so the decision is testable without a PATH.
 */
export function splitAgent(
  preferred: string | undefined,
  installed: (id: string) => boolean
): string | null {
  if (preferred && HEADLESS[preferred] && installed(preferred)) return preferred
  return Object.keys(HEADLESS).find((id) => installed(id)) ?? null
}

/** Is this agent's binary on this machine? Shared by every headless caller. */
export function onDisk(id: string): boolean {
  try {
    which(specFor(id).bin)
    return true
  } catch {
    return false
  }
}

/** What one headless run answered. */
export interface RunHeadlessResult {
  out: string
  err?: string
  /** wall clock of the run */
  ms: number
  /** the run was killed (by its own timeout, or by a caller's `kill()`) rather than exiting */
  killed?: boolean
}

export interface RunHeadlessInput {
  bin: string
  args: string[]
  cwd: string
  /** `NodeJS.ProcessEnv`'s own shape - a plain `process.env` spread carries optional values */
  env: Record<string, string | undefined>
  timeoutMs: number
  /** default 4 MB - a plan or a brief is small; this only guards against a CLI gone wrong */
  maxBufferBytes?: number
}

/**
 * Run one CLI once, with a hard budget, and hand the caller a way to end it early.
 *
 * The exit code is never trusted on its own: several CLIs exit 1 on a warning they printed
 * to stderr, and the parser downstream is what decides whether the output was an answer -
 * so a non-zero exit with usable stdout still resolves as one.
 */
export function runHeadless(input: RunHeadlessInput): {
  promise: Promise<RunHeadlessResult>
  kill: () => void
} {
  const start = Date.now()
  let child: ChildProcess | undefined
  let killedByCaller = false
  const promise = new Promise<RunHeadlessResult>((resolve) => {
    child = execFile(
      input.bin,
      input.args,
      {
        cwd: input.cwd,
        timeout: input.timeoutMs,
        maxBuffer: input.maxBufferBytes ?? 4 * 1024 * 1024,
        env: input.env,
        windowsHide: true
      },
      (err, stdout, stderr) => {
        const ms = Date.now() - start
        const killed = killedByCaller || Boolean(err && (err as NodeJS.ErrnoException & { killed?: boolean }).killed)
        // Never `err.message` as the reason: Node's reads "Command failed: <every argument>",
        // and the arguments carry the person's prompt, which would then land in a log or on
        // screen as an error.
        const why = killed ? 'timed out' : `exited with code ${String((err as NodeJS.ErrnoException | null)?.code ?? '?')}`
        if (err && !stdout.trim()) resolve({ out: '', err: stderr.trim() || why, ms, killed })
        else resolve({ out: stdout, ms, killed })
      }
    )
  })
  return {
    promise,
    kill: () => {
      killedByCaller = true
      child?.kill()
    }
  }
}
