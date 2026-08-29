import { useCallback, useRef, useState } from 'react'

/**
 * `useState` that does not tell React about an update which changes nothing.
 *
 * React bails out of a re-render when a dispatch produces the value the state already
 * holds - but it does so INSIDE the dispatcher, after `requestUpdateLane`, an update
 * object and (for a functional update) the eager evaluation. A pane's `onRender` and
 * `onScroll` fire on every painted frame and every printed line, so eight shells at full
 * blast dispatched thousands of no-op updates a second for a desk that re-rendered
 * seventeen times: measured 2026-08-29 over eight printing panes, `requestUpdateLane`
 * alone was 21% of the renderer's whole profile with the garbage collector on top of it,
 * while the desk's own React work - render plus commit for the entire window - was 37ms
 * of a 3-second run.
 *
 * So the comparison moves in front of the dispatcher: the current value is mirrored in a
 * ref and an equal one returns without touching React at all. The updater form is kept
 * because that is how a caller says "same object when nothing moved" (see `syncGeom`),
 * and it is evaluated here against the ref rather than by React against the fiber.
 */
export function useQuietState<T>(initial: T): [T, (next: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState(initial)
  const held = useRef(value)
  const set = useCallback((next: T | ((prev: T) => T)) => {
    const v = typeof next === 'function' ? (next as (prev: T) => T)(held.current) : next
    if (Object.is(v, held.current)) return
    held.current = v
    setValue(v)
  }, [])
  return [value, set]
}
