/**
 * A dev copy walks you through what it has that the installed app does not.
 *
 * Robert, 2026-09-04: "when i open dev window it should go through everything needed to
 * show me the updated changes ... i just press next/previous and it automatically does
 * things and goes through each change". And later the same day, clicking through it: "its
 * not easy to understand whats done ... on each step it should actually open up a session
 * and type whatever is needed or like maybe some overlay to highlight or point or circle
 * things that have changed ... some things i can't really check right like backend stuff
 * but i still want verifications on that too".
 *
 * So a step is no longer a sentence. It is one CHANGE, read off the commit that made it:
 *   - `text`   the subject, plain words (`try-diff.mjs` strips the machine prefix)
 *   - `where`  which part of the app it lives in, worked out from the FILES the change
 *              touched - `the New session dialog`, `the window's look`, `inside the app,
 *              nothing to click` - so a change with no screen says so instead of leaving
 *              the reader hunting for it
 *   - `see`    what to look for, one line each. Written by the person who made the change
 *              as `See:` lines in the commit body; a commit without them gets the first
 *              paragraph of its body instead, which is at least what the author was
 *              thinking, and one with neither gets nothing rather than a guess
 *   - `try`    a prompt the card can type into a fresh pane so the change can be watched
 *              happening - a `Try:` line in the commit body. Never invented.
 *   - `checks` the test scripts the change touched, which the card RUNS and reports on -
 *              this is how a change with no screen still gets checked. A suite that needs
 *              a window is named rather than run.
 *   - `spot`   a CSS selector for the control the change is about, ringed on screen once
 *              the surface is open. From the same file table as `where`.
 *
 * `scripts/try-diff.mjs` already answers "what is different from the installed app"; its
 * commit list IS the step list, never a second source of truth. This file is arithmetic
 * only: no window, no Electron, no git - `scripts/tour-test.mjs` runs it with neither.
 */

/** A surface this app can open to show a step, or `'none'` when a change names nothing
 * recognisable - never a guess that opens the wrong thing. */
export type TourSurface = 'newSession' | 'settings' | 'sidebarHidden' | 'workspaces' | 'none'

/** One change, as `try-diff.mjs` reads it off git. */
export interface TourCommit {
  subject: string
  body: string
  files: string[]
}

export interface TourStep {
  /** Plain words, already stripped of `feat:`/`fix:`/`perf:` by `try-diff.mjs`. */
  text: string
  open: TourSurface
  /** Which part of the app, in words a person reads on screen. */
  where: string
  /** What to look for. Empty when nobody wrote it down. */
  see: string[]
  /** A prompt to type into a fresh pane, or nothing. */
  try?: string
  /** `scripts/<name>-test.mjs` paths, relative to the repo root, that prove the change. */
  checks: string[]
  /** Suites the change touched that cannot run without a window - named, not run. */
  byHand: string[]
  /** Something on screen to ring, once `open` has been opened. */
  spot?: string
}

export interface TourState {
  steps: TourStep[]
  index: number
  /** The checkout this copy runs from - where `try` prompts open and `checks` run. */
  root: string
}

/** What one check answered. `null` count when the output carried no `ok`/`FAIL` lines. */
export interface TourCheck {
  script: string
  ok: boolean
  passed: number
  failed: number
  /** The last lines the script printed - the whole answer on a failure. */
  tail: string
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

/** Which surface a sentence is about, or `'none'`. */
export function surfaceFor(sentence: string): TourSurface {
  for (const [re, surface] of SURFACE_WORDS) if (re.test(sentence)) return surface
  return 'none'
}

/**
 * A file the change touched, turned into where it shows. Checked in order, first match
 * wins, so the most specific control comes before the dialog it sits in. A file matching
 * nothing here says nothing - `where` is built only from the rows that matched.
 */
interface Place {
  where: string
  open?: TourSurface
  spot?: string
}
const PLACES: ReadonlyArray<readonly [RegExp, Place]> = [
  [/components\/NewSessionDialog\.tsx$/, { where: 'the New session dialog', open: 'newSession', spot: '.dialog' }],
  [/components\/SettingsDialog\.tsx$/, { where: 'Settings', open: 'settings', spot: '.dialog.settings' }],
  [/components\/TourCard\.tsx$/, { where: 'this card' }],
  [/components\/TerminalPane\.tsx$/, { where: 'a pane', spot: '.pane' }],
  [/components\/([A-Z][A-Za-z]+)\.tsx$/, { where: '' }],
  [/renderer\/src\/App\.tsx$/, { where: 'the main window' }],
  [/renderer\/src\/styles\.css$/, { where: "the window's look" }],
  [/^src\/main\//, { where: 'inside the app, nothing to click' }],
  [/^scripts\/try(?:-diff)?\.mjs$/, { where: 'the npm run try command, not this window' }],
  [/^src\/shared\/(choices|autoAnswer)\.ts$/, { where: "a pane's question buttons" }],
  [/^src\/shared\/(clientName|place)\.ts$/, { where: "a pane's name" }],
  [/^src\/shared\/devList\.ts$/, { where: 'the dev server list the pet answers' }],
  [/^src\/shared\//, { where: 'inside the app, nothing to click' }]
]

/** `NewSessionDialog` -> `the New session dialog`; a component's own name, spaced. */
function componentWords(name: string): string {
  const spaced = name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\b(\w)(\w*)/g, (_, a: string, b: string, i: number) =>
    i === 0 ? a + b : a.toLowerCase() + b
  )
  return `the ${spaced}`
}

/** Suites that open a real window - listed in CLAUDE.md under "Needs a window" - keyed by
 * the script's stem, valued by the npm name a person types. */
export const NEEDS_WINDOW: ReadonlyMap<string, string> = new Map([
  ['view', 'test:view'], ['stash-drag', 'test:stashdrag'], ['stash-activate', 'test:activate'],
  ['restore-fix', 'test:restorefix'], ['ask-click', 'test:askclick'], ['ask-render', 'test:askrender'],
  ['devices-fit', 'test:devicesfit'], ['phone-view', 'test:phoneview'], ['contrast', 'test:contrast']
])

const TEST_FILE = /^scripts\/([a-z0-9-]+)-test\.mjs$/

/** Where a change shows, from the files it touched. Rows in the order the table lists them,
 * deduplicated, never a file name. */
export function placesFor(files: string[]): { where: string; open: TourSurface; spot?: string } {
  const seen = new Set<string>()
  const words: string[] = []
  let open: TourSurface = 'none'
  let spot: string | undefined
  for (const f of files) {
    for (const [re, place] of PLACES) {
      const m = re.exec(f)
      if (!m) continue
      const w = place.where || (m[1] ? componentWords(m[1]) : '')
      if (w && !seen.has(w)) {
        seen.add(w)
        words.push(w)
      }
      if (open === 'none' && place.open) open = place.open
      if (!spot && place.spot) spot = place.spot
      break
    }
  }
  return { where: words.join(', '), open, spot }
}

/** `See:` and `Try:` lines out of a commit body. `See:` may repeat; `Try:` keeps the first. */
export function trailersOf(body: string): { see: string[]; try?: string } {
  const see: string[] = []
  let tryLine: string | undefined
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    const m = /^(See|Try):\s*(.+)$/i.exec(line)
    if (!m) continue
    if (m[1].toLowerCase() === 'see') see.push(m[2].trim())
    else if (!tryLine) tryLine = m[2].trim()
  }
  return { see, try: tryLine }
}

/**
 * Words a person who has never coded can read: code spans, file paths, identifiers with
 * dots or camelCase, and every parenthetical go, then the first sentence or two, capped.
 * Robert, reading the card 2026-09-04: "much too technical most things and hard to
 * understand".
 */
export function plainWords(text: string, cap = 160): string {
  let s = text
    .replace(/`[^`]*`/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\b[\w-]+\/[\w./-]+\b/g, '')
    .replace(/\b\w+\.\w+(?:\.\w+)*\b/g, '')
    .replace(/\b[a-z]+[A-Z]\w*\b/g, '')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/^\s*-\s*/, '')
    .trim()
  const m = /^(.+?[.!?])(\s|$)/.exec(s)
  if (m && m[1].length >= 30) s = m[1]
  // A sentence that was mostly code reads as holes once the code is gone
  // ("Pane chip: / with a clock, instead of a bare;") - better nothing than that.
  const before = text.replace(/\s+/g, ' ').trim()
  if (s.length < before.length * 0.75 && !m) return ''
  if (m && m[1].length < (/^(.+?[.!?])(\s|$)/.exec(before)?.[1].length ?? 0) * 0.75) return ''
  if (s.length > cap) s = s.slice(0, cap - 1).replace(/\s+\S*$/, '') + '…'
  return s
}

/** One line saying how to look at this step - in words, for the surface the card has
 * just opened. A step with nothing on screen says the app checked it below. */
export function howToCheck(step: Pick<TourStep, 'open' | 'checks' | 'try'>): string {
  switch (step.open) {
    case 'newSession':
      return 'The New session window is open now - look there.'
    case 'settings':
      return 'Settings is open now - look there.'
    case 'sidebarHidden':
      return 'The list is hidden now - the ringed button brings it back.'
    case 'workspaces':
      return 'Look at the list on the left.'
    default:
      if (step.try) return 'Press Try it in a pane and watch what the pane does.'
      return step.checks.length
        ? 'Nothing to click for this one - the app checked it for you below.'
        : 'Nothing to click for this one, and no automatic check came with it.'
  }
}

/** The first paragraph of a body, with its git trailers and `See:`/`Try:` lines left out,
 * capped so the card stays a card. */
export function firstParagraph(body: string, cap = 320): string {
  const para = body
    .split(/\n\s*\n/)[0]
    ?.split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^(See|Try|Co-Authored-By|Claude-Session):/i.test(l))
    .join(' ')
  if (!para) return ''
  return para.length > cap ? para.slice(0, cap - 1).replace(/\s+\S*$/, '') + '…' : para
}

/** What to ring when only the SENTENCE said which surface a change is about. */
const SURFACE_SPOT: Record<TourSurface, string | undefined> = {
  newSession: '.dialog',
  settings: '.dialog.settings',
  sidebarHidden: '.side-reveal',
  workspaces: '.sidebar',
  none: undefined
}

export function stepFrom(c: TourCommit): TourStep {
  const text = c.subject.trim()
  const { where, open: fileOpen, spot: fileSpot } = placesFor(c.files)
  const open = fileOpen !== 'none' ? fileOpen : surfaceFor(text)
  const spot = fileSpot ?? SURFACE_SPOT[open]
  const { see, try: tryLine } = trailersOf(c.body)
  const checks: string[] = []
  const byHand: string[] = []
  for (const f of c.files) {
    const m = TEST_FILE.exec(f)
    if (!m) continue
    const hand = NEEDS_WINDOW.get(m[1])
    if (hand) byHand.push(`npm run ${hand}`)
    else checks.push(f)
  }
  const step: TourStep = {
    text,
    open,
    where: where || (checks.length ? 'inside the app, nothing to click' : 'no file this card knows'),
    see: see.length ? see : plainWords(firstParagraph(c.body)) ? [plainWords(firstParagraph(c.body))] : [],
    checks,
    byHand
  }
  if (tryLine) step.try = tryLine
  if (spot) step.spot = spot
  return step
}

/** Blank subjects dropped; nothing else about the commits is touched. */
export function buildSteps(commits: TourCommit[]): TourStep[] {
  return commits.filter((c) => c.subject.trim().length > 0).map(stepFrom)
}

/** `null` for an empty list - the caller draws no card at all, never an empty one. */
export function makeTour(commits: TourCommit[], root = ''): TourState | null {
  const steps = buildSteps(commits)
  return steps.length ? { steps, index: 0, root } : null
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

/** Only a test script the repo itself carries may be run - anything else is refused, so a
 * renderer can never name an arbitrary file. */
export function checkAllowed(script: string): boolean {
  return TEST_FILE.test(script) && !script.includes('..')
}

/** Reads a test script's output the way `test-all.mjs` does: `ok` and `FAIL` line counts,
 * exit code decides. */
export function readCheck(script: string, code: number | null, output: string): TourCheck {
  const lines = output.split('\n')
  const passed = lines.filter((l) => /^ok\b/i.test(l.trim())).length
  const failed = lines.filter((l) => /^FAIL\b/.test(l.trim())).length
  const tail = lines.filter((l) => l.trim()).slice(-8).join('\n')
  return { script, ok: code === 0 && failed === 0, passed, failed, tail }
}

/** `test:devlist`, off `scripts/devlist-test.mjs` - the name in package.json. */
export function checkName(script: string): string {
  const m = TEST_FILE.exec(script)
  return m ? `test:${m[1].replace(/-/g, '')}` : script
}
