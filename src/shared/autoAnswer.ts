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
const STOPS = /^(?:no|n|cancel|skip|quit|exit|abort|stop|reject|deny|don'?t)\b|tell (?:claude|codex|it)|something (?:else|different)|go back|leave (?:it|as)|keep (?:current|existing|it as)/i

/**
 * An option that means "go on with what you were doing".
 *
 * Anchored at the start on purpose. A label is a sentence and the word "yes" appears in
 * the middle of plenty of them ("No - I already said yes to that"), so what is read is
 * the word the option LEADS with, which is how every one of these CLIs writes them.
 */
const GOES = /^(?:yes|y|ok(?:ay)?|sure|allow|approve|accept|proceed|continue|confirm|apply|run|do it|go ahead|keep going|use)\b/i

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
}

export const DEFAULT_AUTO_ANSWER: AutoAnswerConfig = {
  // Off, and it ships off. Every question this presses through is one a CLI decided to
  // ask - most often "may I edit this file" - so arriving switched on with an update
  // would answer a permission prompt on a desk whose owner never asked for it.
  enabled: false,
  anyQuestion: false,
  waitMs: 1200,
  maxRun: 12
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

  const good = ask.options.filter((o) => GOES.test(o.label) && !WIDENS.test(o.label) && !STOPS.test(o.label))

  // Exactly one. Two options both leading with "yes" are two different yeses - the second
  // is nearly always the widening one, and when it is not it is a choice between them.
  if (good.length === 1) return { n: good[0].n, why: `"${good[0].label}"` }

  if (!cfg.anyQuestion) return null

  const dflt = ask.options.find((o) => o.n === ask.selected)
  if (!dflt) return null
  // The CLI's own default is only borrowable while it is an ordinary answer. A default
  // that widens permission, or that stops and asks for a sentence, is one this may not
  // take on somebody's behalf however the setting is written.
  if (WIDENS.test(dflt.label) || STOPS.test(dflt.label)) return null
  return { n: dflt.n, why: `the CLI's own default, "${dflt.label}"` }
}
