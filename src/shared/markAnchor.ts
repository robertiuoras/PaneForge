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
// `npm run test:markanchor`.

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
