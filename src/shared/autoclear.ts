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

import { BUILTIN_AGENTS } from './agents'

/**
 * The keystrokes, in the order they are sent and SPLIT the way they are sent.
 *
 * The submit RETURN is its own chunk and is never glued to the prompt: Claude Code treats
 * a long chunk arriving in one pty read as a PASTE, and a CR inside a paste is a newline
 * rather than a submit - which left the resume prompt sitting unsent in the box after a
 * successful /clear. `/clear\r` is under the paste threshold, so only the long one failed.
 * The hook keeps the same list (`paneChunks`); `npm run test:autoclear` pins them equal.
 *
 * An EMPTY prompt is a clear for cost alone - nothing is open, so there is nothing to say
 * to the fresh session and typing a resume prompt would burn a turn doing nothing. The
 * hook reached the same shape first (`paneChunks('')` -> `['/clear\r']`), and the parity
 * check in `npm run test:autoclear` now pins the promptless list too.
 *
 * `command` is the CLI's own word for it, because only Claude Code spells it `/clear` -
 * Codex starts a fresh conversation with `/new`. It is a parameter rather than a lookup
 * so this stays the pure keystroke function the parity check can compare.
 */
export function clearChunks(prompt: string, command = '/clear'): string[] {
  if (!prompt.trim()) return [command + '\r']
  return [command + '\r', prompt, '\r']
}

/**
 * What this CLI calls "start again", or null for one we cannot name.
 *
 * Null is the load-bearing answer. The watcher types into a live pty with nobody
 * watching, so an agent whose clear command we are guessing at gets a guess typed into
 * somebody's session - and `/clear` in a CLI that has no such command is a prompt sent to
 * a model. Unknown therefore means DO NOTHING, for ever, rather than "probably /clear".
 *
 * The claude family is read off the catalogue rather than listed here: `openrouter`,
 * `deepseek` and `glm` are Claude Code with two environment variables changed, they share
 * every slash command, and there will be more of them. `bin === 'claude'` is the fact that
 * makes them the same CLI, so a new re-skin gets this for free instead of silently missing
 * it. A custom agent somebody added themselves is not in the catalogue and stays unknown.
 */
export function clearCommandFor(agent: string | null | undefined): string | null {
  const id = typeof agent === 'string' ? agent.trim() : ''
  if (!id) return null
  // Codex: `/clear` is not a command there. `/new` starts a fresh conversation in the same
  // folder, which is what a clear IS. Antigravity's is `/clear` and it has no `/compact`
  // at all (google-antigravity issue #40), so clearing is the only lever it has.
  if (id === 'codex') return '/new'
  if (id === 'antigravity') return '/clear'
  const spec = BUILTIN_AGENTS.find((a) => a.id === id)
  return spec?.bin === 'claude' ? '/clear' : null
}

/**
 * When each chunk goes out, relative to the fire.
 *
 * Flat 400ms gaps were not enough (2026-08-27, pane s2): `/clear` restarts the CLI's
 * session and redraws, which takes seconds, and a submit CR that arrives while it is
 * still initialising is swallowed - the prompt was left sitting in the box unsent, with
 * no newline where the CR should have been. So the prompt waits for the clear to settle,
 * and the CR arrives a beat after the prompt.
 */
export function chunkDelayMs(i: number): number {
  if (i <= 0) return 0
  return CLEAR_SETTLE_MS + (i - 1) * SUBMIT_GAP_MS
}

/**
 * Between telling the pane to file its screen and the clear command landing.
 *
 * The arm is a round trip - main -> renderer -> xterm write - and the rows have to be in
 * the scrollback BEFORE the CLI repaints over them. 120ms is a frame or two either way and
 * costs nothing: the countdown that got here was fifteen seconds long.
 */
export const ARM_CLEAR_LEAD_MS = 120

/** How long `/clear` gets to finish restarting the session before the prompt is typed. */
export const CLEAR_SETTLE_MS = 2500

/** Between the prompt landing in the composer and the CR that submits it. */
export const SUBMIT_GAP_MS = 1200

/**
 * Re-send the submit CR this long after the last chunk went out, unless somebody has
 * started typing. Enter on an empty composer is a no-op in every CLI we clear, so the
 * retry is free when the first CR landed and a rescue when the CLI swallowed it.
 */
export const SUBMIT_RETRIES_MS = [3000, 8000]

export const MIN_SECONDS = 5
export const MAX_SECONDS = 300

export function clampSeconds(n: unknown): number {
  const s = Math.round(Number(n))
  if (!Number.isFinite(s)) return 15
  return Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, s))
}

export interface AutoClearAsk {
  paneId: string
  steps: string[]
  prompt: string
  seconds: number
  /**
   * Clear and type NOTHING: there is no next step, this is context being freed.
   *
   * The only thing that may waive the "never clear without a prompt" rule below, and it
   * has to be said out loud - `noResume: true`, not an absent prompt. Measured 2026-08-26:
   * `no_open_steps` was the dominant line in ~/.claude/autoclear.log, so sessions with
   * nothing left to do sat at 185-235k tokens paying to re-read a context nobody was
   * using. Clearing those costs nothing, because there was nothing to carry.
   */
  noResume?: boolean
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
  // `=== true`, never truthiness: this flag switches off the refusal below, so a payload
  // from the phone server carrying `noResume: "no"` or `noResume: 1` must land on the old
  // rule rather than on a prompt-less clear nobody asked for.
  const noResume = o.noResume === true
  if (!paneId) return null
  if (!prompt && !noResume) return null
  const steps = Array.isArray(o.steps)
    ? o.steps.filter((s): s is string => typeof s === 'string' && !!s.trim()).slice(0, 12)
    : []
  // Nothing to resume means nothing to list. Steps that arrive anyway are dropped rather
  // than drawn, or the card would promise to carry on with work the clear is not carrying.
  return {
    paneId,
    steps: noResume ? [] : steps,
    prompt: noResume ? '' : prompt,
    seconds: clampSeconds(o.seconds),
    noResume
  }
}

/**
 * Why an armed countdown is dropped without clearing anything.
 *
 * It used to be a longer list. A countdown was read as a promise that nothing happens for
 * N seconds, so anything making the session useful again stood it down - somebody typing,
 * a keystroke arriving, a pane starting another turn. Robert, 2026-08-27, having asked for
 * this twice: "it should continue counting down no matter what for the clear unless i
 * click on keep this session". A countdown that vanishes when you touch the pane is a
 * countdown you cannot read, because reading it is what makes it disappear - and the
 * button under it is the whole reason the card exists.
 *
 * So typing no longer appears here at all, and 'drafting' no longer STOPS anything: it
 * makes the timer wait (`expiryDecision` -> 'wait') so an unsent line is never typed over,
 * with the card still on screen and still stoppable. What is left are the three facts that
 * make a clear impossible rather than merely unwelcome, plus the press itself.
 */
export type DropReason = 'drafting' | 'working' | 'gone' | 'asked' | 'cancelled'

export function dropFor(
  pane: { runSince?: number | null; ask?: unknown; typed?: string } | null
): DropReason | null {
  if (!pane) return 'gone'
  // A pane holding a live question is owed an answer by a PERSON, and clearing it throws
  // that question away along with the conversation that raised it.
  if (pane.ask) return 'asked'
  if (pane.runSince) return 'working'
  // A half-typed line in the composer is somebody's unsent message. `/clear` is typed into
  // the same pty, so it lands on the END of that line: what runs is `their words/clear`,
  // the draft is gone, and nothing on screen ever said it was there. 2026-08-25: a message
  // being typed was destroyed this way. Nothing about the countdown is cancelled for it -
  // the timer WAITS and the card stays up (see `ExpiryVerdict`'s 'wait').
  if (pane.typed && pane.typed.trim()) return 'drafting'
  return null
}

export function dropWords(why: DropReason): string {
  if (why === 'drafting') return 'there is an unsent line in the box'
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
/** The knobs the pane-side watcher runs on. See `main/autoclearWatch.ts`. */
export interface AutoClearConfig {
  /** Context size, in tokens, past which an idle pane is cleared. */
  tokens: number
  /** How long the countdown card is up before the keystrokes go out. */
  seconds: number
  /** Watch codex and antigravity panes at all. Off means only the Stop hook clears. */
  watchNonClaude: boolean
}

/**
 * 150k, the same line the Stop hook draws.
 *
 * Measured 2026-08-13 across a week of transcripts: clearing at 150k costs 28% less than
 * letting a session drift to 300k, because the bill is cache RE-READS of a context nobody
 * is using rather than the tokens the work needs. 15s is long enough to read the card from
 * across the desk and press Keep.
 */
export const DEFAULT_AUTOCLEAR: AutoClearConfig = {
  tokens: 150_000,
  seconds: 15,
  watchNonClaude: true
}

/** One arm per pane per half hour. See `watchDecision`. */
export const WATCH_COOLDOWN_MS = 30 * 60_000

/**
 * Why the watcher is or is not arming a clear on this pane, decided without touching disk.
 *
 * Split out for the same reason `armDecision` was: the bug that killed autoclear for a day
 * was one word inside a method with a pty on the other end of it, and nothing could test
 * it. Everything here is a value the caller already has.
 */
export type WatchVerdict = 'arm' | 'unknown-cli' | 'busy' | 'under' | 'recent'

export function watchDecision(p: {
  agent: string | null | undefined
  status: string
  tokens: number
  threshold: number
  lastArmMs?: number | null
  now: number
}): WatchVerdict {
  // First and hardest: a CLI whose clear command we cannot name is never typed into.
  if (!clearCommandFor(p.agent)) return 'unknown-cli'
  // 'working' is the pane mid-turn. 'starting' has no context yet worth clearing and
  // 'exited' has no pty left to type into, so only a genuinely idle pane is a candidate -
  // unlike the Stop-hook path, nothing here knows a turn is ending, so there is no reason
  // to queue against a moving pane rather than look again in a minute.
  if (p.status !== 'idle') return 'busy'
  if (!(p.tokens > 0) || p.tokens < p.threshold) return 'under'
  // The estimator reads a file the CLI writes, and the CLI does not write it the instant a
  // clear lands. Without this, a pane that has just been cleared reads as oversized for
  // another minute and gets cleared again - twice more before the file catches up.
  if (p.lastArmMs && p.now - p.lastArmMs < WATCH_COOLDOWN_MS) return 'recent'
  return 'arm'
}

/**
 * What the expiry timer does when it finally fires, decided without touching the pty.
 *
 * ADDENDUM 2026-08-27: pane s2's countdown reached zero and nothing was typed, and the
 * old timer body could not say why afterwards - three of its exits were silent `return`s.
 * Every branch is now a named verdict the caller logs, and the one that used to freeze
 * the toast at 0:00 ('stale' - meta left behind by an arm this timer no longer owns)
 * cleans the meta up instead of leaving the card on screen forever.
 */
export type ExpiryVerdict = 'fire' | 'wait' | 'vanished' | 'foreign' | 'stale' | DropReason

/**
 * How long a countdown held off by an unsent draft waits before asking again.
 *
 * Short, because the thing it is waiting for is a person pressing return, and the card is
 * on screen the whole time saying the clear is still coming.
 */
export const DRAFT_RETRY_MS = 5000

export function expiryDecision(p: {
  /** The pane still exists in the manager. */
  exists: boolean
  /** `meta.autoClearAt` as the timer found it. */
  metaAt: number | null | undefined
  /** The `at` this timer was armed with. */
  armedAt: number
  now: number
  /** `dropFor` over the pane's state right now, null when it is clean. */
  drop: DropReason | null
}): ExpiryVerdict {
  if (!p.exists) return 'vanished'
  if (p.metaAt !== p.armedAt) {
    // A LATER countdown owns the meta: its own timer is live, leave everything alone.
    // Anything else - missing, or stuck in the past - is ours gone stale, and must be
    // cleaned up or the toast sits at 0:00 forever, which is exactly what Robert watched.
    return typeof p.metaAt === 'number' && p.metaAt > p.now ? 'foreign' : 'stale'
  }
  // An unsent line is the one state where typing the clear DESTROYS something, so this is
  // the one that waits. It is not a stand-down: the countdown, and the button that stops
  // it, stay exactly where they are and the timer asks again in `DRAFT_RETRY_MS`.
  if (p.drop === 'drafting') return 'wait'
  // 'working' still types: Claude Code queues pty input arriving mid-turn and runs it at
  // the turn boundary, so the clear lands when the turn ends rather than never.
  if (p.drop && p.drop !== 'working') return p.drop
  return 'fire'
}

export function armDecision(why: DropReason | null): 'arm' | 'queue' | 'refuse' {
  if (!why) return 'arm'
  // 'drafting' queues for the same reason 'working' does: the line is submitted or
  // abandoned within the turn, so the ask is still good afterwards. Refusing would throw
  // away a clear that is genuinely due; clearing would eat the draft.
  return why === 'working' || why === 'drafting' ? 'queue' : 'refuse'
}
