/**
 * The things this app can do that nobody would ever find.
 *
 * PaneForge has grown a lot of behaviour that is invisible until you already know it is
 * there: a highlight in a pane can be DELETED, a phone can drive this desk, a pane can be
 * handed to another machine mid-turn, an agent's question is a row of buttons. None of it
 * is discoverable from the window, and none of it is worth a dialog. So it is a quiet card
 * in the bottom-right corner, one tip at a time, with a very long gap between them.
 *
 * Three rules, and they are the whole design:
 *
 *   - **It costs nothing.** No model, no request, no timer of its own beyond one minute
 *     tick shared with everything else that watches the clock. Every tip is a static
 *     sentence and the choice between them is arithmetic over what has been seen.
 *   - **It never interrupts.** Silent while a dialog is open, while a pane is asking a
 *     question, while an update card is up, and for the first `FIRST_MS` of a session.
 *     A tip that lands over a decision somebody is making is worse than no tip.
 *   - **It says how to stop it, before somebody has to go looking.** Every `OFFER_EVERY`
 *     tips the card carries the sentence about turning them off and the button that does
 *     it, so the feature can always be ended from where it is annoying somebody. The
 *     Settings switch is the other half, for turning them back on.
 *
 * Pure: no DOM, no Electron. `npm run test:tips`.
 */

export interface Tip {
  /** Stable, and stored - renaming one shows it to everybody again. */
  id: string
  /** The sentence. One idea, in words, no jargon. */
  say: string
}

export interface TipsConfig {
  enabled: boolean
  /** Tip ids already shown. Reset when everything has been seen, so it cycles. */
  seen: string[]
  /** When the last one was put on screen. */
  lastAt: number
  /** How many have been shown in total - decides when the "you can turn these off" runs. */
  shown: number
}

export const DEFAULT_TIPS: TipsConfig = { enabled: true, seen: [], lastAt: 0, shown: 0 }

/** How long after the app opens the first tip may appear. Long enough to start working. */
export const FIRST_MS = 4 * 60 * 1000
/** The gap between tips. Deliberately long: this is a hint, not a tutorial. */
export const EVERY_MS = 40 * 60 * 1000
/** Every Nth tip also offers the off switch. */
export const OFFER_EVERY = 4
/** A card stays up this long if nobody touches it. It is never modal, so it can go. */
export const SHOW_MS = 26 * 1000

/**
 * The catalogue.
 *
 * Every line here is a feature this repo has actually shipped - the rules that produced it
 * are in CLAUDE.md, one heading each. A tip about something that does not exist is the
 * fastest way to make the whole thing untrustworthy, so `npm run test:tips` refuses a
 * duplicate id and an empty sentence, and the list is short on purpose.
 */
export const TIPS: Tip[] = [
  { id: 'select-delete', say: 'Highlight text you typed in a pane and press Backspace - it deletes the whole selection, not one character. Typing over it works too.' },
  { id: 'click-cursor', say: 'Click inside what you have typed to put the cursor there. Alt-click reaches other lines.' },
  { id: 'turn-copy', say: 'The copy button in a pane’s header copies the last reply, the last prompt, or both - and right-clicking a prompt tag on the rail copies that turn.' },
  { id: 'phone', say: 'Open Devices and scan the code - your phone becomes this window. Same panes, same keyboard, from anywhere.' },
  { id: 'handoff', say: 'Hand off on a pane moves the whole thing to another machine: the repo, the conversation, the screen and the dev server.' },
  { id: 'ask-buttons', say: 'When an agent asks "which of these?", the options become buttons on the pane - and the card in the list turns red so you can see it from across the room.' },
  { id: 'auto-answer', say: 'An obvious yes is answered for you after a few seconds, with a countdown you can stop. Settings decides how long, or turns it off.' },
  { id: 'restore', say: 'Closing a pane keeps its conversation AND what was on its screen. History reopens it exactly where it was.' },
  { id: 'attach', say: 'Drop a screenshot on a pane, or paste one - it goes to the agent as a picture, not as a file path.' },
  { id: 'voice', say: 'Ctrl/Cmd Shift Space dictates into the focused pane. Nothing to install.' },
  { id: 'stash', say: 'The Stash keeps everything you copy. It floats over any app and pastes straight back into a pane.' },
  { id: 'settings-search', say: 'Type what a setting DOES into the Settings search - "close a pane nobody touched" finds the switch, not just the page.' },
  { id: 'lanes', say: 'Two chats on one repo get their own checkouts. The lane chip on a card says which copy it is and what that copy is doing.' },
  { id: 'grid', say: 'The grid shows several panes at once. Ctrl and a number jumps straight to a pane wherever you are.' },
  { id: 'usage', say: 'The chip in each pane title is that pane’s real memory and CPU, measured - not an estimate. The total sits beside the session count.' },
  { id: 'idle-close', say: 'A full machine gives itself room back: it trims, then moves a finished pane to a paired device, then offers to close one - always with a countdown first.' },
  { id: 'dev-servers', say: 'Ask the pet "what is running" and it lists every dev server on this machine, with the pane and the port. "Close the dev in pane 2" stops one.' },
  { id: 'recall', say: 'Ask something you have asked before and a small chip says so, with when. It never blocks you.' },
  { id: 'improve', say: 'The chip beside a prompt rewrites it into something sharper before you send it.' },
  { id: 'telegram', say: 'A pane’s question can go to Telegram, and tapping the answer there presses the button here.' },
  { id: 'text-view', say: 'A pane’s output is also readable as plain text you can select - useful on a phone, where a terminal cannot be highlighted.' },
  { id: 'theme', say: 'Every colour in this window is derived from one accent. Appearance changes all of it at once, light or dark.' },
  { id: 'pets', say: 'There are ten pets in Appearance. They only ever say things the app worked out itself - no model, no tokens.' },
  { id: 'update', say: 'Updates install themselves and never take the screen. The app restarts quietly and puts your panes back.' }
]

/** What the app knows at the moment a tip would be shown. Any of these stays its hand. */
export interface TipContext {
  /** A dialog, an update card, a pairing card - anything already asking for attention. */
  busy: boolean
  /** A pane is holding an agent's question. That is the one thing this may never sit over. */
  asking: boolean
  /** The window is on screen. A tip drawn behind a minimised window is a tip spent. */
  visible: boolean
  /** How long the app has been open. */
  upMs: number
}

/**
 * The tip to show now, or nothing.
 *
 * `seen` is compared against the WHOLE catalogue rather than counted, so a tip added in a
 * later version is shown to somebody who has already been round the list once - which is
 * the case this exists for.
 */
export function dueTip(cfg: TipsConfig, now: number, ctx: TipContext): Tip | null {
  if (!cfg.enabled) return null
  if (ctx.busy || ctx.asking || !ctx.visible) return null
  if (ctx.upMs < FIRST_MS) return null
  if (now - (cfg.lastAt || 0) < EVERY_MS) return null
  const fresh = TIPS.filter((t) => !cfg.seen.includes(t.id))
  const pool = fresh.length ? fresh : TIPS
  // Deterministic rather than random: the same config on the same tick picks the same
  // tip, which is what makes the test a test rather than a coin toss.
  return pool[cfg.shown % pool.length] ?? null
}

/** The config after a tip has been put on screen. Cycles once everything has been seen. */
export function afterShown(cfg: TipsConfig, tip: Tip, now: number): TipsConfig {
  const seen = cfg.seen.includes(tip.id) ? cfg.seen : [...cfg.seen, tip.id]
  const done = TIPS.every((t) => seen.includes(t.id))
  return { ...cfg, seen: done ? [] : seen, lastAt: now, shown: cfg.shown + 1 }
}

/**
 * Does this card carry the off switch?
 *
 * The first one always does - somebody who does not want tips finds out on the first tip
 * rather than on the fourth - and then every `OFFER_EVERY` after it.
 */
export function offersOff(shown: number): boolean {
  return shown === 0 || (shown + 1) % OFFER_EVERY === 0
}
