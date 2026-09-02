// A paired machine updates on its own clock, so the two ends of a link can carry
// different builds for a while - a fix landed on one is not necessarily on the other
// until both restart. `versionGap` is the one place that decides whether the Devices
// panel says so.

/**
 * The sentence to draw on a connected device's row, or null when there is nothing to
 * say: no version known yet, or both machines already agree.
 */
export function versionGap(theirs: string | undefined, ours: string): string | null {
  const t = (theirs ?? '').trim()
  const o = ours.trim()
  if (!t || !o) return null
  if (t === o) return null
  return `on ${t}, this one is ${o}`
}
