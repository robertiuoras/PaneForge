// Classify the draft, and decide what an improvement of that kind should contain.
//
// Deterministic first, and deliberately so: every rule that can be a regex should be,
// because a regex is free, testable and cannot hallucinate. The model is given the
// classifier's answer as a prior and allowed to disagree - it sees the draft and the
// keyword table does not - but the table decides which rules are sent, so the instruction
// budget carries one task type's rules rather than all eight.

import type { TaskType } from './promptSchema'

interface Rule {
  type: TaskType
  /** Weighted: a word that only ever means one thing scores higher. */
  strong: RegExp
  weak?: RegExp
  /**
   * What a `strong` hit is worth. 3 unless stated.
   *
   * `question`'s pattern is anchored to the WHOLE draft rather than matching a word
   * inside it, which is a much stronger signal than any keyword - so it outranks one.
   * Measured: "why does the build take so long?" matched `question` and `feature`
   * equally at 3 apiece, and the tie handed it to whichever rule came first in this
   * list, which was `feature`.
   */
  weight?: number
}

const RULES: Rule[] = [
  {
    type: 'bugfix',
    strong: /\b(bug|broken|breaks?|crash(?:es|ing)?|fails?|failing|error|exception|regress\w*|stack ?trace|not working|doesn'?t work|won'?t work)\b/i,
    weak: /\b(fix|wrong|unexpected|should be|instead of|reproduce|repro)\b/i
  },
  {
    type: 'feature',
    // `build` only counts as the verb. Bare `build` also matches "the build", "build
    // fails" and "why does the build take so long", which is a question about CI, not a
    // feature request - and it beat the question rule on a tie.
    strong: /\b(add|implement|create|introduce|support for|build(?:ing)? (?:a|an|the|out)\b|new (?:page|feature|endpoint|command|screen))\b/i,
    weak: /\b(want|need|would like|can you make|feature)\b/i
  },
  {
    type: 'refactor',
    strong: /\b(refactor|clean ?up|tidy|simplif\w+|extract|rename|deduplicat\w+|restructure|migrate to)\b/i,
    weak: /\b(readable|maintainab\w+|split|move)\b/i
  },
  {
    type: 'research',
    strong: /\b(research|compare|evaluate|investigate|what'?s the best|which (?:library|approach|option)|pros and cons|trade[- ]?offs?)\b/i,
    weak: /\b(should i|options|alternatives|why does)\b/i
  },
  {
    type: 'design',
    strong: /\b(design|ui|ux|layout|styling|visual|landing page|signup|sign[- ]?up|hero|typography|palette|animation|responsive|brand)\b/i,
    weak: /\b(look|feel|pretty|modern|distinctive|polish)\b/i
  },
  {
    type: 'ops',
    // `deploy\w*` rather than `deploy|deployment`: "deployed env" matched neither, and the
    // draft it came from - rotate a key that is in the deployed env - scored as a FEATURE
    // on the word "want" alone. Scheduled work is here for the same reason: a cron that
    // stopped reporting a heartbeat had no ops keyword at all and classified as `other`.
    // Both measured by `prompt-eval.mjs`, which is what the golden set is for.
    strong: /\b(deploy\w*|ci\b|pipeline|docker|kubernetes|k8s|release|rollback|migration|infra\w*|terraform|env(?:ironment)? var\w*|cron|scheduler|scheduled (?:job|task)|heartbeat|rotate|credentials?)\b/i,
    weak: /\b(server|production|prod\b|staging|build fails|nightly|secret)\b/i
  },
  {
    type: 'question',
    strong: /^\s*(what|why|how|where|when|who|is|are|does|do|can|should|could)\b[^.!]*\?\s*$/i,
    weight: 4
  }
]

export interface Classification {
  type: TaskType
  confidence: 'low' | 'medium' | 'high'
  /** Terms worth handing to retrieval. Lowercased, deduplicated. */
  keywords: string[]
}

const STOP = new Set(
  ('a an the and or but if then than that this these those i we you it is are was were be been being ' +
    'do does did have has had can could should would will shall may might must to for of in on at by ' +
    'with from as so not no yes please make made get got need want use using my our your its it\'s ' +
    'about into over under out up down just really very some any all more most other')
    .split(' ')
)

export function classify(draft: string): Classification {
  const scores = new Map<TaskType, number>()
  for (const rule of RULES) {
    let s = 0
    if (rule.strong.test(draft)) s += rule.weight ?? 3
    if (rule.weak?.test(draft)) s += 1
    if (s) scores.set(rule.type, (scores.get(rule.type) ?? 0) + s)
  }

  let type: TaskType = 'other'
  let best = 0
  let runnerUp = 0
  for (const [t, s] of scores) {
    if (s > best) {
      runnerUp = best
      best = s
      type = t
    } else if (s > runnerUp) runnerUp = s
  }

  // Confidence is the GAP, not the score. Two task types matching equally well is exactly
  // the case where the model's reading should win, and the gap is what says so.
  const gap = best - runnerUp
  const confidence = best === 0 ? 'low' : gap >= 3 ? 'high' : gap >= 1 ? 'medium' : 'low'

  const keywords = [
    ...new Set(
      draft
        .toLowerCase()
        .split(/[^a-z0-9+#.-]+/)
        .filter((w) => w.length > 2 && !STOP.has(w))
    )
  ].slice(0, 24)

  return { type, confidence, keywords }
}

/**
 * What an improvement of this kind must contain, in the fewest words that say it.
 *
 * One task type's rules, not all of them: a generic checklist is the thing this feature
 * exists to stop producing, and sending eight of them would guarantee one.
 */
export const TASK_RULES: Record<TaskType, string> = {
  bugfix:
    'State what was observed, what was expected, and the smallest way to reproduce it. Name the file or screen if the draft implies one. Ask for a verification command only if the project has one.',
  feature:
    'State the outcome a user can see, the surface it appears on, and what "done" means. Keep any constraint the draft gave. Do not invent acceptance criteria the draft did not imply.',
  refactor:
    'State what changes shape and what must not change behaviour. Name the test or check that proves behaviour held.',
  research:
    'State the decision being made and what would settle it. Ask for the constraints that rule options out (budget, licence, runtime, existing stack). Do not pre-pick an answer.',
  design:
    'State who it is for, what it must make them do, and the one impression it must leave. Carry any existing design system. Prefer describing the intent over naming libraries.',
  ops:
    'State the environment, the current state and the desired state. Call out anything destructive or irreversible explicitly so it is confirmed before it runs.',
  question:
    'Keep it a question. Add only the context that changes the answer. Do not turn it into a task.',
  other: 'Say what is wanted, on what, and what a good result looks like. Cut everything else.'
}

/**
 * Cheap local gates before anything is spawned.
 *
 * Free, and they catch most of what should never cost a model call.
 */
export function tooSmallToImprove(draft: string): string | null {
  const t = draft.trim()
  if (t.length < 40) return 'too short to be worth improving'
  if (/^\/\S/.test(t)) return 'that is a slash command, not a prompt'
  if (/^(y|n|yes|no|ok|okay|sure|continue|go ahead|1|2|3)\b/i.test(t) && t.length < 60) {
    return 'that is an answer to the agent, not a prompt'
  }
  return null
}
