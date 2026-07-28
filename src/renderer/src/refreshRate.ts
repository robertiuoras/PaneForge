/**
 * How fast is this window actually painting?
 *
 * Measured on this machine, not assumed: the main display runs at 480Hz and the window
 * gets 455 frames a second. Every looping decoration in the sidebar was written against
 * a 60Hz budget and silently costs eight times that here, which is what "the app is so
 * laggy" turned out to be. The numbers, from a test copy with ten running keys on screen:
 *
 *   10 keys, glow breathing   gpu 34% of a core, renderer 12%   (peaks measured at 63%)
 *   10 keys, glow held lit     gpu  0.3%,        renderer  0%
 *
 * Nothing cheaper worked. Dropping `will-change` measured WORSE (39%), stepping the
 * timing function measured no better (29%), and the dots and the turn clocks cost
 * nothing either way - it is specifically the halo layer being re-composited 455 times a
 * second, ten times over. On a 60Hz laptop the same thing is a rounding error, so this
 * is a fix that has to know which machine it is on rather than delete the design.
 *
 * rAF rather than an IPC call to `screen.getPrimaryDisplay().displayFrequency`: what
 * matters is the rate this window is really given, which is the display it is currently
 * on - and that changes when the window is dragged to the other monitor.
 */

/** Above this, the looping decorations are held at full instead of animating. */
const HI_REFRESH_FPS = 130

let measuring = false

/** Time ~24 frames and mark the document when they arrive faster than a 120Hz panel. */
export function measureRefreshRate(): void {
  if (measuring) return
  measuring = true
  const t0 = performance.now()
  let frames = 0
  const step = (): void => {
    frames++
    if (frames < 24) return void requestAnimationFrame(step)
    const fps = frames / ((performance.now() - t0) / 1000)
    measuring = false
    // A window that is minimised or occluded is given about 1 frame a second, and that
    // reading says nothing about the panel. Leave the class as it was and try again on
    // the next focus rather than clearing it on a measurement that cannot be trusted.
    if (fps < 20) return
    document.documentElement.classList.toggle('hi-refresh', fps > HI_REFRESH_FPS)
  }
  requestAnimationFrame(step)
}
