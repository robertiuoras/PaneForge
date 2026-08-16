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
// And then Claude Code stopped sending either of them, and the answer stopped being a
// rewrite at all.
//
// Measured 2026-08-13 over this machine's live pane logs: v2.1.229 emits ZERO `2J` and
// ZERO `3J` in 4 MB of output. The version after it went further. Measured 2026-08-15 in
// this desk's own log, at the banner v2.1.233 draws for `/clear`, the whole clear is:
//
//   ESC[53D ESC[4B \r ESC[6A  ▐▛███▜▌ Claude Code v2.1.233 …
//
// A cursor-up and an overdraw. No erase of any kind - not `2J`, not `3J`, and not the
// erase-per-row this file was taught to catch (the nearest one of those was 12,590 bytes
// earlier and belonged to an ordinary repaint). So the banner is painted straight over the
// rows the last turn was on, those rows are destroyed in place, and NOTHING is pushed into
// the scrollback: "the claude avatar hides the previous output". A guard keyed on the
// bytes a vendor happens to send goes silently dead the release after it is written, which
// is the second time in three days that has happened here.
//
// So the preservation no longer waits to be told. `arm()` - called from the pane the
// moment a line like `/clear` is SUBMITTED, off keystrokes the app is relaying anyway -
// returns the scroll itself, and the pane writes it before the CLI has emitted a byte.
// Whatever the CLI does next (a wipe, an erase-per-row, a cursor-up and an overdraw, or
// something that ships next month) it does to a screen that is already blank, with the
// conversation one wheel-notch up. It needs to know nothing about any CLI.
//
// `ESC[1;1H` at the end, rather than a save/restore: the CLI's redraw is relative to where
// it left the cursor, so leaving it near the bottom draws the banner near the bottom under
// forty blank rows. Homing it first is what puts the banner back at the top of a blank
// screen, which is what a clear has always looked like.
//
// The `2J`/`3J` rewrite below stays for a CLI that clears without being asked, and is
// stood down for the moment after an armed scroll: the screen is already blank and
// rewriting the `2J` that follows would push a screenful of blank rows into the scrollback
// in front of the thing being kept.

/** How long an armed clear stands the rewrite below down for. */
const ARM_MS = 10_000

/** The sequences a chunk may be part-way through. */
const NEEDLES = ['\x1b[2J', '\x1b[3J']
/** The most bytes a sequence this cares about can be part-way through. */
const MAX_PARTIAL = 3

/** Could `tail` be the start of one of them, with the rest still to come? */
function partial(tail: string): boolean {
  for (const n of NEEDLES) if (tail.length < n.length && n.startsWith(tail)) return true
  return false
}

/** Is this submitted line an ask for the screen to be cleared? */
export function clearsScreen(line: string): boolean {
  return /^\/(clear|compact|new|reset)\b/i.test(line.trim())
}

/** The commands that throw the screen away, without their slash. */
const CLEARERS = ['clear', 'compact', 'new', 'reset']

/**
 * Could this submitted line have been a clear, once the CLI's own completion menu had its
 * say?
 *
 * `clearsScreen` reads the line as it was TYPED, and that is not what was sent: typing
 * `/cle` opens Claude Code's command menu with `/clear` highlighted and Enter runs the
 * highlighted row, so the pane sees four characters that match nothing and the banner is
 * then drawn straight over the last turn. Measured in a real pane on this machine:
 * `/clear` typed whole keeps the previous answer (2 marker rows before, 2 after), the same
 * clear picked from the menu after typing `/cle` destroys it (2 before, 0 after).
 *
 * So a slash token that is a PREFIX of one of those commands arms as well. The two
 * mistakes are not the same size: a miss destroys the turn somebody was reading, and a
 * false arm scrolls a screen that is about to be repainted anyway - the output is in the
 * scrollback either way, which is what the whole file is for. `/co` therefore arms (it is
 * `/compact`'s prefix) even though the menu may have been showing `/code-review`.
 *
 * Anything with an argument after it is read literally - by then the menu is gone and the
 * words are the command.
 */
export function mayClearScreen(line: string): boolean {
  const t = line.trim()
  if (clearsScreen(t)) return true
  const m = /^\/([a-z-]*)$/i.exec(t)
  if (!m) return false
  const typed = m[1].toLowerCase()
  return CLEARERS.some((c) => c.startsWith(typed))
}

/** As much of a terminal as counting the written rows needs. */
export interface ScreenReader {
  rows: number
  buffer: {
    active: {
      baseY: number
      getLine(y: number): { translateToString(trim?: boolean): string } | undefined
    }
  }
}

/**
 * How many rows from the top of the screen hold anything.
 *
 * Exported rather than written inline in the pane because a test that keeps its own copy
 * of this walk proves nothing about the one that ships: the stubbed `used()` values below
 * cannot catch an off-by-one here, and this is the number that decides how much of the
 * screen is filed.
 */
export function writtenRows(t: ScreenReader): number {
  const b = t.buffer.active
  for (let y = t.rows - 1; y >= 0; y--) {
    if (b.getLine(b.baseY + y)?.translateToString(true).trim()) return y + 1
  }
  return 0
}

export interface ScrollKeeper {
  /** The bytes to write to the terminal for this chunk. */
  (chunk: string): string
  /**
   * The user just asked for the screen to be cleared.
   *
   * @returns the bytes the pane must write to the terminal NOW, ahead of anything the CLI
   *   says: the screen scrolled into the scrollback and the cursor put at the top of the
   *   blank one it leaves. Empty on the alternate screen, which has no scrollback to keep.
   */
  arm(now?: number): string
}

/**
 * @param rows how tall the pane is, asked for at the moment a clear arrives - a pane is
 *   resized constantly and a stale height either loses lines or pads the scrollback.
 * @param alternate whether the terminal is on the alternate screen right now.
 * @param used how many rows from the top of the screen hold anything, defaulting to all of
 *   them. Scrolling only those is what keeps a false arm cheap and keeps a screenful of
 *   blank rows out of the scrollback in front of the turn being kept: the rows below the
 *   last written one are blank already, so scrolling them buys nothing and files nothing.
 */
export function keepScrollback(
  rows: () => number,
  alternate: () => boolean,
  clock: () => number = Date.now,
  used: () => number = rows
): ScrollKeeper {
  let carry = ''
  let armedAt = 0
  // `CSI <rows> ; 1 H` then one newline per row: the newlines scroll, and a scroll is what
  // puts a line into the scrollback rather than deleting it. `\r` keeps the cursor at
  // column 1 on the way.
  const scrollAway = (): string => {
    const height = Math.max(1, rows())
    const lines = Math.max(0, Math.min(height, Math.ceil(used())))
    if (!lines) return `\x1b[${height};1H`
    return `\x1b[${height};1H` + '\r\n'.repeat(lines)
  }
  const keeper = (chunk: string): string => {
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
    // `3J` is the one that destroys the scrollback, and nothing in a session wants that.
    // It goes whether or not this clear was asked for.
    const out = body.split('\x1b[3J').join('')
    // Just after an armed clear the screen is blank already, so a `2J` is left to blank it
    // again: rewriting it would file a screenful of blank rows in front of the turn being
    // kept.
    if (armedAt > 0 && clock() - armedAt < ARM_MS) return out
    armedAt = 0
    // Wrapped in save/restore because a real `2J` does NOT move the cursor - it blanks the
    // screen around it. Restoring lands on the same row and column, which is now blank,
    // which is exactly what the sequence promised.
    return out.split('\x1b[2J').join('\x1b7' + scrollAway() + '\x1b8')
  }
  keeper.arm = (now = clock()): string => {
    if (alternate()) return ''
    armedAt = now
    return scrollAway() + '\x1b[1;1H'
  }
  return keeper
}
