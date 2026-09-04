// Measuring a pane header, so it drops a control only when there is really no room.
//
// The arithmetic is in `shared/headerFit.ts`; this is the half that needs a window. It
// writes `data-tight` straight onto the header element and keeps NO React state: the
// header re-measures on every window resize and every pane change, and a `setState` there
// would re-render the pane (and, through the sessions list, every other one) for a number
// that only a CSS attribute selector ever reads. Same reasoning as `quietState.ts`.
//
// Each part is measured once while it is VISIBLE and the widest reading is kept: an
// element hidden at the current level measures 0, and believing that would free width
// twice and flip the row in and out on every frame.

import { useEffect, useRef } from 'react'
import { fitLevel, MORE_FROM, TIGHT_GROUPS, type HeaderNeed } from '../../shared/headerFit'

/** Widths remembered per header element, so a hidden part still counts what it costs. */
type Naturals = Map<string, number>

function widthOf(header: HTMLElement, selector: string, seen: Naturals): number {
  let live = 0
  for (const el of header.querySelectorAll<HTMLElement>(selector)) {
    // `offsetWidth` is 0 for a `display: none` element, which is exactly the case this
    // cache exists for. A visible one also carries the row's gap, added once below.
    if (el.offsetWidth > 0) live += el.offsetWidth
  }
  const before = seen.get(selector) ?? 0
  if (live > before) seen.set(selector, live)
  return seen.get(selector) ?? 0
}

/**
 * The width of everything that is never dropped, read off the row itself.
 *
 * Taken as "the whole row minus the name and minus every droppable group", so a control
 * added to the header later is counted without being listed anywhere.
 */
function needFor(header: HTMLElement, seen: Naturals, gap: number): HeaderNeed {
  const groups = TIGHT_GROUPS.map((g) => {
    let w = 0
    for (const sel of g) {
      const each = widthOf(header, sel, seen)
      if (each > 0) w += each + gap
    }
    return w
  })
  let fixed = 0
  for (const el of Array.from(header.children) as HTMLElement[]) {
    if (el.classList.contains('pt-name')) continue
    if (TIGHT_GROUPS.some((g) => g.some((sel) => el.matches(sel)))) continue
    if (el.classList.contains('pt-actions')) {
      // The actions row holds both kinds, so its own children are split the same way.
      for (const a of Array.from(el.children) as HTMLElement[]) {
        if (TIGHT_GROUPS.some((g) => g.some((sel) => a.matches(sel)))) continue
        const key = `act:${a.className}`
        const w = a.offsetWidth
        if (w > (seen.get(key) ?? 0)) seen.set(key, w)
        fixed += (seen.get(key) ?? 0) + gap
      }
      continue
    }
    const key = `own:${el.className}`
    const w = el.offsetWidth
    if (w > (seen.get(key) ?? 0)) seen.set(key, w)
    fixed += (seen.get(key) ?? 0) + gap
  }
  return { fixed, groups }
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
  const seen = useRef<WeakMap<Element, Naturals>>(new WeakMap())
  useEffect(() => {
    const measure = (header: HTMLElement): void => {
      const style = getComputedStyle(header)
      const gap = parseFloat(style.columnGap || style.gap || '0') || 0
      const pad = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0)
      const available = header.clientWidth - pad
      if (available <= 0) return
      let naturals = seen.current.get(header)
      if (!naturals) {
        naturals = new Map()
        seen.current.set(header, naturals)
      }
      const level = fitLevel(available, needFor(header, naturals, gap))
      const now = String(level)
      if (header.dataset.tight !== now) header.dataset.tight = now
      // The ⋯ is a control the row GROWS, not one it drops, so it is not in the ladder:
      // it appears the moment something is behind it, and the CSS reads the same number.
      const more = level >= MORE_FROM ? 'on' : 'off'
      if (header.dataset.more !== more) header.dataset.more = more
    }
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) measure(e.target as HTMLElement)
    })
    for (const header of document.querySelectorAll<HTMLElement>('.pane-title')) {
      measure(header)
      ro.observe(header)
    }
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}
