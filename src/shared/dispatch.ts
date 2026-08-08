// Which agent, which model, how long, and how hard to check it afterwards.
//
// D1 of `docs/agentic-dispatch.md`. A model call to decide which model to call is the
// wrong shape - it costs the thing it is trying to save, it is slower than the decision it
// makes, and it cannot be tested. So the router is arithmetic over the ask, and it is
// checked the way `shared/place.ts` is: a table of real asks in, a table of decisions out.
// `npm run test:dispatch`.
//
// The thing that makes a cheap tier honest is the GATE, not the model. Tier A is not a bet
// that Sonnet is good enough; it is a bet that a diffstat, a typecheck and the repo's own
// suite can tell whether it was. A repo that cannot check itself therefore has no cheap
// tier at all - the money saved there is spent by a person reading the diff instead.

import { HEADLESS } from './agentic'

export type Tier = 'A' | 'B' | 'C'
export type Effort = 'low' | 'medium' | 'high'
export type GateStep = 'diff' | 'typecheck' | 'suite' | 'review'

export interface Ask {
  /** What was asked for, in the words it was asked in. */
  text: string
  /** Paths the ask names, already resolved against the repo. */
  files?: string[]
  repo?: {
    hasTests?: boolean
    hasTypecheck?: boolean
  }
  history?: {
    /** `promptKey` has seen this ask before. */
    sameAskBefore?: boolean
    /** ...and the last attempt did not pass its gate. */
    lastAttemptFailed?: boolean
    /** The tier that attempt ran on, so the next one cannot repeat it. */
    lastTier?: Tier
  }
  /** `dispatch.freeFirst`: try a free CLI before a paid one, tier A only. */
  freeFirst?: boolean
}

export interface Plan {
  tier: Tier
  agent: string
  model: string
  effort: Effort
  budgetMs: number
  gate: GateStep[]
  /** Open a pane and let it be watched, or run it out of sight. */
  watch: boolean
  /** One line, in the words the board prints. */
  why: string
}

/**
 * Words that mean "this touches the whole repository", whatever the file count says.
 *
 * A rename with one file named in it is still a rename: the one file is where the person
 * happened to notice it. This list is deliberately short and deliberately about SCOPE -
 * "refactor" is not on it, because most refactors named in an ask are one function.
 */
const WIDE = [
  'rename',
  'renaming',
  'migrate',
  'migration',
  'upgrade',
  'everywhere',
  'all the',
  'every file',
  'across the',
  'throughout',
  'the whole',
  'repo-wide',
  'codebase'
]

/** The paid tiers, cheapest first. `agent` is what `HEADLESS` already knows how to start. */
const TIERS: Record<Tier, Omit<Plan, 'why' | 'tier'>> = {
  A: {
    agent: 'claude',
    model: 'sonnet',
    effort: 'low',
    budgetMs: 6 * 60_000,
    gate: ['diff', 'typecheck', 'suite'],
    watch: true
  },
  B: {
    agent: 'claude',
    model: 'sonnet',
    effort: 'high',
    budgetMs: 15 * 60_000,
    gate: ['diff', 'typecheck', 'suite', 'review'],
    watch: true
  },
  C: {
    agent: 'claude',
    model: 'opus',
    effort: 'high',
    budgetMs: 40 * 60_000,
    gate: ['diff', 'typecheck', 'suite', 'review'],
    watch: true
  }
}

/** A free CLI has no reviewer worth failing closed on, so it is only ever tier A. */
const FREE = 'gemini'

const order: Tier[] = ['A', 'B', 'C']

/** The next tier up, or null at the ceiling - which is an answer, not a failure. */
export function escalate(from: Tier): Tier | null {
  const i = order.indexOf(from)
  return i >= 0 && i + 1 < order.length ? order[i + 1] : null
}

/** Does the ask name a change that cannot be local, whatever it names? */
export function wideAsk(text: string): boolean {
  const t = text.toLowerCase()
  return WIDE.some((w) => t.includes(w))
}

/**
 * A quoted symbol, error string or path in the ask - the strongest signal that somebody
 * has already found the work, which is the difference between a small ask and a big one.
 */
export function pinpointed(text: string): boolean {
  return /["'`][^"'`\n]{3,}["'`]/.test(text) || /\b\w+\.(ts|tsx|js|mjs|css|json|py|go|rs)\b/.test(text)
}

/**
 * The tier this ask starts on.
 *
 * The signals in the order they decide anything, and the first two are the ones that stop
 * the cheap tier being a lie:
 *
 *  1. **What the repo can prove.** No typecheck and no suite means the gate is two skipped
 *     steps and a reviewer - it cannot tell a good diff from a bad one, so nothing may be
 *     routed cheaply into it. (`agentGate` reports a missing step as *skipped*; a plan that
 *     counts on a step that will be skipped is a plan with no gate.)
 *  2. **Whether it has been tried.** A second attempt never gets the tier the first one
 *     failed on.
 *  3. **Words that name a whole-repo change** - never tier A, whatever the file count.
 *  4. **How many files the ask names.** Zero is the strongest signal of a BIG ask, not a
 *     small one: it means nobody has located the work yet. One named file with a quoted
 *     symbol or error string in the text is the small one.
 */
export function tierFor(ask: Ask): { tier: Tier; why: string } {
  const files = ask.files ?? []
  const provable = Boolean(ask.repo?.hasTypecheck) && Boolean(ask.repo?.hasTests)
  const failed = Boolean(ask.history?.lastAttemptFailed)
  const floor: Tier | null = failed ? escalate(ask.history?.lastTier ?? 'A') : null

  let tier: Tier
  let why: string
  if (!provable) {
    tier = 'B'
    why = ask.repo?.hasTypecheck
      ? 'no test script here, so the gate cannot prove a cheap run'
      : 'this repo cannot check itself, so a person reads the diff'
  } else if (wideAsk(ask.text)) {
    tier = 'C'
    why = 'the ask names a change across the whole repo'
  } else if (files.length === 0) {
    tier = 'C'
    why = 'no file named, so the work has not been found yet'
  } else if (files.length <= 1 && pinpointed(ask.text)) {
    tier = 'A'
    why = 'one file, and the ask names what to change in it'
  } else if (files.length <= 4) {
    tier = 'B'
    why = `${files.length} files named`
  } else {
    tier = 'C'
    why = `${files.length} files named`
  }

  if (floor && order.indexOf(floor) > order.indexOf(tier)) {
    return { tier: floor, why: `the last attempt failed on tier ${ask.history?.lastTier ?? 'A'}` }
  }
  // At the ceiling with a failure behind it, the honest answer is still tier C - the
  // supervisor's own retry count is what stops it, not this.
  if (failed && !floor) return { tier: 'C', why: 'tier C already, and the last attempt failed' }
  return { tier, why }
}

/**
 * The whole decision. Never throws and never returns null: an unroutable ask is a tier C
 * plan, because "this needs a person" is something the board has to be able to draw.
 */
export function route(ask: Ask): Plan {
  const { tier, why } = tierFor(ask)
  const base = TIERS[tier]
  const free = Boolean(ask.freeFirst) && tier === 'A' && Boolean(HEADLESS[FREE])
  return {
    tier,
    ...base,
    ...(free ? { agent: FREE, model: '' } : {}),
    why: free ? `${why}; free CLI first, and the gate is complete here` : why
  }
}

/** The line the board prints under a queued goal. */
export function planLine(p: Plan): string {
  const mins = Math.round(p.budgetMs / 60_000)
  const model = p.model ? ` ${p.model}` : ''
  return `tier ${p.tier} · ${p.agent}${model} · ${mins}m · ${p.gate.join(', ')} — ${p.why}`
}
