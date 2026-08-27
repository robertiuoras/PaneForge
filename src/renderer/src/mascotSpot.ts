/**
 * Where the mascot's sprite is standing, in window pixels, for the panes underneath it.
 *
 * A module rather than a prop: the sprite's box is only known after it has been laid out
 * and after its 900ms walk has finished, and threading that through App into every pane
 * would re-render the whole desk on a transition that concerns at most one of them. Panes
 * subscribe, and a pane that is nowhere near the sprite computes a reserve of 0 and never
 * changes state.
 *
 * `null` means there is nothing to clear - the mascot is off, or hidden behind a minimised
 * window - and is deliberately different from a zero box, which would sit at the top-left
 * corner and reserve the top of a pane.
 */
import type { Box } from '../../shared/mascot'

let rect: Box | null = null
const subs = new Set<(r: Box | null) => void>()

export function mascotRect(): Box | null {
  return rect
}

/** Same box twice is not an event: the walk fires this on every frame it moves. */
export function setMascotRect(next: Box | null): void {
  const same =
    (next === null && rect === null) ||
    (next !== null &&
      rect !== null &&
      Math.abs(next.left - rect.left) < 0.5 &&
      Math.abs(next.top - rect.top) < 0.5 &&
      Math.abs(next.right - rect.right) < 0.5 &&
      Math.abs(next.bottom - rect.bottom) < 0.5)
  if (same) return
  rect = next
  for (const fn of subs) fn(rect)
}

export function onMascotRect(fn: (r: Box | null) => void): () => void {
  subs.add(fn)
  return () => {
    subs.delete(fn)
  }
}
