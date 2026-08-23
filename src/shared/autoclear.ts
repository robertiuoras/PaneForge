// The countdown in front of an automatic /clear.
//
// A Stop hook (`claude-config/autoclear.mjs`) decides that a session has grown past the
// context line AND has next steps a fresh session could start on, and asks this app to
// clear the pane. Until 2026-08-23 it typed `/clear` straight into the pty, which meant
// the first Robert knew of it was his session already gone. His words: "it shouldnt be
// auto clearing instantly or at least put popup for a countdown when its about to auto
// clear just so i can stop it if needed".
//
// So the ask lands here instead: the desk draws a card with what would be continued and a
// countdown, and anybody at the desk can stop it. Nobody at the desk means it happens by
// itself, which is the whole point of the feature - a clear that needs a person is a
// reminder, and reminders were what this replaced.
//
// Every refusal below is a way an automatic /clear destroys work:
//
//   - no steps                -> a clear that continues nothing just costs a fresh cache.
//   - the pane started a turn -> he asked it something during the countdown; a /clear
//                                queued behind that turn would land on the answer.
//   - he typed into it        -> somebody is here and using this pane.
//   - the pane is gone        -> nothing to clear, and the id may now be another pane's.
//
// `clearTick` is deliberately re-evaluated on every tick against a FRESH pane reading
// rather than trusting what was true when the ask arrived - same rule as handoffQueue.

/** The fields of a pane this decision reads. Loose so a test can build one. */
export interface ClearPane {
  id: string
  status: string
  /** epoch ms the current turn started, absent when nothing is running */
  runSince?: number
  /** epoch ms of the most recent keystroke or prompt in this pane */
  lastKeyboard: number
}

/** What the hook asks for. */
export interface ClearRequest {
  paneId: string
  /** the open next steps, as the handoff wrote them - shown so the card says WHY */
  steps: string[]
  /** what gets typed after the clear, to start the fresh session on those steps */
  prompt: string
  /** how long the card counts down for. Clamped. */
  seconds?: number
}

/** A countdown in flight. */
export interface ClearAsk {
  paneId: string
  title: string
  steps: string[]
  prompt: string
  askedAt: number
  dueAt: number
  /** the pane's `lastKeyboard` when the ask arrived - a later one means somebody is here */
  keyboardAt: number
}

export type ClearVerdict =
  | { act: 'wait'; leftMs: number }
  | { act: 'fire' }
  | { act: 'drop'; reason: string }

/** Default countdown. Long enough to read the card and reach it, short enough to be automatic. */
export const CLEAR_COUNTDOWN_MS = 45_000
export const MIN_COUNTDOWN_MS = 5_000
export const MAX_COUNTDOWN_MS = 10 * 60_000

/**
 * The keystrokes, and why they are three.
 *
 * The submit RETURN is its OWN chunk, never glued to the prompt text: Claude Code's input
 * treats a long chunk arriving in one pty read as a PASTE and turns an embedded CR into a
 * newline instead of a submit, which on 2026-08-23 left the resume prompt sitting unsent
 * in the box after a successful /clear.
 */
export function clearChunks(prompt: string): string[] {
  return ['/clear\r', prompt, '\r']
}

/** How long between those chunks. The CLI has to finish clearing before the prompt lands. */
export const CLEAR_CHUNK_GAP_MS = 6_000

export function clampCountdown(seconds: number | undefined): number {
  const ms = Number.isFinite(seconds) ? Number(seconds) * 1000 : CLEAR_COUNTDOWN_MS
  return Math.min(MAX_COUNTDOWN_MS, Math.max(MIN_COUNTDOWN_MS, ms))
}

/** Steps worth showing: trimmed, de-bulleted, empty ones dropped. */
export function cleanSteps(steps: readonly unknown[] | undefined): string[] {
  return (steps ?? [])
    .map((s) => String(s ?? '').replace(/^\s*(?:[-*]|\d+[.)])\s+/, '').replace(/\*\*/g, '').trim())
    .filter(Boolean)
    .slice(0, 6)
}

export type ClearAccept = { ok: true; ask: ClearAsk } | { ok: false; reason: string }

/** Turn a request into a countdown, or say why not. */
export function acceptClear(
  req: ClearRequest,
  pane: ClearPane | undefined,
  now: number,
  title = ''
): ClearAccept {
  if (!pane) return { ok: false, reason: 'no such pane' }
  if (pane.status === 'exited') return { ok: false, reason: 'the pane has exited' }
  const steps = cleanSteps(req.steps)
  if (!steps.length) return { ok: false, reason: 'nothing open to continue' }
  const prompt = String(req.prompt ?? '').trim()
  if (!prompt) return { ok: false, reason: 'no resume prompt' }
  return {
    ok: true,
    ask: {
      paneId: pane.id,
      title,
      steps,
      prompt,
      askedAt: now,
      dueAt: now + clampCountdown(req.seconds),
      keyboardAt: pane.lastKeyboard
    }
  }
}

/** Should the countdown still be running, and has it run out? Re-read the pane every tick. */
export function clearTick(ask: ClearAsk, pane: ClearPane | undefined, now: number): ClearVerdict {
  if (!pane) return { act: 'drop', reason: 'the pane closed' }
  if (pane.status === 'exited') return { act: 'drop', reason: 'the pane exited' }
  if (pane.runSince) return { act: 'drop', reason: 'the pane started another turn' }
  if (pane.lastKeyboard > ask.keyboardAt) return { act: 'drop', reason: 'you typed into it' }
  if (now >= ask.dueAt) return { act: 'fire' }
  return { act: 'wait', leftMs: ask.dueAt - now }
}
