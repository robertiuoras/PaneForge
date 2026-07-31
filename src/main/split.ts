// Splitting one job across several lanes, instead of doing it in one pane.
//
// A long build is output-bound, not tool-bound. Measured on this repo: 55.9 minutes of
// wall clock, of which 12.7 was tool calls and 43 was one agent writing 451,786 tokens
// for seven workstreams that shared almost no files. Reading faster does not touch that
// number. Writing in three places at once divides it.
//
// The swarm in sessions.ts is the other shape and stays as it is: several roles, ONE
// checkout, told to keep out of each other's files by their briefs. That works when the
// roles genuinely interleave (a builder and a reviewer want the same files). It is the
// wrong shape for four independent features, because "do not edit files another role
// owns" is a sentence in a prompt, and a sentence does not survive an agent that decides
// it needs one import from over there.
//
// A split is the enforced version: each workstream gets its own git worktree lane, so
// two agents CANNOT write the same file - they are not looking at the same file. What
// they can still do is disagree about a shared type, so the plan names the contracts and
// every brief carries them.
//
// The model proposes; this file decides. Everything the CLI hands back is untrusted
// text, and the load-bearing check is that no two lanes claim the same path: a plan that
// overlaps is REFUSED rather than repaired, because repairing it means guessing which
// half of the overlap was meant, and guessing wrong is two agents in one file - exactly
// the thing lanes exist to make impossible.

import { extractJson } from '../shared/promptSchema'
import type { SplitLane, SplitPlan } from '../shared/types'

export type { SplitLane, SplitPlan }

/**
 * Fewer than two lanes is not a split, it is this pane.
 *
 * The ceiling is four because the win flattens and the cost does not: each lane is a
 * full checkout on disk and a concurrent agent against the same plan limit, and a plan
 * needing five separate owners usually has one workstream in it that was cut too thin.
 */
export const MIN_LANES = 2
export const MAX_LANES = 4

/**
 * How long the planner is given before the click is called a failure.
 *
 * Measured, because the last feature that guessed this number shipped a deadline under
 * the work and every click died as "produced no answer" - which reads as a broken
 * feature rather than as a wrong constant. A real three-lane plan for this repository
 * took **61.5 s** from a bare `claude -p`, and the app's own overhead put the first
 * in-app attempt at just over the 90 s it was given. Four minutes is not what it costs;
 * it is what it is allowed to cost before the answer is thrown away, and the dialog
 * counts the seconds out loud so a slow one looks slow rather than stuck.
 */
export const SPLIT_DEADLINE_MS = 240_000

/**
 * Longest brief kept.
 *
 * Measured rather than guessed: a real three-lane plan for this repository came back
 * with briefs of about 1,300 characters each, so the first cap of 1,200 truncated every
 * one of them mid-sentence - and a brief is not a description, it is the instruction the
 * agent is started with. The ceiling is still here because it is typed into a CLI, just
 * high enough that a normal plan is never cut.
 */
const BRIEF_LIMIT = 2400
const NAME_LIMIT = 60
/** Most paths one lane may claim. A lane that owns forty files owns the repo. */
const OWNS_LIMIT = 24

/**
 * What the CLI is asked for.
 *
 * JSON only, and every field it is allowed to invent is listed - a free-form answer
 * would be a second parser to write and a second thing to get wrong. The refusal is
 * offered as an ordinary outcome on purpose: a planner with no way to say "this is one
 * job" will always find three workstreams in one job.
 */
export function splitPayload(mission: string, files: string[] = []): string {
  const tree = files.length
    ? `\nTop-level entries in the repository:\n${files.slice(0, 60).join('\n')}\n`
    : ''
  return [
    'You are planning how to build one task with several coding agents at the same time.',
    'Each agent gets its OWN git worktree - a separate checkout of this repository - so',
    'two agents can never edit the same file. That is also the constraint: a file can be',
    'owned by exactly one workstream.',
    '',
    `Task:\n${mission.trim()}`,
    tree,
    'Answer with JSON and nothing else, in this shape:',
    '{"contracts":"...","lanes":[{"name":"...","brief":"...","owns":["src/x.ts","src/y/"]}]}',
    '',
    `- Between ${MIN_LANES} and ${MAX_LANES} lanes. Each is a deliverable someone could finish alone.`,
    '- "owns" lists the repo-relative files or directories that workstream will write.',
    '  These MUST NOT overlap between lanes, not even by containing directory. If two',
    '  workstreams both need one file, they are one workstream.',
    '- "brief" is what that agent should build, standalone: it will not see the others.',
    '- "contracts" is what all lanes must agree on before they start - shared types,',
    '  config keys, function signatures, test script names. Leave "" if there are none.',
    '',
    'If the work cannot be split - the steps feed each other, it is one feature, it is',
    'small, or everything touches one file - answer exactly:',
    '{"refused":"<one sentence saying why>"}'
  ].join('\n')
}

/**
 * The claim as it will be shown and as the agent will be told it: separators the way
 * git writes them, no `./`, no trailing slash, no glob tail.
 *
 * Case is left exactly as it came. That is not cosmetic - this string ends up in the
 * brief the agent is started with, and `src/renderer/components/settingsdialog.tsx` is
 * a file that does not exist on a Mac.
 */
function tidy(p: string): string {
  return String(p ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
    .replace(/\/\*+$/, '')
}

/**
 * The same claim reduced to the form two claims are COMPARED in - lowercased, because
 * the file systems this runs on are case-insensitive and `src/App.tsx` and
 * `src/app.tsx` are one file that two lanes must not both own.
 *
 * `.`, `./` and `*` all mean the repository root, and the root contains every other
 * claim - so they reduce to the empty string everything else is measured against,
 * rather than to a token that silently collides with nothing.
 */
function keyOf(p: string): string {
  const s = tidy(p).toLowerCase()
  return s === '.' || s === '*' ? '' : s
}

/**
 * Would these two claims ever name the same file?
 *
 * Equal, or one is a directory containing the other. `src` and `src/main/x.ts` collide;
 * `src/main` and `src/mainWindow.ts` do not, which is why the boundary is tested on a
 * slash rather than with startsWith alone.
 */
function collide(a: string, b: string): boolean {
  if (!a || !b) return false
  if (a === b) return true
  // A `*` anywhere else is a pattern we are not going to evaluate properly, so it is
  // treated as owning its whole prefix - conservative in the direction of refusing.
  const wild = (s: string): string => s.split('*')[0].replace(/\/+$/, '')
  const x = wild(a)
  const y = wild(b)
  if (!x || !y) return true
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)
}

/** A claim that would let a lane write outside the checkout it was given. */
function escapes(p: string): boolean {
  return !p || p.startsWith('/') || /^[a-z]:/i.test(p) || p.split('/').includes('..')
}

/**
 * Turn what the CLI printed into a plan, or into a refusal explaining itself.
 *
 * Never throws: a bad plan is an outcome the dialog shows, not an error dialog. The
 * checks are ordered so the most specific message wins - "two lanes both own src/main"
 * tells the user something; "could not read the plan" does not.
 */
export function parsePlan(text: string): SplitPlan {
  const none = (refused: string): SplitPlan => ({ lanes: [], contracts: '', refused })

  // The shared extractor, not a second copy of it: it matches braces rather than
  // regexing them (a brief containing `}` would truncate the plan), unwraps a fence,
  // and strips the escape sequences a CLI prints around its answer.
  const parsed = extractJson(text ?? '')
  if (!parsed || typeof parsed !== 'object')
    return none('The planner did not answer with a plan.')
  const raw = parsed as Record<string, unknown>

  if (typeof raw.refused === 'string' && raw.refused.trim())
    return none(raw.refused.trim().slice(0, 300))

  const list = Array.isArray(raw.lanes) ? raw.lanes : []
  const lanes: SplitLane[] = []
  const seenName = new Set<string>()

  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const l = item as Record<string, unknown>
    const name = String(l.name ?? '')
      .trim()
      .slice(0, NAME_LIMIT)
    const brief = String(l.brief ?? '')
      .trim()
      .slice(0, BRIEF_LIMIT)
    if (!name || !brief) continue
    const key = name.toLowerCase()
    if (seenName.has(key)) continue

    const owns: string[] = []
    const keys: string[] = []
    for (const o of Array.isArray(l.owns) ? l.owns : []) {
      const k = keyOf(String(o))
      // Checked before `escapes`, which would also reject the empty string but with a
      // message about escaping the project, which is not what happened.
      if (!k) return none(`“${name}” claims the whole repository - that is not a lane.`)
      if (escapes(k)) return none(`A lane claimed a path outside the project: ${String(o)}`)
      if (keys.includes(k)) continue
      keys.push(k)
      owns.push(tidy(String(o)))
      if (owns.length >= OWNS_LIMIT) break
    }
    if (!owns.length) continue

    seenName.add(key)
    lanes.push({ name, brief, owns })
    if (lanes.length >= MAX_LANES) break
  }

  if (lanes.length < MIN_LANES)
    return none('There is only one workstream here - build it in this pane.')

  // The whole reason lanes are worth having. Checked after the list is built rather
  // than while building it, so the message can name both sides of the clash.
  for (let i = 0; i < lanes.length; i++)
    for (let j = i + 1; j < lanes.length; j++)
      for (const a of lanes[i].owns)
        for (const b of lanes[j].owns)
          if (collide(keyOf(a), keyOf(b)))
            return none(
              `“${lanes[i].name}” and “${lanes[j].name}” both own ${a === b ? a : `${a} and ${b}`} - that is one workstream, not two.`
            )

  return {
    lanes,
    contracts: String(raw.contracts ?? '')
      .trim()
      .slice(0, BRIEF_LIMIT)
  }
}

/**
 * The text one lane's agent is actually started with.
 *
 * It never sees the other briefs - only their names and what they own, which is the
 * part that changes its behaviour: knowing that `src/main/knowledge/` belongs to someone
 * else is what stops it "just adding one function" there. The contracts are repeated in
 * full in every lane because they are the one thing all of them must implement the same.
 */
export function laneBrief(plan: SplitPlan, index: number, mission: string): string {
  const me = plan.lanes[index]
  const others = plan.lanes.filter((_, i) => i !== index)
  return [
    `You are one of ${plan.lanes.length} agents building this in parallel, each in its own git worktree of this repository.`,
    `The whole task: ${mission.trim()}`,
    '',
    `Your workstream: ${me.name}`,
    me.brief,
    '',
    `You own these paths and may edit them: ${me.owns.join(', ')}.`,
    others.length
      ? `Owned by other agents you cannot see - do not edit, do not fix, leave a note in your final message instead: ${others
          .map((o) => `${o.name} (${o.owns.join(', ')})`)
          .join('; ')}.`
      : '',
    plan.contracts
      ? `Agreed with the other agents before anyone started - implement exactly this, do not redesign it: ${plan.contracts}`
      : '',
    'Commit your work on this worktree’s own branch when it is done and verified. Do not merge, do not release, do not touch another branch.'
  ]
    .filter(Boolean)
    .join('\n')
}
