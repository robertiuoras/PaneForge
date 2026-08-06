// One agent turn, awaited - the first thing in this app that runs a coding agent with no
// pane around it.
//
// `docs/agentic.md` calls this the foundation and it is: three of the five gaps close
// here. There is a prompt going in, a structured stream coming back, and a settled
// promise at the end carrying what the turn actually did - including, and this is the
// part a pty could never give us, whether it changed any code at all.
//
// Nothing in this file imports electron. That is deliberate and load-bearing: it is what
// lets `npm run test:agentic` bundle it with esbuild and run real spawns - a stub that
// emits a stream, a stub that hangs and must be killed by its budget - without a window,
// which is the `test:wedge` pattern this repository already trusts for exactly this class
// of bug.
//
// The two rules the rest of the app lives by apply here with no exception. Nothing takes
// the screen (`windowsHide`, no console, no dialog), and nothing blocks the main process:
// every process-table read and every git call is `execFile`, never `spawnSync`.

import { execFile, spawn } from 'node:child_process'
import type { AgentEvent, Diffstat, TurnExit, TurnResult } from '../shared/agentic'
import { HEADLESS, foldEvents, headlessArgs, parseDiffstat, parseEvent } from '../shared/agentic'
import { which } from './which'

export interface AgentRunInput {
  /** The checkout the agent works in. A driven lane's own worktree, never the main one. */
  cwd: string
  /** Agent id, as in `shared/agents.ts`. Must be one `HEADLESS` knows. */
  agent: string
  model?: string
  prompt: string
  /** Cancellation handle. One per lane, so stopping a lane cannot kill its neighbour. */
  key: string
  /** Hard wall clock. When it fires the tree is killed and the exit is `budget`. */
  budgetMs: number
  /**
   * Called as the turn happens, for a progress line. It must be cheap: it runs on the
   * main process for every event of every live lane.
   */
  onEvent?: (e: AgentEvent) => void
  /** Skip the git work. The reviewer reads a diff; it does not produce one. */
  noDiff?: boolean
  env?: Record<string, string>
  /**
   * The executable, when PATH is not where it lives.
   *
   * The seam `npm run test:agentic` runs through: the tests spawn a stub that emits a
   * scripted stream and a stub that hangs on purpose, and without this they would have
   * to resolve `claude` on PATH - which means the suite would either need a real CLI
   * installed or would silently start one. Production never sets it.
   */
  bin?: string
  /**
   * Arguments before the CLI's own. The other half of the same test seam: a stub is run
   * as `node <stub.mjs> …`, which works on every platform a shebang does not. Production
   * never sets it.
   */
  argsPrefix?: string[]
}

interface Running {
  cancel: () => void
}

const running = new Map<string, Running>()

export function cancelAgentRun(key: string): void {
  running.get(key)?.cancel()
}

export function agentRunning(key: string): boolean {
  return running.has(key)
}

/** How many keys are live. The budget scheduler's input when it arrives (I5). */
export function agentRunCount(): number {
  return running.size
}

/** Kill the whole tree. A CLI that spawned a helper leaves one behind otherwise. */
function killTree(pid: number | undefined): void {
  if (!pid) return
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/F', '/T', '/PID', String(pid)], {
        windowsHide: true,
        stdio: 'ignore',
        detached: true
      }).unref()
    } else {
      // The child leads its own group (see `detached` below), so this reaches the tree.
      process.kill(-pid, 'SIGKILL')
    }
  } catch {
    /* already gone */
  }
}

function git(cwd: string, args: string[], timeout = 20_000): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out) =>
      resolve(err ? '' : out)
    )
  })
}

/** The commit the lane started from, so the diff can be taken against it afterwards. */
export async function headSha(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', 'HEAD'])).trim()
}

/**
 * Everything that changed since `base`, committed or not.
 *
 * `git diff` alone cannot see a file the agent created and never added, and a lane whose
 * whole deliverable is one new file would otherwise report itself as having changed
 * nothing - which is the exact signal `noOp` exists to trust. `--intent-to-add` records
 * the paths without their content, so the diff sees them; it is the one git write this
 * file makes, into the lane's own index, which the agent is expected to be committing
 * from anyway.
 */
export async function diffSince(cwd: string, base: string): Promise<Diffstat> {
  if (!base) return { files: 0, added: 0, removed: 0, paths: [] }
  await git(cwd, ['add', '-A', '--intent-to-add'])
  return parseDiffstat(await git(cwd, ['diff', '--numstat', base]))
}

/** The patch a reviewer reads. Capped, because a diff can be a context window. */
export async function patchSince(cwd: string, base: string, limit = 120_000): Promise<string> {
  if (!base) return ''
  const out = await git(cwd, ['diff', base, '--', '.'], 60_000)
  return out.length > limit ? `${out.slice(0, limit)}\n… diff truncated at ${limit} characters …` : out
}

const NO_TOOLS: Record<string, number> = {}

function unavailable(agent: string, ms: number): TurnResult {
  return {
    ok: false,
    exit: 'unavailable',
    text: '',
    toolCalls: 0,
    tools: { ...NO_TOOLS },
    tokens: { input: 0, output: 0 },
    costUsd: 0,
    code: null,
    ms,
    diffstat: { files: 0, added: 0, removed: 0, paths: [] },
    detail: HEADLESS[agent]
      ? `${agent} is not on PATH`
      : `${agent} cannot be driven headlessly - see HEADLESS in shared/agentic.ts`
  }
}

/**
 * Run one turn and resolve when it has settled, whatever settling turned out to mean.
 *
 * Never rejects. Every way this can end - the CLI finished, the CLI errored, we killed
 * it, it was cancelled, it was never there - comes back as a `TurnExit`, because the
 * caller is a loop that has to decide what to do next and an exception is not a decision.
 */
export async function runAgentTurn(input: AgentRunInput): Promise<TurnResult> {
  const started = Date.now()
  const mode = HEADLESS[input.agent]
  const own = headlessArgs(input.agent, input.model ?? '')
  if (!mode || !own) return unavailable(input.agent, Date.now() - started)
  const args = input.argsPrefix ? [...input.argsPrefix, ...own] : own

  const bin = input.bin ?? which(input.agent)
  // `which` hands back the bare name when it found nothing. Here that means not installed.
  if (bin === input.agent) return unavailable(input.agent, Date.now() - started)

  const base = input.noDiff ? '' : await headSha(input.cwd)
  const events: AgentEvent[] = []

  const raw = await new Promise<{ exit: TurnExit; code: number | null; stderr: string }>((resolve) => {
    let settled = false
    let killedBy: TurnExit | null = null
    let stderr = ''
    let buf = ''

    const done = (exit: TurnExit, code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      running.delete(input.key)
      resolve({ exit, code, stderr })
    }

    const child = spawn(bin, args, {
      cwd: input.cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Non-interactive and colourless: the CLIs read these, and it saves the parser a
        // page of escape sequences it would otherwise have to strip out of the JSON.
        NO_COLOR: '1',
        TERM: 'dumb',
        CI: '1',
        ...input.env
      },
      // On POSIX the child leads its own group so `kill(-pid)` reaches the whole tree.
      ...(process.platform === 'win32' ? {} : { detached: true })
    })

    // The budget is armed BEFORE anything is awaited, and it is the only thing standing
    // between an unattended overnight run and a CLI that waits for ever on a prompt
    // nobody will answer. Same lesson as the updater's `phaseAt`: a recovery that lives
    // inside the thing that can hang is not a recovery.
    const timer = setTimeout(() => {
      killedBy = 'budget'
      killTree(child.pid)
    }, input.budgetMs)

    child.stdout?.on('data', (d: Buffer) => {
      buf += d.toString('utf8')
      // A JSON object per line, and a line can arrive in three chunks. Everything up to
      // the last newline is complete; whatever follows it is not yet a line.
      let nl = buf.indexOf('\n')
      while (nl !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        const e = parseEventLine(line, mode.parse)
        if (e) {
          events.push(e)
          try {
            input.onEvent?.(e)
          } catch {
            /* a listener that throws must not end the run it was watching */
          }
        }
        nl = buf.indexOf('\n')
      }
      // A CLI in `plain` mode prints prose and may never write a newline. Keeping the
      // whole tail would be unbounded, so it is capped and the text is taken from it.
      if (buf.length > 400_000) buf = buf.slice(-200_000)
    })

    child.stderr?.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString('utf8')).slice(-4000)
    })

    child.on('error', () => done('unavailable', null))
    child.on('close', (code) => {
      // Whatever is left in the buffer was the last line without its newline.
      const e = parseEventLine(buf, mode.parse)
      if (e) events.push(e)
      if (killedBy) return done(killedBy, code)
      done(code === 0 ? 'done' : 'error', code)
    })

    running.set(input.key, {
      cancel: () => {
        killedBy = 'cancelled'
        killTree(child.pid)
        // Do not settle here: `close` still arrives and carries the exit code. If the
        // kill missed, the budget timer is still armed behind it.
      }
    })

    try {
      child.stdin?.end(input.prompt)
    } catch {
      killTree(child.pid)
      done('unavailable', null)
    }
  })

  const folded = foldEvents(events)
  // `plain` CLIs print prose, not events, so the fold has nothing. Their stderr is the
  // only thing left that can say why.
  const diffstat = input.noDiff
    ? { files: 0, added: 0, removed: 0, paths: [] }
    : await diffSince(input.cwd, base)

  let exit = raw.exit
  // A run that exited 0 without ever saying it had finished, and printed nothing, did
  // not succeed quietly - it produced no answer. Named apart from `error` because the
  // two want different next moves: one is retried, one is reported.
  if (exit === 'done' && !folded.finished && !folded.text.trim()) exit = 'silent'
  if (exit === 'done' && folded.errored) exit = 'error'

  return {
    ok: exit === 'done',
    exit,
    text: folded.text,
    toolCalls: folded.toolCalls,
    tools: folded.tools,
    tokens: folded.tokens,
    costUsd: folded.costUsd,
    code: raw.code,
    ms: Date.now() - started,
    diffstat,
    detail: detailFor(exit, raw.code, raw.stderr, input.budgetMs)
  }
}

function parseEventLine(line: string, parse: 'claude' | 'codex' | 'plain'): AgentEvent | null {
  if (parse === 'plain') {
    const t = line.trim()
    return t ? { kind: 'text', text: t } : null
  }
  return parseEvent(line, parse)
}

function detailFor(exit: TurnExit, code: number | null, stderr: string, budgetMs: number): string {
  const tail = stderr.trim().split('\n').filter(Boolean).pop() ?? ''
  if (exit === 'done') return ''
  if (exit === 'budget') return `killed after ${Math.round(budgetMs / 60000)} min - it was still running`
  if (exit === 'cancelled') return 'stopped'
  if (exit === 'silent') return 'the agent produced no answer'
  if (exit === 'unavailable') return tail || 'the CLI could not be started'
  return tail || `the CLI exited ${code ?? '?'}`
}
