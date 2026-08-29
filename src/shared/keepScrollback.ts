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
// `ESC[1;1H` then `ESC[J` at the end, rather than a save/restore: the CLI's redraw is
// relative to where it left the cursor, so leaving it near the bottom draws the banner
// near the bottom under forty blank rows. Homing it first is what puts the banner back at
// the top, and erasing from there down is what makes the screen it is drawn on genuinely
// blank - see `blank` below for why the scroll alone does not.
//
// The `2J`/`3J` rewrite below stays for a CLI that clears without being asked, and is
// stood down for the moment after an armed scroll: the screen is already blank and
// rewriting the `2J` that follows would push a screenful of blank rows into the scrollback
// in front of the thing being kept.

// ---------------------------------------------------------------------------------------
//
// ...and then 2.1.235 wiped the screen a third way, which is why the answer below stopped
// being a list of the shapes a vendor has used.
//
// Measured 2026-08-19 against a live `claude` in a real pty, capturing the bytes a
// submitted `/clear` really produces (`2J` 0, `3J` 0, `ESC[J` 0):
//
//   ESC[H  (ESC[2K ESC[1B) x29  ESC[H  <banner>
//
// A home, then every row on the screen erased in place walking down, then the banner drawn
// on top. An erase-in-line blanks a row where it sits; nothing is scrolled, so nothing
// reaches the scrollback and the turn that was on screen is gone. Three releases, three
// different byte patterns (`2J`+`3J`, a bare cursor-up overdraw, and this), and a guard
// written against any one of them is dead the week after.
//
// What all three have in common is not a sequence, it is a SHAPE: the cursor is sent to
// the top of the screen and the first thing that happens there is an erase rather than
// something being written. Nothing repaints that way except a wipe - a CLI redrawing its
// composer erases the rows it is standing on, and one redrawing a frame writes over it.
// Measured over this machine's own pane logs, a home is rare enough to key on: 0-12 bare
// `ESC[H` and 4-28 `ESC[1;1H` per 8 MB of output, and the ones that are there ARE wipes
// (a CLI's startup repaint, Codex's `ESC[1;1H ESC[J`).
//
// So `homeWipe` below files the screen when it sees home-then-erase, whatever the bytes
// after that turn out to be, and whoever asked for it. That last part matters as much as
// the shape: `arm()` is fed by keystrokes in ONE window, so the app's own Clear button
// (which writes `/clear` straight at the pty), a phone typing into a desk pane, a prompt
// the app queues, and the CLI compacting itself when its context fills all cleared the
// screen with nothing armed. Measured in the running app: a pane cleared by keystrokes
// kept its screen, the same pane cleared through `api.write` lost it.
//
// `arm()` stays, because it is the only thing that can act BEFORE a CLI that erases
// nothing at all, and it stands the data path down for a moment so one clear is not filed
// twice.

/** How long an armed clear stands the rewrite below down for. */
const ARM_MS = 10_000

/**
 * How many rows a CLI has to erase in a row before that run is a wipe.
 *
 * ...and then 2.1.241 wiped the screen a FOURTH way, walking UP instead of down:
 *
 *   ESC[8D ESC[30B  (ESC[2K ESC[1A) x32  ESC[G ESC[1A  ESC[11A  <banner>
 *
 * The cursor still ends at the top of the screen, but it gets there with cursor-ups
 * rather than a home - so `homed` is never set, `homeWipe` never fires, and the turn that
 * was on screen is destroyed with nothing filed. Measured 2026-08-24 in this desk's own
 * pane log: 5 of these against 73 of the home-then-walk-down shape, and the last two are
 * the clears Robert lost his screen to.
 *
 * So the shape this keys on is the RUN itself rather than where the cursor came from:
 * erase a row, step one row, repeat, writing nothing in between. Nothing redraws that way
 * except a wipe. Measured over the same 3.7 MB log, the run lengths are bimodal with
 * nothing in the middle - 12 runs of 0-1 rows (a CLI redrawing the composer it stands on)
 * and 79 runs of 10-32 (every one a wipe) - so a threshold of 6 separates them with room
 * either side. A report is cheap in any case: `screenLoss.ts` decides whether the screen
 * was really lost, and refuses a repaint that put its own rows back.
 */
const WIPE_RUN = 6

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
      /** Where the caret is on the screen. The composer is drawn around it. */
      cursorY?: number
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

/**
 * The glyphs a CLI rules its composer off with. Claude Code 2.1.234 draws a horizontal
 * rule above and below the input; Codex and Gemini draw a full box, whose corners and
 * sides are in the same block.
 */
const FRAME = /^[\s\u2500-\u257f]+$/
/** How short a run of them is still a markdown separator rather than a composer edge. */
const FRAME_MIN = 8

/** This row is nothing but frame: a composer edge, not something somebody wrote. */
export function ruleRow(text: string): boolean {
  const t = text.trim()
  return t.length >= FRAME_MIN && FRAME.test(t)
}

/** How far above the caret a composer's top edge may be before this stops believing it. */
const COMPOSER_MAX = 20

/**
 * The screen row the composer starts on, or null when this pane draws none.
 *
 * The caret has to be INSIDE the pair of rules for them to count, which is what keeps a
 * markdown separator in an answer from being read as an input box and swallowing the rows
 * under it.
 */
export function composerTop(t: ScreenReader, written: number): number | null {
  const b = t.buffer.active
  const cur = b.cursorY
  if (cur === undefined || cur < 1) return null
  const line = (y: number): string => b.getLine(b.baseY + y)?.translateToString(true) ?? ''
  let bottom = -1
  for (let y = Math.min(t.rows - 1, written); y > cur; y--) {
    if (ruleRow(line(y))) {
      bottom = y
      break
    }
  }
  if (bottom < 0) return null
  for (let y = cur - 1; y >= Math.max(0, bottom - COMPOSER_MAX); y--) {
    if (ruleRow(line(y))) return y
  }
  return null
}

/**
 * How much of the screen is HISTORY - everything above the composer the CLI is drawing.
 *
 * `writtenRows` on its own files the composer too, and at the moment a clear is submitted
 * the composer is still showing the very line that was submitted. So `/clear` was kept
 * TWICE: once as the box that still held it, and once as the CLI's own echo of it on the
 * fresh screen. Measured in a live pane before this - six `❯ /clear` rows in the
 * scrollback for three clears, which is "it shows duplicated /clear message".
 *
 * The composer is live UI redrawn on every keystroke and is never a record of anything, so
 * it and the hint lines under it are left where they are rather than filed.
 */
export function keptRows(t: ScreenReader): number {
  const written = writtenRows(t)
  const top = composerTop(t, written)
  return top === null ? written : Math.min(written, top)
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
  used: () => number = rows,
  onWipe: () => void = () => {}
): ScrollKeeper {
  let carry = ''
  // Negative infinity rather than 0: a clock that starts at 0 is a real clock (a test's,
  // a monotonic one), and `armedAt > 0` quietly turned the standdown off for it.
  let armedAt = Number.NEGATIVE_INFINITY
  // The cursor has been sent to the top of the screen and nothing has been written there
  // since. An erase arriving in that state is a wipe rather than a repaint - see the note
  // at the top of the file for the measurement that says so.
  let homed = false
  // How many rows this run of erase-in-line has blanked with nothing written between
  // them. See `WIPE_RUN`.
  let eraseRun = 0
  // `CSI <rows> ; 1 H` then one newline per row: the newlines scroll, and a scroll is what
  // puts a line into the scrollback rather than deleting it. `\r` keeps the cursor at
  // column 1 on the way.
  const scrollAway = (): string => {
    const height = Math.max(1, rows())
    const lines = Math.max(0, Math.min(height, Math.ceil(used())))
    if (!lines) return `\x1b[${height};1H`
    return `\x1b[${height};1H` + '\r\n'.repeat(lines)
  }
  // Home, then erase everything from there down.
  //
  // The scroll above files the HISTORY rows and only those, which is right - but a scroll
  // of N rows moves the whole screen up by N, so the rows it did not file (the composer,
  // its hint line, whatever the CLI was drawing under it) are still on screen, now sitting
  // at the top. The banner is then painted over the first few of them and the rest are
  // left in place around it: `────|`, `❯ h 10%pass permissions on (shift+tab to cycle)`,
  // half a rule - a composer cut in half by a banner drawn through it. That is the
  // "it is still cut off after /clear" report, and it is on the LIVE screen rather than in
  // the scrollback, which is why the kept turn above it reads fine.
  //
  // `ESC[J` (erase from the cursor to the end of the display) touches no scrollback - only
  // `3J` does - so what has just been filed is safe, and what is wiped is live UI the CLI
  // redraws on its next keystroke.
  const blank = '\x1b[1;1H\x1b[J'

  /**
   * File the screen, or nothing at all when one clear is already being handled.
   *
   * The standdown is what keeps ONE clear from being filed twice: an armed `/clear` has
   * already scrolled the screen away before the CLI emitted a byte, and the wipe that
   * follows would otherwise file a screenful of blanks in front of the turn being kept.
   * The same window covers the 29 row-erases the wipe itself is made of.
   */
  const fileScreen = (): string => {
    if (clock() - armedAt < ARM_MS) return ''
    armedAt = clock()
    return scrollAway() + blank
  }

  /**
   * Say that a wipe has started - once per wipe, and never for one the pane armed itself.
   *
   * A wipe is thirty-odd row erases and the pane needs to hear about the first only. The
   * standdown does both jobs: it collapses the run, and it stays quiet for a clear that
   * was armed off the keystrokes, whose screen is already in the scrollback.
   */
  const wiped = (): void => {
    if (clock() - armedAt < ARM_MS) return
    armedAt = clock()
    onWipe()
  }

  /** A whole CSI sequence starting at `i`, or null when the chunk ends inside one. */
  const csiAt = (s: string, i: number): { seq: string; params: string; final: string } | null => {
    let j = i + 2
    while (j < s.length && s.charCodeAt(j) >= 0x20 && s.charCodeAt(j) <= 0x3f) j++
    while (j < s.length && s.charCodeAt(j) >= 0x20 && s.charCodeAt(j) <= 0x2f) j++
    if (j >= s.length) return null
    return { seq: s.slice(i, j + 1), params: s.slice(i + 2, j), final: s[j] }
  }

  /** A run holding something other than cursor movement - see the copy loop below. */
  const PLAIN = /[^\r\n]/

  /** How far past an ESC this waits for the rest of a sequence before giving up on it. */
  const MAX_SEQ = 64
  /** The same, for an OSC - a window title can be a whole path. */
  const MAX_OSC = 1024

  const keeper = (chunk: string): string => {
    const s = carry + chunk
    carry = ''
    // The alternate screen has no scrollback to protect: vim, less and a CLI's own menu
    // clear constantly, and rewriting those would push a frame of redraw into the real
    // scrollback several times a second.
    if (alternate()) return s
    // The whole of a CLI's output passes through here, so how it is COPIED is the cost.
    // Character at a time with `out += ch` allocated a new string per byte: measured over
    // 30s of eight shell panes at full blast, the renderer spent 42.5% of its profile in
    // the garbage collector (12.9s of 30.4s) and a keystroke took 553ms to reach a frame.
    // A run of plain text is now taken in one slice, and a chunk carrying no escape at all
    // - which is most of them - is returned untouched. Same answer, one allocation.
    let out = ''
    let i = 0
    while (i < s.length) {
      const esc = s.indexOf('\x1b', i)
      if (esc !== i) {
        const end = esc < 0 ? s.length : esc
        const run = s.slice(i, end)
        // Anything written lands where the cursor is, so the screen is no longer waiting
        // untouched at its top. A run of nothing but carriage returns and newlines is a
        // walk, not a write, which is the distinction the two flags below are about.
        if (PLAIN.test(run)) {
          homed = false
          // Something was written between two erases, so this is a redraw and not a walk.
          eraseRun = 0
        }
        // The common case by a mile: one chunk, no escapes, no copy at all.
        out = out ? out + run : run
        i = end
        if (esc < 0) break
        continue
      }
      const ch = s[i]
      const next = s[i + 1]
      if (next === undefined) {
        carry = s.slice(i)
        break
      }
      if (next === ']') {
        // OSC: a title, a colour query, a hyperlink. It writes nothing to the screen.
        const bel = s.indexOf('\x07', i)
        const st = s.indexOf('\x1b\\', i + 2)
        const endAt = bel >= 0 && (st < 0 || bel < st) ? bel + 1 : st >= 0 ? st + 2 : -1
        if (endAt < 0) {
          if (s.length - i < MAX_OSC) {
            carry = s.slice(i)
            break
          }
          out += ch
          i++
          continue
        }
        out += s.slice(i, endAt)
        i = endAt
        continue
      }
      if (next !== '[') {
        // `ESC M`, `ESC 7`, `ESC =` and friends: two bytes, and every one of them either
        // moves the cursor or changes a mode, so the top of the screen is no longer
        // untouched.
        homed = false
        out += s.slice(i, i + 2)
        i += 2
        continue
      }
      const csi = csiAt(s, i)
      if (!csi) {
        if (s.length - i < MAX_SEQ) {
          carry = s.slice(i)
          break
        }
        out += ch
        i++
        continue
      }
      const { seq, params, final } = csi
      const n = params.replace(/^[?<>!]/, '')
      if (final === 'H' || final === 'f') {
        // A home is the only cursor move that arms this: `ESC[H`, `ESC[1;1H`, `ESC[1H`.
        homed = n === '' || n === '1' || n === '1;1'
        eraseRun = 0
        out += seq
      } else if (final === 'J' && n === '3') {
        // The one sequence that destroys the scrollback itself. Nothing in a session wants
        // it, asked for or not.
      } else if (final === 'J' && (n === '' || n === '0' || n === '2')) {
        if (n === '2') {
          // A `2J` does NOT move the cursor - it blanks the screen around it - so the
          // scroll is wrapped in a save/restore and lands back where it started.
          // The scroll ends with a blank screen and the cursor put back where the `2J`
          // found it, which is everything the sequence promised - so it is dropped rather
          // than replayed over the blank it would land on.
          const away = fileScreen()
          out += away ? '\x1b7' + away + '\x1b8' : seq
        } else {
          // Erase from the cursor down, from the top of the screen: a wipe. Reported to
          // the pane rather than rewritten - see `wiped`.
          if (homed) wiped()
          out += seq
        }
        homed = false
        eraseRun = 0
      } else if (final === 'K') {
        // Erase in line. One of these at the top of an untouched screen is the first row
        // of an erase-per-row wipe - which is how Claude Code 2.1.235 clears. And a RUN of
        // them, whichever way the cursor is walking, is how 2.1.241 clears - see
        // `WIPE_RUN`.
        if (homed) wiped()
        if (++eraseRun === WIPE_RUN) wiped()
        out += seq
      } else if ('ABCDEFGIdSTLM@P'.includes(final)) {
        // Every other cursor move, scroll or insert: the top of the screen is no longer
        // where the next byte lands.
        homed = false
        // A one-row step is what an erase-per-row walk is made of, in either direction, so
        // it carries the run; anything else ends it.
        if (!((final === 'A' || final === 'B') && (n === '' || n === '1'))) eraseRun = 0
        out += seq
      } else {
        // Colours, modes, cursor shape, scroll regions: they write nothing, so a home
        // followed by one of them is still a home.
        out += seq
      }
      i += seq.length
    }
    return out
  }
  keeper.arm = (now = clock()): string => {
    if (alternate()) return ''
    armedAt = now
    return scrollAway() + blank
  }
  return keeper
}
