// The arithmetic behind every clock on screen, with no React in it.
//
// It lives here rather than in `renderer/src/components/Elapsed.tsx` for one reason: that
// file is TSX, and a test cannot load JSX through node's type stripping, so these rules
// were unchecked. They are small and they are read a hundred times a second between them,
// which is exactly the shape of thing that is wrong for a fortnight before anybody looks.

/**
 * 42s / 5m 23s / 1h 04m / 3d 04h - always two units, so the width barely moves.
 *
 * Days exist because this also answers "how long has this pane been open", which is
 * routinely overnight and occasionally a week: `171h 20m` is a number somebody has to do
 * arithmetic on to read.
 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  if (h >= 24) return `${Math.floor(h / 24)}d ${String(h % 24).padStart(2, '0')}h`
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`
  return `${s}s`
}

/**
 * How often a readout of this length actually has to be redrawn.
 *
 * Straight off `formatElapsed`: under an hour the last unit drawn is seconds, past it the
 * last unit is minutes and a second-by-second wakeup rewrites an identical string. This is
 * the whole cost saving - a pane's "open for" clock is one per pane and lives for days.
 */
export function stepFor(ms: number): number {
  return ms >= 3600_000 ? 60_000 : 1000
}

/**
 * Which step a moment falls in, measured FROM the clock's own start.
 *
 * The offset is the load-bearing half and looks like decoration. Bucketing on the wall
 * minute (offset 0) passes any test that only checks "does it tick once a minute" and is
 * wrong on screen: a pane opened at 09:00:30 turns its displayed minute over at :30 past,
 * so a bucket aligned to :00 leaves the header reading `1h 04m` for up to 59 seconds after
 * it became `1h 05m`. A clock that is slow is fine; a clock that is WRONG is not.
 */
export function bucketOf(now: number, step: number, offset = 0): number {
  return Math.floor((now - offset) / step)
}

/**
 * How long until the number a COUNTDOWN draws turns over.
 *
 * A countdown card is not the same clock as an elapsed one. `Elapsed` counts up from a
 * start and may bucket against that start; a countdown counts DOWN to a deadline, and the
 * boundary its displayed second turns over on belongs to the DEADLINE, not to the wall
 * clock. `MoveSoon` used a plain `setInterval(1000)` armed at mount, so every displayed
 * number was up to 999 ms stale and the card died on `1s` without ever reaching zero -
 * the pane vanished while the card still said there was a second left, which reads as the
 * countdown having done nothing at all. Reported 2026-08-30 against an assistant pane;
 * `reclaim.log` proved the ENGINE exact (arm to close 14.98-15.00s every time), so the lag
 * was only ever the drawing.
 *
 * Returns the ms to the next turnover, clamped to (0, step]. At the deadline it returns
 * `step` rather than 0, because a timer of 0 is a spin.
 */
export function nextTickMs(deadline: number, now: number, step = 1000): number {
  const left = deadline - now
  const rem = ((left % step) + step) % step
  return rem === 0 ? step : rem
}

export const DAY_MS = 86_400_000

/**
 * When something happened, said the way somebody actually reads it: `4 min ago`.
 *
 * A closing time drawn as `24/08/2026, 13:15` makes the reader do arithmetic against the
 * clock in their own status bar before they can answer the only question History is open
 * for - which of these did I just close. Inside a day the distance is the useful half; past
 * a day the distance stops being readable (`31h ago`) and the date is what identifies it,
 * so that is where this hands back over to the calendar.
 */
export function whenWords(at: number, now = Date.now()): string {
  const ms = now - at
  // A clock that disagrees with the one that wrote the timestamp - a session closed on the
  // other desk, a machine whose clock moved - is not a reason to print a negative age.
  if (!(ms >= 0) || ms >= DAY_MS) return new Date(at).toLocaleString()
  if (ms < 60_000) return 'just now'
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  const r = m % 60
  return r ? `${h}h ${r}m ago` : `${h}h ago`
}

/** 0 B / 74 KB / 3.2 MB - short enough to sit inside a chip on a pane header. */
export function kb(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
