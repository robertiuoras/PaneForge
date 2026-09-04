// Whether an app activation is one that should put the main window on screen.
//
// macOS activates the WHOLE application when any of its windows is clicked, and PaneForge
// answers activation by revealing its main window - which is the only way back into a copy
// that launched hidden, and into an app that was Cmd-Tabbed to with nothing on screen.
//
// The one activation that must NOT reveal anything is the launch's own: macOS emits one for
// the launch itself, and a copy an agent started minimized would answer it by showing
// itself over whatever is on the screen.
//
// It is a pure function because the alternative is checking it on a Mac by hand.

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
}

/** True when this activation should reveal (and focus) the main window. */
export function revealOnActivation(a: Activation): boolean {
  return a.activatedAt >= a.quietUntil
}
