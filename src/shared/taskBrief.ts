// A pane opened on a task is briefed from the task.
//
// `docs/agentic-backlog-2026-09-02.md`, item 1, which is A3 of the milestone in
// `claude-memory/PaneForge/project_autonomous_task_loop_milestone_2026-08-30.md`. The rest
// of that loop already exists: `claude-config/next-action.mjs` answers WHICH item is next,
// `backlog.mjs done --gate` answers whether it worked, and `queuePrompt` types a prompt
// into a pane and confirms the turn landed. The only hand-written step left was the prompt
// itself - `pf open --prompt "<whatever Robert types>"` - and that is the milestone's own
// named bottleneck.
//
// Everything here is arithmetic over a backlog row. Nothing judges, nothing writes: the
// backlog stays A1's single source of truth and this only reads it.
//
// `npm run test:taskbrief`.

import { forgePrompt, type ForgeTemplate } from './promptForge'

/** One backlog row, as `claude-config/backlog.mjs` writes it. */
export interface BacklogRow {
  id: string
  /** add | start | done | ... - the event this row records */
  ev?: string
  state?: string
  title?: string
  class?: string
  project?: string
  /** why it is worth doing */
  why?: string
  /** the acceptance criterion, usually a command that must exit 0 */
  success?: string
  /** what may be touched */
  scope?: string
  impact?: string
  owner?: string
  deps?: string[]
  /** gate commands the item is judged by, when it carries any */
  gates?: string[]
  /** how many times it has been tried and refused */
  attempts?: number
  /** what the last refusal said */
  evidence?: string
  note?: string
  updated?: number
}

/**
 * The store as it stands, folded out of the append-only log.
 *
 * Last row per id wins field by field, which is how `backlog.mjs` itself reads it: a
 * `start` row carries only what changed, so a plain overwrite would lose the title. A row
 * with no id is not a row.
 */
export function foldBacklog(rows: BacklogRow[]): Map<string, BacklogRow> {
  const out = new Map<string, BacklogRow>()
  for (const r of rows) {
    if (!r || typeof r.id !== 'string' || !r.id) continue
    out.set(r.id, { ...(out.get(r.id) ?? {}), ...r })
  }
  return out
}

/** Why a task could not be turned into a brief. Never shares a shape with a brief. */
export interface TaskRefusal {
  error: string
}

/**
 * The row this reference names, or the reason it names none.
 *
 * An exact id wins outright. Otherwise a PREFIX is allowed, because the ids the backlog
 * generates are long and hyphenated (`fix-node-claude-config-run-g-7589`) and a person
 * copying one out of `next-action.mjs` gets it right far more often than they type it.
 * A prefix matching more than one row is refused BY NAME rather than resolved to the
 * first: opening a pane on the wrong task is twenty minutes of an agent being confidently
 * wrong, which is the same reason `SplitDialog` draws its rows before opening anything.
 */
export function findTask(store: Map<string, BacklogRow>, ref: string): BacklogRow | TaskRefusal {
  const want = String(ref || '').trim()
  if (!want) return { error: 'no task id given' }
  const exact = store.get(want)
  if (exact) return exact
  const hits = [...store.keys()].filter((k) => k.startsWith(want))
  if (!hits.length) return { error: `no task called "${want}"` }
  if (hits.length > 1) return { error: `"${want}" names ${hits.length} tasks: ${hits.join(', ')}` }
  return store.get(hits[0]) as BacklogRow
}

/** A row that is already finished is not something to open a pane on. */
export function closedStates(): string[] {
  return ['done', 'dropped', 'cancelled']
}

/**
 * The brief, or the reason there is none.
 *
 * The shape is `forgePrompt`'s, so this inherits the rule that made it worth writing: the
 * prompt cannot exist without a `Done means:` block. Here that block is not invented -
 * it is the item's own `success` line and its gate commands, which is exactly what
 * `backlog.mjs done` will run to decide whether the pane succeeded. The pane is judged by
 * the criterion it was given.
 */
export function taskBrief(
  row: BacklogRow | TaskRefusal,
  template?: ForgeTemplate | null
): string | TaskRefusal {
  if ('error' in row) return row
  const title = String(row.title || '').trim()
  if (!title) return { error: `task ${row.id} has no title to work from` }
  if (row.state && closedStates().includes(row.state))
    return { error: `task ${row.id} is already ${row.state}` }

  const gates = (row.gates ?? []).map((g) => String(g).trim()).filter(Boolean)
  const done = [...(row.success ? [String(row.success).trim()] : []), ...gates]

  const task = [
    title,
    ...(row.why ? ['', `Why it matters: ${String(row.why).trim()}`] : []),
    ...(row.impact ? [`What it is worth: ${String(row.impact).trim()}`] : []),
    // A failed attempt is the single most useful thing in the row and the thing a
    // hand-typed prompt never carries: without it the pane starts the approach that has
    // already been refused. `next-action.mjs` reads the same count to decide when three
    // failures mean the APPROACH is wrong rather than the attempt.
    ...(row.attempts
      ? [
          '',
          `This has been tried ${row.attempts} time${row.attempts === 1 ? '' : 's'} and refused${
            row.attempts >= 3 ? ' - three refusals blame the approach, not the attempt, so change it' : ''
          }.`,
          ...(row.evidence ? [`The last refusal said: ${String(row.evidence).trim()}`] : [])
        ]
      : []),
    '',
    `Record the result with: node claude-config/backlog.mjs done ${row.id}`
  ].join('\n')

  const forged = forgePrompt({
    task,
    template,
    ...(row.project ? { anchors: [`the ${row.project} repo`] } : {}),
    scope: [
      ...(row.scope ? [String(row.scope).trim()] : []),
      'only this task - anything else you notice goes in the backlog, not in this diff'
    ],
    done: done.length ? done : ['the task above is finished, and you name what proves it']
  })
  return forged
}
