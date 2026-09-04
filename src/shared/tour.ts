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
export type TourSurface = 'newSession' | 'settings' | 'sidebarHidden' | 'workspaces' | 'pane' | 'none'

/** One change, as `try-diff.mjs` reads it off git. */
export interface TourCommit {
  subject: string
  /** The Conventional Commit scope, lower-cased - `header` out of `fix(header): ...`.
   * The author's own word for where the change lives, and the best name a step has. */
  scope?: string
  body: string
  files: string[]
}

export interface TourStep {
  /** The step's NAME, in the words of the thing on screen - `A session's header`, `The
   * New session window`. Never the commit subject, which is written in the metaphor the
   * person who made the change was using: `ask the row whether it fits, instead of adding
   * its widths up` is a true sentence about a header nobody can find from it (Robert,
   * 2026-09-04, on step 4 of 30: "i think you can name these better ... like positioning
   * of icons in header would be easier to understand"). The subject stays, under it. */
  title: string
  /** Plain words, already stripped of `feat:`/`fix:`/`perf:` by `try-diff.mjs`. */
  text: string
  open: TourSurface
  /** Which part of the app, in words a person reads on screen. */
  where: string
  /** What to look for. Empty when nobody wrote it down. */
  see: string[]
  /** `scripts/<name>-test.mjs` paths, relative to the repo root, that prove the change. */
  checks: string[]
  /** Suites the change touched that cannot run without a window - named, not run. */
  byHand: string[]
  /** Something on screen to ring, once `open` has been opened. */
  spot?: string
  /** The author's own hands-on test, off a `Try:` line in the commit body. Shown in place
   * of the generic instruction, which can only ever name the surface. */
  tryIt?: string
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
/** The words for a change that has nothing on screen at all. */
export const NO_SCREEN = 'inside the app, nothing to click'

const PLACES: ReadonlyArray<readonly [RegExp, Place]> = [
  [/components\/NewSessionDialog\.tsx$/, { where: 'the New session dialog', open: 'newSession', spot: '.dialog .dialog-head' }],
  [/components\/SettingsDialog\.tsx$/, { where: 'Settings', open: 'settings', spot: '.dialog.settings .dialog-head' }],
  [/components\/TourCard\.tsx$/, { where: 'this card' }],
  [/components\/TerminalPane\.tsx$/, { where: 'a pane', open: 'pane', spot: '.pane-title' }],
  [/(?:renderer\/src|shared)\/headerFit\.ts$/, { where: "a session's header", open: 'pane', spot: '.pt-actions' }],
  [/components\/([A-Z][A-Za-z]+)\.tsx$/, { where: '' }],
  [/renderer\/src\/App\.tsx$/, { where: 'the main window' }],
  [/renderer\/src\/styles\.css$/, { where: "the window's look" }],
  [/^src\/main\//, { where: NO_SCREEN }],
  [/^scripts\/try(?:-diff)?\.mjs$/, { where: 'the npm run try command, not this window' }],
  [/^src\/shared\/(choices|autoAnswer)\.ts$/, { where: "a pane's question buttons" }],
  [/^src\/shared\/(clientName|place)\.ts$/, { where: "a pane's name" }],
  [/^src\/shared\/devList\.ts$/, { where: 'the dev server list the pet answers' }],
  [/^src\/shared\//, { where: NO_SCREEN }]
]

/**
 * The scope the author already wrote, turned into where a person looks.
 *
 * Read BEFORE the file table, because it is the one word somebody chose deliberately to
 * say where the change lives, while the file list is whatever the change happened to
 * touch - and a header fix that only edits `src/shared/headerFit.ts` reads off the file
 * table as `inside the app, nothing to click`, which is how a change to the icons in
 * every pane header ended up with nothing to look at.
 *
 * Only scopes this app can actually SHOW. A scope with no row here falls through to the
 * files, exactly as before.
 */
const SCOPE_PLACES: ReadonlyMap<string, Place> = new Map<string, Place>([
  ['header', { where: "a session's header", open: 'pane', spot: '.pt-actions' }],
  ['pane', { where: 'a pane', open: 'pane', spot: '.pane-title' }],
  // NEVER `.pane`: a ring around the whole pane is a 618x1050 rectangle whose left edge
  // is a glowing line down the middle of the window, which reads as a rendering fault and
  // points at nothing (Robert, 2026-09-04: "theres a glowing line on the left of the pane
  // window"). A ring is for a CONTROL.
  ['panes', { where: 'the panes', open: 'pane', spot: '.pane-title' }],
  ['rail', { where: "a pane's prompt marks", open: 'pane', spot: '.pane-title' }],
  ['tour', { where: 'this card' }],
  ['cards', { where: 'the cards in the corner' }]
])

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
  ['view', 'test:view'],
  ['restore-fix', 'test:restorefix'], ['ask-click', 'test:askclick'], ['ask-render', 'test:askrender'],
  ['devices-fit', 'test:devicesfit'], ['phone-view', 'test:phoneview'], ['contrast', 'test:contrast']
])

const TEST_FILE = /^scripts\/([a-z0-9-]+)-test\.mjs$/

/** Where a change shows, from the files it touched. Rows in the order the table lists them,
 * deduplicated, never a file name. */
export function placesFor(files: string[], scope = ''): { where: string; open: TourSurface; spot?: string } {
  const seen = new Set<string>()
  const words: string[] = []
  let open: TourSurface = 'none'
  let spot: string | undefined
  const byScope = SCOPE_PLACES.get(scope.trim().toLowerCase())
  if (byScope) {
    seen.add(byScope.where)
    words.push(byScope.where)
    if (byScope.open) open = byScope.open
    if (byScope.spot) spot = byScope.spot
  }
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
  return { where: whereWords(words), open, spot }
}

/** A change touching five files listed five places, one of them the words for a change
 * with no screen at all - so the card read `the New session dialog, this card, the
 * window's look, inside the app, nothing to click`, which contradicts itself and is too
 * long to read (Robert, 2026-09-04, looking at that exact line). A person only needs to
 * be told where to look: the two nearest places, and `NO_SCREEN` only when it is the
 * whole answer. */
export function whereWords(places: string[]): string {
  const real = places.filter((w) => w !== NO_SCREEN)
  const kept = (real.length ? real : places.slice(0, 1)).slice(0, 2)
  return kept.length === 2 ? kept[0] + ' and ' + kept[1] : kept.join('')
}

/**
 * The `See:` lines out of a commit body - what the person who made the change said to
 * look for. They may repeat; each is one line on the card.
 *
 * A `Try:` line is read no more. It used to become a button that opened a pane and typed
 * that prompt, and Robert 2026-09-04: "i dont want the try in pane testing helper it
 * should automatically go through each thing and show exactly whats done". A card that
 * hands you an errand is not a card that shows you the change, so the tour plays itself
 * instead - see `dwellFor`. Commits may keep writing `Try:`; nothing reads it.
 */
export const MAX_SEE = 2

export function trailersOf(body: string): { see: string[]; tryIt: string } {
  const see: string[] = []
  // `Try:` is the AUTHOR'S OWN hands-on test for this change - "open a session, ask the
  // agent for a folder path, click it". It outranks every sentence this file can work out
  // on its own, because the person who made the change knows what proves it and a surface
  // table can only ever say "a ring is showing what changed" (Robert 2026-09-04: "tell me
  // how to check if it works ... e.g. if fixed folder not linking to folder ... you would
  // open a new session and ask prompt for the path etc then test if it works").
  //
  // ONE, and it is the first: a step with a list of things to do is a step nobody does.
  let tryIt = ''
  for (const raw of body.split('\n')) {
    const t = /^Try:\s*(.+)$/i.exec(raw.trim())
    if (t && !tryIt) tryIt = t[1].trim()
    const m = /^See:\s*(.+)$/i.exec(raw.trim())
    if (m && !see.includes(m[1].trim())) see.push(m[1].trim())
  }
  // Two, never three. A card carrying every line the author wrote is a card nobody reads
  // to the end - Robert, 2026-09-04, looking at a three-bullet step: "too much fluff just
  // 1 or 2 points to check". The bullets are written most-important-first, so the tail is
  // what goes.
  return { see: see.slice(0, MAX_SEE), tryIt }
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

/**
 * WHAT TO DO on this step, as an instruction - then what you should see.
 *
 * `Nothing to click - the app checks this one below.` was the line on a third of the
 * steps, and it is the one Robert stopped at (2026-09-04: "what do you mean nothing to
 * click? tell me how to check if it works"). Two things were wrong with it. It described
 * the card's own situation instead of telling him to do anything, and where there really
 * is nothing to press it never said WHY - a change to what two machines say to each other
 * has no button anywhere, and that is a fact about the change, not an apology.
 *
 * So every step now opens with a verb, and the no-screen one names the reason it has no
 * verb and what stands in for one.
 */
export function howToCheck(step: Pick<TourStep, 'open' | 'checks' | 'tryIt'>): string {
  // The author wrote the test for this change; nothing worked out from a file list beats it.
  if (step.tryIt) return `Do this: ${step.tryIt}`
  switch (step.open) {
    case 'newSession':
      return 'Do this: look at the New session window the tour just opened - the ring is round what changed. Close it when you are done.'
    case 'settings':
      return 'Do this: look at the Settings window the tour just opened - the ring is round what changed. Close it when you are done.'
    case 'sidebarHidden':
      return 'Do this: the list of sessions is hidden. Press the ringed button to bring it back.'
    case 'workspaces':
      return 'Do this: look at the list on the left, under your open panes.'
    case 'pane':
      return 'Do this: a session is open behind this card. The ring is round the part that changed - click it, type in it, see it behave.'
    default:
      return step.checks.length
        ? 'Nothing here to press: this change is under the app, where no screen shows it - between two machines, or in what the app does when nobody is looking. The check below is how it is proved instead, and it just ran for real.'
        : 'Nothing here to press: this change is under the app, where no screen shows it, and no check came with it. The sentence above is all this step has.'
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
/* A ring goes round a CONTROL, never a container: `.dialog` measured 636x900 - 61% of
   the window - and drew a rectangle round the whole screen (found by the look check,
   2026-09-04, steps 22 and 30). The dialog's own head names it and fits. */
const SURFACE_SPOT: Record<TourSurface, string | undefined> = {
  pane: '.pane-title',
  newSession: '.dialog .dialog-head',
  settings: '.dialog.settings .dialog-head',
  sidebarHidden: '.side-reveal',
  workspaces: '.sidebar',
  none: undefined
}

/**
 * The step's NAME, off the place it lives - `A session's header`, `The New session
 * dialog`. A change with nothing on screen says so plainly rather than borrowing a
 * heading it has not earned.
 */
export function titleFor(where: string): string {
  if (!where || where === NO_SCREEN || where === 'no file this card knows') return 'Inside the app'
  return where.charAt(0).toUpperCase() + where.slice(1)
}

/**
 * WHAT the change actually was, in a handful of words, for the end of the step's name.
 *
 * A name that is only the PLACE says nothing: `Inside the app` was a heading over a card
 * with no statement of the change on it at all (Robert 2026-09-04: "its not clear enough
 * ... at least one thing of what the change is, inside the app - changed the pet icon
 * etc, or like in the header - aligned the icons"). The commit's own subject is that
 * statement, so it comes back - but as the tail of the name, cut to its FIRST clause and
 * stripped of code the way every other sentence on the card is (`plainWords`), because
 * the whole subject printed as its own paragraph is what read as too much to take in.
 */
/*
 * The whole first clause, never an ellipsis.
 *
 * At 52 the name ended `A test copy draws a mirrored pane but does not…` and the sentence
 * it was cutting off was the whole point of the step (Robert 2026-09-04: "it doesnt fully
 * explain or finish i must see the whole thing"). The clause split above already bounds
 * this - it takes the FIRST clause of a subject, which the author wrote as one readable
 * phrase - so the cap is only a backstop against a pathological subject with no
 * punctuation in it at all. The card's name wraps to two lines; that is cheaper than a
 * sentence nobody can finish reading.
 */
export const WHAT_CAP = 120
export function whatChanged(subject: string): string {
  // The first clause only. A subject here is routinely three joined sentences ("a move
  // says which half is running, a starting pane is not called mid-turn, menu hints stop
  // being cut off, and ..."), and all of it in a heading is a paragraph again.
  let s = plainWords(subject.split(/\s+[-\u2013]\s+|[,;]\s+| and (?=[a-z])/)[0] ?? '', WHAT_CAP)
  if (!s) return ''
  s = s.replace(/[.!?]+$/, '').trim()
  if (!s) return ''
  // Lower case unless the first word is a name the app itself capitalises.
  return /^[A-Z][a-z]/.test(s) && !/^(New session|Settings|Devices|History|Stash)/.test(s)
    ? s.charAt(0).toLowerCase() + s.slice(1)
    : s
}

/** The step's name on the card: WHERE it is, then WHAT changed there. */
export function stepName(where: string, subject: string): string {
  const place = titleFor(where)
  const what = whatChanged(subject)
  return what ? `${place} - ${what}` : place
}

export function stepFrom(c: TourCommit): TourStep {
  const text = c.subject.trim()
  const { where, open: fileOpen, spot: fileSpot } = placesFor(c.files, c.scope ?? '')
  const open = fileOpen !== 'none' ? fileOpen : surfaceFor(text)
  const spot = fileSpot ?? SURFACE_SPOT[open]
  const { see, tryIt } = trailersOf(c.body)
  const checks: string[] = []
  const byHand: string[] = []
  for (const f of c.files) {
    const m = TEST_FILE.exec(f)
    if (!m) continue
    const hand = NEEDS_WINDOW.get(m[1])
    if (hand) byHand.push(`npm run ${hand}`)
    else checks.push(f)
  }
  const placeWords = where || (checks.length ? NO_SCREEN : 'no file this card knows')
  const step: TourStep = {
    title: stepName(placeWords, text),
    text,
    open,
    where: placeWords,
    see: see.length ? see : plainWords(firstParagraph(c.body)) ? [plainWords(firstParagraph(c.body))] : [],
    checks,
    byHand
  }
  if (spot) step.spot = spot
  if (tryIt) step.tryIt = tryIt
  return step
}

/** A stable identity for a step, used to remember which ones have been ticked done. The
 * commit's own subject - `try-diff.mjs` carries no sha into this file, and a subject is
 * already unique within one tour's commit list. */
export function stepKey(step: Pick<TourStep, 'text'>): string {
  return step.text
}

/** The first step not yet ticked done, in the order the tour lists them - `-1` once every
 * step is, so the caller can say so instead of landing back on the first. */
export function nextUnchecked(steps: TourStep[], done: Record<string, boolean>): number {
  for (let i = 0; i < steps.length; i++) if (!done[stepKey(steps[i])]) return i
  return -1
}

/**
 * Is this change one a person can go and look at?
 *
 * A commit that touched nothing under `src/` changed nothing in the app: it is a test
 * script, a build script, a document. Those are real work and they belong in the release
 * notes; they are not a step on a tour, because the tour's whole promise is "here is what
 * is different, go and look at it" and there is nothing to look at. Measured on the 44
 * steps Robert was shown 2026-09-04 - "first of all its too complicated" - 14 of them were
 * this, mostly `fix(checks)` and `fix(try)` about the tour and the test runner themselves.
 */
export function showsInApp(files: string[]): boolean {
  return files.some((f) => /^src\//.test(f))
}

/**
 * Blank subjects dropped, changes with nothing in the app dropped, and a subject seen
 * twice drawn once.
 *
 * The duplicate is not hypothetical: a change committed in one lane and again after a
 * merge appeared as two identical cards in the same tour, and being asked to check the
 * same sentence twice is what makes a list of thirty read as a list of forty.
 */
export function buildSteps(commits: TourCommit[]): TourStep[] {
  const seen = new Set<string>()
  const kept: TourCommit[] = []
  for (const c of commits) {
    const subject = c.subject.trim()
    if (!subject || seen.has(subject)) continue
    if (!showsInApp(c.files)) continue
    seen.add(subject)
    kept.push(c)
  }
  return kept.map(stepFrom)
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

/**
 * How long the tour stays on a step before it moves itself on, ms - or `null`, meaning
 * hold here, because this step has not finished showing what it did.
 *
 * The card plays itself. Robert opens the dev window to see what changed, and pressing
 * Next twelve times while working out what each step was for is the errand this replaces:
 * "it should automatically go through each thing and show exactly whats done if visual"
 * (2026-09-04, dropping the button that opened a pane and typed a prompt).
 *
 * Three lengths, and the reason for each:
 *  - a step whose checks are RUNNING holds (`null`). They only run because somebody
 *    pressed Run, so moving off the result they asked for is the one unforgivable step.
 *  - a step with something on screen - a surface it opened, a control it ringed - holds
 *    too (`waitsForYou`), for as long as it takes: that is the kind you read by looking at
 *    the app rather than at the card, and the card cannot know when you have finished.
 *  - everything else gets the short one, being one sentence and a tick already drawn.
 *
 * They were 3.5s/7s/4s and every one was too short to read the card: Robert, 2026-09-04,
 * "start the tour doesnt work and goes by too quick ... it keeps going next thing". The
 * two that are left are nine seconds, and the third was not made longer - it was replaced
 * by waiting for a person, which is the only honest length for a step with something to
 * do on it.
 */
export const DWELL_CHECKS_MS = 9000
export const DWELL_PLAIN_MS = 9000

/**
 * A step nothing may move off until a PERSON says so.
 *
 * Anything with a surface opened or a control ringed is a step whose whole content is on
 * the screen behind the card - a dialog to open, a box to type in, a button to press. No
 * number of seconds is the right number for that, because the answer depends on how long
 * somebody wants to poke at it: Robert, 2026-09-04, "it should wait if theres any test
 * like new session and has to type in there and also i can just mark myself if theres more
 * time to properly check". So the clock does not run there at all. The card says it is
 * waiting, and Done or Next is what moves it.
 *
 * The steps that DO move on their own are the ones with nothing to do: one sentence, and a
 * result the app fetched itself.
 */
export function waitsForYou(step: Pick<TourStep, 'open' | 'spot'>): boolean {
  return step.open !== 'none' || !!step.spot
}

export function dwellFor(step: TourStep, checksRunning: boolean): number | null {
  // A check only runs because somebody pressed it, and moving off a result nobody has
  // seen is the same defect as having no result: while one is in flight, the tour holds.
  if (checksRunning) return null
  if (waitsForYou(step)) return null
  return step.checks.length ? DWELL_CHECKS_MS : DWELL_PLAIN_MS
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
  const failed = lines.filter((l) => /^FAIL\b/.test(l.trim())).length
  let passed = lines.filter((l) => /^ok\b/i.test(l.trim())).length
  // NOT EVERY SUITE PRINTS A LINE PER ASSERTION. `scripts/sound-test.mjs` prints one
  // sentence - `sounds: 829 checks passed` - so counting `ok` lines answered 0 and the
  // card said "Checked - 0 things proved" over a suite that had just proved 829 things
  // (Robert, 2026-09-04, with the screenshot). The summary line is the count when there
  // are no per-assertion lines to count.
  if (!passed && !failed) passed = summaryCount(output)
  const tail = lines.filter((l) => l.trim()).slice(-8).join('\n')
  return { script, ok: code === 0 && failed === 0, passed, failed, tail }
}

/** `sounds: 829 checks passed`, `176 tests passed in 40.9s` - the number a suite prints
 * about itself when it prints nothing per assertion. The LAST one wins: a suite that
 * counts sections would otherwise be read off its first heading. */
export function summaryCount(output: string): number {
  let n = 0
  for (const m of output.matchAll(/(\d+)\s+(?:checks?|tests?|assertions?)\s+passed/gi)) n = Number(m[1])
  return n
}

/** What the card says once a check has answered. A number nobody measured is worse than
 * no number: `0 things proved` reads as a suite that did nothing. */
export function checkedWords(c: Pick<TourCheck, 'ok' | 'passed' | 'failed'>): string {
  if (!c.ok) return `Something is wrong here - ${c.failed} of ${c.passed + c.failed} checks failed`
  // NOT A COUNT. `Checked - 53 things proved` was the headline, and the number is the part
  // that meant nothing to the person reading it (Robert 2026-09-04: "53 things proved means
  // nothing i dont understand that"). Fifty-three of what, proving what, is unanswerable
  // from the card, and a number nobody can interpret reads as the card showing off rather
  // than as an answer. A failure keeps its numbers, because there the count is the size of
  // the problem and it is about to be read next to the output itself.
  return 'The app just ran its own checks on this - they passed'
}

/**
 * EVERY suite a step ran, as ONE sentence.
 *
 * A step with two suites drew two rows, and both rows say the same words with a different
 * number in them - `Checked - 34 things proved` over `Checked - 38 things proved` - which
 * reads as the card saying the same thing twice and disagreeing with itself (Robert,
 * 2026-09-04: "bug i think checked - 34 things proved, 38 things proved"). The suite names
 * are deliberately not on the card (`checkWords`), so there is nothing to tell the rows
 * apart: one line, one total, is the honest shape.
 */
export function checkedAll(results: TourCheck[]): { ok: boolean; passed: number; failed: number } {
  let passed = 0
  let failed = 0
  let ok = true
  for (const r of results) {
    passed += r.passed
    failed += r.failed
    if (!r.ok) ok = false
  }
  return { ok, passed, failed }
}

/**
 * SOMETHING TO SEE OR HEAR, done by the tour itself.
 *
 * A step about a sound used to be a sentence about a sound (Robert, 2026-09-04: "i
 * actually meant for it to play the sound etc ... just actual things i can see as i watch
 * the tour"). If the change is about something the app can simply DO on the spot, the
 * tour does it as the step arrives.
 *
 * Only sounds so far, because a sound is the one demonstration that needs no surface, no
 * pane and no state: it cannot leave anything behind for the next step to trip over.
 */
export type TourDemo = { kind: 'sound'; sound: string; says: string }

const SOUND_WORDS = /\b(sound|sounds|chime|note|bowl|knock|bell|beep|heard|audible|tick|ticks|plays?|playing)\b/i

export function demoFor(step: Pick<TourStep, 'text' | 'see'>): TourDemo | null {
  const words = [step.text, ...step.see].join(' ')
  if (!SOUND_WORDS.test(words)) return null
  // The three the app actually uses, picked off what the change is about: the countdown
  // bowl, the question knock, the finished-turn chime.
  if (/\b(countdown|counting|close|closing|move|moving|idle)\b/i.test(words))
    return { kind: 'sound', sound: 'bowl', says: 'the countdown note' }
  if (/\b(question|ask|asking|answer|choice)\b/i.test(words))
    return { kind: 'sound', sound: 'knock', says: 'the question knock' }
  return { kind: 'sound', sound: 'chime', says: 'the finished-turn chime' }
}

/**
 * One line out of a check while it is still running - see `main/tour.ts`.
 *
 * The counts are cumulative, so the card can say `12 checked` before the run is over
 * without keeping a tally of its own.
 */
export interface TourProgress {
  script: string
  passed: number
  failed: number
  /** the line itself, as the suite printed it */
  line: string
}

/**
 * What the card says about a step's automatic checks, in words.
 *
 * NEVER `test:cloudwork`. That is the name of a file in this repository, it is on screen
 * because the card had nothing else to put there, and it is exactly the machinery word
 * CLAUDE.md says never reaches a screen - Robert, 2026-09-04: "why is there another
 * button calld run test:cloudwork? its wrong".
 */
export function checkWords(count: number): string {
  return count === 1 ? 'Checking this change' : `Checking this change (${count} checks)`
}

/** `test:devlist`, off `scripts/devlist-test.mjs` - the name in package.json. */
export function checkName(script: string): string {
  const m = TEST_FILE.exec(script)
  return m ? `test:${m[1].replace(/-/g, '')}` : script
}
