/**
 * Is the desk still there, and what a phone should say when it is not.
 *
 * A phone client draws its panes from the last session list it was sent, and that list
 * has no clock in it. So when the Mac goes to sleep - or the tunnel drops, or the phone
 * loses signal - nothing changes on the phone's screen: every pane it is showing keeps
 * the status it had at the moment the link died, and a desk full of finished turns reads
 * as a desk full of dead sessions. Reported 2026-08-25: "it shows completely stopped when
 * laptop is asleep, so its weird - maybe show some message when its definitely asleep
 * rather than dead sessions".
 *
 * The honest reading is not about the panes at all. It is that this screen has not heard
 * from the desk since `lastSeen`, and everything below that line is a photograph.
 */
export interface LinkState {
  /** Is the event stream carrying anything right now? */
  up: boolean
  /** When the desk last said ANYTHING to this screen. 0 = never. */
  lastSeen: number
}

/** Below this, a gap is a phone's ordinary flaky stream and not worth a word. */
export const LINK_QUIET_MS = 20_000

/**
 * Whether the gap is worth telling somebody about.
 *
 * A handset drops its stream constantly - walking between rooms does it - and a banner
 * that flashes on every one of those is a banner nobody reads. The stream is expected to
 * come back on its own within a few seconds, so the word only earns its place once the
 * silence is longer than any ordinary reconnect.
 */
export function linkLost(link: LinkState, now: number): boolean {
  if (link.up) return false
  if (!link.lastSeen) return true
  return now - link.lastSeen > LINK_QUIET_MS
}

/**
 * What to say about it.
 *
 * Deliberately does NOT claim the machine is asleep. This screen cannot tell a sleeping
 * Mac from a dropped tunnel from a phone with no signal, and naming the wrong one sends
 * somebody to fix the wrong thing. What it CAN prove is when it last heard anything, so
 * that is what leads - and "asleep?" is offered as the likely reason, with a question
 * mark, never as a verdict.
 */
export function linkWords(link: LinkState, now: number): string {
  if (!link.lastSeen) return 'Cannot reach the desk'
  const secs = Math.max(0, Math.round((now - link.lastSeen) / 1000))
  const ago =
    secs < 60
      ? `${secs}s`
      : secs < 3600
        ? `${Math.floor(secs / 60)}m`
        : `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`
  return `Desk not answering for ${ago} - asleep?`
}

/**
 * The second half of the sentence: what the panes on screen are worth.
 *
 * Named separately because it is the part that answers the actual complaint - the rows
 * are not dead, they are old.
 */
export function linkNote(): string {
  return 'Sessions below are the last thing it said, not what they are doing now.'
}

/**
 * The moment every clock on a phone should stop at.
 *
 * A pane's header clock counts up from when its turn started, and it counts on the SCREEN
 * - not from anything the desk sends. So a phone whose link has gone keeps drawing a turn
 * clock that climbs forever: reported 2026-08-31, "timer still counting when not even
 * connection". Nothing on the other end is running; the number is this handset's own
 * arithmetic over a photograph, and it is the most convincing wrong thing on the screen
 * because it moves.
 *
 * `lastSeen` is the honest freeze point: it is when this screen was last told anything, so
 * a clock stopped there says "this pane had been running 4m as of the last thing I heard",
 * which is true. Returns 0 while the link is up, meaning "do not freeze anything".
 */
export function linkFrozenAt(link: LinkState, now: number): number {
  if (!linkLost(link, now)) return 0
  return link.lastSeen || 0
}

/** What the banner's icon means, so the same word is used in the aria-label and the tip. */
export function linkIconWords(link: LinkState, now: number): string {
  return linkLost(link, now) ? 'Not connected to the desk' : 'Connected'
}
