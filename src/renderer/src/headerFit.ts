// Measuring a pane header, so it drops a control only when there is really no room.
//
// The ladder and the climb are in `shared/headerFit.ts`; this is the half that needs a
// window. It writes `data-tight` straight onto the header element and keeps NO React
// state: a `setState` here would re-render the pane (and, through the sessions list, every
// other one) for a number only a CSS attribute selector ever reads. Same reasoning as
// `quietState.ts`.
//
// The row is ASKED, never calculated. A flex row that is too narrow has already shrunk its
// own children, so every width read back is the squeezed one and the arithmetic says a
// 196px header fits what wants 536px. Setting the attribute and reading the layout back
// costs a synchronous reflow per rung, at most six per resize per header, and only while a
// window is actually being dragged.

import { useEffect, useRef } from 'react'
import { climbLevel, MORE_FROM, TIGHT_GROUPS } from '../../shared/headerFit'

/** Does the row fit as it is drawn right now? */
function fits(header: HTMLElement): boolean {
  // One pixel of tolerance: sub-pixel layout makes an exact comparison flicker.
  if (header.scrollWidth > header.clientWidth + 1) return false
  const name = header.querySelector<HTMLElement>('.pt-name')
  // A clipped name is the same failure as an overflowing row - the pane stops being able
  // to say which pane it is - and it is the one the row hides by ellipsing instead.
  if (name && name.scrollWidth > name.clientWidth + 1) return false
  const actions = header.querySelector<HTMLElement>('.pt-actions')
  return !actions || actions.scrollWidth <= actions.clientWidth + 1
}

/**
 * Keep every pane header's `data-tight` up to date.
 *
 * Mounted ONCE, from `App`, rather than per pane: the headers are drawn inside the
 * sessions map, where a hook cannot go without turning that block into a component, and
 * one observer over the whole desk costs less than one per pane either way. Re-syncs
 * whenever `deps` change - a pane's name, its chips and its agent all change what the row
 * needs and none of them changes its width.
 */
export function useHeaderFits(deps: unknown[]): void {
  const frame = useRef(0)
  useEffect(() => {
    const measure = (header: HTMLElement): void => {
      if (header.clientWidth <= 0) return
      const before = header.dataset.tight
      const level = climbLevel((l) => {
        header.dataset.tight = String(l)
        return fits(header)
      }, TIGHT_GROUPS.length)
      const now = String(level)
      if (header.dataset.tight !== now) header.dataset.tight = now
      if (before !== now) header.dataset.tight = now
      // The ⋯ is a control the row GROWS, not one it drops, so it is not in the ladder:
      // it appears the moment something is behind it, and the CSS reads the same number.
      const more = level >= MORE_FROM ? 'on' : 'off'
      if (header.dataset.more !== more) header.dataset.more = more
    }
    const all = (): void => {
      for (const header of document.querySelectorAll<HTMLElement>('.pane-title')) measure(header)
    }
    // One pass per frame however many headers resized: the climb reads layout back, and
    // doing that once per observer callback during a window drag is the expensive shape.
    const ro = new ResizeObserver(() => {
      if (frame.current) return
      frame.current = requestAnimationFrame(() => {
        frame.current = 0
        all()
      })
    })
    all()
    for (const header of document.querySelectorAll<HTMLElement>('.pane-title')) ro.observe(header)
    return () => {
      ro.disconnect()
      if (frame.current) cancelAnimationFrame(frame.current)
      frame.current = 0
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}
