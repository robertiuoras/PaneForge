// A new chat's first ask suggests a lighter or stronger model, before any context has
// built up around it - see `main/sessions.ts` `write()` for the one moment this fires.
//
// Robert's decisions (2026-09-23), not re-derived here:
//  - ONLY a Claude Code pane's FIRST ask (`!live.meta.engaged`), never mid-conversation.
//    A model switch part-way through a chat re-sends the whole cached context, which is
//    the expensive direction to be wrong in.
//  - BOTH directions. A simple ask on a strong setup suggests lighter; a hard ask on a
//    light setup suggests stronger. Robert's own model FAMILY is kept unless the ask is
//    plainly a lookup or plainly hard - this never suggests Fable or Haiku on its own.
//  - Free, local, code-based rules. No LLM call, no network, and no keyword list on its
//    own: several signals are scored, because a single word deciding the whole card was
//    the failure `shared/effort.ts` already learned from.
//  - Silence is the safe answer. Ambiguous, or nothing distinctive either way, is `null`
//    - a wrong card costs more than no card, because a wrong one teaches "ignore this".
//
// `HIGH`/`LOW`/`CONTINUATION` are Codex's OWN signal lists from `shared/effort.ts`,
// imported rather than copied: two files each holding half-remembered opinions about
// what "hard" and "small" mean is how they quietly disagree eighteen months from now.
// Codex's own suite (`test:effort`) proves this import changed nothing about it.

import { CONTINUATION, HIGH, LOW, LOW_MAX_CHARS } from './effort'

/** The two directions this card ever points. */
export type ModelAdviceTier = 'light' | 'heavy'

/** A model FAMILY - never a dated id. The card and the `/model` command both work in
 * families; which exact id a family resolves to is the catalogue's business
 * (`shared/agents.ts`), not this file's. */
export type ModelFamily = 'opus' | 'sonnet' | 'haiku' | 'fable' | 'other'

export interface ModelAdviceInput {
  /** The line that is about to be submitted, exactly as typed. */
  prompt: string
  /** The model this pane is really running, or the launch value - `shared/paneModel.ts`. */
  model: string
  /** `low` | `medium` | `high` (or whatever `~/.claude/settings.json` names); unknown = 'medium'. */
  effort: string
  /** How many files were dropped onto the composer with this ask, if any. */
  attachments?: number
}

export interface ModelAdviceTarget {
  /** The family to switch to, or `undefined` when the current one is kept. */
  family?: ModelFamily
  effort: string
}

export interface ModelAdvice {
  tier: ModelAdviceTier
  to: ModelAdviceTarget
  /** Plain words for why - the log's field, not necessarily the card's sentence. */
  reason: string
}

/** Which family a model id or alias belongs to. `claude-opus-5-5`, `opus`, and a future
 * `claude-opus-6` all read the same: the family is the part of the name that never
 * changes underneath a version bump. */
export function modelFamily(model: string): ModelFamily {
  const m = String(model || '').toLowerCase()
  // Fable checked first: `claude-fable-5-1` contains no other family's word, but a model
  // string is never assumed to be well-formed, so order still matters if one ever did.
  if (m.includes('fable')) return 'fable'
  if (m.includes('opus')) return 'opus'
  if (m.includes('haiku')) return 'haiku'
  if (m.includes('sonnet')) return 'sonnet'
  return 'other'
}

/** A pasted stack trace or error block: several lines each naming a frame or an error. */
function stackTraceLines(text: string): number {
  return text.split('\n').filter((l) => /\bat\s|\bError\b|\bTraceback\b/.test(l)).length
}

/** Path-like tokens: `src/foo/bar.ts`, or a bare `utils.ts` with a code-shaped extension. */
const FILE_PATH_RE =
  /\b[\w.-]+\/[\w./-]+\.\w+\b|\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|swift|c|cpp|h|hpp|json|css|scss|html|md|yml|yaml|sh|sql)\b/g

function distinctFilePaths(text: string): number {
  return new Set(text.match(FILE_PATH_RE) ?? []).size
}

/** A numbered or bulleted list, counted by its own lines rather than by one match. */
const TASK_LINE_RE = /^\s*(?:\d+[.)]|[-*])\s+\S/gm

function taskListLines(text: string): number {
  return (text.match(TASK_LINE_RE) ?? []).length
}

/** Words that name planning or investigation work, distinct from Codex's own HIGH list
 * (some overlap - `flaky`, `security` - is fine: two signals agreeing is not a bug). */
const HEAVY_WORDS = /\b(plan|design|investigat\w*|root cause|race|flaky|security|performance)\b/

/** A build/change verb inside a question means it is asking for WORK, not an answer -
 * "what is the port the dev server uses?" is a lookup, "what should I build here?" is not. */
const IMPERATIVE_VERBS =
  /\b(build|implement|create|write|add|refactor|migrate|fix|design|architect|integrate|configure|set ?up|generate|make)\b/

/** Ends `?`, short, and asks for an answer rather than for work. */
function isPureQuestion(raw: string): boolean {
  const t = raw.trim()
  if (!t.endsWith('?')) return false
  if (t.length > 120) return false
  return !IMPERATIVE_VERBS.test(t.toLowerCase())
}

/**
 * The whole rule: score the heavy signals, score the light signals, and answer only when
 * exactly one side has anything to say.
 *
 * `null` covers three shapes on purpose, not one: a bare continuation with nothing to
 * judge, a genuinely ambiguous ask (both sides scored), and a plain one (neither side
 * scored). All three are the same answer - say nothing - so they are not told apart.
 */
export function judgeModelAdvice(input: ModelAdviceInput): ModelAdvice | null {
  const raw = String(input.prompt || '')
  const text = raw.trim()
  if (!text) return null
  const lower = text.toLowerCase()
  const bare = lower.replace(/[.!?,;:]+$/, '').trim()
  if (CONTINUATION.test(bare)) return null

  const heavySignals: string[] = []
  for (const [re, words] of HIGH) {
    if (re.test(lower)) {
      heavySignals.push(words)
      break // the same one word `highReason` in effort.ts would have given
    }
  }
  if (stackTraceLines(text) >= 3) heavySignals.push('a pasted error')
  if (distinctFilePaths(text) >= 3) heavySignals.push('work across several files')
  if (taskListLines(text) >= 3) heavySignals.push('a multi-step list')
  if (raw.length > 600) heavySignals.push('a long ask')
  if (HEAVY_WORDS.test(lower)) heavySignals.push('planning or investigation')
  if ((input.attachments ?? 0) > 0) heavySignals.push('a file attached')

  const lightSignals: string[] = []
  if (LOW.test(lower) && raw.length < LOW_MAX_CHARS) lightSignals.push('small edit or lookup')
  const pureLookup = isPureQuestion(raw)
  if (pureLookup) lightSignals.push('a quick lookup')

  const heavy = heavySignals.length > 0
  const light = lightSignals.length > 0
  if (heavy === light) return null // both scored (ambiguous), or neither (plain) - silence either way

  const family = modelFamily(input.model)
  const effort = String(input.effort || 'medium').toLowerCase()

  if (heavy) {
    // Already the family this problem deserves: a sonnet/haiku pane is offered Opus, and
    // an opus/fable pane (or one this build has never named) is left on its own family.
    const targetFamily: ModelFamily = family === 'opus' || family === 'fable' ? family : 'opus'
    if (targetFamily === family && effort === 'high') return null
    return {
      tier: 'heavy',
      to: { family: targetFamily === family ? undefined : targetFamily, effort: 'high' },
      reason: heavySignals[0]
    }
  }

  // A pure lookup on Opus or Fable is offered Sonnet; every other light ask keeps the
  // family Robert chose and only turns the effort down.
  const targetFamily: ModelFamily = pureLookup && (family === 'opus' || family === 'fable') ? 'sonnet' : family
  if (targetFamily === family && effort === 'low') return null
  return {
    tier: 'light',
    to: { family: targetFamily === family ? undefined : targetFamily, effort: 'low' },
    reason: lightSignals[0]
  }
}
