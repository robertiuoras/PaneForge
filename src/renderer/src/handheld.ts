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
    () => typeof window !== 'undefined' && window.innerWidth <= HANDHELD_MAX
  )
  // Open on the list: the first question on a phone is "what is running", never "type
  // into pane 3". A pane opened after that keeps the screen until Back is pressed.
  const [listOpen, setListOpen] = useState(true)

  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${HANDHELD_MAX}px)`)
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
    setListOpen(true)
    if (isPhoneClient()) window.api.returnSize()
  }, [])

  return {
    handheld,
    listOpen,
    showList,
    showPane: () => setListOpen(false)
  }
}
