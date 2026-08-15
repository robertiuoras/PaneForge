// Quitting the whole app when nobody is using it.
//
// The pane-level clocks in reclaim.ts close individual panes; this closes the window and
// the process. Robert's reason for wanting it: PaneForge does not need to be open at all
// times, and an Electron app with a few live ptys is the largest idle thing on the desk.
//
// The refusals are stricter than reclaim's, because the cost of being wrong is bigger. A
// wrongly closed pane is reopened from History; a wrongly quit app takes every pane with
// it, mid-turn, and whatever was being generated is gone. So:
//
//   - Never while the window is focused. Somebody is at it, whatever the keyboard says.
//   - Never while ANY pane is working, starting or stalled. A running turn is not idle
//     just because nobody is typing at it, and stalled means a turn is still open.
//   - Never while a pane is remote. Another device is driving this machine through it,
//     and quitting would cut the link that the person on the other end is using.
//   - Never with no panes at all - there is nothing to save, and an empty window that
//     closes itself is a window that cannot be left open on purpose.
//
// The clock is keyboard input, the same signal reclaim uses, because pty output repaints
// for status lines and would keep a finished desk alive forever.
//
// Pure: no Electron, no `os`, `now` is passed in. `npm run test:idlequit`.

import type { FleetState } from './fleet'

/** States that mean a turn is in flight. Any one of them vetoes the quit. */
const BUSY: ReadonlySet<FleetState> = new Set<FleetState>(['working', 'starting', 'stalled'])

export interface IdleQuitPane {
  state: FleetState
  /** Epoch ms of this pane's most recent user input. */
  lastKeyboard: number
  /** Another device's pty, mirrored here. Quitting cuts somebody else's link. */
  remote: boolean
}

export interface IdleQuitInput {
  panes: IdleQuitPane[]
  /** Minutes of no input before the app quits itself. 0 (the default) is off. */
  minutes: number
  /** The window has keyboard focus right now. */
  focused: boolean
  /**
   * Epoch ms of the last input anywhere in the app that was NOT typed into a pane -
   * clicks, the shelf, the settings dialog. Without it, reading the fleet board for
   * twenty minutes looks exactly like being away.
   */
  lastAppInput: number
  now: number
}

export interface IdleQuitVerdict {
  quit: boolean
  /** Why, in the words that go in the log line. */
  reason: string
  /** How long the desk had been quiet, ms. 0 when a refusal fired first. */
  idleMs: number
}

/**
 * Whether to quit now.
 *
 * Returns a reason either way: a feature that closes the app on a timer has to be able to
 * say why it did, and "why did it NOT" is the question actually asked when it feels stuck.
 */
export function idleQuitVerdict(input: IdleQuitInput): IdleQuitVerdict {
  const minutes = Math.max(0, input.minutes ?? 0)
  if (!minutes) return { quit: false, reason: 'off', idleMs: 0 }
  if (input.focused) return { quit: false, reason: 'window focused', idleMs: 0 }
  if (!input.panes.length) return { quit: false, reason: 'no panes', idleMs: 0 }

  const busy = input.panes.find((p) => BUSY.has(p.state))
  if (busy) return { quit: false, reason: `a pane is ${busy.state}`, idleMs: 0 }
  if (input.panes.some((p) => p.remote)) {
    return { quit: false, reason: 'a pane is driven from another device', idleMs: 0 }
  }

  // The most recent touch anywhere wins: one busy pane keeps the whole app alive, which is
  // the point - the question is whether the PERSON is here, not whether a given pane is.
  const lastTouch = Math.max(input.lastAppInput, ...input.panes.map((p) => p.lastKeyboard))
  const idleMs = input.now - lastTouch
  if (idleMs < minutes * 60_000) {
    return { quit: false, reason: 'not idle long enough', idleMs: Math.max(0, idleMs) }
  }
  return { quit: true, reason: `no input for ${Math.round(idleMs / 60_000)} min`, idleMs }
}
