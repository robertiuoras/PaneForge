// Running the improver.
//
// Where the model runs was the one real decision here and the answer is the same one
// `voice.ts` reached: use what the user already has. Every pane in this app is an agent
// CLI that is already installed and already authenticated, so a headless run of one costs
// no new API key, no new billing surface, no new network client and no second auth
// surface - and the text goes exactly where that project's code already goes every day.
//
// Four rules on the spawn, all of them things this repository has been bitten by:
//
//   1. `windowsHide: true`, always. A console flashing is a focus steal, and the app's
//      whole identity is that it never takes the screen.
//   2. `cwd` is a scratch directory under userData, never the project. The improver is
//      reading untrusted text; with no repository and no tools, a successful injection
//      has nothing to act on. This is the load-bearing mitigation - not a CLI flag, which
//      differs per CLI and per version and cannot be verified from here.
//   3. A hard deadline with the process TREE killed. `scripts/lane.mjs` had to adopt this
//      after hung `git` processes outlived the chat that spawned them by 23 hours.
//   4. Any keystroke into the pane aborts, silently.
//
// The improver's answer is never trusted: it is JSON, schema-validated, sanitised, and
// checked for the placeholders it was given. See `promptSchema.ts`.

import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { AgentSpec } from '../shared/agents'
import { classify, tooSmallToImprove } from '../shared/classify'
import { buildImproveRequest } from '../shared/improveRequest'
import type { KnowledgeNote } from '../shared/knowledge'
import { budgetFor, estimateTokens } from '../shared/promptBudget'
import type { ImproveMetrics } from '../shared/promptBudget'
import { extractJson, parseImprovement } from '../shared/promptSchema'
import type { Improvement } from '../shared/promptSchema'
import { envelope, heldSummary, placeholdersMatch, restore } from '../shared/redact'
import type { GitInfo, PromptImproveConfig } from '../shared/types'
import { buildContextPack } from './contextPack'
import { providersFor, retrieve } from './knowledge'
import { which } from './which'

/**
 * Hard deadline. A hung improver must not outlive the click that started it.
 *
 * 90 s, not the 20 s this shipped with, because 20 s was under the time the work takes and
 * the feature could therefore never succeed on this machine. Measured 2026-07-31, a real
 * 661-token payload through `claude -p` with no knowledge notes: **22,540 ms**. Every click
 * was killed at 20,000 ms and reported as "produced no answer (cancelled, or timed out)",
 * which reads as the feature being broken rather than as a deadline being wrong.
 *
 * The number is a runaway guard, not a promise about latency: the sheet counts the seconds
 * out loud and Cancel is one click, so a wait that has gone strange is visible and endable
 * long before this fires.
 */
export const DEADLINE_MS = 90_000

/**
 * How to run each CLI once, headlessly, printing to stdout.
 *
 * These are defaults, not guarantees. A CLI can rename a flag in a release, so the
 * command is overridable in Settings and a wrong one fails as "no usable answer" rather
 * than as anything worse - the security properties come from the scratch cwd and the
 * validated output, neither of which depends on getting a flag right.
 *
 * The payload goes on stdin rather than in argv: Windows caps a command line at about
 * 8191 characters and a 2500-token request goes past that.
 */
export const PRINT_MODE: Record<string, { args: string[]; modelFlag?: string }> = {
  claude: { args: ['-p'], modelFlag: '--model' },
  codex: { args: ['exec', '--skip-git-repo-check', '-'], modelFlag: '--model' },
  gemini: { args: ['-p'], modelFlag: '--model' },
  qwen: { args: ['-p'], modelFlag: '--model' },
  ollama: { args: ['run'], modelFlag: '' }
}

/** Preference order when the pane has no agent of its own (a `shell` pane). */
const FALLBACK_ORDER = ['claude', 'codex', 'gemini', 'qwen', 'ollama']

export interface ImproveEngine {
  id: string
  bin: string
  args: string[]
}

/**
 * Which CLI runs the improvement.
 *
 * The pane's own agent first: the user chose it, is authenticated to it, and already
 * sends this repository's code through it. A shell pane borrows the first CLI on PATH and
 * the sheet says which - a pane with no agent is not a reason to have no feature.
 */
export function resolveEngine(
  preferred: string,
  paneAgent: string,
  specs: AgentSpec[],
  model: string
): ImproveEngine | null {
  const order = [preferred, paneAgent, ...FALLBACK_ORDER].filter(
    (id): id is string => Boolean(id) && id !== 'shell'
  )
  const seen = new Set<string>()
  for (const id of order) {
    if (seen.has(id)) continue
    seen.add(id)
    const mode = PRINT_MODE[id]
    if (!mode) continue
    const spec = specs.find((s) => s.id === id)
    const bin = which(spec?.bin ?? id)
    // `which` hands back the bare name when it found nothing, which node-pty and execFile
    // both then fail on with their own error. Here that means "not installed".
    if (!spec || bin === (spec.bin ?? id)) continue

    const args = [...mode.args]
    if (model) {
      if (id === 'ollama') args.push(model)
      else if (mode.modelFlag) args.push(mode.modelFlag, model)
    } else if (id === 'ollama') {
      // `ollama run` with no model is not a command. Without one chosen, skip it.
      continue
    }
    return { id, bin, args }
  }
  return null
}

/** A scratch directory with nothing in it: the improver's whole view of the filesystem. */
function scratchDir(): string {
  const dir = join(app.getPath('userData'), 'improve-scratch')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* fall through - execFile will report a cwd it cannot use */
  }
  return dir
}

export function clearScratch(): void {
  try {
    rmSync(join(app.getPath('userData'), 'improve-scratch'), { recursive: true, force: true })
  } catch {
    /* tidy-up only */
  }
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
      process.kill(-pid, 'SIGKILL')
    }
  } catch {
    /* already gone */
  }
}

export interface ImproveInput {
  sessionId: string
  cwd: string
  agent: string
  draft: string
  git: GitInfo | null
  config: PromptImproveConfig
  specs: AgentSpec[]
  /** Answers from a previous round, when this is the second pass. */
  answers?: Array<{ question: string; answer: string }>
  /** Bring untrusted knowledge back, labelled. Tests and the demonstration only. */
  includeUntrusted?: boolean
  /** Note ids the user removed. Excluded from retrieval, so the rewrite loses them too. */
  exclude?: string[]
  /**
   * "Make it shorter", "keep the file names", "ask me about the auth part" - what the
   * person wants changed about the REWRITE, typed after reading one.
   *
   * Their own instruction, so it is instruction here too rather than another block of
   * data: the draft is fenced because it may be pasted from anywhere, and this line was
   * typed into the sheet by the person sitting in front of it. It is still stripped of the
   * fence tokens and capped, so it cannot close a block or spend the whole budget.
   */
  tweak?: string
}

export interface ImproveOutcome {
  ok: boolean
  /** Why not, in one line the sheet can show. Never a stack trace. */
  error?: string
  improvement?: Improvement
  /** The original draft, always. Nothing is replaced until the user says so. */
  original: string
  /** Notes actually used, for the provenance list. */
  sources: KnowledgeNote[]
  /** "held back: 1 secret, 2 code blocks", or empty. */
  held: string
  metrics: ImproveMetrics
}

interface Running {
  cancel: () => void
}

const running = new Map<string, Running>()

/** Memory-only, per project+draft. Its whole job is making Reject -> Improve again free. */
const cache = new Map<string, ImproveOutcome>()
const CACHE_MAX = 20

function cacheKey(i: ImproveInput, envelopedDraft: string, contextHash: string): string {
  return createHash('sha256')
    .update(
      [
        i.cwd,
        i.agent,
        i.config.engine,
        i.config.model,
        envelopedDraft,
        contextHash,
        // Both of these change what is being asked for while leaving the draft identical,
        // so a key without them hands back the previous answer: removing a capability
        // redrew the same words with that capability still recommended in them, and
        // asking for a change did nothing at all.
        (i.exclude ?? []).join(','),
        i.tweak ?? ''
      ].join('\u0000'))
    .digest('hex')
}

export function clearImproveCache(): void {
  cache.clear()
}

/** Abort whatever this pane has in flight. Silent: no flash, no chip flicker. */
export function cancelImprove(sessionId: string): void {
  running.get(sessionId)?.cancel()
  running.delete(sessionId)
}

export function isImproving(sessionId: string): boolean {
  return running.has(sessionId)
}

function fail(original: string, error: string, metrics: Partial<ImproveMetrics> = {}): ImproveOutcome {
  return {
    ok: false,
    error,
    original,
    sources: [],
    held: '',
    metrics: {
      originalTokens: estimateTokens(original),
      improvedTokens: 0,
      contextTokens: 0,
      knowledgeTokens: 0,
      knowledgeNotes: 0,
      ms: 0,
      questions: 0,
      taskType: 'other',
      engine: '',
      outcome: 'failed',
      secretsHeld: 0,
      ...metrics
    }
  }
}

/**
 * Run one CLI once, headlessly, and return whatever it printed.
 *
 * Extracted so the research pass gets exactly this sandbox rather than a second one that
 * looks like it: the scratch cwd is the load-bearing mitigation (a successful injection
 * has no repository to act on), and a second copy of it is a second chance to leave out
 * the `cwd` line. Cancellation is keyed rather than per-session so that cancelling a
 * research run does not kill an improvement of the same pane.
 */
export async function runCli(
  engine: ImproveEngine,
  payload: string,
  opts: { key: string; deadlineMs?: number }
): Promise<string> {
  return new Promise<string>((resolve) => {
    let settled = false
    const done = (value: string): void => {
      if (settled) return
      settled = true
      running.delete(opts.key)
      resolve(value)
    }

    const child = execFile(
      engine.bin,
      engine.args,
      {
        cwd: scratchDir(),
        windowsHide: true,
        timeout: opts.deadlineMs ?? DEADLINE_MS,
        maxBuffer: 2 * 1024 * 1024,
        env: {
          ...process.env,
          // Non-interactive, no colour: the CLIs read these and it saves the sanitiser a
          // page of escape sequences it would otherwise have to strip out of the JSON.
          NO_COLOR: '1',
          TERM: 'dumb',
          CI: '1'
        },
        // On POSIX the child leads its own group so `kill(-pid)` reaches the tree.
        ...(process.platform === 'win32' ? {} : { detached: true })
      },
      (err, out) => {
        if (err) killTree(child.pid)
        done(err ? '' : out)
      }
    )

    running.set(opts.key, {
      cancel: () => {
        killTree(child.pid)
        done('')
      }
    })

    try {
      child.stdin?.end(payload)
    } catch {
      killTree(child.pid)
      done('')
    }
  })
}

/** Cancel any keyed run - an improvement or a research pass. */
export function cancelRun(key: string): void {
  running.get(key)?.cancel()
}

export async function improve(input: ImproveInput): Promise<ImproveOutcome> {
  const started = Date.now()
  const original = input.draft

  const small = tooSmallToImprove(original)
  if (small) return fail(original, small)

  const budget = budgetFor(input.config.optimise)
  if (estimateTokens(original) > budget.draft) {
    // Structural editing of a very long draft is stage 3. Declining is the honest answer:
    // a wholesale rewrite of a 2000-token prompt is a new prompt, not an improvement.
    return fail(original, 'too long to improve safely')
  }

  // 1. Envelope. Nothing below this line has seen a secret.
  const env = envelope(original, { projectPath: input.cwd })

  // 2. Classify, locally and for free.
  const classification = classify(env.text)

  // 3. Project context, per request, from this cwd only.
  const context = buildContextPack(input.cwd, input.git, budget.context)

  const key = cacheKey(input, env.text, createHash('sha256').update(context.text).digest('hex'))
  if (!input.answers) {
    const hit = cache.get(key)
    if (hit) return hit
  }

  // 4. Knowledge. An empty result is normal and the improvement proceeds without it.
  let notes: KnowledgeNote[] = []
  if (budget.knowledge > 0) {
    const providers = providersFor(
      {
        vaultPath: input.config.vaultPath,
        indexScript: input.config.indexScript,
        capabilities: input.config.capabilities
      },
      { stack: context.stack, dependencies: context.dependencies }
    )
    const result = await retrieve(providers, {
      task: `${classification.type}: ${env.text.slice(0, 300)}`,
      project: context.project,
      keywords: classification.keywords,
      sensitivityMax: 'private',
      includeUntrusted: input.includeUntrusted ?? false,
      budgetChars: Math.floor(budget.knowledge * 3.8),
      limit: 4
    })
    // What the user removed, removed. Applied here rather than in the provider so it
    // covers every provider at once, and so the exclusion cannot be forgotten by whichever
    // one is added next.
    const dropped = new Set(input.exclude ?? [])
    notes = dropped.size ? result.notes.filter((n) => !dropped.has(n.id)) : result.notes
  }

  // 5. Assemble, within budget.
  const request = buildImproveRequest({
    draft: env.text,
    classification,
    context: context.text,
    knowledge: notes,
    budget,
    clarify: input.config.clarify,
    answers: input.answers,
    tweak: input.tweak
  })

  const engine = resolveEngine(input.config.engine, input.agent, input.specs, input.config.model)
  if (!engine) {
    return fail(original, 'no agent CLI on PATH to run the improver')
  }

  // 6. Spawn.
  const stdout = await runCli(engine, request.text, { key: input.sessionId })

  const ms = Date.now() - started
  const baseMetrics: ImproveMetrics = {
    originalTokens: estimateTokens(original),
    improvedTokens: 0,
    contextTokens: request.tokens.context,
    knowledgeTokens: request.tokens.knowledge,
    knowledgeNotes: request.used.length,
    ms,
    questions: 0,
    taskType: classification.type,
    engine: engine.id,
    outcome: 'failed',
    secretsHeld: env.counts.secret
  }

  if (!stdout.trim()) {
    return fail(original, `${engine.id} produced no answer (cancelled, or timed out)`, baseMetrics)
  }

  // 7. Validate and sanitise.
  const parsed = parseImprovement(extractJson(stdout))
  if (!parsed.ok) return fail(original, `unusable answer: ${parsed.why}`, baseMetrics)

  const check = placeholdersMatch(parsed.value.improved, env.holds)
  if (!check.ok) {
    // Dropping one means the user's key or their code silently vanished from the prompt;
    // inventing one means a strange token would be typed into an agent. Both are refusals.
    const why = check.dropped.length
      ? `the answer dropped ${check.dropped.length} of the held-back parts`
      : 'the answer invented a placeholder that was never given to it'
    return fail(original, why, baseMetrics)
  }

  // 8. Un-envelope. The user's own text comes back byte for byte.
  const improved = restore(parsed.value.improved, env.holds)

  const outcome: ImproveOutcome = {
    ok: true,
    original,
    improvement: { ...parsed.value, improved },
    sources: request.used,
    held: heldSummary(env.counts),
    metrics: {
      ...baseMetrics,
      improvedTokens: estimateTokens(improved),
      questions: parsed.value.questions.length,
      taskType: parsed.value.taskType,
      outcome: 'pending'
    }
  }

  if (!input.answers) {
    cache.set(key, outcome)
    // Bounded, and oldest-first: a Map iterates in insertion order.
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string)
  }
  return outcome
}
