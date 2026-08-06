// What a lane has to survive before the app will say it is finished.
//
// Decision 4 of `docs/agentic.md`: verification is a gate between phases, not a check at
// the end. Three steps in this order, each cheap enough to be worth running before the
// next - did it change anything, does it typecheck, does the repository's own suite pass,
// and then one agent reading the diff against what was asked.
//
// The order is the whole design. A reviewer agent is the expensive step and it is asked
// last, because a diff that does not compile has nothing worth an opinion about; and the
// diffstat is asked FIRST, because the cheapest way to spend twenty minutes of tokens is
// to typecheck a branch nobody changed.
//
// Failing is not the same as being wrong. A failed gate hands the failure straight back
// to the agent that caused it (`retryBrief`) at most twice, and only then does it stop
// and say so - to the board, never to a dialog, and never at 3am to the screen.
//
// No electron import: this bundles for `npm run test:agentic` the same way `agentRun`
// does.

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GateResult, GateStep, TurnResult } from '../shared/agentic'
import {
  GATE_BUDGET_MS,
  REVIEW_BUDGET_MS,
  noOp,
  parseVerdict,
  reviewPayload
} from '../shared/agentic'
import { extractJson } from '../shared/promptSchema'
import { diffSince, patchSince, runAgentTurn } from './agentRun'

/**
 * Where the reviewer runs: a directory with nothing in it.
 *
 * Same mitigation as the improver's scratch cwd and for a sharper reason. The reviewer is
 * the one agent here whose job is to say no, and it is started with the same
 * `bypassPermissions` posture as the lane it is judging - so if it ran inside the lane it
 * could edit the branch to agree with itself, and the gate would be a formality. Its
 * whole input is the patch already in its prompt; it needs no files.
 */
function reviewScratch(): string {
  const dir = join(tmpdir(), 'paneforge-review')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* a cwd we cannot make is reported by the spawn, as `unavailable` */
  }
  return dir
}

/**
 * Which commands verify this repository.
 *
 * Read from the repo rather than hardcoded, because the gate has to work in every repo
 * lanes work in - and "every repo" already includes ones with no test runner at all. A
 * missing step is SKIPPED and says so; it is never silently treated as a pass, because
 * "the suite passed" and "there is no suite" are different sentences and only one of them
 * is a reason to trust a branch.
 *
 * `.lanes.json` wins when it names them, because a repo with twenty `test:*` scripts (this
 * one) knows which of them is the gate and package.json cannot say so.
 */
export interface GateCommands {
  typecheck: string[] | null
  suite: string[] | null
  /** Why a step is missing, for the line the board shows. */
  notes: { typecheck: string; suite: string }
}

function scriptsOf(repo: string): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    return pkg.scripts ?? {}
  } catch {
    return {}
  }
}

export function gateCommands(repo: string): GateCommands {
  let cfg: { gate?: { typecheck?: string | false; suite?: string | false } } = {}
  try {
    if (existsSync(join(repo, '.lanes.json')))
      cfg = JSON.parse(readFileSync(join(repo, '.lanes.json'), 'utf8')) as typeof cfg
  } catch {
    /* a malformed config falls back to the scripts, rather than to no gate at all */
  }

  const scripts = scriptsOf(repo)
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const asArgv = (s: string): string[] => s.split(' ').filter(Boolean)

  const pick = (
    named: string | false | undefined,
    script: string,
    missing: string
  ): { cmd: string[] | null; note: string } => {
    if (named === false) return { cmd: null, note: 'turned off in .lanes.json' }
    if (typeof named === 'string' && named.trim()) return { cmd: asArgv(named), note: '' }
    if (scripts[script]) return { cmd: [npm, 'run', script], note: '' }
    return { cmd: null, note: missing }
  }

  const t = pick(cfg.gate?.typecheck, 'typecheck', 'no typecheck script in this repo')
  const s = pick(cfg.gate?.suite, 'test', 'no test script in this repo')
  return {
    typecheck: t.cmd,
    suite: s.cmd,
    notes: { typecheck: t.note, suite: s.note }
  }
}

/**
 * Run one gate command in the lane.
 *
 * The exit code is the verdict and the tail of the output is the evidence: the agent that
 * has to fix this gets the same text a person would have read, which is the only version
 * of it that is definitely true. Everything above the tail is dropped - a failing suite
 * can print a megabyte and the useful part of it is at the bottom.
 */
export function runCommand(
  cwd: string,
  argv: string[],
  budgetMs = GATE_BUDGET_MS
): Promise<{ ok: boolean; output: string; ms: number }> {
  const started = Date.now()
  return new Promise((resolve) => {
    const child = execFile(
      argv[0],
      argv.slice(1),
      {
        cwd,
        timeout: budgetMs,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, NO_COLOR: '1', TERM: 'dumb', CI: '1' }
      },
      (err, out, errOut) => {
        const text = `${out ?? ''}${errOut ?? ''}`.trim()
        resolve({
          ok: !err,
          output: text || (err ? String(err.message ?? 'failed') : ''),
          ms: Date.now() - started
        })
      }
    )
    child.on('error', () => resolve({ ok: false, output: `${argv[0]} could not be run`, ms: Date.now() - started }))
  })
}

/** The one line a step shows. The tail, because the answer is at the bottom. */
function lastLine(output: string): string {
  const lines = output.split('\n').map((l) => l.trim()).filter(Boolean)
  return (lines[lines.length - 1] ?? '').slice(0, 200)
}

export interface GateInput {
  /** The lane's worktree. */
  cwd: string
  /** The commit the lane started from. */
  base: string
  mission: string
  brief: string
  agent: string
  model?: string
  key: string
  /** Called before each step starts, for the board's line. */
  onStep?: (name: GateStep['name']) => void
  /** Read at every step. A stop must not wait for a suite to finish. */
  stopped?: () => boolean
  /** Skip the reviewer agent - the one step that costs tokens. */
  skipReview?: boolean
  /** The reviewer's executable when PATH is not where it lives. Tests only. */
  bin?: string
  /** Arguments before the reviewer CLI's own. Tests only. */
  argsPrefix?: string[]
}

const skipped = (name: GateStep['name'], note: string): GateStep => ({
  name,
  ok: true,
  detail: `skipped - ${note}`,
  ms: 0
})

/**
 * Verify one lane. Resolves with every step it ran and the one that stopped it.
 *
 * Short-circuits: the first failure is the answer, because the next step's output would
 * be a consequence of it rather than a second finding, and a person reading two failures
 * has to work out which one is the cause.
 */
export async function runGate(input: GateInput): Promise<GateResult> {
  const steps: GateStep[] = []
  const stop = (): boolean => input.stopped?.() === true
  const fail = (name: GateStep['name']): GateResult => ({ ok: false, steps, failedAt: name })

  // 1. Did it do anything at all? Decision 6 - the silent no-op is the dangerous outcome.
  input.onStep?.('diff')
  const started = Date.now()
  const stat = await diffSince(input.cwd, input.base)
  const empty = noOp(stat)
  steps.push({
    name: 'diff',
    ok: !empty.noop,
    detail: empty.noop
      ? `the agent ${empty.why}`
      : `${stat.files} file${stat.files === 1 ? '' : 's'}, +${stat.added} −${stat.removed}`,
    ms: Date.now() - started,
    output: empty.noop ? `The branch ${empty.why}. Nothing was verified because there is nothing to verify.` : ''
  })
  if (empty.noop) return fail('diff')
  if (stop()) return fail('diff')

  const cmds = gateCommands(input.cwd)

  // 2. Does it compile.
  if (cmds.typecheck) {
    input.onStep?.('typecheck')
    const r = await runCommand(input.cwd, cmds.typecheck)
    steps.push({
      name: 'typecheck',
      ok: r.ok,
      detail: r.ok ? 'clean' : lastLine(r.output) || 'failed',
      ms: r.ms,
      output: r.output
    })
    if (!r.ok) return fail('typecheck')
  } else steps.push(skipped('typecheck', cmds.notes.typecheck))
  if (stop()) return fail('typecheck')

  // 3. Does the repository's own suite still pass.
  if (cmds.suite) {
    input.onStep?.('suite')
    const r = await runCommand(input.cwd, cmds.suite)
    steps.push({
      name: 'suite',
      ok: r.ok,
      detail: r.ok ? 'passed' : lastLine(r.output) || 'failed',
      ms: r.ms,
      output: r.output
    })
    if (!r.ok) return fail('suite')
  } else steps.push(skipped('suite', cmds.notes.suite))
  if (stop()) return fail('suite')

  // 4. One agent, reading the diff against what was asked. Last because it is the
  //    expensive one and because everything above it is a cheaper way to be wrong.
  if (input.skipReview) {
    steps.push(skipped('review', 'review turned off for this run'))
    return { ok: true, steps, failedAt: '' }
  }

  input.onStep?.('review')
  const patch = await patchSince(input.cwd, input.base)
  const turn = await runAgentTurn({
    cwd: reviewScratch(),
    agent: input.agent,
    model: input.model,
    prompt: reviewPayload(input.mission, input.brief, patch),
    key: `${input.key}:review`,
    budgetMs: REVIEW_BUDGET_MS,
    noDiff: true,
    bin: input.bin,
    argsPrefix: input.argsPrefix
  })
  const verdict = parseVerdict(extractJson(turn.text))
  steps.push({
    name: 'review',
    ok: verdict.pass,
    detail: verdict.summary,
    ms: turn.ms,
    output: [verdict.summary, ...verdict.issues.map((i) => `- ${i}`)].join('\n')
  })
  if (!verdict.pass) return fail('review')

  return { ok: true, steps, failedAt: '' }
}

/** What the board says about a finished gate, in one line. */
export function gateLine(result: GateResult): string {
  if (result.ok) return 'verified'
  const failed = result.steps.find((s) => !s.ok)
  return failed ? `${failed.name}: ${failed.detail}` : 'failed verification'
}

export type { GateResult, TurnResult }
