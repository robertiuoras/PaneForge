// Running an agent CLI once, headlessly, to read a long ask into panes.
//
// This is the only place in the app that starts an agent OUTSIDE a pane. Everything about
// it is written to be refusable: a CLI with no headless flag is named and refused rather
// than launched with a guess, the run has a budget, and an answer that is not a plan is
// `null` - never an empty plan, which is a different, real answer ("this is one job").
//
// The run itself - the flag table, which CLI can answer, and the exec with a budget - is
// `main/headless.ts` now (split off 2026-09-23 for a second caller since removed). What stays here is the part specific to a
// SPLIT: the prompt asked, how many panes it may propose, and what is done with an answer
// that is wrong.

import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { specFor } from './agents'
import { getConfig } from './config'
import { resolveEnv } from '../shared/agents'
import { parseSplit, splitInstruction, maxTasks, type SplitAnswer } from '../shared/splitPlan'
import { loadTemplate } from './promptForge'
import { which } from './which'
import { HEADLESS, onDisk, runHeadless, splitAgent } from './headless'

/**
 * How long a split may take.
 *
 * Measured on this machine at 12-24s for a six-part ask. Two minutes is the point past
 * which the answer has stopped being worth waiting for with a dialog open - and the
 * budget exists at all because a CLI waiting for an auth prompt nobody can see never
 * returns on its own.
 */
export const SPLIT_BUDGET_MS = 120_000

/** An empty folder under userData for the headless run to start in. See the call below. */
function quietDir(): string {
  const dir = join(app.getPath('userData'), 'split')
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Ask an agent to break `text` into panes.
 *
 * Nothing in the answer is executed: it is parsed as JSON and drawn as rows somebody has
 * to read and press.
 */
/**
 * How many checkouts this repo's own lane pool has, off `.lanes.json`'s `pool` array - the
 * real number `MAX_TASKS` used to hardcode as four. Missing file, no `pool` key, or
 * anything unreadable falls back to that same four: a repo with no lanes still has main.
 */
function poolSize(): number {
  try {
    const raw = readFileSync(join(app.getAppPath(), '.lanes.json'), 'utf8')
    const cfg = JSON.parse(raw) as { pool?: unknown }
    return Array.isArray(cfg.pool) && cfg.pool.length > 0 ? cfg.pool.length : 4
  } catch {
    return 4
  }
}

export async function splitPrompt(text: string): Promise<SplitAnswer> {
  const body = text.trim()
  if (!body) return { error: 'Nothing to split.' }
  const max = maxTasks(poolSize())
  const cfg = getConfig()
  const id = splitAgent(cfg.defaultAgent, onDisk)
  if (!id) return { error: 'No installed agent can answer a split on its own.' }
  const spec = specFor(id)
  let bin: string
  try {
    bin = which(spec.bin)
  } catch {
    return { error: `${spec.label} is not installed on this machine.` }
  }
  // The exemplar comes from Robert's own library on disk. `multi-item-opener` is the
  // template for exactly this shape - several unrelated asks in one message - and about
  // half his openers are one. A machine with no promptlib gets the built-in copy, which
  // carries the judgement and no example; nothing about the split depends on it.
  const args = [
    ...(spec.alwaysArgs ?? []),
    ...HEADLESS[id],
    splitInstruction(body, max, loadTemplate('multi-item-opener'))
  ]
  // An EMPTY folder, deliberately, and not the project the ask is about. A headless run
  // loads the settings and the CLAUDE.md of the directory it starts in, and this desk's
  // project hooks answered the split for it - twice, with `Noted - next reply shorter.`,
  // which is a reply-length Stop hook talking. `--settings` covers the user-level file and
  // cannot cover a project one, so the folder is the fix. The split reads only the text it
  // is given; it needs no repo.
  const { promise } = runHeadless({
    bin,
    args,
    cwd: quietDir(),
    timeoutMs: SPLIT_BUDGET_MS,
    env: { ...process.env, ...resolveEnv(spec, cfg.providerKeys ?? {}) }
  })
  const raw = await promise
  if (!raw.out.trim()) return { error: raw.err || `${spec.label} answered nothing.` }
  const plan = parseSplit(raw.out, max)
  // The head of what it DID say, because "not a plan" on its own is unactionable: the two
  // real causes look nothing alike on screen (a refusal sentence, or this desk's own hooks
  // answering for it) and the first 160 characters separate them.
  if (!plan)
    return {
      error: `${spec.label} did not answer with a plan: ${raw.out.trim().slice(0, 160)}`
    }
  return plan
}
