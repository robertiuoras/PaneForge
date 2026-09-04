// A card nobody touched goes away by itself.
//
// The corner stack fills up with things the app decided to say - what changed in this
// build, a tip, a pane that named itself - and none of them had an end. "What changed in
// 0.8.199" sat there for the rest of the day because the only way out was a press, so the
// stack a countdown card has to draw into was permanently one card shorter (Robert
// 2026-09-04: "after maybe 5 mins the what changed in 0.8.199 disappears or like any popup
// disappears if not interacted with").
//
// WHAT MAY NOT USE THIS. A card that is asking something, or counting down to doing
// something, is not a card nobody has answered - it is a card whose whole point is the
// answer: `MoveSoon`, `OffloadSoon`, `AutoClearToast`, `StopServer`, `LoginCard`, the
// update prompt. Those already end themselves, at their own deadline, by doing the thing.
// This is only for a card that says something and wants nothing back.

/** Nobody has touched it for this long, so it has been read or it has been ignored. */
export const CARD_IDLE_MS = 5 * 60_000

/** A pointer resting on the card is somebody reading it - the clock starts again when it
 * leaves, rather than the card going while it is under the cursor. */
export type IdleReading = {
  /** When the clock last started, or was restarted by a touch. */
  since: number
  /** True while a pointer is over the card, or a control inside it has focus. */
  held: boolean
}

/** Milliseconds left before the card goes, or null while it is held - a held card has no
 * deadline at all, the same shape `dwellFor` uses for a tour step that waits for a person. */
export function idleLeft(r: IdleReading, now: number, after = CARD_IDLE_MS): number | null {
  if (r.held) return null
  return Math.max(0, r.since + after - now)
}

/** Has it been ignored long enough to go? */
export function idleGone(r: IdleReading, now: number, after = CARD_IDLE_MS): boolean {
  return idleLeft(r, now, after) === 0
}
