// Keeping what an agent wipes off the screen.
//
// `/clear` in Claude Code, and the equivalent in every other CLI here, sends two escape
// sequences: `CSI 2 J` erases the display and `CSI 3 J` deletes the saved scrollback. The
// second one is why scrolling up after a clear finds a torn stub of the previous turn and
// nothing before it - the report was "you can still see a bit of the previous prompt but
// it hides the last parts". Measured across the 128 pane logs on this machine: 73 of each,
// always paired, and no other erase-in-display in the set.
//
// So the pane keeps its own history of the screen, the way a terminal does for a `clear`:
//
//   - `CSI 3 J` is dropped. Nothing else in a session asks for the scrollback to be
//     destroyed, and the app's own history file has kept those bytes all along - this only
//     stops the WINDOW throwing them away.
//   - `CSI 2 J` becomes a scroll: the cursor goes to the bottom row and a newline is sent
//     for every row on screen. A newline at the bottom row scrolls, and a scroll pushes the
//     top line into the scrollback rather than deleting it. What is left is a blank screen,
//     which is what `2J` promised, with the old one one wheel-notch away.
//
// The alternate screen is left alone: vim, less and a menu clear constantly, have no
// scrollback of their own, and would otherwise push a frame of redraw into the real one
// several times a second.
//
// A sequence can be split across two chunks from the pty - `\x1b[` at the end of one and
// `2J` at the start of the next - so this is a transformer with a carry, not a replace.
// `npm run test:scrollclear`.
//
// ---------------------------------------------------------------------------------------
//
// And then Claude Code stopped sending either of them. Measured 2026-08-13 over this
// machine's live pane logs: v2.1.229 emits ZERO `2J` and ZERO `3J` in 4 MB of output, so
// everything above was a no-op and `/clear` was eating the last screenful again. What it
// sends instead is an erase-per-row:
//
//   ESC[H ESC[2K  (ESC[1B ESC[2K)x56  ESC[1B ESC[H  <redraw>
//
// 56 being the pane's height. That wipes the visible screen in place - an erased line is
// simply blanked, it is never pushed into the scrollback the way a scrolled one is - so
// the last screenful of the conversation is destroyed and the banner is redrawn from row
// 1 over the top of it. Everything OLDER survives, which is why the pane looks like it
// kept its history right up to a hole where the last turn was.
//
// The catch is that this is Claude Code's ordinary full repaint, not its clear: 60 of them
// in one session log. Rewriting every one into a scroll would push a duplicate screenful
// into the scrollback sixty times. So the wipe is only kept when the user has just asked
// for one - `arm()`, called from the pane when a line like `/clear` is submitted, and
// spent on the first wipe that follows. That is intent, measured off the keystrokes the
// app is relaying anyway, rather than a guess about which repaint is which.

/** The rows-erased-one-at-a-time wipe, from its start: home, erase, then one row down. */
const WIPE_OPEN = '\x1b[H\x1b[2K\x1b[1B\x1b[2K'
/** How long an armed clear waits for the CLI to do the wiping. */
const ARM_MS = 10_000

/** The sequences a chunk may be part-way through, longest first. */
const NEEDLES = [WIPE_OPEN, '\x1b[2J', '\x1b[3J']
/** The most bytes a sequence this cares about can be part-way through. */
const MAX_PARTIAL = WIPE_OPEN.length - 1

/**
 * Could `tail` be the start of one of them, with the rest still to come?
 *
 * The long needle is only worth waiting for while a clear is armed. A chunk ending in
 * `ESC [ H` is ordinary cursor traffic and holding it back for a byte that may not come
 * for another frame would show as the pane lagging its own agent.
 */
function partial(tail: string, armed: boolean): boolean {
  for (const n of NEEDLES) {
    if (n === WIPE_OPEN && !armed) continue
    if (tail.length < n.length && n.startsWith(tail)) return true
  }
  return false
}

/** Is this submitted line an ask for the screen to be cleared? */
export function clearsScreen(line: string): boolean {
  return /^\/(clear|compact|new|reset)\b/i.test(line.trim())
}

export interface ScrollKeeper {
  /** The bytes to write to the terminal for this chunk. */
  (chunk: string): string
  /**
   * The user just asked for the screen to be cleared. The next full-screen wipe keeps
   * what it wipes; every other repaint is left alone.
   */
  arm(now?: number): void
}

/**
 * @param rows how tall the pane is, asked for at the moment a clear arrives - a pane is
 *   resized constantly and a stale height either loses lines or pads the scrollback.
 * @param alternate whether the terminal is on the alternate screen right now.
 */
export function keepScrollback(
  rows: () => number,
  alternate: () => boolean,
  clock: () => number = Date.now
): ScrollKeeper {
  let carry = ''
  let armedAt = 0
  const keeper = (chunk: string): string => {
    const s = carry + chunk
    carry = ''
    const armed = armedAt > 0 && clock() - armedAt < ARM_MS
    if (!armed) armedAt = 0
    // Hold back only a genuine partial: anything else that ends in ESC is passed through,
    // because a lone ESC is a real key and waiting for a second byte that never comes
    // would stall the pane.
    let body = s
    for (let n = Math.min(MAX_PARTIAL, s.length); n > 0; n--) {
      if (partial(s.slice(s.length - n), armed)) {
        carry = s.slice(s.length - n)
        body = s.slice(0, s.length - n)
        break
      }
    }
    const wipe = armed ? body.indexOf(WIPE_OPEN) : -1
    if (wipe < 0 && !body.includes('\x1b[2J') && !body.includes('\x1b[3J')) return body
    if (alternate()) return body
    const height = Math.max(1, rows())
    // `CSI <rows> ; 1 H` then one newline per row: the newlines scroll, and a scroll is
    // what puts a line into the scrollback. `\r` keeps the cursor at column 1 on the way.
    //
    // Wrapped in save/restore because a real `2J` does NOT move the cursor - it blanks the
    // screen around it. Restoring lands on the same row and column, which is now blank,
    // which is exactly what the sequence promised.
    const scroll = '\x1b7' + `\x1b[${height};1H` + '\r\n'.repeat(height) + '\x1b8'
    let out = body.split('\x1b[3J').join('').split('\x1b[2J').join(scroll)
    if (wipe >= 0) {
      // Scroll the screen away FIRST and let the wipe run over the blank rows it leaves.
      // Rewriting the erases themselves would have to model where the CLI's cursor is on
      // every one of the fifty-odd rows; putting the whole screen into the scrollback in
      // front of them needs to know nothing about the rows at all.
      const at = out.indexOf(WIPE_OPEN)
      out = out.slice(0, at) + scroll + out.slice(at)
      armedAt = 0
    }
    return out
  }
  keeper.arm = (now = clock()): void => {
    armedAt = now
  }
  return keeper
}
