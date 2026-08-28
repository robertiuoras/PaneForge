// Two copies of this app on one desk: the live one and `npm run try`.
//
// Checking a change means having both on screen at once, and doing that by hand - drag,
// resize, drag the other, resize - is the manual work this app exists to stop. So when a
// second screen is attached the two copies take a half of it each: the live app on the
// left, a named profile (`dev`) on the right, decided once at launch.
//
// Every rule here is a refusal, because the failure mode is the app moving somebody's
// window for no reason:
//
// - **Nothing happens on the laptop alone.** One screen is the whole desk; halving it puts
//   two 800px windows where a person had one they had already placed. The MacBook is
//   routinely the only screen, so this is the common case and it must be a no-op.
// - **The EXTERNAL screen, never the primary one.** On this desk the built-in Retina is
//   `getPrimaryDisplay()` while the 1920x1080 beside it is the one to fill, so primary is
//   exactly the wrong reading. Electron's `internal` flag is what separates them.
// - **A half nobody could use is not offered.** The window's own `minWidth` is 900, so a
//   1280-wide screen would hand each copy 640 and the platform would clamp them back into
//   an overlap - the same mess by a longer route. Under the floor, nothing moves.
// - **Launch only.** This never runs on a display change or a poll: a person who drags a
//   window has said where they want it, and a snap that fires again would take it back.

/** A rectangle in screen coordinates. Electron's `Display.workArea` shape. */
export interface SnapRect {
  x: number
  y: number
  width: number
  height: number
}

/** The part of `Electron.Display` this decision reads. */
export interface SnapScreen {
  id: number
  /** true for the machine's own panel; Electron reports this per display. */
  internal: boolean
  workArea: SnapRect
}

/**
 * Narrowest half worth having. The window's `minWidth` is 900: a half under it is not a
 * half, it is two windows the platform will push back into each other.
 */
export const MIN_HALF = 900

export interface SnapPlan {
  bounds: SnapRect
  /** which side this copy took, for the log line */
  side: 'left' | 'right'
}

/**
 * Where this copy should open, or `null` for "leave the window exactly as it was".
 *
 * `profile` is the empty string for the installed app and the profile name (`dev`) for a
 * test copy, which is the only thing separating the two halves.
 */
export function snapPlan(screens: SnapScreen[], profile: string): SnapPlan | null {
  if (screens.length < 2) return null
  // Widest external, so a desk with two of them fills the bigger one rather than whichever
  // the platform happened to list first.
  const external = screens
    .filter((s) => !s.internal)
    .sort((a, b) => b.workArea.width - a.workArea.width)[0]
  if (!external) return null
  const { x, y, width, height } = external.workArea
  const half = Math.floor(width / 2)
  if (half < MIN_HALF) return null
  const side = profile ? 'right' : 'left'
  return {
    side,
    bounds: { x: side === 'left' ? x : x + (width - half), y, width: half, height }
  }
}
