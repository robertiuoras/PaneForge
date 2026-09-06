// How hard a Codex pane thinks, decided from the ask rather than from a menu.
//
// Codex's own TUI carries the control already: Shift+Up and Shift+Down step its reasoning
// effort up and down a ladder the model itself publishes. Nothing in this file talks to
// Codex - it is the arithmetic only, the same split every other reading in this app uses
// (`shared/paneModel.ts` parses, `main/paneModel.ts` reads the disk), because a node test
// can follow a value import into a shared file and never into a main-side one.
//
// Three rules the whole design rests on:
//  - A level is only ever CLAIMED once the rollout on disk says so. The TUI's own footer
//    is a screen, and a screen is not evidence (see the stale-frame lesson).
//  - Nothing is pressed while a turn is running. Arrow keys into a busy composer are
//    keystrokes into somebody's work.
//  - One change in flight at a time. Two decisions racing each other up and down the
//    ladder is the oscillation this refuses by construction.

/** Codex's `increase_reasoning_effort` / `decrease_reasoning_effort` keys, as bytes. */
export const EFFORT_UP = '\x1b[1;2A'
export const EFFORT_DOWN = '\x1b[1;2B'

/** How many ordinary prompts keep High after a hard problem was named. */
export const HIGH_HOLD_TURNS = 3

/** How long an unconfirmed change blocks the next one. A turn is normally seconds. */
export const PENDING_MAX_MS = 2 * 60 * 1000

/** Between two presses, and between the last press and the return that follows it. */
export const EFFORT_PRESS_GAP_MS = 120
export const EFFORT_SETTLE_MS = 250

/** The three the rule itself picks. The ladder underneath may be longer. */
export type AutoLevel = 'low' | 'medium' | 'high'

export interface EffortState {
  mode: 'auto' | 'manual'
  /** the level a person chose by hand; it stays in force until Auto is restored */
  manual?: string
  /** the newest level the rollout has actually shown - the only level ever claimed */
  confirmed?: string
  /** what the pane was launched with, until the first rollout line proves otherwise */
  launched?: string
  /** a change that has been typed and not yet seen in the rollout */
  pending?: { level: string; at: number }
  /** what this model says it supports, newest first-hand answer from the app-server */
  ladder?: string[]
  /** plain words for the card */
  reason: string
  /** how many more ordinary prompts keep High while a hard problem is open */
  holdTurns?: number
}

/** Where a name sits, so a ladder missing a rung can still be aimed at. */
const RANK: Record<string, number> = {
  minimal: 0,
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
  ultra: 6
}

interface ModelRow {
  id?: string
  model?: string
  supportedReasoningEfforts?: Array<{ reasoningEffort?: string } | string>
}

/**
 * The levels this model offers, out of the app-server's `model/list` answer.
 *
 * Tolerant on purpose: the answer arrives as a JSON-RPC frame in one build and as the
 * bare result in the next, the rows live under `data` or `models`, and a row names itself
 * with `id` or `model`. Anything it cannot read is `undefined`, which every caller treats
 * as "Codex did not say" - never as an empty ladder, which would read as "no levels".
 */
export function ladderFromModelList(payload: unknown, model: string): string[] | undefined {
  const want = String(model || '').trim()
  if (!want) return undefined
  const seen = new Set<unknown>()
  const rowsOf = (node: unknown, depth = 0): ModelRow[] | undefined => {
    if (!node || typeof node !== 'object' || depth > 4 || seen.has(node)) return undefined
    seen.add(node)
    const obj = node as Record<string, unknown>
    for (const key of ['data', 'models']) {
      const list = obj[key]
      if (Array.isArray(list)) return list as ModelRow[]
    }
    for (const key of ['result', 'payload', 'body']) {
      const found = rowsOf(obj[key], depth + 1)
      if (found) return found
    }
    return undefined
  }
  const rows = rowsOf(payload)
  if (!rows) return undefined
  const row = rows.find((r) => r && (r.id === want || r.model === want))
  const raw = row?.supportedReasoningEfforts
  if (!Array.isArray(raw)) return undefined
  const out: string[] = []
  for (const entry of raw) {
    const name = typeof entry === 'string' ? entry : entry?.reasoningEffort
    const level = String(name || '').trim().toLowerCase()
    if (level && !out.includes(level)) out.push(level)
  }
  return out.length ? out : undefined
}

const CONTINUATION =
  /^(continue|go on|carry on|proceed|next|yes|ok|okay|do it|same again|keep going)$/

const RESOLVED = /\b(works now|fixed|all good|passing|that's it|thats it|thanks|done)\b/

/** Word-boundary signals that a problem is hard, and the plain words for each group. */
const HIGH: Array<[RegExp, string]> = [
  [/\b(security|auth|token|secret|credential|permission|vulnerab\w*|injection)\b/, 'security-sensitive'],
  [
    /\b(why|diagnos\w*|investigat\w*|root cause|debug\w*|flaky|intermittent|race|deadlock|regression|crash\w*|hang\w*|leak\w*)\b/,
    'hard diagnosis'
  ],
  [
    /(\bstill (fails|failing|broken|not working|wrong)\b|\bdidn'?t work\b|\bdoes ?n'?t work\b|\bnot working\b|\bagain\b)/,
    'repeated failed attempts'
  ],
  [/\b(migrat\w*|architect\w*|trade-?offs?|design decision|refactor across)\b/, 'a difficult tradeoff']
]

const LOW =
  /\b(rename|typo|format|lint|indent|comment|what is|where is|show me|list|find|grep|print|read|open|explain this line|bump|add import|remove unused|wording|label)\b/

/** The longest an ask can be and still be a lookup. Past this it is work. */
const LOW_MAX_CHARS = 160

function highReason(text: string, failures?: number): string | undefined {
  if ((failures ?? 0) >= 2) return 'repeated failed attempts'
  for (const [re, words] of HIGH) if (re.test(text)) return words
  return undefined
}

function isAutoLevel(level: string | undefined): level is AutoLevel {
  return level === 'low' || level === 'medium' || level === 'high'
}

/**
 * How hard THIS ask looks, given what the pane is already working on.
 *
 * The context matters as much as the words: "continue" on its own says nothing about
 * difficulty, and downgrading a hard investigation because somebody typed one word is the
 * failure this whole rule exists to avoid. So a short continuation keeps the level the
 * pane is already at, and a named hard problem holds High for `HIGH_HOLD_TURNS` ordinary
 * prompts afterwards - ended early by an explicitly small ask or by a sentence saying the
 * problem is solved.
 */
export function classifyEffort(
  prompt: string,
  ctx: { active?: string; failures?: number; holdTurns?: number } = {}
): { level: AutoLevel; reason: string; holdTurns: number } {
  const raw = String(prompt || '').trim()
  const text = raw.toLowerCase()
  const words = text.split(/\s+/).filter(Boolean)
  const bare = text.replace(/[.!?,;:]+$/, '').trim()
  const high = highReason(text, ctx.failures)
  const low = !high && LOW.test(text) && raw.length < LOW_MAX_CHARS
  const cont = CONTINUATION.test(bare) || (words.length > 0 && words.length <= 3 && !high && !low)
  const hold = Math.max(0, ctx.holdTurns ?? 0)

  if (high && !cont) return { level: 'high', reason: high, holdTurns: HIGH_HOLD_TURNS }
  if (low) return { level: 'low', reason: 'small edit or lookup', holdTurns: 0 }

  const kept = cont && isAutoLevel(ctx.active) ? ctx.active : 'medium'
  const reason = cont ? 'continuing the task' : 'routine implementation'
  if (RESOLVED.test(text)) {
    return { level: kept === 'high' ? 'medium' : kept, reason, holdTurns: 0 }
  }
  if (ctx.active === 'high' && hold > 0) {
    return { level: 'high', reason: 'kept while the problem is open', holdTurns: hold - 1 }
  }
  // A continuation was holding High on the pane's behalf; the hold has run out.
  return { level: kept === 'high' ? 'medium' : kept, reason, holdTurns: 0 }
}

/**
 * The ladder entry to aim at for one of the three levels.
 *
 * A model whose ladder skips a rung (no `high`) still gets the closest thing BELOW the
 * one asked for - never above, because spending more of somebody's weekly limit than the
 * rule asked for is the expensive direction to be wrong in.
 */
export function autoTarget(level: AutoLevel, ladder: string[]): string | undefined {
  if (!ladder?.length) return undefined
  if (ladder.includes(level)) return level
  const want = RANK[level]
  let best: string | undefined
  let bestRank = -1
  for (const entry of ladder) {
    const rank = RANK[entry]
    if (rank === undefined || rank > want || rank <= bestRank) continue
    best = entry
    bestRank = rank
  }
  return best
}

/** The keys that walk the ladder from one entry to another, or null when they cannot. */
export function planEffortKeys(
  from: string,
  to: string,
  ladder: string[]
): { seq: string; presses: number } | null {
  const a = ladder.indexOf(from)
  const b = ladder.indexOf(to)
  if (a < 0 || b < 0 || a === b) return null
  const presses = Math.abs(b - a)
  return { seq: (b > a ? EFFORT_UP : EFFORT_DOWN).repeat(presses), presses }
}

export type EffortRefusal = 'busy' | 'no-ladder' | 'unknown-level' | 'pending'

export interface EffortDecision {
  target?: string
  reason: string
  holdTurns: number
  refused?: EffortRefusal
}

/**
 * What to do about effort for the turn that is about to start, and nothing else.
 *
 * Every refusal keeps the pane exactly as it is and lets the prompt through unchanged.
 * That is the contract: this feature may make a turn think harder, and may never stop one
 * happening.
 */
export function decideBeforeTurn(
  state: EffortState,
  prompt: string,
  opts: { busy: boolean; now: number }
): EffortDecision {
  const hold = Math.max(0, state.holdTurns ?? 0)
  if (opts.busy) return { reason: 'kept: the pane was busy', holdTurns: hold, refused: 'busy' }
  if (state.pending && opts.now - state.pending.at < PENDING_MAX_MS) {
    return { reason: 'kept: the last change has not landed yet', holdTurns: hold, refused: 'pending' }
  }
  const ladder = state.ladder
  if (!ladder?.length) {
    return { reason: "Codex did not list its levels", holdTurns: hold, refused: 'no-ladder' }
  }
  const from = state.confirmed ?? state.launched
  if (!from || !ladder.includes(from)) {
    return { reason: "waiting for Codex's first reply", holdTurns: hold, refused: 'unknown-level' }
  }
  if (state.mode === 'manual') {
    const want = state.manual
    if (!want || !ladder.includes(want)) {
      return { reason: 'Codex does not offer that level', holdTurns: hold, refused: 'unknown-level' }
    }
    if (want === from) return { reason: 'set by hand', holdTurns: hold }
    return { target: want, reason: 'set by hand', holdTurns: hold }
  }
  const call = classifyEffort(prompt, {
    active: isAutoLevel(from) ? from : undefined,
    holdTurns: hold
  })
  const target = autoTarget(call.level, ladder)
  if (!target) {
    return { reason: 'Codex does not offer that level', holdTurns: call.holdTurns, refused: 'unknown-level' }
  }
  if (target === from) return { reason: call.reason, holdTurns: call.holdTurns }
  return { target, reason: call.reason, holdTurns: call.holdTurns }
}

/**
 * The rollout said `seen` for the newest turn. That, and only that, is what confirms a
 * level: the keys may have been eaten by a menu, a trust prompt, or a composer that was
 * not where it looked.
 */
export function confirmEffort(state: EffortState, seen: string, now = Date.now()): EffortState {
  void now
  const level = String(seen || '').trim().toLowerCase()
  if (!level) return state
  const missed = state.pending && state.pending.level !== level
  return {
    ...state,
    confirmed: level,
    pending: undefined,
    reason: missed ? `Codex answered ${level}, kept it` : state.reason
  }
}

function capitalise(word: string): string {
  return word ? word[0].toUpperCase() + word.slice(1) : word
}

/**
 * The card's half of the state: the level the rollout CONFIRMED, the words for why, and
 * the levels this model offers. Structurally the same as `PaneEffort` in `shared/types.ts`,
 * written out here rather than imported because a bare `node` test run cannot follow an
 * extensionless sibling import into that file.
 */
export interface EffortReading {
  mode: 'auto' | 'manual'
  level?: string
  reason: string
  ladder?: string[]
}

/** What the card says. Plain words - the reader has never used a CLI. */
export function effortWords(reading: EffortReading): string {
  if (reading.mode === 'manual') {
    return reading.level ? `Manual: ${capitalise(reading.level)}` : 'Manual'
  }
  if (!reading.ladder?.length) return 'Auto: Codex did not list its levels'
  if (!reading.level) return "Auto: waiting for Codex's first reply"
  return `Auto: ${capitalise(reading.level)} · ${reading.reason}`
}

/** The short form beside the model chip. */
export function effortChip(reading: EffortReading): string {
  if (!reading.level) return reading.mode === 'manual' ? 'Manual' : 'Auto'
  const how = reading.mode === 'manual' ? 'Manual' : 'Auto'
  return `${how} · ${capitalise(reading.level)}`
}

/** How much of a rollout's tail is worth reading. A turn's own line is never this long. */
export const ROLLOUT_TAIL_BYTES = 64 * 1024

interface TurnContextLine {
  type?: string
  payload?: { type?: string; effort?: string; reasoning_effort?: string; model?: string }
}

/**
 * The newest turn a Codex rollout recorded: what it ran at, and what model ran it.
 *
 * The model comes back with it because a pane launched WITHOUT a `--model` flag has no
 * other way of knowing which ladder it is on - the CLI picked the model from the person's
 * own config and this app was never told.
 *
 * Same tolerance as `lastAssistantModel`: only the tail of the file is ever handed over,
 * so the first line is usually cut in half and `JSON.parse` throwing is the normal case,
 * not an error.
 */
export function lastTurnContext(tailText: string): { effort?: string; model?: string } | undefined {
  const lines = String(tailText || '').split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line || line[0] !== '{' || !line.includes('turn_context')) continue
    let row: TurnContextLine
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (row.type && row.type !== 'turn_context') continue
    const raw = row.payload?.effort ?? row.payload?.reasoning_effort
    const effort = String(raw || '').trim().toLowerCase() || undefined
    const model = String(row.payload?.model || '').trim() || undefined
    if (effort || model) return { effort, model }
  }
  return undefined
}

/** Just the level, for the callers that only ask that. */
export function lastTurnEffort(tailText: string): string | undefined {
  return lastTurnContext(tailText)?.effort
}

/** What a new Codex pane is launched with, when this feature is on for it. */
export function effortLaunchArgs(level?: string): string[] {
  const want = String(level || '').trim()
  return want ? ['-c', `model_reasoning_effort="${want}"`] : []
}
