// Keeping a prompt tag on the line it was sent on, when the CLI moves the lines.
//
// A pane's prompt rail hangs off xterm markers, because a marker is the only thing that
// keeps a buffer line right while the buffer scrolls and says so when that line is finally
// forgotten. What it also does, and what nothing in the rail expected, is die whenever the
// CLI ERASES that line - which is not the buffer forgetting anything at all.
//
// Found by replaying this machine's own pane logs into a real xterm, registering a marker
// every 20 KB, and taking a stack trace from inside the disposal:
//
//   eraseInDisplay -> _resetBufferLine -> Buffer.clearMarkers -> Marker.dispose
//
// So `CSI J` kills every tag on every row it blanks, and `CSI 2 K` - erase in LINE - kills
// none. That one difference is the whole bug report: Claude Code repaints a row at a time
// with `2K`, Codex repaints with `CSI J`.
//
//   Claude Code  0 of 278 markers lost
//   Codex        1 of 4, 1 of 2, 1 of 3 lost  (25%, 50%, 33%, three different panes)
//
// That is the "Codex shows no prompt tags so I cannot jump to my prompts" report. The
// prompt has not scrolled out of anything - its line is still sitting in the buffer, and
// the CLI is about to draw over it with the same transcript it just erased.
//
// So a disposal is read for what it is. If the line is gone from the buffer the tag is
// genuinely over; if the line is still there, another marker is registered on it and the
// tag carries on. Two details are load-bearing:
//
//   - the replacement is registered on a DEFERRED callback, because the disposal fires
//     from inside xterm's own walk over its marker list (and from inside the erase that
//     started it), and registering one there mutates the array being walked;
//   - the line comes from the caller, not from the marker, because xterm sets a marker's
//     line to -1 BEFORE it announces the disposal.
//
// A second way a tag ends up on the wrong row, and the one that made every tag after the
// first useless in a Claude Code pane (measured 2026-09-03 in a dev copy, four prompts of
// 120-line replies): the CLI STREAMS a reply inside the screen and only writes it out into
// scrollback when the NEXT prompt is sent. So at submit time the composer sits a few rows
// under the previous reply's start, the tag is registered there - buffer row 10 for a
// prompt whose echo would later be on row 133 - and the flush that follows erases that
// row (`CSI J`, which disposes the marker) and refills it with the middle of the previous
// reply. Re-registering on "the same row" is exactly wrong here: the row number survived,
// the content did not. Marks were [6, 10, 138, 265] against echoes at [6, 133, 260, 387] -
// every tag but the first one reply-length early, and a click on any of them landed on
// row 9 of a numbers list.
//
// So a tag is checked against the one thing that identifies its prompt: the CLI's own echo
// of it (`❯ text`, `shared/promptEcho.ts`). A tag whose row no longer carries its echo
// looks for the row that does, newest first, between its neighbours, and moves there.
// `echoKey`, `onEchoRow` and `findEcho` are the pure half; the pane owns the marker swap.
// A pane whose CLI prints no such echo (a shell) simply never matches and never moves.
//
// `npm run test:markanchor`.

import { promptEcho } from './promptEcho'

/** How much of a prompt identifies it on its echo row. */
export const ECHO_KEY_CHARS = 24
/**
 * How far back from the end of the buffer the newest tag is looked for. The flush that
 * moves an echo writes it near the tail - the previous reply plus a screen - and a scan
 * bounded here keeps a shell pane's never-matching tags from reading 20,000 rows a beat.
 */
export const ECHO_SCAN_ROWS = 2000

/** The part of a prompt its echo row must begin with. Whitespace collapsed, capped. */
export function echoKey(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, ECHO_KEY_CHARS)
}

/** Whether this buffer row is the CLI's echo of the prompt `key` came from. */
export function onEchoRow(row: string | undefined, key: string): boolean {
  if (!row || !key) return false
  const e = promptEcho(row)
  return e.length > 0 && e.replace(/\s+/g, ' ').startsWith(key)
}

/**
 * The row between `from` and `to` (both exclusive) carrying the echo of `key`, newest
 * first, or -1. `row(i)` reads one buffer line as text.
 */
export function findEcho(
  row: (i: number) => string | undefined,
  from: number,
  to: number,
  key: string
): number {
  if (!key) return -1
  for (let i = to - 1; i > from; i--) if (onEchoRow(row(i), key)) return i
  return -1
}

export interface AnchoredMarker {
  /** The buffer line, or -1 once xterm has disposed it. */
  readonly line: number
  onDispose(cb: () => void): void
}

/** The bit of a terminal this needs, so the test drives the real function. */
export interface MarkerHost {
  /** The absolute buffer line the cursor is on (xterm's `baseY + cursorY`). */
  cursor(): number
  /** How many lines the buffer holds, scrollback included. */
  length(): number
  /** xterm's `registerMarker`, whose argument is an offset from the cursor. */
  register(offset: number): AnchoredMarker | undefined
  /** Run this once the callback that is running now has finished. */
  defer(fn: () => void): void
}

/** What the caller keeps per tag. `line` is refreshed by the caller as the buffer moves. */
export interface Anchored {
  marker: AnchoredMarker
  line: number
}

export interface AnchorHooks {
  /** False once the pane is gone - nothing is re-registered after that. */
  alive: () => boolean
  /** The tag is genuinely over: forget it. */
  drop: () => void
  /** A replacement is in place; the rail should redraw. */
  changed: () => void
}

/**
 * Is the line this tag was last seen on one worth registering another marker on?
 *
 * Line 0 is the exception, and it is the whole trim story. xterm trims by walking its
 * markers, taking the trimmed count off each line and disposing the ones that go below
 * zero - so a marker the scrollback has finally forgotten was, one moment earlier, on
 * line 0. That is indistinguishable here from a marker still sitting on the oldest line
 * in the buffer, and getting it wrong in the direction of keeping it would leave a tag
 * pointing at somebody else's output for the rest of the run. A tag that has reached the
 * top of the scrollback is one line from being gone anyway, so it goes.
 */
function reusable(host: MarkerHost, entry: Anchored): boolean {
  return entry.line > 0 && entry.line < host.length()
}

/**
 * Bind `entry` to `marker`, and put it back on a fresh one for as long as its line is
 * still in the buffer.
 */
export function anchorMark(
  host: MarkerHost,
  entry: Anchored,
  marker: AnchoredMarker,
  hooks: AnchorHooks
): void {
  entry.marker = marker
  marker.onDispose(() => {
    // A marker the entry has already moved off - see the echo relocation in the pane -
    // is disposed by the pane itself, and must not be put back.
    if (entry.marker !== marker) return
    if (!hooks.alive()) return
    if (!reusable(host, entry)) {
      hooks.drop()
      return
    }
    host.defer(() => {
      if (!hooks.alive()) return
      if (!reusable(host, entry)) {
        hooks.drop()
        return
      }
      const again = host.register(entry.line - host.cursor())
      if (!again || again.line < 0) {
        hooks.drop()
        return
      }
      anchorMark(host, entry, again, hooks)
      hooks.changed()
    })
  })
}
