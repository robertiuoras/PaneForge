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

/** 0 B / 74 KB / 3.2 MB - short enough to sit inside a chip on a pane header. */
export function kb(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
