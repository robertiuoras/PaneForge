// How often a person had to step in.
//
// `docs/agentic-backlog-2026-09-02.md`, item 2, which is A7 of the milestone in
// `claude-memory/PaneForge/project_autonomous_task_loop_milestone_2026-08-30.md`. The
// target that milestone sets is a NUMBER - one bounded feature finished with 0-2 human
// interventions - and nothing has ever measured it. Without the number, "more agentic" is
// a feeling; with it, every item on that backlog can be judged by whether it moved.
//
// This is arithmetic over readings the app already takes. It counts what a PERSON had to
// do, never what the app did on its own - which is the guard against the trap the same
// document names: activity is not leverage, and a count of everything the app did would
// go up when it got worse.
//
// `npm run test:interventions`.

/** Who put this in the pane. Mirrors `WriteOrigin` in main/sessions.ts. */
export type Hand = 'desk' | 'phone' | 'app'

/** The pane, at the moment something arrived in it. */
export interface Moment {
  /** who did it */
  hand: Hand
  /** a return went in - text was actually sent, not just typed */
  submitted: boolean
  /** that return was pressed at an empty composer, so it asked nothing */
  bare: boolean
  /** the pane was holding a question */
  asking: boolean
  /** the pane was mid-turn */
  running: boolean
}

/** Whether this moment cost a person, and the words for the log. */
export interface Verdict {
  counts: boolean
  why: string
}

const NO = (why: string): Verdict => ({ counts: false, why })

/**
 * Did a person have to step in?
 *
 * The order is the point. `app` is refused FIRST and unconditionally: a queued prompt, an
 * autoclear's `/clear`, an auto-answered question and a lane hand-over all reach the pty
 * through the same write path as a keystroke, and counting one of those would make the
 * number go UP as the app got better at working alone. Everything else is a person - at
 * the desk or on the phone, which are the same person.
 */
export function judge(m: Moment): Verdict {
  if (m.hand === 'app') return NO('the app did it, not a person')
  // Keys that were never sent are not a separate intervention: somebody typing a sentence
  // presses forty of them and steps in once, at the return.
  if (!m.submitted) return NO('typed but not sent')
  // A return at an empty composer answered nothing, sent nothing and asked nothing - the
  // same reading `isBareReturn` exists for in the Ready group.
  if (m.bare) return NO('a bare return sent nothing')
  if (m.asking) return { counts: true, why: 'you answered a question the app would not' }
  if (m.running) return { counts: true, why: 'you stepped into a turn that was running' }
  return { counts: true, why: 'you had to say what to do next' }
}

/** One counted intervention, as `interventions.log` records it. */
export interface Note {
  at: number
  session: string
  project: string
  why: string
  /** how many this pane has now cost, including this one */
  count: number
}

/** The log line. One per intervention, tab separated, newest appended. */
export function noteLine(n: Note): string {
  return [new Date(n.at).toISOString(), n.session, n.project, String(n.count), n.why].join('\t') + '\n'
}

/**
 * What the card says.
 *
 * Zero is the interesting reading and gets its own sentence, because "0 times" reads as a
 * missing number rather than as the thing the milestone is aiming at.
 */
export function interventionWords(count: number | undefined): string {
  if (count === undefined) return ''
  if (count === 0) return 'you have not had to step in'
  if (count === 1) return 'you stepped in once'
  return `you stepped in ${count} times`
}
