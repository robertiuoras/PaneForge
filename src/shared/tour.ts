/**
 * A dev copy walks you through what it has that the installed app does not.
 *
 * Robert, 2026-09-04: "when i open dev window it should go through everything needed to
 * show me the updated changes ... i just press next/previous and it automatically does
 * things and goes through each change". `scripts/try-diff.mjs` already answers the
 * question "what is different from the installed app" as a list of plain sentences - that
 * list IS the step list, never a second source of truth.
 *
 * This file is the arithmetic only: turning sentences into steps, moving an index between
 * them, and guessing which part of the app each sentence is ABOUT so the card can open it.
 * No window, no Electron, no git - `scripts/tour-test.mjs` runs it with neither.
 */

/** A surface this app can open to show a step, or `'none'` when a sentence names nothing
 * recognisable - never a guess that opens the wrong thing. */
export type TourSurface = 'newSession' | 'settings' | 'sidebarHidden' | 'workspaces' | 'none'

export interface TourStep {
  /** Plain words, already stripped of `feat:`/`fix:`/`perf:` by `try-diff.mjs`. */
  text: string
  open: TourSurface
}

export interface TourState {
  steps: TourStep[]
  index: number
}

/**
 * Small keyword table, checked in order, first match wins. Every entry names words a
 * person would actually read on screen, never a commit prefix or a file name - the same
 * "no git" rule the sentences themselves already follow.
 */
const SURFACE_WORDS: ReadonlyArray<readonly [RegExp, TourSurface]> = [
  [/\bnew session\b|\bstart(?:ing)? a project\b|\bopen a project\b/i, 'newSession'],
  [/\bsettings?\b/i, 'settings'],
  [/\bsidebar\b|\bthe list\b|\bhid(?:e|ing|den)\s+the list\b/i, 'sidebarHidden'],
  [/\bworkspace/i, 'workspaces']
]

/** Which surface a step's sentence is about, or `'none'`. */
export function surfaceFor(sentence: string): TourSurface {
  for (const [re, surface] of SURFACE_WORDS) if (re.test(sentence)) return surface
  return 'none'
}

/** Blank lines dropped; nothing else about the sentences is touched. */
export function buildSteps(lines: string[]): TourStep[] {
  return lines
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((text) => ({ text, open: surfaceFor(text) }))
}

/** `null` for an empty list - the caller draws no card at all, never an empty one. */
export function makeTour(lines: string[]): TourState | null {
  const steps = buildSteps(lines)
  return steps.length ? { steps, index: 0 } : null
}

export function currentStep(state: TourState): TourStep {
  return state.steps[state.index]
}

/** Clamped at the last step - pressing Next again does nothing, never wraps or throws. */
export function next(state: TourState): TourState {
  return { ...state, index: Math.min(state.index + 1, state.steps.length - 1) }
}

/** Clamped at the first step. */
export function previous(state: TourState): TourState {
  return { ...state, index: Math.max(state.index - 1, 0) }
}

/** Whether this is the last step - the card's own button reads `Done` here instead of
 * `Next`, and pressing it is the caller's job to close the tour, not this file's. */
export function done(state: TourState): boolean {
  return state.index >= state.steps.length - 1
}

/** A profile name of `''` is the installed app - `main/tour.ts` refuses it before this
 * is even asked; kept here too so the refusal is provable with no window. */
export function tourAllowed(profile: string): boolean {
  return profile !== ''
}
