// Whether an app activation is one that should put the main window on screen.
//
// macOS activates the WHOLE application when any of its windows is clicked, and PaneForge
// answers activation by revealing its main window - which is the only way back into a copy
// that launched hidden, and into an app that was Cmd-Tabbed to with nothing on screen.
//
// The Stash is one of its windows. So clicking a row to copy something, or grabbing the
// grip to move the overlay, activated PaneForge and pulled the whole window over whatever
// you were typing in. That is the exact opposite of what the overlay is for: it exists so
// you can copy here and press Cmd-V THERE, in the app you were already in, and an app that
// takes the screen has also taken the keyboard focus the paste needed.
//
// The window's own options are the real fix (a non-activating panel never activates the app
// at all - see shelfWindow.ts), and this is the belt: whatever AppKit decides to emit, an
// activation that a press on the Stash explains is not one anybody asked for.
//
// It is a pure function because the alternative is checking it on a Mac by hand, and a rule
// measured in milliseconds is one nobody re-tests once it looks plausible.

/**
 * How long before an activation a press on the Stash still explains it.
 *
 * The press and the activation are the same gesture, but they reach the main process by
 * different routes - AppKit's activation notification, and the input event as the browser
 * routes it to the overlay - and nothing promises an order. So the answer is "within a few
 * frames either way", not "before" or "after". Short enough that a press, then a deliberate
 * Cmd-Tab a moment later, still shows the window.
 */
export const SHELF_TOUCH_MS = 400

/**
 * How long to wait before acting on an activation, so the other half of the gesture has
 * arrived. A reveal is a window appearing; an eighth of a second later is not a wait.
 */
export const ACTIVATION_SETTLE_MS = 120

export interface Activation {
  /** When the activation arrived. */
  activatedAt: number
  /** Anything this close to startup is the launch's own activation, not a click. */
  quietUntil: number
  /** When a pointer was last pressed on the Stash overlay; 0 if never. */
  shelfTouchedAt: number
  /** Override for SHELF_TOUCH_MS, for tests. */
  window?: number
}

/** True when this activation should reveal (and focus) the main window. */
export function revealOnActivation(a: Activation): boolean {
  if (a.activatedAt < a.quietUntil) return false
  if (a.shelfTouchedAt > 0) {
    // Negative when the press landed AFTER the activation - which is the ordering that
    // actually happens on a click, so it is the case that has to be covered, not the
    // one that reads naturally.
    const since = a.activatedAt - a.shelfTouchedAt
    if (since <= (a.window ?? SHELF_TOUCH_MS)) return false
  }
  return true
}
