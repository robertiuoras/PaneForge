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

/** The most bytes a sequence this cares about can be part-way through. */
const MAX_PARTIAL = 4

/** Could `tail` be the start of `\x1b[2J` or `\x1b[3J`, with the rest still to come? */
function partial(tail: string): boolean {
  return tail === '\x1b' || tail === '\x1b[' || tail === '\x1b[2' || tail === '\x1b[3'
}

export interface ScrollKeeper {
  /** The bytes to write to the terminal for this chunk. */
  (chunk: string): string
}

/**
 * @param rows how tall the pane is, asked for at the moment a clear arrives - a pane is
 *   resized constantly and a stale height either loses lines or pads the scrollback.
 * @param alternate whether the terminal is on the alternate screen right now.
 */
export function keepScrollback(rows: () => number, alternate: () => boolean): ScrollKeeper {
  let carry = ''
  return (chunk: string): string => {
    const s = carry + chunk
    carry = ''
    // Hold back only a genuine partial: anything else that ends in ESC is passed through,
    // because a lone ESC is a real key and waiting for a second byte that never comes
    // would stall the pane.
    let body = s
    for (let n = Math.min(MAX_PARTIAL, s.length); n > 0; n--) {
      if (partial(s.slice(s.length - n))) {
        carry = s.slice(s.length - n)
        body = s.slice(0, s.length - n)
        break
      }
    }
    if (!body.includes('\x1b[2J') && !body.includes('\x1b[3J')) return body
    if (alternate()) return body
    const height = Math.max(1, rows())
    // `CSI <rows> ; 1 H` then one newline per row: the newlines scroll, and a scroll is
    // what puts a line into the scrollback. `\r` keeps the cursor at column 1 on the way.
    //
    // Wrapped in save/restore because a real `2J` does NOT move the cursor - it blanks the
    // screen around it. Restoring lands on the same row and column, which is now blank,
    // which is exactly what the sequence promised.
    const scroll = '\x1b7' + `\x1b[${height};1H` + '\r\n'.repeat(height) + '\x1b8'
    return body.split('\x1b[3J').join('').split('\x1b[2J').join(scroll)
  }
}
