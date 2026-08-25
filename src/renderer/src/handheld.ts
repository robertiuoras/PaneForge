/**
 * A phone is not a small desktop.
 *
 * The window's layout is a 282px sidebar beside the panes. At 414px that leaves a pane
 * 132px wide - a 16-column terminal, which is not a small version of this app, it is a
 * broken one. So under 720px the two halves stop sharing the screen and take turns: the
 * list IS the home screen (it already says which project, which agent, who wants you,
 * and it already holds Fleet, Swarm, search and Settings), and tapping a pane gives that
 * pane the whole display with one chip to come back.
 *
 * Only two pieces of state, and they live on `<html>` rather than in React, because what
 * reads them is `styles.css`: `handheld` (this screen takes turns) and `handheld-list`
 * (the list is the one showing). A component that wants to know asks this hook.
 *
 * Deliberately width-only, not touch-only: a narrow desktop window has exactly the same
 * problem, and a tablet held wide does not.
 */

import { useCallback, useEffect, useState } from 'react'
import { isPhoneClient } from './client'

/** Below this the sidebar and the panes take turns. Matches the `@media` in styles.css. */
export const HANDHELD_MAX = 720

/**
 * ...and a phone turned sideways is still a phone. An iPhone in landscape is 932x430, so
 * a width-only rule handed it the 282px sidebar and a pane beside it - and with the
 * sidebar showing there is no Back chip and no swipe, which is "swipe left doesn't always
 * work": it worked in portrait and nothing existed to work in landscape. The second half
 * asks for a touch screen AND a short viewport, so a tablet held sideways (820px tall) and
 * every desktop window keep the two-column layout. Kept as ONE string because
 * `styles.css` matches on it too and a copy that drifts is a layout with no rules.
 */
export const HANDHELD_QUERY = `(max-width: ${HANDHELD_MAX}px), (pointer: coarse) and (max-height: 520px)`

export interface Handheld {
  /** the screen is taking turns */
  handheld: boolean
  /** the list is what is showing (meaningless when `handheld` is false) */
  listOpen: boolean
  showList(): void
  showPane(): void
}

/**
 * `activeId` is passed in so that choosing a pane hands the screen to it without every
 * one of the twenty places that sets the active pane having to know about phones.
 */
export function useHandheld(activeId: string | null): Handheld {
  const [handheld, setHandheld] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(HANDHELD_QUERY).matches
  )
  // Open on the list: the first question on a phone is "what is running", never "type
  // into pane 3". A pane opened after that keeps the screen until Back is pressed.
  const [listOpen, setListOpen] = useState(true)

  useEffect(() => {
    const query = window.matchMedia(HANDHELD_QUERY)
    const sync = (): void => setHandheld(query.matches)
    sync()
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }, [])

  // A pane became the active one: that is the tap, and the pane gets the screen. Not on
  // first mount - there the list is what should be up - so an id that was already active
  // does not steal it. And not on the null -> id transition either: that is the RESTORE
  // filling activeId as the sessions load, seconds after mount, which on a phone put a
  // pane on the home screen before the list was ever seen (measured: listOpen was false
  // at first paint). A real tap does not need this effect - the row's onClick calls
  // showPane() itself.
  const [seen, setSeen] = useState(activeId)
  useEffect(() => {
    if (activeId === seen) return
    const restore = seen === null
    setSeen(activeId)
    if (activeId && !restore) setListOpen(false)
  }, [activeId, seen])

  /**
   * The phone's OWN Back - its button, and the swipe every other app on the device answers
   * - goes back to the list instead of leaving the page.
   *
   * A pane taking the screen is a navigation as far as the person holding it is concerned,
   * and nothing in the URL said so: back left the app entirely, from a pane, with no
   * warning. So opening a pane pushes one history entry and `popstate` is Back. The chip
   * calls `history.back()` when it is standing on that entry, so both routes are the same
   * one move and the stack cannot grow a step per pane opened.
   */
  useEffect(() => {
    if (!handheld || listOpen) return
    history.pushState({ pfPane: true }, '')
    const pop = (): void => setListOpen(true)
    window.addEventListener('popstate', pop)
    return () => window.removeEventListener('popstate', pop)
  }, [handheld, listOpen])

  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('handheld', handheld)
    root.classList.toggle('handheld-list', handheld && listOpen)
    return () => {
      root.classList.remove('handheld', 'handheld-list')
    }
  }, [handheld, listOpen])

  /**
   * Going back to the list is a phone saying "I have stopped looking at that pane", and
   * that is the moment the desk gets its pty shape back: a pane fitted to 50 columns is
   * right for the phone in your hand and wrong for the 157-column window it is also drawn
   * in. The stream closing says the same thing for a phone that is simply put down - see
   * `returnSizes` in main/sessions.ts. A narrow DESKTOP window is handheld too and owes
   * nothing, so only a phone speaks up.
   */
  const showList = useCallback(() => {
    // Standing on the entry the pane pushed, so unwinding it is the same move the phone's
    // own Back makes; `popstate` is what sets the state in that case. Pressing the chip
    // and pressing the phone's Back must not leave the history stack in two shapes.
    if (history.state?.pfPane) history.back()
    else setListOpen(true)
    if (isPhoneClient()) window.api.returnSize('phone')
  }, [])

  return {
    handheld,
    listOpen,
    showList,
    showPane: () => setListOpen(false)
  }
}
