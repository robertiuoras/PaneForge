/** A clipped OutBuffer adds retained modes above this raw-tail size. */
export const LIVE_REPLAY_LIMIT = 400_000

/** Keep saved scrollback while including output newer than a capped transcript. */
export function freshReplay(saved: string, live: string): string {
  if (!saved) return live
  if (!live) return saved
  // OutBuffer prepends retained DEC modes after trimming. They are not bytes at
  // the overlap boundary; keep them only when the streams no longer overlap.
  const modePrefix = live.length > LIVE_REPLAY_LIMIT ? live.match(/^\x1b\[\?([\d;]+)h/) : null
  const retainedModes = modePrefix?.[1].split(';').every(n =>
    [9, 47, 1047, 1049, 1000, 1002, 1003, 1006, 2004].includes(Number(n)))
  const tail = retainedModes ? live.slice(modePrefix![0].length) : live
  if (!tail) return saved
  // KMP finds the longest exact saved suffix / live prefix in linear time. A
  // repetitive spinner must not turn a 400 KB tail into quadratic work.
  const prefix = new Uint32Array(tail.length)
  for (let i = 1, n = 0; i < tail.length; i++) {
    while (n && tail[i] !== tail[n]) n = prefix[n - 1]
    if (tail[i] === tail[n]) n++
    prefix[i] = n
  }
  let overlap = 0
  const start = Math.max(0, saved.length - tail.length)
  for (let i = start; i < saved.length; i++) {
    while (overlap && saved[i] !== tail[overlap]) overlap = prefix[overlap - 1]
    if (saved[i] === tail[overlap]) overlap++
    if (overlap === tail.length && i < saved.length - 1) overlap = prefix[overlap - 1]
  }
  if (overlap) return saved + tail.slice(overlap)
  // A gap cannot reconstruct the missing cursor state. Cancel a potentially
  // unfinished escape and retain both streams; the replay handler requests a
  // real CLI frame once parsing has settled. The original disk log stays intact.
  return saved + '\x18' + live
}
