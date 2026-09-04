// One long ask, broken into the panes that can actually run at the same time.
//
// A prompt with six unrelated jobs in it is one session doing them one after another,
// re-explaining the repo to itself between each. The parts that are genuinely independent
// - different repos, different files - are panes, and the app already knows how to open
// panes with a prompt already typed (`queuePrompt` in main/sessions.ts). What was missing
// is the step in front of it: reading the ask and saying which parts those are.
//
// The reading is done by an agent CLI run headlessly (`main/splitPrompt.ts`), because that
// is the only thing on this machine that can tell "add a settings row and a test for it"
// (one job) from "fix the installer, and separately rewrite the sidebar" (two). Everything
// in THIS file is the part that must not depend on the model behaving: what it is asked
// for, and what is done with an answer that is wrong.
//
// Both briefs this file produces - the one the planner is asked, and the one each pane is
// opened with - are forged by `shared/promptForge.ts`, so they carry a scope fence, a
// definition of done, and (when this machine has Robert's promptlib) an example of a good
// ask of this kind. Before today the planner brief had four of those five and the PANE
// brief had none of them guaranteed at all.
//
// `npm run test:splitplan`, `npm run test:promptforge`.

import { DONE_HEAD, forgePrompt, type ForgeTemplate } from './promptForge'

/** One pane the split proposes: a brief, and where it runs. */
export interface SplitTask {
  /** a few words for the row and the pane's title */
  title: string
  /** the whole brief this pane is opened with, already rewritten to stand alone */
  prompt: string
  /**
   * What the brief named, if it named anything - a repo name, not a path. The window
   * resolves it against the real project list (`routeProjects`); main never guesses.
   */
  project?: string
}

/** What a split answered, plus anything it had to drop to answer it. */
export interface SplitPlan {
  tasks: SplitTask[]
  /**
   * Everything left out, said out loud. A cap inside a filter is invisible, and a split
   * that quietly returns four of seven jobs is worse than one that refuses.
   */
  dropped: string[]
}

/**
 * How many panes a split may propose.
 *
 * Four is the lane pool (`main` plus `a`/`b`/`c`), which is the number of checkouts of one
 * repo this machine actually has. A fifth task is not refused because five is unreasonable
 * - it is refused because the fifth pane would share a checkout with one of the others and
 * the two would edit each other's files.
 */
export const MAX_TASKS = 4

/**
 * How many panes a split may propose, given how many checkouts of this repo actually exist.
 *
 * `MAX_TASKS` was the lane pool hardcoded to four - `main` plus `a`/`b`/`c` - which is
 * wrong the moment `.lanes.json` names a different pool, and it is also narrower than it
 * needs to be now that a pane past the live checkouts can be QUEUED (`shared/wakePlan.ts`)
 * rather than refused outright: a fifth task used to be dropped for the same reason a
 * fifth checkout does not exist, and a queued pane does not share anyone's files, it simply
 * waits its turn. `queueAllowance` is capped at 12 so a split still cannot propose more
 * than a person could sensibly review in `SplitDialog`.
 */
export function maxTasks(poolSize: number, queueAllowance = 8): number {
  const pool = Math.max(1, Math.floor(poolSize))
  return Math.min(pool + Math.max(0, Math.floor(queueAllowance)), 12)
}

/** Below this there is nothing to split - one ask is one pane. */
export const MIN_CHARS = 120

/**
 * The ceiling on the whole planner brief.
 *
 * Deliberately far above `MAX_PROMPT_CHARS`, which is sized for a prompt typed into a pane
 * one chunk at a time. This one is a single argument to a headless CLI, and the thing it
 * carries is a LONG ask - the feature does not exist for short ones - so the pane ceiling
 * would truncate the request the planner was asked to read.
 */
export const SPLIT_BUDGET_CHARS = 40_000

/**
 * What the headless agent is asked.
 *
 * Three things it must be told and one it must be refused. Told: the shape of the answer
 * (JSON, one array), that each brief has to stand ALONE (a pane cannot read the other
 * panes' prompts, so "and the same for the other one" opens a session that asks what the
 * other one was), and the ceiling. Refused: inventing work - a split that helpfully adds
 * "and write tests for all of it" is scope nobody asked for, running in a pane nobody is
 * watching.
 */
export function splitInstruction(
  text: string,
  max = MAX_TASKS,
  template?: ForgeTemplate | null
): string {
  return forgePrompt({
    task: [
      'Split the request below into the parts that can be worked on AT THE SAME TIME by',
      "separate agents in separate checkouts - parts that do not need each other's output",
      'and do not edit the same files.',
      '',
      'The request:',
      text
    ].join('\n'),
    template,
    budget: SPLIT_BUDGET_CHARS,
    scope: [
      `At most ${max} tasks - if the request is really one job, answer with one task`,
      'ADD NO WORK: no task, file, test or refactor that the request did not ask for',
      'each "prompt" must stand alone: it is the ONLY thing its agent will be given, so it repeats whatever context it needs and never refers to the other tasks'
    ],
    done: [
      'the answer is JSON only, no prose, no code fence: {"tasks":[{"title":"","prompt":"","project":""}]}',
      'every "prompt" names the file, folder or repo to start from, and says what finished looks like',
      '"project" is the repo name the part names, or "" when it names none',
      '"title" is at most six words'
    ]
  })
}

/**
 * The first balanced `{...}` in a model's answer, or null. Fences and prose survive it.
 *
 * Every `{` is tried, not only the first one: a CLI that writes `the shape is {tasks: ...}`
 * in a sentence before printing the real object left the scan chasing a brace that never
 * closes, and the whole plan was reported as "not a plan". Measured against a live
 * `claude -p` answer, which is why it is written this way rather than `indexOf('{')`.
 */
function firstObject(raw: string): string | null {
  for (let from = raw.indexOf('{'); from >= 0; from = raw.indexOf('{', from + 1)) {
    const found = balancedAt(raw, from)
    if (found && /"tasks"\s*:/.test(found)) return found
  }
  return null
}

/** The balanced object starting at `start`, or null if it never closes. */
function balancedAt(raw: string, start: number): string | null {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < raw.length; i++) {
    const c = raw[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (c === '\\') {
      escaped = true
      continue
    }
    if (c === '"') inString = !inString
    else if (!inString && c === '{') depth++
    else if (!inString && c === '}' && --depth === 0) return raw.slice(start, i + 1)
  }
  return null
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * Read a plan out of whatever the CLI printed.
 *
 * Every failure here is the same failure - the answer is not a plan - and it is reported
 * as `null` rather than as an empty plan. An empty list means "this is one job", which is
 * a real answer and must never share a shape with "the model printed an apology".
 */
export function parseSplit(raw: string, max = MAX_TASKS): SplitPlan | null {
  const body = firstObject(raw)
  if (!body) return null
  let data: unknown
  try {
    data = JSON.parse(body)
  } catch {
    return null
  }
  const list = (data as { tasks?: unknown }).tasks
  if (!Array.isArray(list)) return null
  const dropped: string[] = []
  const tasks: SplitTask[] = []
  for (const row of list) {
    const prompt = str((row as { prompt?: unknown })?.prompt)
    const title = str((row as { title?: unknown })?.title) || prompt.slice(0, 40)
    // A task with no brief is not a task. It is dropped by name rather than silently,
    // because a plan one row short is exactly the shape of a plan that worked.
    if (!prompt) {
      dropped.push(title || 'a task with no prompt')
      continue
    }
    if (tasks.length >= max) {
      dropped.push(title)
      continue
    }
    const project = str((row as { project?: unknown })?.project)
    tasks.push({ title, prompt, ...(project ? { project } : {}) })
  }
  if (!tasks.length) return null
  return { tasks, dropped }
}

/**
 * The brief a pane is actually opened with.
 *
 * `parseSplit` returns what the MODEL wrote, unchanged, because that is what the parser's
 * refusals are about. This is the step after it, and it exists because of the count in
 * `docs/prompt-review-2026-09-02.md`: of the six places this app writes a prompt, the pane
 * brief was the only one with none of the five definition-of-done items guaranteed - and
 * it is the one that opens up to four CLIs at once, ~190 MB each, on text nothing read.
 *
 * Idempotent: a model that already ended its brief with a `Done means:` block has that
 * block LIFTED and re-used rather than a second one added under it, so forging a forged
 * brief changes nothing.
 */
export function paneBrief(task: SplitTask): string {
  const { body, done } = liftDone(task.prompt)
  return forgePrompt({
    task: body,
    ...(task.project ? { anchors: [`the ${task.project} repo`] } : {}),
    scope: [
      'only what this brief asks for - the other parts of the split are other panes and other checkouts'
    ],
    done
  })
}

/**
 * Split a brief into its body and the done lines it already carried.
 *
 * The block has to be the LAST thing in the text to count, and every line under the
 * heading has to be a bullet. A `Done means:` in the middle of a brief is the brief
 * talking about something else, and lifting that would move a sentence out of the ask.
 */
export function liftDone(prompt: string): { body: string; done: string[] } {
  const text = String(prompt || '').trim()
  const at = text.lastIndexOf(DONE_HEAD)
  if (at < 0) return { body: text, done: [] }
  const tail = text.slice(at + DONE_HEAD.length)
  const rows = tail.split('\n').filter((l) => l.trim())
  if (!rows.length || rows.some((l) => !/^\s*[-*]\s/.test(l))) return { body: text, done: [] }
  return { body: text.slice(0, at).trimEnd(), done: rows.map((l) => l.replace(/^\s*[-*]\s*/, '').trim()) }
}

/** Why a split could not run, in the words the dialog shows. */
export interface SplitFailure {
  error: string
}

/** A plan, or the reason there is none. The two never share a shape. */
export type SplitAnswer = (SplitPlan & { error?: undefined }) | SplitFailure

/**
 * What the window says about a plan before anything is opened.
 *
 * One task is not a failure and is not silence: it is the split saying this ask is one
 * job, which is the answer that stops somebody splitting it by hand anyway.
 */
export function splitWords(plan: SplitPlan): string {
  const n = plan.tasks.length
  const head =
    n === 1 ? 'This reads as one job, so one pane.' : `${n} parts that can run at the same time.`
  if (!plan.dropped.length) return head
  return `${head} Left out: ${plan.dropped.join(', ')}.`
}
