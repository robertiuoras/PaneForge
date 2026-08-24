// A session that has grown too big clears ITSELF, and says so first.
//
// The Stop hook (`claude-config/autoclear.mjs`) decides WHETHER: past the token line, with
// a fresh handoff whose Next steps a fresh session could actually start on. It then asks
// this app to do it, because the hook cannot draw anything - it is a process that exits.
// This module is the part that must be right on screen: a countdown somebody can stop.
//
// It was written against a channel that did not exist. `pane-clear.mjs` called
// `autoclear:ask`, PaneForge had never implemented it, the call failed inside a DETACHED
// child with `stdio: 'ignore'`, and the hook had already written `cleared` to its state
// file - so every one of the five clears logged on 2026-08-23 (03:23, 03:33, 06:13, 07:13,
// 08:07) silently did nothing and could never retry. Hence the two rules below.

/**
 * The keystrokes, in the order they are sent and SPLIT the way they are sent.
 *
 * The submit RETURN is its own chunk and is never glued to the prompt: Claude Code treats
 * a long chunk arriving in one pty read as a PASTE, and a CR inside a paste is a newline
 * rather than a submit - which left the resume prompt sitting unsent in the box after a
 * successful /clear. `/clear\r` is under the paste threshold, so only the long one failed.
 * The hook keeps the same list (`paneChunks`); `npm run test:autoclear` pins them equal.
 */
export function clearChunks(prompt: string): string[] {
  return ['/clear\r', prompt, '\r']
}

/** Between chunks, so the CLI has processed the clear before the prompt arrives. */
export const CHUNK_GAP_MS = 400

export const MIN_SECONDS = 5
export const MAX_SECONDS = 300

export function clampSeconds(n: unknown): number {
  const s = Math.round(Number(n))
  if (!Number.isFinite(s)) return 45
  return Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, s))
}

export interface AutoClearAsk {
  paneId: string
  steps: string[]
  prompt: string
  seconds: number
}

/**
 * What arrived over the wire, or null.
 *
 * The phone server reaches this channel, so the payload is data from outside: everything
 * is re-checked here rather than trusted. A missing prompt is refused outright - clearing
 * a session and then typing nothing is the one outcome worse than not clearing, because
 * the context is gone AND nothing says what it was doing.
 */
export function readAsk(raw: unknown): AutoClearAsk | null {
  const o = raw as Partial<AutoClearAsk> | null
  if (!o || typeof o !== 'object') return null
  const paneId = typeof o.paneId === 'string' ? o.paneId.trim() : ''
  const prompt = typeof o.prompt === 'string' ? o.prompt.trim() : ''
  if (!paneId || !prompt) return null
  const steps = Array.isArray(o.steps)
    ? o.steps.filter((s): s is string => typeof s === 'string' && !!s.trim()).slice(0, 12)
    : []
  return { paneId, steps, prompt, seconds: clampSeconds(o.seconds) }
}

/**
 * Why an armed countdown is dropped without clearing anything.
 *
 * A countdown is a promise that nothing happens for N seconds, so anything that makes the
 * session USEFUL again cancels it: somebody typing, or the pane starting another turn. The
 * asymmetry is deliberate - a wrong cancel costs one oversized session, a wrong clear costs
 * a conversation that cannot be got back.
 */
export type DropReason = 'typed' | 'working' | 'gone' | 'asked' | 'cancelled'

export function dropFor(pane: { runSince?: number | null; ask?: unknown } | null): DropReason | null {
  if (!pane) return 'gone'
  // A pane holding a live question is owed an answer by a PERSON, and clearing it throws
  // that question away along with the conversation that raised it.
  if (pane.ask) return 'asked'
  if (pane.runSince) return 'working'
  return null
}

export function dropWords(why: DropReason): string {
  if (why === 'typed') return 'you started typing'
  if (why === 'working') return 'the pane started another turn'
  if (why === 'asked') return 'the agent is asking something'
  if (why === 'gone') return 'the pane closed'
  return 'you stopped it'
}

/**
 * What to do with an ask, given why the pane cannot be cleared this instant.
 *
 * Split out of the manager so it can be tested: the bug that killed this feature for a
 * whole day was a one-word decision buried in `armAutoClear`. The Stop hook runs INSIDE
 * the turn it ends, so `dropFor` says 'working' for essentially EVERY ask - refusing on
 * that meant the countdown never started, and ~/.claude/autoclear.log recorded six of
 * seven arms as "no countdown: the pane started another turn" within the same second as
 * the decision to clear.
 *
 * 'working' therefore QUEUES: the countdown starts when the turn ends. Everything else
 * still refuses, because a pane holding a question or a pane that has closed will not
 * become clearable by waiting.
 */
export function armDecision(why: DropReason | null): 'arm' | 'queue' | 'refuse' {
  if (!why) return 'arm'
  return why === 'working' ? 'queue' : 'refuse'
}
