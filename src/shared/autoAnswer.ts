// Answering the agent's question without a person, when the answer is not in doubt.
//
// `shared/choices.ts` turns a live chooser into buttons, which fixed "a pane sat unanswered
// for hours because nobody was at the desk". This is the next thing that costs time: at the
// desk, most of those questions have one obvious answer - the CLI is asking whether it may
// do the thing it was just told to do - and the person presses return. That press is the
// only thing between the pane and the rest of its run, and it is worth exactly nothing.
//
// So: read the options, and when one of them is unmistakably "yes, go on", press it. This
// module is the decision and nothing else - no Electron, no timers, no keystrokes - so the
// rule can be argued with in `npm run test:autoanswer` rather than in a running pane.
//
// What makes this defensible is that the refusals are the feature. A question with no
// plainly-good answer is left on screen; a design question ("which of these three shapes")
// is a decision somebody is being asked to make, and answering it for them is not speed, it
// is the app choosing the work. The one setting that widens that (`anyQuestion`) takes the
// CLI's OWN default rather than inventing a preference, and still refuses the options below.

import type { PaneAsk } from './choices'

/**
 * An option that grants more than the question asks.
 *
 * "Yes, and don't ask again" is not the same answer as "Yes": it answers every future
 * question of that shape as well, and it is the one press that cannot be taken back by
 * noticing a second later. It is never chosen automatically, in either mode - a person
 * turning this feature on asked for their own returns to be pressed, not for the pane's
 * permission prompt to be switched off behind them.
 *
 * The bare word "always" rather than a phrase: the CLIs here word it at least three ways
 * ("Yes, allow always", "Always allow this command", "Yes, and don't ask again") and a
 * phrase list is a guess at the fourth. An ordinary option that happens to say "always"
 * is merely left for a person, which is the direction this is allowed to be wrong in.
 *
 * Same reason the "ask again" half is a SHAPE and not the two strings this desk happens
 * to have captured: "don't ask me again", "never ask again", "don't ever ask again" and
 * "stop asking about this again" are the same sentence, and matching only the wording
 * Claude Code uses today makes the guard a note about one CLI's release rather than a
 * rule. A false match here costs a question left for a person; a miss costs the one
 * press that cannot be taken back.
 */
const WIDENS =
  /(?:don'?t|do not|never|stop)\s+(?:\w+\s+){0,2}ask(?:ing)?\b(?:\s+\w+){0,3}\s+again|\bask (?:me |us )?again\b|\balways\b|rest of this session|auto[- ]?accept|yolo|remember this/i

/**
 * An option that stops, or that answers with a question of its own.
 *
 * The second half matters more than the first: "No, tell Claude what to do differently"
 * leaves the CLI holding an empty composer waiting for a sentence, so picking it turns a
 * pane that was merely waiting into one that is waiting AND has lost its question.
 */
const STOPS = /^(?:no|n|cancel|skip|quit|exit|abort|stop|reject|deny|don'?t)\b|tell (?:claude|codex|it)|something (?:else|different)|go back|leave (?:it|as)|keep (?:the |my |its )?(?:current|existing|it as)/i

/**
 * An option that means "go on with what you were doing".
 *
 * Anchored at the start on purpose. A label is a sentence and the word "yes" appears in
 * the middle of plenty of them ("No - I already said yes to that"), so what is read is
 * the word the option LEADS with, which is how every one of these CLIs writes them.
 *
 * `submit` / `done` / `finish` are here for the screen that ENDS a multi-question ask:
 * Claude Code collects each answer and then draws `1. Submit answers / 2. Cancel`, and
 * with none of those words read as a go-ahead a set of questions somebody had already
 * answered - by hand or through this very file - sat on the last screen for ever. It is
 * the narrowest sense of "go on with what you were doing" there is: the decisions were
 * all made on the screens before it, and the only other option is `Cancel`, which throws
 * them away.
 */
const GOES = /^(?:yes|y|ok(?:ay)?|sure|allow|approve|accept|proceed|continue|confirm|apply|run|do it|go ahead|keep going|use|submit|done|finish)\b/i

/**
 * An option the CLI itself points at.
 *
 * This is the difference between choosing the BEST option and choosing the first one. Every
 * agent CLI here marks its own preference in the label when it has one - `(recommended)`,
 * `[default]`, `- suggested` - and that is a statement from the tool rather than a guess by
 * this app, so it outranks both a yes-shaped word and the row the arrow happens to be
 * sitting on. Read anywhere in the label, not anchored, because it is written as a suffix.
 *
 * Exactly ONE marked option counts. Two are a tool that recommends two things, which is a
 * choice again, and picking between them would be the invention this file exists to avoid.
 * A marked option that widens permission or stops is still refused by the guards above -
 * the marker raises an option's rank and can never lift it over a refusal.
 *
 * **A MARKER, never the word.** This read `\b(recommended|suggested)\b` and `\bthe
 * default\b` anywhere in the label, which is not a marker at all - it is prose. "Keep the
 * default permissions", "Overwrite with the suggested fix" and "Delete files not in the
 * recommended set" all describe what an option DOES, and each of them would have been
 * pressed as though the CLI had endorsed it, in the strict mode, five seconds after
 * appearing. So the marker has to be punctuated: parenthesised, bracketed, or a trailing
 * dash at the very END of the label, which is where every CLI here appends one. A real
 * recommendation this misses costs a question left for a person, which is the direction
 * this file is allowed to be wrong in.
 */
const RECOMMENDED =
  /\(\s*(?:recommended|suggested|default)\s*\)|\[\s*(?:recommended|suggested|default)\s*\]|[-–—·]\s*(?:recommended|suggested|the default)\s*$/i

export interface AutoAnswerConfig {
  /** Press the obvious answer without being asked. */
  enabled: boolean
  /**
   * Also answer a question that has no obviously-good option, by taking the CLI's own
   * default - the row its `❯` is already on.
   *
   * Off by default because it is a different promise. The rule above answers questions
   * whose answer was never in doubt; this one answers questions somebody is being asked to
   * DECIDE, and takes the CLI's preference as theirs. Whoever turns it on is saying "keep
   * moving and I will read the diff", which is a real way to work and is not the default.
   */
  anyQuestion: boolean
  /**
   * How long a question must sit unchanged before it is answered, in ms.
   *
   * Not zero, and not for the CLI's sake: it is the window in which a person at the desk
   * who disagrees can reach the pane. Short enough that a run does not stall on it.
   */
  waitMs: number
  /**
   * Answers in a row on one pane before it stops and leaves the next one for a person.
   *
   * The counter resets whenever the pane has no question, so an ordinary run - question,
   * work, question - never reaches it. What it catches is the pane that asks the same
   * thing forever because the answer is not taking: at that point pressing return again is
   * the app talking to itself, which is exactly the shape `recover` guards against too.
   */
  maxRun: number
  /**
   * Marker for the one-time default flip, written by `main/config.ts` and read nowhere else.
   *
   * This shipped OFF and now ships ON, and a default alone cannot change an existing desk:
   * every install has `enabled: false` WRITTEN into its config.json, because the defaults are
   * persisted at first launch. So a config with no marker is one written before the flip and
   * is moved to the new default once; after that the switch in Settings is the only thing
   * that decides, and turning it off stays off through every later update.
   */
  defaultsV2?: boolean
}

export const DEFAULT_AUTO_ANSWER: AutoAnswerConfig = {
  // On. It was off for exactly one reason - "arriving switched on with an update would
  // answer a permission prompt on a desk whose owner never asked for it" - and the answer
  // to that is the countdown, not silence: the pane now says WHICH option is about to be
  // pressed and how many seconds are left, and pressing any other button, or arrowing at
  // the desk, cancels it. Every refusal below is unchanged, and they are the feature: one
  // plainly-yes option and nothing else, never an option that widens permission, never one
  // that stops. A question with no obvious answer still waits for a person for ever.
  enabled: true,
  anyQuestion: false,
  // Five seconds rather than 1.2: the wait is the window in which somebody who disagrees
  // reaches the pane, and while this was off by default that window only had to satisfy
  // whoever went looking for the setting. On by default it has to be long enough to READ.
  waitMs: 5000,
  maxRun: 12,
  defaultsV2: true
}

/**
 * How long after a press this may press again, whatever the frame says.
 *
 * The keys are spread over a few hundred milliseconds and the widget redraws after each
 * one, so the frames arriving during a press are a moving target by construction. Without
 * a floor here, the arrow moving under our own keystrokes reads as "the question changed",
 * which restarts the settle clock and lets a second press interleave with the first -
 * arrows from two sequences landing between each other, and the wrong row committed.
 */
export const PRESS_COOLDOWN_MS = 4000

/**
 * A question's identity: what it asks and what it offers, with the arrow left out.
 *
 * `askSignature` in `shared/choices.ts` deliberately INCLUDES the arrow, because a phone
 * answering from a stale position picks the wrong row. This is the other question - "is
 * this the same question I already pressed" - and for that the arrow is noise: it moves
 * every time a key lands, including our own.
 */
export function askKeyOf(ask: PaneAsk | null | undefined): string {
  if (!ask) return ''
  return `${ask.question}|${ask.options.map((o) => `${o.n}.${o.label}`).join('|')}`
}

/** What a pane knows about the question on its screen. All times are ms epoch. */
export interface AutoAnswerState {
  /**
   * The question's IDENTITY - its text and its options, and deliberately NOT where the
   * arrow is. The arrow moves as the keys land, so a signature carrying it says "a
   * different question" about the question being answered.
   */
  askKey: string
  /** When the frame last changed, arrow included. A person arrowing restarts this. */
  askSince: number
  /** The identity last pressed, and when. */
  autoKey: string
  autoAt: number
  /** Presses in a row on this pane. */
  autoRun: number
}

/**
 * May this pane's question be answered right now?
 *
 * Every guard here is a way the app could end up arguing with a widget, and each one is
 * cheap to state and expensive to discover in a pane: the question has to have settled
 * (`waitMs`, the window in which somebody who disagrees can reach it), it has to be a
 * question this has not already pressed, the last press has to be far enough behind that
 * its own keystrokes are not still landing, and a pane may not do this for ever.
 */
export function dueForAuto(s: AutoAnswerState, cfg: AutoAnswerConfig, now: number): boolean {
  if (!cfg.enabled) return false
  if (!s.askKey || !s.askSince) return false
  if (now - s.askSince < cfg.waitMs) return false
  if (s.askKey === s.autoKey) return false
  if (s.autoAt && now - s.autoAt < PRESS_COOLDOWN_MS) return false
  return s.autoRun < cfg.maxRun
}

/**
 * WHEN this pane's question will be answered, epoch ms, or 0 for "it will not be".
 *
 * `dueForAuto` answers "may I press now" and is what really presses. This is the same
 * question asked ahead of time, because a press that arrives with no warning is
 * indistinguishable from the pane answering itself: the countdown on the pane
 * (`AskCountdown` in `TerminalPane.tsx`) is the whole reason this exists, and the
 * seconds it shows have to be the seconds the press actually waits.
 *
 * So every guard here is `dueForAuto`'s, plus the one it cannot make on its own - that
 * there IS an option this would pick. A question with no obvious answer is left for a
 * person, and promising a countdown for it would be a clock that never fires.
 */
export function autoAnswerAt(
  s: AutoAnswerState,
  cfg: AutoAnswerConfig,
  ask: PaneAsk | null | undefined
): number {
  if (!cfg.enabled || !ask) return 0
  if (!s.askKey || !s.askSince) return 0
  if (s.askKey === s.autoKey) return 0
  if (s.autoRun >= cfg.maxRun) return 0
  if (!pickAnswer(ask, cfg)) return 0
  const settled = s.askSince + cfg.waitMs
  const cooled = s.autoAt ? s.autoAt + PRESS_COOLDOWN_MS : 0
  return Math.max(settled, cooled)
}

export interface AutoPick {
  /** The option number to press. */
  n: number
  /** Why, in words, for the log. Never invented - it names the option or the rule. */
  why: string
}

/**
 * The option to press for this question, or null to leave it for a person.
 *
 * Null is the common answer and is not a failure: the buttons stay on screen and the pane
 * keeps saying it is waiting, which is what it did before this file existed.
 */
export function pickAnswer(ask: PaneAsk, cfg: AutoAnswerConfig): AutoPick | null {
  if (!cfg.enabled) return null
  if (!ask.options.length) return null

  // The two refusals come first and apply to every rule below. Nothing a later rule finds
  // may reach an option that widens permission or that stops and asks for a sentence.
  const usable = ask.options.filter((o) => !WIDENS.test(o.label) && !STOPS.test(o.label))
  if (!usable.length) return null

  // The CLI's own recommendation, when it made exactly one. This is the tool stating the
  // answer, so it outranks a yes-shaped word and it outranks the arrow - which is the
  // whole of "pick the best option rather than the first one". It is allowed in the strict
  // mode too: a question whose own tool has marked the answer is not a question somebody
  // is being asked to decide.
  const marked = usable.filter((o) => RECOMMENDED.test(o.label))
  if (marked.length === 1) {
    return { n: marked[0].n, why: `the option "${marked[0].label}", which the CLI marks as its own recommendation` }
  }

  const good = usable.filter((o) => GOES.test(o.label))

  // Exactly one. Two options both leading with "yes" are two different yeses - the second
  // is nearly always the widening one, and when it is not it is a choice between them.
  if (good.length === 1) return { n: good[0].n, why: `"${good[0].label}"` }

  if (!cfg.anyQuestion) return null

  // The CLI's own default, only while it survived the refusals above. A default that
  // widens permission, or that stops and asks for a sentence, is one this may not take on
  // somebody's behalf however the setting is written.
  // The arrow sitting on an option this may not take is not a licence to take a different
  // one: at that point the CLI's preference has been refused and there is no second signal
  // to fall back on, so the question is a person's again.
  const dflt = usable.find((o) => o.n === ask.selected)
  if (!dflt) return null
  return { n: dflt.n, why: `the CLI's own default, "${dflt.label}"` }
}
