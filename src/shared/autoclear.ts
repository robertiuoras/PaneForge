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

import { forgePrompt } from './promptForge'
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
export function clearChunks(prompt: string, command = '/clear', model = ''): string[] {
  if (!prompt.trim()) return [command + '\r']
  // A model switch goes BETWEEN the clear and the prompt: `/model X` and then a bare
  // CR, because leaving Fable opens a confirm dialog and without the Enter the CLI prints
  // "Kept model as Fable 5". Typed onto the empty post-clear context the switch is free;
  // one turn later it re-writes the whole handoff context into a new per-model cache.
  // The Stop hook asks for it when the session it clears runs on Fable ("Fable plans,
  // Opus builds"): 2026-09-02 a cleared session resumed and built a whole phase on Fable
  // because the switch it was told to make found no pane.
  const m = model.trim()
  if (m) return [command + '\r', `/model ${m}\r`, '\r', prompt, '\r']
  return [command + '\r', prompt, '\r']
}

/** Where the resume prompt sits in a `clearChunks` list, with or without a model switch. */
export function resumeOf(chunks: readonly string[]): { switchCmd: string; resume: string } {
  if (chunks.length > 3) return { switchCmd: chunks[1].replace(/\r$/, ''), resume: chunks[3] }
  return { switchCmd: '', resume: chunks.length > 1 ? chunks[1] : '' }
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

/**
 * How long `/clear` gets to finish restarting the session before the prompt is typed.
 *
 * Only the HOOK's own fallback typing path still runs on this clock. The app does not:
 * `armAutoClear` hands the resume prompt to `queuePrompt`, which waits for an idle
 * composer instead of guessing at one. See `CLEAR_PROMPT_START_MS`.
 */
export const CLEAR_SETTLE_MS = 2500

/** Between the prompt landing in the composer and the CR that submits it. */
export const SUBMIT_GAP_MS = 1200

/**
 * Re-send the submit CR this long after the last chunk went out, unless somebody has
 * started typing. Enter on an empty composer is a no-op in every CLI we clear, so the
 * retry is free when the first CR landed and a rescue when the CLI swallowed it.
 *
 * The APP no longer uses these either, and the measurement is why: over 16 clears on
 * 2026-08-27/28 the app's own log recorded 28 retries, i.e. BOTH blind CRs fired every
 * single time, including the fourteen where the first one had plainly landed. A blind
 * Enter into a session that has already started answering is a stray keystroke at a live
 * CLI - harmless at an empty composer and not harmless at a chooser. `queuePrompt`
 * re-sends only after READING the pane and finding it still idle. Kept for the hook's
 * fallback, which types into the pty with no reading of its own.
 */
export const SUBMIT_RETRIES_MS = [3000, 8000]

/**
 * How long the app waits after `/clear` before it starts ASKING whether the composer is
 * ready for the resume prompt.
 *
 * It is short because it is not the wait - it is the beat before the wait begins.
 * `queuePrompt` then polls for an idle composer (its own quiet window plus `readsBusy`
 * over what was last painted) and types the moment the CLI has finished redrawing,
 * which on a `/clear` is well under the 2500ms this used to spend unconditionally.
 * Measured on this desk: the old path typed the prompt at +2500ms and its submit at
 * +3700ms, then fired two more CRs at +6700 and +11700 whatever happened.
 */
export const CLEAR_PROMPT_START_MS = 400

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
  /** Model alias the FRESH session is switched to between the clear and the prompt. */
  model?: string
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
  // An alias only - this is typed into a live pty, so anything else is refused rather
  // than sent.
  const model =
    typeof o.model === 'string' && /^[a-z0-9.-]{2,40}$/i.test(o.model.trim()) ? o.model.trim() : ''
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
    noResume,
    ...(model && !noResume ? { model } : {})
  }
}

/**
 * The prompt the fresh session is actually given.
 *
 * The hook sends 23 words - `Continue the handoff: work its Next steps in order, and do
 * not re-do finished items.` - and that is a whole session's continuation with no path in
 * it and nothing saying what finished looks like (`docs/prompt-review-2026-09-02.md`).
 * Both of the missing halves are already on THIS side at the moment the prompt is typed:
 * `main/handoffSteps.ts` knows which file the handoff is, and the ask carries the steps
 * that file says are still open.
 *
 * A `noResume` clear forges nothing - it types no prompt at all, deliberately.
 */
export function resumeBrief(ask: AutoClearAsk, handoffPath: string | null): string {
  if (ask.noResume || !ask.prompt) return ''
  return forgePrompt({
    task: ask.prompt,
    ...(handoffPath ? { anchors: [handoffPath] } : {}),
    scope: ['the steps that handoff already lists - add no work it does not name'],
    // The steps ARE the definition of done here: the handoff was written by the session
    // that did the work, and these are the lines it said were still open.
    done: ask.steps.length ? ask.steps : ['every Next step in that handoff is finished, or is named as blocked']
  })
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
  /** Context size, in tokens, used by the Claude Stop-hook clear policy. */
  tokens: number
  /** How long the countdown card is up before the keystrokes go out. */
  seconds: number
  /** Retained for existing settings; enables non-Claude native-policy status logging. */
  watchNonClaude: boolean
}

/**
 * 150k, the same line the Claude Stop hook draws.
 *
 * Measured 2026-08-13 across a week of transcripts: clearing at 150k costs 28% less than
 * letting a completed Claude session drift to 300k, because the bill is cache RE-READS of
 * a context nobody is using. Codex uses its native compaction policy instead.
 */
export const DEFAULT_AUTOCLEAR: AutoClearConfig = {
  tokens: 150_000,
  seconds: 15,
  watchNonClaude: true
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
  // 'working' does NOT type. Claude Code queues pty input arriving mid-turn, and this
  // sequence is THREE chunks: `/clear`, the resume prompt, the submit CR. All three land
  // in that queue, the `/clear` runs first at the turn boundary, and a clear throws the
  // rest of the queue away with the conversation - so the pane is cleared and continues
  // nothing, which is the one outcome `readAsk` refuses to arrange on purpose. Measured
  // 2026-08-28 on s11-mtck156b: fired 09:52:03 into a 20-minute turn, the screen read
  // `> /clear` then `Press up to edit queued messages`, and the fresh session sat idle
  // with its handoff never asked for. It is not a refusal either - the caller puts the
  // ask back on the queue the arm path already uses and re-arms when the turn ends.
  if (p.drop) return p.drop
  return 'fire'
}

/**
 * How quiet a pane has to be before a countdown may APPEAR.
 *
 * `dropFor` reads `runSince`, and `runSince` is dropped the moment the agent's footer goes
 * quiet - which is BEFORE the turn is really over. Claude Code's Stop hooks run after the
 * reply is on screen, and a hook that blocks makes the model write a SECOND reply into the
 * same pane. So the ask arrives in the gap between those two, `dropFor` says nothing is
 * running, and the card counts down over a session that is still working: 2026-08-30,
 * Robert watched the countdown start while the gates were still going, and it then had to
 * requeue itself when the next reply began.
 *
 * A quiet floor is the reading that covers it, and it is the same shape `closeWhenDone`
 * already uses for the same reason (`CLOSE_DONE_QUIET_MS`): a pane is finished when it has
 * been finished for a moment, not at the instant its last byte landed. 10s, because the
 * hook chain on this desk runs 2-6s and a countdown that starts a few seconds late costs
 * nothing - the card is 15s long and nobody is waiting on it.
 */
export const ARM_QUIET_MS = Number(process.env.PF_ARM_QUIET_MS ?? 10_000)

/**
 * Whether a pane that looks idle has been idle long ENOUGH to draw a countdown over.
 *
 * Separate from `armDecision` so the caller can say how long to wait rather than being
 * told yes or no: the arm path re-asks after the remainder instead of dropping the ask.
 */
export function quietEnoughToArm(quietMs: number): boolean {
  return quietMs >= ARM_QUIET_MS
}

export function armDecision(why: DropReason | null): 'arm' | 'queue' | 'refuse' {
  if (!why) return 'arm'
  // 'drafting' queues for the same reason 'working' does: the line is submitted or
  // abandoned within the turn, so the ask is still good afterwards. Refusing would throw
  // away a clear that is genuinely due; clearing would eat the draft.
  return why === 'working' || why === 'drafting' ? 'queue' : 'refuse'
}

/**
 * What a QUEUED prompt should do on this poll: type it, wait, or give up on it.
 *
 * `queuePrompt` waits for an idle composer before typing, and until 2026-08-30 that was
 * the ONLY thing it read. It could not tell a composer that is idle because the CLI has
 * finished booting from one that is idle because a PERSON has just sent their own
 * message into the fresh session - so the resume prompt was typed anyway, arriving as a
 * second message in the middle of somebody else's turn.
 *
 * Measured that morning on pane s4-mtednh9i (assistant): the 02:12 autoclear armed
 * correctly, `/clear` landed, the SessionStart hook chain (memory symlinks, handoff
 * injection, superpowers) kept the pane painting for several seconds, Robert read the
 * screen and typed his own question, and `Continue the handoff: ...` was then delivered
 * INTO that turn. From the desk it reads as "autoclear broke again": the clear worked
 * and the resume prompt hijacked the next turn instead of owning the first one.
 *
 * `mark` is `lastKeyboard` as it stood when the prompt was queued - after the app's own
 * `/clear` write, which bumps it. Anything later is a human submit, and a human submit
 * means the fresh session already has work: the queued prompt is stale and is dropped,
 * not typed. The handoff is still injected at SessionStart, so nothing is lost by
 * dropping it.
 *
 * `drafting` is a half-typed line in the composer, the same state `dropFor` refuses to
 * type over. It waits while there is time left and is ABANDONED at the deadline rather
 * than pasted onto the end of somebody's unsent sentence.
 */
export type QueuedPromptVerdict = 'type' | 'wait' | 'abandon'

export function queuedPromptDecision(p: {
  /** The pane still exists. */
  exists: boolean
  /** `meta.lastKeyboard` right now. */
  lastKeyboard: number | null | undefined
  /** `meta.lastKeyboard` as it stood when this prompt was queued. */
  mark: number
  /** There is an unsent line in the composer. */
  drafting: boolean
  /** The pane has been quiet long enough and is not painting a busy footer. */
  composerIdle: boolean
  /** The wait budget has run out. */
  expired: boolean
}): QueuedPromptVerdict {
  if (!p.exists) return 'abandon'
  if (typeof p.lastKeyboard === 'number' && p.lastKeyboard > p.mark) return 'abandon'
  if (p.drafting) return p.expired ? 'abandon' : 'wait'
  if (p.composerIdle) return 'type'
  // Expiry still types into a merely-busy pane: that is the long-standing rescue for a
  // CLI whose footer never goes quiet, and the pty queues it. It is only the two cases
  // above - a person's message, a person's draft - that the deadline must not override.
  return p.expired ? 'type' : 'wait'
}
