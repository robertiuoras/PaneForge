import { memo, useEffect, useRef, useState } from 'react'
import { borrowGrid, mirrorFit as mirrorSize } from '@shared/mirrorFit'
import { Terminal, type ILink, type IMarker } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebglAddon } from '@xterm/addon-webgl'
import { pastesClipboardImage } from '../../../shared/agents'
import { pasteImageDrop, splitDropUris, type AttachIn } from '../../../shared/attach'
import { FULL_SCROLLBACK } from '../../../shared/capacity'
import { GRANT_GRACE_MS, nextResize } from '../../../shared/shrinkFirst'
import { readsBusy } from '../../../shared/busy'
import { whenWords } from '../../../shared/elapsed'
import { busyReason, readsElapsedMs, type BusyReason } from '../../../shared/busy'
import { askSignature, type PaneAsk } from '../../../shared/choices'
import {
  applyKey,
  scrollFor,
  selectionOf,
  startState,
  type CopyCtx,
  type CopyState
} from '../../../shared/copyMode'
import { feedDraft, flatDraft, newDraft, RAIL_LABEL_CHARS, type DraftState } from '../../../shared/draft'
import type { InputRow } from '../../../shared/cursorMove'
import { cellAt, keysAlongLine, keysForClick, keysForRows, keysToPoint } from '../../../shared/cursorMove'
import { keepScrollback, keptRows, mayClearScreen } from '../../../shared/keepScrollback'
import { fileRows, lostRows, screenLost } from '../../../shared/screenLoss'
import { anchorMark, type MarkerHost } from '../../../shared/markAnchor'
import { chipSpot, type ChipBox } from '../../../shared/copyChip'
import { composerAt, frameAt, inputEnd, inputStart, leadingBlanks, promptTop } from '../../../shared/promptBox'
import { findPathTokens } from '../../../shared/pathToken'
import { seedPrompts } from '../../../shared/promptEcho'
import { START_COLS, START_ROWS } from '../../../shared/paneGrid'
import { splitReplay } from '../../../shared/replayWidth'
import { placeRail } from '../../../shared/rail'
import type { RevealTarget } from '../../../shared/pathToken'
import { placeTurnCopies } from '../../../shared/turnCopy'
import { HANDHELD_MAX } from '../handheld'
import { CopyIcon, CopyReplyIcon } from './Icons'
import { useNow } from './Elapsed'
import './TerminalPane.css'

const api = window.api

interface Props {
  sessionId: string
  /**
   * The folder this pane's pty is running in.
   *
   * Agents print repo-relative paths (`docs/proposals/x.pdf`), so without this a printed
   * path cannot be turned into a place on disk.
   */
  cwd: string
  visible: boolean
  /**
   * This is the pane you are working in.
   *
   * Separate from `visible` because a grid makes every pane visible at once, and a pane
   * being on screen is not permission to take the keyboard off the one you are typing in.
   * Exactly one pane is active, and only that pane ever calls focus().
   */
  active: boolean
  fontSize: number
  /** put a mouse selection straight on the clipboard, the way most terminals do */
  copyOnSelect: boolean
  clickMovesCursor: boolean
  /** let a plain drag select text even while the agent has mouse reporting on (the wheel
   *  always scrolls this pane - that is not a setting) */
  mouseSelect: boolean
  /** repaint by itself once a resize settles */
  autoFixUi: boolean
  /**
   * This pane mirrors a pty on another machine, at that machine's grid size.
   *
   * A mirror never fits itself: the device the agent runs on owns the terminal's
   * shape, and two windows both fitting one pty would trade SIGWINCHes at each other
   * for as long as both were open. It matches the host's cols/rows exactly and shrinks
   * its own font until that grid fits whatever window is watching, so the pane is a
   * true copy of what is on screen over there rather than a reflow of it.
   */
  mirror?: { cols: number; rows: number } | null
  /**
   * Fit to THIS grid instead of to the window, while the pty stays ours.
   *
   * A phone borrows a local pane's size, and while it is holding it the desk may not
   * bend the pty back: the CLI's repaint is cursor-arithmetic in the width it believes
   * it has, so a pty snapped to 157 columns underneath a phone drawing 50 puts every
   * "thinking" frame on a new line instead of over the last one. So the desk draws the
   * borrowed grid, shrinking its font the way a mirror does - and unlike `mirror`, it
   * keeps everything that is true of a local pane: the busy reading, the clipboard, the
   * attach paths.
   */
  grid?: { cols: number; rows: number } | null
  /**
   * The grid the pty is CONFIRMED to be at, for a local pane.
   *
   * Not the same question as `grid`, which is only set while somebody else is holding the
   * pane's size. This is always the pty's own shape, and it is here so a SHRINK can wait
   * for it: the terminal must never be narrower than the width the agent is painting at.
   * See `shared/shrinkFirst.ts`.
   */
  pty?: { cols: number; rows: number } | null
  /**
   * The width the restored part of this pane's buffer was painted at.
   *
   * A CLI draws in absolute column moves, and a terminal clamps one past its own last
   * column - so a 159-column screen replayed into an 85-column pane collapses onto the
   * right-hand edge, one word over the last, and no repaint fixes it because the damage
   * is in the scrollback. The replay is written at this width and the terminal is put
   * back afterwards. See `shared/replayWidth.ts`.
   */
  replayCols?: number
  /**
   * The four colours the terminal's own chrome is drawn in, from the app's theme.
   *
   * Handed over as strings because xterm renders to a canvas and cannot read a CSS
   * variable. Only the chrome: the sixteen ANSI colours belong to the AGENT, and
   * recolouring those means a CLI's own red stops looking like its red.
   */
  termTheme?: {
    background: string
    foreground: string
    cursor: string
    cursorAccent: string
    selectionBackground: string
    selectionForeground: string
    selectionInactiveBackground: string
  }
  /**
   * The question this pane is sitting on, if it is sitting on one.
   *
   * Read in the main process off the frame this pane reported (`shared/choices.ts`), not
   * here: the same reading has to reach a phone and a bot, and a second one computed in
   * the renderer could only ever disagree with the first.
   */
  ask?: PaneAsk | null
  /**
   * When that question will be answered for you, epoch ms, and which option.
   *
   * Decided in the main process (`shared/autoAnswer.ts`), never here: the press and the
   * countdown have to come from one clock, or the pane promises seconds the presser does
   * not keep. Absent means nothing is going to happen and no clock is drawn.
   */
  autoAnswerAt?: number
  autoAnswerN?: number
  /** That press is being held because somebody is at this window. See `shared/types.ts`. */
  autoAnswerHeld?: boolean
  /**
   * Which CLI is running in this pane.
   *
   * Only used to decide what a dropped IMAGE becomes: Claude Code reads an image off the
   * clipboard when it gets a ^V, so it can be handed the picture itself; the other twelve
   * read a path off the prompt and would see nothing at all from a paste.
   */
  agent?: string
  /** Say something happened, in the window's own toast. */
  onToast?: (msg: string) => void
}

/**
 * "This will be answered for you in N seconds."
 *
 * Its own component so the second timer only runs while a countdown is on screen: `useNow`
 * is one shared tick for the whole app, and subscribing the pane itself would re-render
 * every pane once a second for a clock almost none of them are showing.
 *
 * It names the OPTION as well as the time. A countdown alone says something is about to
 * happen; the point of showing it at all is that somebody who disagrees can reach the pane
 * first, and they cannot disagree with a number.
 */
function AskCountdown({
  at,
  n,
  ask,
  held
}: {
  at: number
  n?: number
  ask: PaneAsk
  held?: boolean
}): React.JSX.Element {
  // Aligned to the DEADLINE, not to the wall clock. `useNow()`'s buckets turn over on the
  // second boundary while `at` is an arbitrary millisecond, so the last step before a press
  // was however much of a second happened to be left - measured as a number that sits for
  // 900ms and then jumps two, which is what "buggy when the timer counts down" was. With
  // `at` as the offset every tick lands exactly on a whole second of the real remainder.
  const now = useNow(held ? Infinity : 1000, at)
  const left = Math.max(0, Math.ceil((at - now) / 1000))
  const label = ask.options.find((o) => o.n === n)?.label
  if (held)
    return (
      // Held has no deadline to draw: leaving the window starts the whole wait again, so a
      // number here would be a second that never arrives. It still names the option, which
      // is the half of the promise that is true either way.
      <div
        className="pane-ask-auto"
        title="Nothing is pressed while you are looking at this window. Settings -> Answer an agent's question for me"
      >
        <span className="pane-ask-auto-left">hold</span>
        <span className="pane-ask-auto-word">
          Waiting while you are here, then
          {label ? <b className="pane-ask-auto-pick"> {label}</b> : null}
        </span>
      </div>
    )
  return (
    <div className="pane-ask-auto" title="Settings -> Answer an agent's question for me">
      {/* The seconds are their own element and are the biggest thing on the row: this is
          the one part somebody has to read at a glance from across the desk, and the
          11px line it used to be was a sentence nobody reported ever seeing. */}
      <span className="pane-ask-auto-left">{left > 0 ? `${left}s` : 'now'}</span>
      <span className="pane-ask-auto-word">
        {/* The seconds are in the pill to the left, so the words say WHAT rather than
            when: "Answering for you in Yes, run it" is what reading the two halves as one
            sentence produced, and it parses as nonsense. */}
        Answering for you with
        {/* The option is named, not only numbered: a countdown alone says something is
            about to happen, and the point of showing it is that somebody who disagrees
            can reach the pane - which they cannot do against a number. */}
        {label ? <b className="pane-ask-auto-pick"> {label}</b> : null}
      </span>
    </div>
  )
}

// On macOS the clipboard lives on Cmd, which leaves Ctrl+C free to interrupt the agent.
// Same detector the window-level shortcuts use, so the two halves cannot disagree.
import { isMac } from '../platform'
import { isPhoneClient, viewerName } from '../client'

/**
 * Panes register their repair function here, so the toolbar button, the shortcut and the
 * command palette can all reach the focused pane without threading a ref through App.
 */
export const paneRepair = new Map<string, () => void>()

/**
 * Re-render a pane from its own bytes. Separate from `paneRepair` on purpose: that one is
 * cheap and runs on its own (a restore, a font change), this one rewrites the whole buffer
 * and only ever runs because somebody pressed Fix. See `redrawHistory`.
 */
export const paneRedraw = new Map<string, () => Promise<boolean>>()

/** Per-pane render counter, exposed on the window for probes. See the component body. */
export const renderCount = new Map<string, number>()
;(window as unknown as { __pfRenders?: Map<string, number> }).__pfRenders = renderCount

/**
 * Tell a pane that a clear is about to be sent to it, from something other than its own
 * keyboard.
 *
 * `arm()` is fed by keystrokes, and a keystroke is only one of the ways a `/clear` reaches
 * a pty here: the Clear button on a card writes it straight at the pty, and so does the
 * session menu and every path in main that types for you. Measured in the running app on
 * 2026-08-19, a pane cleared by typing kept its screen and the same pane cleared through
 * `api.write` lost it - the keeper never heard about the second one. This is that seam,
 * and it is the cheap half of the answer: an armed clear files the screen whole, colours
 * and all, before the CLI has emitted a byte. A clear that arrives with nothing armed is
 * still caught, one step later and in plain text, by the wipe check in the pane.
 */
export const paneArmClear = new Map<string, () => void>()

/**
 * What each pane's user has typed but not sent, reconstructed from the keystrokes this
 * app relays anyway. See `shared/draft.ts` for why it is reconstructed rather than read.
 *
 * A map plus a listener set, exactly like `paneRepair` above and for the same reason: the
 * footer chip, the shortcut and the improve sheet all need the focused pane's draft, and
 * threading it through App as props would put a state update on every keystroke into the
 * component that owns every pane.
 */
export const paneDraft = new Map<string, DraftState>()

/**
 * The panes every keystroke is mirrored into, while synchronised typing is on.
 *
 * Empty the rest of the time, so the fan-out below costs one `Set.has` per keystroke and
 * nothing else. App owns what is in here; a pane only ever reads it.
 *
 * We already had a broadcast box - one line, typed once, sent to every pane. That is the
 * wrong shape for the thing people actually want from tmux's `synchronize-panes`: "all
 * four of you, Ctrl-C, then re-read the plan" is a control code, an arrow key and a menu
 * choice, none of which is a line you can type into a box.
 */
export const syncedPanes = new Set<string>()

/**
 * Each pane's draft reconstruction, keyed by session.
 *
 * A pane whose keystrokes arrived from ANOTHER pane never sees its own `onData`, so its
 * draft would drift away from what its terminal is echoing - and the improve chip reads
 * that draft. The mirror feeds it the same bytes instead.
 */
const paneFeed = new Map<string, (d: string) => void>()

/**
 * The selection chip's own size, in pixels, so `chipSpot` can keep it inside the pane.
 * Kept next to the CSS rather than measured: measuring it means laying it out first, which
 * means one frame of a chip drawn in the wrong place on every drag.
 */
const CHIP_W = 76
const CHIP_H = 26

/**
 * How tall one turn's pair of copy icons is, in pixels - two 22px buttons and the gap.
 * It is a constant rather than a measurement because it decides which pairs are drawn at
 * all, and measuring would need them on screen first. `.turn-copy` in styles.css is these
 * numbers; change one and change both.
 */
const TURN_COPY_H = 48
/** The same stack at finger size, which is what the `handheld` rules draw. */
const TURN_COPY_H_TOUCH = 66

/** Each pane's live prompt-mark list, for the debug handle. */
const paneMarks = new Map<string, { marker: { line: number }; text: string }[]>()

type DraftListener = (id: string, state: DraftState) => void
const draftListeners = new Set<DraftListener>()

export function onPaneDraft(cb: DraftListener): () => void {
  draftListeners.add(cb)
  return () => draftListeners.delete(cb)
}

function publishDraft(id: string, state: DraftState): void {
  paneDraft.set(id, state)
  for (const cb of draftListeners) cb(id, state)
}

/**
 * Put text into a pane the way a paste does, from anywhere in the app.
 *
 * Not the same as writing the bytes to the pty. Claude Code, Codex and every other TUI
 * here turn bracketed paste on, and xterm's paste is what wraps text in the markers they
 * are watching for; raw bytes arrive as if they had been typed a character at a time,
 * which those TUIs are free to read as keystrokes rather than as one insertion.
 */
export const paneInsert = new Map<string, (text: string) => void>()

/**
 * Put the caret back in a pane, from anywhere in the app.
 *
 * Clicking a button, closing a dialog and switching panes with the keyboard all end with
 * the keyboard somewhere that cannot use it - a `<button>`, or nothing at all - and the
 * only cure was clicking back into the terminal. App owns the "which pane" decision; this
 * is how it carries it out. Registered per pane rather than reached through a ref so a
 * pane that is still booting simply is not in the map yet.
 */
export const paneFocus = new Map<string, () => void>()

/**
 * Open this pane's find bar, from the window-level Ctrl+F.
 *
 * The shortcut has to be caught on the window - xterm would otherwise send Ctrl+F to the
 * agent as readline's "forward one character" - but the search itself belongs to the pane
 * that owns the buffer. Same shape as the other three maps: App decides which pane, the
 * pane knows how.
 */
export const paneFind = new Map<string, () => void>()
/** Enter keyboard copy mode in this pane (Ctrl Shift U, or the palette). */
export const paneCopyMode = new Map<string, () => void>()

/**
 * The live terminals, for scripts/probe.mjs to ask questions of.
 *
 * Every scroll bug this app has had lives in the gap between what the buffer thinks
 * (`baseY`, `viewportY`) and what the scrolling element thinks (`scrollTop`), and the DOM
 * side alone cannot tell the two apart - with the GPU renderer there is not even any text
 * in the DOM to read. Both of the last two were found by guessing at that gap and both
 * guesses were wrong. This is the handle that makes the question answerable from a probe
 * instead: `window.__paneTerms.get(id).buffer.active.viewportY`. It is a map of objects the
 * renderer is holding anyway, so it costs one property on `window`.
 */
export const paneTerms = new Map<string, Terminal>()
;(window as unknown as { __paneTerms: Map<string, Terminal> }).__paneTerms = paneTerms

/**
 * The live search addons, on the same handle and for the same reason as `paneTerms`.
 *
 * A search that reports "no matches" for a word that is plainly on screen is answerable
 * from here - `window.__paneSearch.get(id).findNext('x', opts)` returns whether it found
 * anything - and is not answerable from the DOM at all: with the GPU renderer the
 * highlights are decorations over a canvas, so a probe counting elements cannot tell a
 * search that found nothing from one that found five and drew them somewhere else.
 */
export const paneSearch = new Map<string, SearchAddon>()
;(window as unknown as { __paneSearch: Map<string, SearchAddon> }).__paneSearch = paneSearch

/**
 * The panes that currently hold a live WebGL context.
 *
 * A pane that is not on screen was still paying for the GPU renderer: every session's
 * `TerminalPane` stays mounted and is hidden with CSS, so a WebGL context and its glyph
 * atlas lived for the whole session whether or not anyone could see the pane. Measured on
 * this machine with seven sessions open: the GPU helper process sat at 1.57 GB resident
 * and had peaked at 1.81 GB, against 251 MB in the renderer - roughly 220 MB of GPU memory
 * per pane, most of it for panes nobody was looking at. On a 16 GB machine that is enough
 * to push the whole system into swap, and the first thing that shows it is this app, which
 * is the one repainting continuously.
 *
 * So the context now follows visibility (see the effect below), and this set is the
 * backstop for the other half of the problem: Chromium caps live WebGL contexts per
 * renderer, and past the cap it evicts the oldest, which arrives here as a context loss and
 * drops that pane to the DOM renderer for good. Keeping our own count below the browser's
 * means the fallback stays something that happens to a driver, not something we cause by
 * opening one pane too many.
 */
const glLive = new Set<string>()
const GL_BUDGET = 8

/**
 * How long a restored pane's output must be quiet before it repairs itself. Long enough
 * that a CLI still printing its resume banner is not poked mid-paint, short enough that
 * nobody reaches for the Fix button first.
 */
const RESTORE_FIX_MS = 1200

/**
 * Refit, and land back on the newest line if this pane was following it. A resize changes
 * how many rows fit while xterm leaves the viewport offset alone, which is one of the ways
 * the view ends up a line short of the tail. Someone reading scrollback is left alone.
 *
 * Returns whether the terminal actually changed shape. "Nothing moved" is the answer that
 * matters: a pane coming back from `display: none` measures to the same cols/rows it had,
 * and telling the pty a size it already has - then asking the agent to redraw for it - is
 * what made every click between sessions flash a whole repainted frame a moment later.
 */
function refit(t: Terminal, f: FitAddon, pinned: boolean): boolean {
  const cols = t.cols
  const rows = t.rows
  f.fit()
  if (pinned) t.scrollToBottom()
  return t.cols !== cols || t.rows !== rows
}

/** A mirror asks for its grid at most this often, and this many times per target. */
const BORROW_EVERY_MS = 1200
const BORROW_TRIES = 6

/**
 * A mirrored pane's version of the same thing: take the host's grid exactly, and pick
 * the largest font at or below the user's own at which that grid still fits here.
 *
 * Self-correcting rather than exact. `proposeDimensions()` answers for the font that is
 * set right now, so the ratio it implies is one step towards the right size, not the
 * answer; the observer that called this runs again on the layout that results and the
 * two converge in a frame or two. Solving it in one go would mean reading xterm's
 * internal cell metrics, which are stale for a frame after any font change anyway.
 */
function mirrorFit(
  t: Terminal,
  f: FitAddon,
  pinned: boolean,
  mirror: { cols: number; rows: number },
  maxFont: number,
  host: HTMLElement | null,
  /**
   * Ask the machine that owns this pty to draw it at the grid THIS window has room for.
   *
   * Fitting the font was the only lever a mirror had, and it cannot win: the PC's pane
   * was 69x35 (its window is small - a disconnected RDP session) against room for 152x58
   * here, so the far end's screen was either a block of text in the corner or, once it
   * was allowed to grow, enormous. Neither is the screen the agent is drawing on.
   *
   * So a mirror BORROWS the size, exactly as a phone borrows a desk pane's (see `resize`
   * in main/sessions.ts): the host bends the pty to the viewer, keeps its own desk size,
   * and takes it back the moment the mirror detaches. Nothing here forces it - a host
   * that ignores the request leaves this function fitting the font, as before.
   */
  ask?: (cols: number, rows: number) => void
): boolean {
  const cols = t.cols
  const rows = t.rows
  let stepped = false
  let scaleWanted = 1
  const d = f.proposeDimensions()
  // The font the measurement was TAKEN at, read before anything below changes it. `d`
  // answers for the font that is set right now, so every conversion off it has to use
  // THIS number and not the one the shrink is about to write - see `borrowGrid`, whose
  // comment carries the infinite loop that cost.
  const current = t.options.fontSize ?? maxFont
  if (d && d.cols > 0 && d.rows > 0) {
    const out = mirrorSize({
      fitCols: d.cols,
      fitRows: d.rows,
      hostCols: mirror.cols,
      hostRows: mirror.rows,
      font: current,
      maxFont
    })
    if (out.font !== current) {
      t.options.fontSize = out.font
      stepped = true
    }
    scaleWanted = out.scale
    // Below the font floor the only lever left is the element itself. Without this
    // the pane simply drew a grid wider than itself and the far end's screen was cut
    // off at the edge - reported as "half way cut across the screen". xterm's hit
    // testing reads getBoundingClientRect, which includes the transform, so a click
    // in a scaled mirror still lands on the cell under the pointer.
  }
  if (ask && d && d.cols > 0 && d.rows > 0) {
    // The grid to ask for is the one that fits at the USER's font, so the answer arrives
    // and needs no shrinking at all - converted with the font `d` was measured at.
    const want = borrowGrid({ fitCols: d.cols, fitRows: d.rows, font: current, maxFont })
    if (want.cols !== mirror.cols || want.rows !== mirror.rows) ask(want.cols, want.rows)
  }
  t.resize(Math.max(20, mirror.cols), Math.max(5, mirror.rows))

  // The scale is MEASURED, not walked.
  //
  // `mirrorSize` says whether the font alone can do it; how much is left over is a
  // question about pixels that are already on the screen, and asking the DOM is exact
  // where another ratio-of-a-ratio step is not. It also cannot stall: the walk stops
  // as soon as the font settles, so a scale derived from it never got a pass with the
  // font already at the floor - measured live at a forced 600x150 grid, 902px of the
  // far end's screen stayed clipped with no transform at all.
  if (host) {
    const screen = host.querySelector('.xterm-screen') as HTMLElement | null
    // `offsetWidth` and `clientWidth` are LAYOUT sizes: a transform on this element
    // does not move them, so reading them back after applying one cannot feed on
    // itself and walk the pane down to nothing.
    const room = host.clientWidth
    const drawn = screen ? screen.offsetWidth : 0
    const tall = screen ? screen.offsetHeight : 0
    const measured =
      drawn > 0 && room > 0 ? Math.min(1, room / drawn, host.clientHeight / Math.max(1, tall)) : 1
    // The arithmetic answer and the measured one, whichever is smaller. `mirrorSize`
    // decides whether scaling is needed at all and is what the tests pin; the DOM
    // decides by how much.
    const fits = Math.min(scaleWanted, measured)
    const s = fits < 0.999 ? Math.max(0.05, fits) : 1
    // ...and whatever room is STILL left over is split, not left on one side.
    //
    // A grid is a whole number of cells, so a mirror almost never fills its pane
    // exactly - and the leftover used to sit entirely at the right and the bottom,
    // which is what makes a correctly-drawn remote screen read as a broken one: text
    // jammed into the top-left corner with a black L around it. Centring is layout
    // arithmetic only (`clientWidth`, `offsetWidth` - neither moves under a transform)
    // so it cannot feed on itself the way a rect-based measurement would.
    const pad = getComputedStyle(host)
    const padX = parseFloat(pad.paddingLeft) || 0
    const padY = (parseFloat(pad.paddingTop) || 0) + (parseFloat(pad.paddingBottom) || 0)
    // ...and only when the leftover is worth splitting. A borrowed mirror fills its pane
    // to within a cell, and nudging THAT by 7px only moves the pane off the left edge it
    // is meant to sit flush against (the scrollbar hugs the right, see styles.css).
    const cellW = drawn / Math.max(1, t.cols)
    const cellH = tall / Math.max(1, t.rows)
    const halfX = Math.max(0, Math.round((room - padX - drawn * s) / 2))
    const halfY = Math.max(0, Math.round((host.clientHeight - padY - tall * s) / 2))
    // Two cells, not one: a grid is whole cells, so a pane that took everything it
    // could still leaves up to a cell over on each axis, and that is not slack - it is
    // the pane being full.
    const slackX = halfX * 2 >= cellW * 2 ? halfX : 0
    const slackY = halfY * 2 >= cellH * 2 ? halfY : 0
    const move = slackX || slackY ? `translate(${slackX}px, ${slackY}px)` : ''
    const zoom = s < 0.999 ? `scale(${s.toFixed(3)})` : ''
    const want = [move, zoom].filter(Boolean).join(' ')
    if (host.style.transform !== want) {
      host.style.transformOrigin = 'top left'
      host.style.transform = want
      stepped = true
    }
  }
  if (pinned) t.scrollToBottom()
  // The FONT and the SCALE count as a change, not just the grid.
  //
  // This walk converges over frames - each pass measures the layout the previous one
  // produced - and the only thing that makes the next pass happen is this returning
  // true. Reporting only `cols/rows` meant a mirror whose grid was already correct
  // stopped after ONE step: measured live at a forced 600x150 grid, the scale settled
  // at 0.807 where 0.565 was needed and 502px stayed off the right edge, stable and
  // wrong. The grid is the one thing that does NOT change here - a mirror takes the
  // host's cols and rows verbatim - so it was the wrong thing to key on.
  return t.cols !== cols || t.rows !== rows || stepped
}

/**
 * The bottom `rows` rows on screen right now - not the scrollback, and not wherever the
 * user scrolled. Only the bottom of the frame is read because that is the only place a
 * "still running" footer ever appears, and translating every visible row of every pane
 * several times a second is enough main-thread work that Windows leaves the mouse on the
 * busy cursor between bursts.
 */
function screenText(t: Terminal, rows: number): string {
  const buf = t.buffer.active
  const read = (i: number): string => buf.getLine(buf.baseY + i)?.translateToString(true) ?? ''
  // Start at the last row with anything on it, not at the last row of the grid. A CLI
  // that is painting fewer rows than the pane is tall - the pty grid a beat behind a
  // resize, a window that grew while the agent was quiet - leaves the bottom of the
  // frame blank, and reading the bottom rows then reads nothing at all. Measured: a
  // 44-row pane whose agent was drawing 30 rows returned an empty frame for a whole
  // turn, so the footer was "not on screen" for as long as the mismatch lasted.
  let last = t.rows - 1
  while (last > 0 && !read(last).trim()) last--
  let out = ''
  for (let i = Math.max(0, last - rows + 1); i <= last; i++) out += read(i) + '\n'
  return out
}

/**
 * How far up from the last row the busy footer can be. Generous, and generous on
 * purpose: a Claude Code pane with a three-line statusline puts its own input box, two
 * borders and that statusline below the spinner, which is seven rows before the agent
 * has printed anything at all.
 */
const BUSY_ROWS = 16

/**
 * How far up the frame a live QUESTION can start, which is much further than a footer.
 *
 * Deliberately a second number rather than a bigger BUSY_ROWS: the busy read must stay
 * on the last thing painted, because a `esc to interrupt` printed during a boot stays in
 * the buffer and a wider window reports a pane as working long after it went quiet. A
 * chooser is the opposite shape - Claude Code's AskUserQuestion draws a question, six
 * options and a paragraph under each, which is past 30 rows before the footer that
 * proves it is live. Read only when the pane is IDLE, so the wider translate costs
 * nothing during a turn.
 */
const ASK_ROWS = 44

/**
 * How often a pane re-states that it is still busy. The main process holds "busy" as a
 * deadline rather than a flag, so silence eventually reads as finished - which is the right
 * default for a pane that crashed or was closed, and wrong for a turn that is simply taking
 * a long time. Well under that deadline so a few dropped ticks cost nothing.
 */
const BUSY_RESTATE = 120_000

/** A prompt that was submitted to this pane, pinned to the buffer line it was sent on. */
interface Mark {
  /** The FIRST marker's id, kept as the React key across a re-anchor. */
  id: number
  marker: IMarker
  /**
   * The buffer line the marker was last seen on.
   *
   * xterm sets a marker's line to -1 before it announces the disposal, so this is the only
   * way to know where a tag was when its marker died - which is what re-anchoring one
   * needs. Refreshed every render; a marker keeps its own line right in between.
   */
  line: number
  /** The rail's label: one line, flattened, capped at RAIL_LABEL_CHARS. */
  text: string
  /**
   * What was actually typed, whole - every line of it, at whatever length it was.
   *
   * `text` is a LABEL and cannot be the thing the copy button copies: it collapses the
   * newlines of a multi-line prompt into spaces and stops at 400 characters, so "copy this
   * prompt" handed back a one-line paraphrase of a long ask with the end missing, silently
   * (measured: a 492-character prompt copied as exactly 400, cut mid-word). The rail wants
   * the short form and the clipboard wants the whole one, so both are kept.
   */
  full: string
  at: number
}

/**
 * What a rail tag reads out on hover. The time is the point of it as much as the text is -
 * "what did I ask at 14:32" is how you find a prompt again hours into a run.
 *
 * The tip says the DISTANCE (`/clear  (5 min ago)`) and the native tooltip under it says
 * the exact moment. A wall-clock time is the thing somebody has to subtract from the clock
 * in their own status bar before it answers "is this pane stuck or did I only just ask" -
 * which is the question the rail is opened for. The exact time is still one hover-hold
 * away, because "5 min ago" is the wrong half once a session is being read back hours
 * later. Same split, and the same `whenWords`, as History's rows.
 */
function markLabel(m: Mark, now: number): string {
  // 0 is a tag rebuilt from a restored pane's own output (seedMarks): the text is known
  // and the clock is not. A confident wrong time on a prompt is worse than no time - it is
  // what somebody uses to decide which tag to press.
  const text = m.text.length > 160 ? m.text.slice(0, 159) + '…' : m.text
  if (!m.at) return text
  return text + '  (' + whenWords(m.at, now) + ')'
}

/** The exact moment, for the hover-hold. Empty for a tag whose clock is unknown. */
function markWhen(m: Mark): string {
  return m.at ? new Date(m.at).toLocaleString() : ''
}

/** Quote a dropped path only when it needs it, so an agent reads it as one argument. */
function quote(p: string): string {
  return /[\s'"]/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p
}

/** Ctrl+V as a byte, for the agents that read the OS clipboard themselves. */
const RAW_PASTE = String.fromCharCode(0x16)

/** Between two pasted images: long enough for the CLI to have read the first one. */
const PASTE_GAP_MS = 250

/** The one refusal that means "nothing to attach" rather than "something went wrong". */
const NO_IMAGE = 'No image on the clipboard'

/**
 * Bytes as base64, in chunks.
 *
 * `String.fromCharCode(...bytes)` on a whole 2 MB screenshot is a two-million-argument
 * call, which throws RangeError on every engine here. 32 KB at a time is well under it.
 */
function base64(bytes: Uint8Array): string {
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(s)
}

/**
 * One xterm bound to one pty. Output arrives as a global 'pty:data' event, so each
 * pane filters by id rather than opening a channel per session.
 */
function TerminalPane({
  sessionId,
  cwd,
  visible,
  active,
  fontSize,
  copyOnSelect,
  mouseSelect,
  clickMovesCursor,
  autoFixUi,
  mirror = null,
  grid = null,
  pty = null,
  replayCols,
  termTheme,
  ask = null,
  autoAnswerAt,
  autoAnswerN,
  autoAnswerHeld,
  agent,
  onToast
}: Props): JSX.Element {
  // How many times each pane has rendered, where a probe can read it.
  //
  // A pane's render is not cheap - it re-measures the turn-copy pairs and the rail against
  // the live xterm buffer - and the sessions list arrives from main as a fresh array on
  // every change, so before `memo` below EVERY pane re-rendered whenever ANY pane's
  // question moved by one arrow. This counter is what makes that statement a measurement
  // rather than a theory, and it is what `scripts/ask-render-test.mjs` reads.
  renderCount.set(sessionId, (renderCount.get(sessionId) ?? 0) + 1)
  const host = useRef<HTMLDivElement>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  const fit = useRef<FitAddon | null>(null)
  // Null whenever this pane is drawing itself as DOM: off screen, over the context budget,
  // or after the GPU took the context away. See `glLive` for why that is worth tracking.
  const glRef = useRef<WebglAddon | null>(null)
  // Read inside listeners that are attached once per session, so flipping the
  // setting takes effect without tearing the terminal down.
  const copyOnSelectRef = useRef(copyOnSelect)
  copyOnSelectRef.current = copyOnSelect
  const mouseSelectRef = useRef(mouseSelect)
  mouseSelectRef.current = mouseSelect
  const clickCursorRef = useRef(clickMovesCursor)
  clickCursorRef.current = clickMovesCursor
  // The two halves of editing by selection. They read the live terminal, so they are built
  // inside the effect that owns it; the key handler is attached before that point and
  // reaches them through here.
  const selectInputRef = useRef<() => boolean>(() => false)
  const deleteSelectionRef = useRef<() => 'done' | 'refused' | 'no'>(() => 'no')
  const inputRowsRef = useRef<(() => { top: number; rows: InputRow[] } | null) | null>(null)
  const autoFixRef = useRef(autoFixUi)
  autoFixRef.current = autoFixUi
  // The width this pane's replayed history was painted at, where the effect that owns the
  // terminal can read it. See `Props.replayCols`.
  const replayColsRef = useRef(replayCols)
  replayColsRef.current = replayCols
  /**
   * The replay is mid-flight and the terminal is deliberately the WRONG shape for its box.
   *
   * `reshape` is called by the resize observer, by the visibility effect and by the grid -
   * any one of them landing between the two halves of a staged replay would fit the
   * terminal back to the window while the old screen is still being written into it, which
   * is the bug this exists to fix, arriving from the other side.
   */
  const replaying = useRef(false)
  /**
   * The question this pane is sitting on, where the mouse handlers can see it.
   *
   * They are attached once per session and they TYPE INTO THE PTY - a bare click becomes
   * left and right arrows, an Alt-click becomes up and down, a selection delete becomes a
   * run of backspaces - and a live chooser is the one moment on a pane when every one of
   * those is an action rather than a movement. Measured against a real `claude` in a pty
   * on 2026-08-19: 15 right arrows sent while its `/model` chooser was up moved it from
   * Medium to `max effort`, and 2 down arrows moved the selection and left a torn partial
   * repaint behind. Claude Code does NOT turn mouse reporting on (no `?1000h` anywhere in
   * its boot), so `mouseGrabbed()` is false, nothing is swallowed, and a click that merely
   * tried to place the cursor was silently answering somebody else's question.
   *
   * So: while a question is up, a click does nothing to the pty at all. The answer is the
   * buttons under the pane, which say what they will do before they do it.
   */
  const askRef = useRef<PaneAsk | null>(null)
  askRef.current = ask ?? null
  // The paste path lives inside a long-lived effect, so the prop itself would be the
  // one this pane mounted with - and a pane switched to another CLI would keep pasting
  // the way the old one wanted.
  const agentRef = useRef(agent)
  agentRef.current = agent
  /**
   * Every keystroke this pane's MOUSE handlers have sent, for a probe to read.
   *
   * `window.api` is frozen by the context bridge, so a test cannot wrap `write` to watch
   * what a click did - it assigns, the assignment is dropped in silence, and the test then
   * reports an empty list for every click it makes, including the ones that typed. That is
   * how the first version of `test:askclick` passed without ever reaching the handler. The
   * only honest reading is one the pane keeps itself.
   */
  const clickKeys = useRef<string[]>([])
  const sendKeys = (keys: string): void => {
    clickKeys.current.push(keys)
    void api.write(sessionId, keys)
  }
  // A session can be moved into a lane worktree without the pane being rebuilt, and the
  // link provider is attached once per session, so it reads the folder through a ref.
  const cwdRef = useRef(cwd)
  cwdRef.current = cwd
  // Read inside the terminal effect, which is built once per session: a device
  // reconnecting changes these numbers without the pane being rebuilt.
  const mirrorRef = useRef(mirror)
  mirrorRef.current = mirror
  const gridRef = useRef(grid)
  gridRef.current = grid
  // The grid the pty is CONFIRMED to be at, so a shrink can wait for it rather than
  // assuming. Asking and assuming is what tore a pane on every resize.
  const ptyRef = useRef(pty)
  ptyRef.current = pty
  /** the shrink this pane has asked the pty for and has not seen granted yet */
  const asked = useRef<{ cols: number; rows: number; at: number } | null>(null)
  /** gives up on an ask main never grants - see GRANT_GRACE_MS */
  const grantTimer = useRef<number | undefined>(undefined)
  /** whether this pane's shape was last drawn from somebody else's grid - see the font
   *  effect, which must refit when that stops being true even if the font does not move */
  const wasDerived = useRef(false)
  const fontRef = useRef(fontSize)
  fontRef.current = fontSize

  /**
   * The last grid this mirror asked the host for.
   *
   * A request that is never applied - an older build over there, a pane whose size
   * something else owns - must not become a request per animation frame for ever, so
   * the same target is asked at most `BORROW_TRIES` times and never faster than
   * `BORROW_EVERY_MS`. A DIFFERENT target (this window was resized) starts again.
   */
  const borrowRef = useRef<{ cols: number; rows: number; at: number; tries: number } | null>(null)
  const askBorrow = (cols: number, rows: number): void => {
    const now = Date.now()
    const b = borrowRef.current
    if (b && b.cols === cols && b.rows === rows) {
      if (b.tries >= BORROW_TRIES || now - b.at < BORROW_EVERY_MS) return
      b.tries += 1
      b.at = now
    } else borrowRef.current = { cols, rows, at: now, tries: 1 }
    api.resize(sessionId, cols, rows, true)
  }
  // Same reason as the font: the terminal is built once per session, and changing the
  // theme must not tear down a running agent's scrollback to recolour its background.
  const themeRef = useRef(termTheme)
  themeRef.current = termTheme
  // Full-screen TUIs (Claude Code, vim) repaint constantly and xterm drops the
  // selection on the next buffer change, so the highlight vanishes before the user
  // can hit Ctrl+C. Remember the last real selection and copy that instead.
  const lastSelection = useRef('')
  // Whether this pane is following the tail. A ref because the resize and font-size effects
  // need it too, and it must survive without re-running the effect that owns the terminal.
  const pinned = useRef(true)
  // Only for the "back to newest" pill: the scroll position itself lives in xterm.
  const [scrolledUp, setScrolledUp] = useState(false)

  /**
   * Give this pane its shape. A local pane fits its own window and tells the pty about
   * it; a mirror takes the far end's grid and shrinks its own font until that grid
   * fits. Returns whether the terminal actually changed shape, which is what decides
   * whether the agent gets asked to repaint - and a mirror never asks, because the
   * frame it is showing was drawn on the other machine to begin with.
   */
  const reshape = (t: Terminal, f: FitAddon): boolean => {
    if (replaying.current) return false
    const m = mirrorRef.current
    if (m && m.cols > 0 && m.rows > 0)
      return mirrorFit(t, f, pinned.current, m, fontRef.current, host.current, askBorrow)
    // A phone is holding this pane's size. Same drawing as a mirror - take the grid, fit
    // the font to it - and no resize is reported, because reporting one is exactly what
    // used to pull the pty out from under the phone.
    const g = gridRef.current
    if (g && !isPhoneClient() && g.cols > 0 && g.rows > 0)
      return mirrorFit(t, f, pinned.current, g, fontRef.current, host.current)
    // No longer drawn at somebody else's grid: drop any scale a mirror left behind,
    // or the pane keeps drawing at two thirds size with nothing to explain it.
    if (host.current && host.current.style.transform) host.current.style.transform = ''
    // Which of this pane's two widths moves first. A GROW may fit here and tell the pty
    // afterwards - a terminal wider than the paint only leaves short lines. A SHRINK may
    // not: for the one IPC hop between the two the CLI is still painting at the old width,
    // and every absolute column move past the new last column CLAMPS onto the right-hand
    // edge, one word over the last, into scrollback no repaint can reach. See
    // `shared/shrinkFirst.ts` for the asymmetry and the measurement behind it.
    const room = ((): { cols: number; rows: number } | null => {
      try {
        const d = f.proposeDimensions()
        return d && d.cols > 0 && d.rows > 0 ? { cols: d.cols, rows: d.rows } : null
      } catch {
        return null
      }
    })()
    const step = nextResize({
      have: { cols: t.cols, rows: t.rows },
      want: room,
      pty: ptyRef.current,
      asked: asked.current,
      waitedMs: asked.current ? Date.now() - asked.current.at : 0
    })
    if (step.do === 'none' || step.do === 'wait') return false
    if (step.do === 'ask') {
      asked.current = { cols: step.cols, rows: step.rows, at: Date.now() }
      api.resize(sessionId, step.cols, step.rows, isPhoneClient(), viewerName())
      // Nothing moved on screen, so this is not a resize as far as the caller is concerned
      // - the repaint belongs to the fit that follows the grant. The timer is only the
      // floor under a grant that never comes; the effect below is the fast path.
      window.clearTimeout(grantTimer.current)
      grantTimer.current = window.setTimeout(() => {
        const tt = term.current
        const ff = fit.current
        if (tt && ff && asked.current) reshape(tt, ff)
      }, GRANT_GRACE_MS + 50)
      return false
    }
    asked.current = null
    const changed = refit(t, f, pinned.current)
    // A phone BORROWS the pty's shape rather than owning it. One pty cannot be 50 columns
    // for a phone and 157 for the window it is also drawn in, and before this the phone
    // simply won and never gave it back - the desk went on drawing a full-width pane whose
    // every line wrapped a third of the way across, for as long as it took somebody to
    // resize the window by hand. See `resize` in main/sessions.ts.
    if (changed) api.resize(sessionId, t.cols, t.rows, isPhoneClient(), viewerName())
    return changed
  }
  // The pty has just reported a new grid. A pane holding a shrink back was waiting for
  // exactly this, so it applies now instead of at the end of the grace.
  useEffect(() => {
    if (!asked.current) return
    const t = term.current
    const f = fit.current
    if (t && f) reshape(t, f)
  }, [pty?.cols, pty?.rows])
  const [dropping, setDropping] = useState(false)

  /**
   * Finding something in this pane's scrollback.
   *
   * A pane holds 20,000 lines and there was no way to find anything in them: the only
   * tools were the wheel and the prompt rail, and the rail only knows where prompts were
   * submitted. This is the terminal's own search, so it reads the buffer rather than the
   * DOM - with the WebGL renderer there is no text in the DOM to read, and Chromium's own
   * Ctrl+F finds nothing at all in a pane.
   */
  const search = useRef<SearchAddon | null>(null)
  // The term this pane last handed to the addon, which is not the same as the term the
  // addon thinks it last searched for - see runFind.
  const lastTerm = useRef('')
  const findInput = useRef<HTMLInputElement>(null)
  const [finding, setFinding] = useState(false)
  const [query, setQuery] = useState('')
  // What the addon says about the term as it is typed: which match is lit and how many
  // there are. -1 means it stopped counting, which it does past a thousand matches.
  const [hits, setHits] = useState({ index: -1, count: 0 })
  // Whether the last search found nothing at all, which is not the same question as how
  // many matches are highlighted. The count comes from the addon's decorations, and those
  // need a terminal that is being drawn; a pane whose matches were all found and none
  // counted has been measured. Printing "no matches" from that number is the box lying
  // about the buffer, so the two are kept apart: "no matches" only when the search itself
  // came back with nothing, and a bare "found" when it landed somewhere uncounted.
  const [missed, setMissed] = useState(false)
  /**
   * Keyboard copy mode: the pane's scrollback navigated and selected with no mouse.
   *
   * The state is a ref because every keypress redraws the SELECTION, which is xterm's
   * job and not React's - re-rendering the component per keystroke to move a highlight
   * would repaint the mark rail and the find bar as well. The one thing React draws is
   * the strip at the bottom saying the mode is on, so that gets its own small state.
   */
  const copy = useRef<CopyState | null>(null)
  const [copyOn, setCopyOn] = useState(false)
  const [copySel, setCopySel] = useState(false)
  // xterm's key handler is attached long before copy mode is built, so it reaches the
  // mode through a ref rather than being re-attached when one exists.
  const copyKeyRef = useRef<(e: KeyboardEvent) => boolean>(() => false)
  // Every prompt submitted to this pane, oldest first. State rather than a ref because the
  // rail is rendered by React and has to repaint when a prompt is sent or scrolled away.
  const [marks, setMarks] = useState<Mark[]>([])
  /**
   * The clock behind each tag's `(5 min ago)`.
   *
   * A minute, never a second: `whenWords` draws nothing finer than a minute under an hour,
   * so a second-by-second wakeup would re-render the whole pane - which re-measures the
   * turn-copy pairs and the rail against the live xterm buffer - to write out an identical
   * string. `Infinity` on a pane with no tags subscribes to nothing at all.
   *
   * The offset is the NEWEST tag's own moment, so its minute turns over exactly when it
   * became true rather than up to 59 seconds later on the wall minute. It is the tag being
   * read: the older ones are within a minute of correct, which is inside their own unit.
   */
  const railNow = useNow(marks.length ? 60_000 : Infinity, marks[marks.length - 1]?.at ?? 0)
  /**
   * Nothing has come out of this pty yet.
   *
   * An agent CLI is not instant and the pane it is starting in is a black rectangle until
   * it prints its first byte: measured here, `claude` takes ~0.5s warm and ~4s on a cold
   * start, against the 16-40ms this app spends spawning it. Nothing in that gap says a
   * process was even started, so a slow launch and a broken one look identical - which is
   * what "opening a terminal is too slow" is really reporting most of the time. A line
   * saying it is starting costs nothing and turns dead into pending.
   */
  const [blank, setBlank] = useState(true)
  // How many buffer lines this pane spans (scrollback + screen). It is the denominator that
  // turns a marker's absolute line into a height on the rail, so it has to follow the buffer.
  const [total, setTotal] = useState(1)
  // How many of those lines are on screen. Only the rail wants it: a tag lines up with the
  // scrollbar thumb that would bring its line into view, and the thumb is `rows/total` tall.
  const [rows, setRows] = useState(24)
  // Where xterm's scrollbar actually is, in the pane's own coordinates. It cannot be
  // written as CSS: the host is inset 7px, but the terminal is a whole number of rows and
  // overhangs that box by whatever the rounding left over, so the track's real top and
  // height are only knowable by measuring. Guessing put every tag a few pixels out.
  const [track, setTrack] = useState({ top: 7, height: 0 })
  // Which tag just got clicked, so it can light up long enough to be seen.
  const [flash, setFlash] = useState(-1)
  const flashTimer = useRef<number | undefined>(undefined)
  /** Phone re-wraps this pane has been through. Read by `npm run test:phoneview`. */
  const rewraps = useRef(0)

  /** Self-repairs this pane has been given after a restore. Read by the probe. */
  const restoreFixes = useRef(0)
  /**
   * This pane came back wearing a frame drawn at somebody else's width.
   *
   * A restored pane is seeded with the tail of what the OLD pty printed (`restoredTail`
   * in `main/sessions.ts`), and the CLI hard-wrapped those lines itself at the width it
   * had then - into a terminal that has not necessarily been fitted yet, since xterm
   * opens at 80x24 and the fit lands a frame or two later. So the replay regularly
   * arrives at the wrong width, the resuming agent then draws its own frame over it, and
   * the pane reads as broken. That is "after the update restart it looks broken, Fix
   * fixes it": the app restarts itself for every update, so this is the launch most panes
   * on this desk get. The pane now presses Fix for itself, once.
   */
  const needRestoreFix = useRef(false)
  /**
   * Give a restored pane that repair, once. Deliberately not a plain timer from the
   * replay: a hidden pane cannot be measured and its agent has nothing to redraw against,
   * so it is left FLAGGED and the visibility effect asks again once it has a real grid.
   */
  const runRestoreFix = (): void => {
    if (!needRestoreFix.current) return
    // `autoFixUi` is "do not poke a CLI on my behalf", and this is a poke. A mirror is the
    // other machine's pty, and that machine is repairing its own pane.
    if (!autoFixRef.current || mirrorRef.current) {
      needRestoreFix.current = false
      return
    }
    if (!host.current?.offsetParent) return
    needRestoreFix.current = false
    restoreFixes.current++
    paneRepair.get(sessionId)?.()
  }

  /**
   * The two copy affordances, and why they are separate.
   *
   * `selChip` follows a HIGHLIGHT: something is selected and there is a button beside it.
   * Ctrl+C already copies, and copy-on-select copies without being asked - but both are
   * invisible, so the only way to find out whether the copy happened was to paste
   * somewhere and look. A button is the affordance; the toast is the receipt.
   *
   * `geom` is what puts a copy icon on every PROMPT that is on screen, and one under it
   * for the reply that prompt got. That used to follow the pointer: hovering a turn drew
   * the pair at the top of it. Which cannot be used. The buttons are anchored to the row
   * the turn STARTS on, so reaching for them means moving the pointer up - across rows
   * belonging to the turn before, which recomputes the block and moves the buttons out
   * from under the pointer, and out of the pane entirely once the pointer leaves the
   * screen element the listener is on ("cant even copy prompt because once you move mouse
   * over hover it disappears"). A thing you have to chase is not a button.
   *
   * So they are always drawn, faint, in the gutter left of the rail - the same place for
   * every turn, so the second copy is muscle memory - and nothing about them depends on
   * where the pointer is. The cost is arithmetic on every scroll, which `syncTotal` was
   * already doing for the rail.
   */
  const [selChip, setSelChip] = useState<{ left: number; top: number } | null>(null)
  const [geom, setGeom] = useState<{
    viewportY: number
    cellH: number
    offY: number
    height: number
  } | null>(null)
  const toast = useRef(onToast)
  toast.current = onToast

  /**
   * Put saved attachments at the prompt, quoted, with a trailing space.
   *
   * Written to the pty rather than pasted, and nothing is sent for you: the paths land in
   * the input box so the thing being attached can be described first.
   */
  const typePaths = (paths: string[]): void => {
    if (!paths.length) return
    api.write(sessionId, paths.map(quote).join(' ') + ' ')
    term.current?.focus()
  }

  /**
   * Hand files to the machine this pane's pty is on, and type the paths it answers with.
   *
   * The bytes travel rather than the path because a path is only true on one machine: a
   * screenshot dragged onto a MIRRORED pane used to type a path from this desk at an
   * agent running on the other one, which reads as a missing file and not as an error
   * anybody can act on.
   */
  const sendFiles = async (files: File[]): Promise<void> => {
    const payload: AttachIn[] = []
    for (const file of files) {
      const bytes = new Uint8Array(await file.arrayBuffer())
      if (!bytes.length) continue
      payload.push({ name: file.name, data: base64(bytes) })
    }
    if (!payload.length) return
    const res = await api.attachFiles(sessionId, payload)
    if (res.error) toast.current?.(res.error)
    typePaths(res.paths)
  }

  /** Is a paste the right answer for this drop? The rule itself is in shared/attach.ts. */
  const pasteImagesInstead = (items: { name: string; type?: string }[]): boolean =>
    pasteImageDrop({ agent, sessionId, items }, pastesClipboardImage)

  /**
   * Hand images to the agent through the clipboard, one ^V each.
   *
   * A `path` item is a Finder drag or a screenshot dragged off its own preview thumbnail:
   * there is no File object behind it and the main process reads the file itself. A
   * `file` item carries its bytes.
   *
   * ALL OR NOTHING. Every item is decoded first, and one the decoder refuses sends the
   * WHOLE drop back to typing paths. Pasting the ones that worked and typing paths for
   * the rest leaves the prompt holding two pastes and a path in an order nobody can
   * predict - and a name is the least trustworthy thing about a file, so a PDF called
   * `shot.png` is exactly how a mixed batch gets this far: `pasteImageDrop` can only read
   * names and MIME types, and only a decode knows.
   */
  const pasteImages = async (items: { file?: File; path?: string }[]): Promise<void> => {
    /** What this drop does when anything at all goes wrong. Never silent, never partial. */
    const fallBack = async (why?: string): Promise<void> => {
      if (why) toast.current?.(why)
      const files = items.map((i) => i.file).filter((f): f is File => !!f)
      const paths = items.map((i) => i.path).filter((p): p is string => !!p)
      if (files.length) await sendFiles(files)
      if (paths.length) typePaths(paths)
      term.current?.focus()
    }

    // 1. Read the bytes. A File handle can be revoked between the drop and this line - the
    //    file was moved, or the browser refuses it - and that rejection would otherwise be
    //    swallowed whole by the `void` at the call site.
    const loaded: { data?: string; path?: string }[] = []
    for (const item of items) {
      if (item.file) {
        try {
          const bytes = new Uint8Array(await item.file.arrayBuffer())
          if (!bytes.length) return fallBack()
          loaded.push({ data: base64(bytes) })
        } catch {
          return fallBack()
        }
      } else if (item.path) loaded.push({ path: item.path })
    }
    if (loaded.length !== items.length) return fallBack()

    // 2. Decode every one of them BEFORE a single ^V is sent. `probe` writes nothing, so a
    //    batch that turns out not to be all images leaves the clipboard as it was.
    for (const src of loaded) {
      let readable = false
      try {
        readable = await api.putImageOnClipboard({ ...src, probe: true })
      } catch {
        readable = false
      }
      if (!readable) return fallBack()
    }

    // 3. Now paste. A failure here has already overwritten the clipboard, so it is said out
    //    loud rather than left as a drop that appeared to do nothing at all.
    for (let i = 0; i < loaded.length; i++) {
      try {
        if (!(await api.putImageOnClipboard(loaded[i]))) return fallBack()
        api.write(sessionId, RAW_PASTE)
      } catch {
        return fallBack('That image reached the clipboard but the pane could not paste it.')
      }
      // The CLI reads the clipboard when the ^V lands, so two images pasted in the same
      // tick would both read whichever one was written last. One at a time, with a gap
      // wide enough for the read - and no gap after the last one, which is only a wait.
      if (i < loaded.length - 1) await new Promise((r) => setTimeout(r, PASTE_GAP_MS))
    }
    term.current?.focus()
  }

  const syncTotal = (): void => {
    const t = term.current
    if (!t) return
    setTotal(t.buffer.active.baseY + t.rows)
    setRows(t.rows)
    // Where the rows are, so the copy icons can be drawn beside the ones on screen. Same
    // call the rail's own placement makes, and skipped whole when nothing moved: this runs
    // on every scroll and every write.
    const box = cellBox()
    if (box) {
      const off = screenOffset()
      setGeom((p) =>
        p &&
        p.viewportY === box.viewportY &&
        Math.abs(p.cellH - box.cellH) < 0.01 &&
        Math.abs(p.offY - off.y) < 0.5 &&
        Math.abs(p.height - box.height) < 0.5
          ? p
          : { viewportY: box.viewportY, cellH: box.cellH, offY: off.y, height: box.height }
      )
    }
    const w = wrap.current
    const vp = host.current?.querySelector('.xterm-viewport')
    if (!w || !vp) return
    const next = {
      top: vp.getBoundingClientRect().top - w.getBoundingClientRect().top,
      height: vp.clientHeight
    }
    setTrack((p) => (Math.abs(p.top - next.top) < 0.5 && p.height === next.height ? p : next))
  }

  /**
   * One cell in pixels, measured rather than derived from the font size.
   *
   * xterm rounds a cell to whole device pixels and the host is inset, so a number worked
   * out from `fontSize` is out by a pixel or two per row - which is invisible at the top
   * of a pane and half a line out by the bottom of it. `.xterm-screen` is the element the
   * rows are actually drawn into, so its box divided by the grid is the truth.
   */
  const cellBox = (): ChipBox | null => {
    const t = term.current
    const screen = host.current?.querySelector('.xterm-screen') as HTMLElement | null
    const w = wrap.current
    if (!t || !screen || !w) return null
    const r = screen.getBoundingClientRect()
    if (!r.width || !r.height) return null
    return {
      cellW: r.width / t.cols,
      cellH: r.height / t.rows,
      width: r.width,
      height: r.height,
      viewportY: t.buffer.active.viewportY,
      chipW: CHIP_W,
      chipH: CHIP_H
    }
  }

  /** The pane offset of the screen box, so a chip drawn on the wrap lands on the right cell. */
  const screenOffset = (): { x: number; y: number } => {
    const screen = host.current?.querySelector('.xterm-screen') as HTMLElement | null
    const w = wrap.current
    if (!screen || !w) return { x: 0, y: 0 }
    const a = screen.getBoundingClientRect()
    const b = w.getBoundingClientRect()
    return { x: a.left - b.left, y: a.top - b.top }
  }

  /** Plain text of an absolute buffer row range, trailing blank lines off. */
  const textOf = (from: number, to: number): string => {
    const t = term.current
    if (!t) return ''
    const buf = t.buffer.active
    const out: string[] = []
    for (let i = from; i <= to; i++) {
      const line = buf.getLine(i)
      if (!line) continue
      // `true` keeps a wrapped line joined to the one it wrapped from, which is what makes
      // a copied paragraph paste as a paragraph instead of as terminal-width fragments.
      out.push(line.translateToString(true).replace(/\s+$/, ''))
    }
    while (out.length && !out[out.length - 1]) out.pop()
    while (out.length && !out[0]) out.shift()
    return out.join('\n')
  }

  /**
   * Put the selection chip where the selection is, or take it away.
   *
   * Called from the selection change AND from every scroll: the highlight is anchored to
   * absolute buffer rows and the chip is drawn in pane pixels, so a pane that scrolls
   * under a live selection would otherwise leave the button hovering over an unrelated
   * line. Scrolled out of view entirely, it goes - `chipSpot` clamps into the pane, and a
   * clamped chip pointing at nothing on screen is worse than no chip.
   */
  const refreshSelChip = (): void => {
    const t = term.current
    const box = cellBox()
    if (!t || !box || !t.getSelection()) {
      setSelChip(null)
      return
    }
    const pos = t.getSelectionPosition()
    if (!pos) {
      setSelChip(null)
      return
    }
    // Gone only when the WHOLE highlight is off screen. The chip is anchored to the first
    // line now, so keying the test on that row alone would take the button away from a long
    // selection whose start has scrolled off the top while most of it is still in view.
    const rowsOnScreen = t.rows
    const endRow = pos.end.y - box.viewportY
    const startRow = pos.start.y - box.viewportY
    if (endRow < -1 || startRow > rowsOnScreen) {
      setSelChip(null)
      return
    }
    const spot = chipSpot(pos.start, pos.end, box)
    if (!spot) {
      setSelChip(null)
      return
    }
    const off = screenOffset()
    setSelChip({ left: spot.left + off.x, top: spot.top + off.y })
  }

  const say = (msg: string): void => toast.current?.(msg)

  const putOnClipboard = (text: string, what: string): void => {
    const body = text.trim()
    if (!body) {
      say('Nothing to copy there')
      return
    }
    api.copyText(body)
    // The count is the receipt: "Copied" alone cannot tell a whole reply from one blank
    // line, and a copy that quietly took the wrong range is the failure worth catching.
    const lines = body.split('\n').length
    say(`${what} copied - ${lines} line${lines === 1 ? '' : 's'}`)
  }

  /**
   * The receipt for a copy that has already happened.
   *
   * Same words as `putOnClipboard`, without the write: the keyboard and right-click paths
   * hand the text to the clipboard themselves (they have their own "did anything get
   * copied" rules and their own highlight handling), and all they were missing was the
   * sentence saying it worked.
   */
  const sayCopied = (text: string, what = 'Selection'): void => {
    const body = text.trim()
    // Nothing readable in it - a drag that caught only spaces, or a blank row. It still
    // reached the clipboard (these callers write before they announce), and saying
    // nothing here is the exact silence this whole change exists to remove: the press
    // worked, nothing happened on screen, and there is no way to tell that from a copy
    // that failed. Same sentence `putOnClipboard` uses, so the two paths agree.
    if (!body) {
      say('Nothing to copy there')
      return
    }
    const lines = body.split('\n').length
    say(`${what} copied - ${lines} line${lines === 1 ? '' : 's'}`)
  }

  /**
   * Jump the view to where a prompt was submitted. Going back into history is exactly the
   * gesture that means "stop following the tail" - if the pane kept snapping to the newest
   * line the click would undo itself on the agent's next write.
   */
  const jumpTo = (m: Mark): void => {
    const t = term.current
    if (!t || m.marker.line < 0) return
    // One line of lead-in so the prompt itself is not glued to the top edge.
    t.scrollToLine(Math.max(0, m.marker.line - 1))
    pinned.current = false
    setScrolledUp(true)
    setFlash(m.id)
    window.clearTimeout(flashTimer.current)
    flashTimer.current = window.setTimeout(() => setFlash(-1), 600)
  }

  useEffect(() => () => window.clearTimeout(flashTimer.current), [])

  useEffect(() => {
    if (!host.current) return
    const t = new Terminal({
      // The pty is already this wide (see shared/paneGrid.ts). xterm's own default is
      // 80, and every byte a resumed CLI prints before the first fit is drawn at the
      // PTY's width - into whatever grid this terminal happens to be. Clamped, and no
      // repaint can undo it.
      cols: START_COLS,
      rows: START_ROWS,
      fontFamily: 'Cascadia Mono, Consolas, monospace',
      fontSize,
      // Blinking costs a FULL WebGL frame per pane per blink, forever, even when the
      // pane is idle and nothing on it changed. Measured 2026-08-23 with 6 panes open
      // and no output at all: renderer 42-46% CPU, GPU helper 30-34%, WindowServer 46%,
      // GPU device utilisation 50% - enough to make every other app on the machine
      // judder. A steady block cursor is just as visible and costs nothing.
      cursorBlink: false,
      allowProposedApi: true,
      scrollback: FULL_SCROLLBACK,
      theme: themeRef.current ?? {
        background: '#0c0c10',
        foreground: '#e6e6e6',
        cursor: '#7dd3fc',
        selectionBackground: '#2f5d8a'
      }
    })
    /**
     * Everything an agent writes goes through here first, so that `/clear` stops taking
     * the previous turn with it - `CSI 2 J` plus `CSI 3 J` in the CLIs that still send
     * those, and an erase-per-row in the Claude Code builds that no longer do. See
     * shared/keepScrollback.ts: it is stateful (a sequence is routinely torn across two
     * chunks from the pty), so there is exactly one of it per pane and every write site
     * uses it, and `arm()` below is what tells it a wipe is a clear, not a repaint.
     */
    /** The screen as it stands, one string per row. */
    const screenNow = (): string[] => {
      const b = t.buffer.active
      const out: string[] = []
      for (let y = b.baseY; y < b.baseY + t.rows; y++) {
        out.push(b.getLine(y)?.translateToString(true) ?? '')
      }
      return out
    }
    // The screen as it was when a wipe started, held until the redraw that follows has
    // settled and can be compared with it. See `wipeSettled`.
    let wipeSnap: string[] | null = null
    let wipeTimer: number | undefined
    /**
     * The redraw after a wipe has gone quiet: decide whether it was a repaint or a clear.
     *
     * A repaint puts the same rows back and there is nothing to keep. A clear does not, and
     * the rows it took are still in `wipeSnap` - so they are printed onto a blank screen
     * and scrolled off it, which is the only way to put anything into a terminal's
     * scrollback, and the agent is then asked to redraw the frame that was wiped out from
     * under it. What is kept is the TEXT of those rows: the colours are gone, which is the
     * price of finding out after the fact rather than being told in advance. A clear the
     * pane armed itself never gets here - `arm()` files the screen whole, colours and all,
     * before the CLI has said a word.
     */
    const wipeSettled = (): void => {
      const snap = wipeSnap
      wipeSnap = null
      wipeTimer = undefined
      if (!snap || dead) return
      // What is filed is what the redraw did NOT put back. A repaint hands every row back
      // and this is empty; a clear hands none back and this is the whole screen; a CLI
      // re-rendering its view a line or two further on hands back everything except the
      // lines that fell off the top - which are the ones nothing else would have kept.
      const lost = lostRows(snap, screenNow())
      if (!screenLost(snap, screenNow())) return
      // The bytes are built in the shared file so the test drives the shipped ones against
      // a real terminal rather than a copy of them.
      const bytes = fileRows(lost, t.rows)
      if (!bytes) return
      t.write(bytes)
      paneRepair.get(sessionId)?.()
    }
    /** How long the redraw after a wipe is given to stop before it is judged. */
    const WIPE_SETTLE_MS = 400
    const armWipeCheck = (): void => {
      if (!wipeSnap) return
      window.clearTimeout(wipeTimer)
      wipeTimer = window.setTimeout(wipeSettled, WIPE_SETTLE_MS)
    }
    const keep = keepScrollback(
      () => t.rows,
      () => t.buffer.active.type === 'alternate',
      Date.now,
      // How much of the screen is worth filing. Everything under the last written row is
      // blank, and scrolling those rows only puts a screenful of nothing into the
      // scrollback in front of the turn being kept. The walk itself is in the shared file
      // so the test can drive the shipped one against a real xterm rather than a copy.
      () => keptRows(t),
      // A wipe has started, and nothing in the bytes says whether it is a clear or one of
      // the full repaints this CLI does dozens of times a session. Remember the screen and
      // find out - see `wipeSettled`.
      () => {
        if (wipeSnap) return
        wipeSnap = screenNow()
        armWipeCheck()
      }
    )
    const f = new FitAddon()
    t.loadAddon(f)
    t.open(host.current)
    term.current = t
    fit.current = f

    /**
     * One composer on a touch screen, not two.
     *
     * xterm keeps a hidden textarea to receive keystrokes, and a phone treats it as a text
     * field: tapping the terminal raises the keyboard with its own caret and its own
     * accessory bar, beside the typing bar this app draws at the bottom of the pane. Two
     * places to type into one pane, and only one of them composes a line before sending it
     * - that is "there's 2 chat box for prompt".
     *
     * So on a touch screen the textarea keeps its keydown handling (a paired hardware
     * keyboard still types straight into the pty) and gives up being a text field:
     * `readOnly` and `inputMode: none` are what stop iOS raising the keyboard for it, and
     * it is out of the tab order so nothing lands on it by accident. The bar at the bottom
     * is then the only thing that opens a keyboard, and it still has its Send button.
     *
     * `pointer: coarse` and NOT the handheld width: a narrow desktop window is handheld
     * too and its terminal must stay typeable.
     */
    const coarse = window.matchMedia('(pointer: coarse)')
    const oneComposer = (): void => {
      const ta = t.textarea
      if (!ta) return
      ta.readOnly = coarse.matches
      ta.inputMode = coarse.matches ? 'none' : ''
      ta.tabIndex = coarse.matches ? -1 : 0
    }
    oneComposer()
    coarse.addEventListener('change', oneComposer)

    /**
     * Paths an agent printed become links that reveal the file in Explorer or Finder.
     *
     * The pane is a pty, so there is no markup to hang a link off: the only thing to work
     * with is the characters on the row under the mouse. Matching them is guesswork, so
     * every candidate is checked against the disk before it is offered, and a token that
     * is not really there is simply not a link. That check is what keeps the guessing
     * honest - the matcher can stay cheap and slightly greedy because being wrong is
     * invisible.
     *
     * xterm only asks for links on the row the mouse is over, so this runs on hover and
     * nowhere else. One consequence worth knowing: a path long enough to wrap is only
     * matched on the row it starts on, because a provider is handed one row at a time.
     */
    const KIND_TTL = 15_000
    const kinds = new Map<string, { at: number; target: RevealTarget | null }>()
    const kindOf = async (dir: string, token: string): Promise<RevealTarget | null> => {
      const key = dir + '\u0000' + token
      const hit = kinds.get(key)
      if (hit && Date.now() - hit.at < KIND_TTL) return hit.target
      const target = await api.pathKind(dir, token)
      // Hovering a long output scrolls a lot of rows past; the cap stops a pane that has
      // been open for a day from holding every path it ever drew.
      if (kinds.size > 500) kinds.clear()
      kinds.set(key, { at: Date.now(), target })
      return target
    }
    t.registerLinkProvider({
      provideLinks(row, done) {
        const dir = cwdRef.current
        const line = dir ? t.buffer.active.getLine(row - 1) : null
        if (!line) return done(undefined)
        const tokens = findPathTokens(line.translateToString(true))
        if (!tokens.length) return done(undefined)
        void Promise.all(
          tokens.map(async (tok): Promise<ILink | null> => {
            const target = await kindOf(dir, tok.text)
            if (!target) return null
            return {
              // xterm columns are 1-based and its end is inclusive.
              range: { start: { x: tok.start + 1, y: row }, end: { x: tok.end, y: row } },
              text: tok.text,
              activate: () => api.reveal(target.abs)
            }
          })
        ).then((found) => {
          const links = found.filter((l): l is ILink => l !== null)
          done(links.length ? links : undefined)
        })
      }
    })

    /**
     * Draw the terminal on the GPU instead of as DOM.
     *
     * xterm's default renderer builds a <span> per run of styled text and hands the whole
     * screen to the compositor as DOM on every frame. Measured on this machine with one
     * pane taking ~900 lines a second: 12.7% of a core, 8.8% of it in the GPU process,
     * and the live app - four panes, a maximised window - sat at 94% of a core in the GPU
     * process and 76% in the renderer for as long as it was open. The WebGL renderer
     * uploads a glyph atlas once and draws the screen as textured quads, so the cost stops
     * scaling with how much text is on it.
     *
     * It is loaded after open() because it needs the canvas the terminal just created.
     * If the GPU drops the context - a driver reset, or too many live contexts in one
     * renderer once enough panes are open - the addon is disposed and xterm falls straight
     * back to the DOM renderer for that pane. Slower, still correct, and never a blank
     * pane, which is what a lost context looks like if nothing handles it.
     *
     * The context itself is acquired and released by the visibility effect below rather
     * than here, because a hidden pane holds its atlas just as hard as a visible one and
     * there is nothing on screen to show for it.
     */

    // Loaded after the renderer, because the highlight for every other match is drawn as
    // an xterm decoration and a decoration needs something to be drawn on.
    const sa = new SearchAddon()
    t.loadAddon(sa)
    search.current = sa
    paneSearch.set(sessionId, sa)
    const offResults = sa.onDidChangeResults(({ resultIndex, resultCount }) =>
      setHits({ index: resultIndex, count: resultCount })
    )

    // Debug handle. Given --remote-debugging-port, an agent can read cols/rows, call fit,
    // and check where the viewport sits, instead of guessing at pixel bugs from screenshots.
    // The window loads no remote content, so nothing untrusted can reach it.
    const dbg = window as unknown as { __pf?: Record<string, unknown> }
    // `gl` is on the handle so the renderer can be turned off at runtime and the same
    // pane measured both ways - which is the only way to compare them honestly, since a
    // pane's cost scales with its grid and no two panes have the same one.
    dbg.__pf = {
      ...(dbg.__pf ?? {}),
      [sessionId]: {
        term: t,
        fit: f,
        host: host.current,
        // The full re-render Fix runs (see `redrawHistory`). On the handle because a
        // probe cannot press a button, and repairing torn scrollback is only checkable by
        // reading the buffer back afterwards.
        redraw: () => paneRedraw.get(sessionId)?.(),
        dropWebgl: () => {
          glRef.current?.dispose()
          glRef.current = null
          glLive.delete(sessionId)
        },
        // What a probe needs to check the visibility rule from outside: whether this pane
        // is holding a context right now, and how many are held in total.
        hasWebgl: () => glRef.current !== null,
        webglLive: () => glLive.size,
        // How many times this pane has been re-wrapped by a phone taking the pty's width.
        // On the handle because a test that only checks the buffer afterwards cannot tell
        // "the history survived" from "the path never ran", and the second one is how a
        // regression here would pass unnoticed: the re-wrap only happens when the COLUMNS
        // move, which depends on the desk's window size on the day.
        rewraps: () => rewraps.current,
        // How many times this pane has repaired itself after being restored. A probe that
        // only reads the buffer cannot tell "the frame came back clean" from "the path
        // never ran", and the second is how a regression here would pass unnoticed.
        restoreFixes: () => restoreFixes.current,
        // What the mouse handlers have typed into the pty, newest last. See `clickKeys`.
        clickKeys: () => [...clickKeys.current],
        // What this pane believes is being TYPED right now - the rows of the CLI's own
        // composer, or of a wrapped shell line. On the handle because every symptom of
        // this being wrong looks like something else: a selection that deletes one
        // character reads as a dead key, not as "the pane could not find the composer".
        inputRows: () => inputRowsRef.current?.() ?? null
      },
      // The draft is reconstructed from keystrokes rather than read off the screen, so it
      // is the one thing about a pane that no amount of DOM or buffer inspection can
      // answer. `prompt-view-test.mjs` reads it back after typing through xterm's own
      // input path, which is the only honest way to check the reconstruction in a real
      // window.
      draft: (id: string) => paneDraft.get(id) ?? null,
      // The prompt rail's own list, for the same reason: a tag that is missing is either
      // a mark that was never made or a mark the rail declined to draw, and the DOM
      // cannot tell those apart.
      marks: (id: string) =>
        (paneMarks.get(id) ?? []).map((m) => ({ line: m.marker.line, text: m.text }))
    }

    // Only a deliberate gesture stops this pane following the tail - a wheel notch upward,
    // or letting go of a scrollbar drag above the last line. Typing resumes it, which is
    // what xterm's own scrollOnUserInput already implies.
    //
    // The slack matters. xterm grows its scroll area on the next render, so during a live
    // turn the bottom you drag the thumb to is one or two lines short of the bottom that
    // exists by the time you let go - land there and the pane silently stops following, and
    // reaching the real last line means waiting for the view to settle and dragging again.
    // Anything inside two lines of the tail counts as "meant the bottom" and snaps to it.
    const TAIL_SLACK = 2
    const distanceFromTail = (): number => t.buffer.active.baseY - t.buffer.active.viewportY
    const atBottom = (): boolean => distanceFromTail() <= 0
    const nearBottom = (): boolean => distanceFromTail() <= TAIL_SLACK

    // xterm's own scrolling element. Its scrollTop is the only reading that is correct
    // *during* the event that moved it - the buffer's viewportY catches up a frame later.
    const viewport = (): HTMLElement | null =>
      (t.element?.querySelector('.xterm-viewport') as HTMLElement | null) ?? null
    /**
     * Rendered height of one row, in px, straight off the thing being scrolled.
     *
     * Measured against the *visible* box, not the scroll area. `scrollHeight / bufferLength`
     * is the same number once a frame has been painted and a wildly different one in the
     * window that matters: xterm grows its scroll area on the next animation frame, so in
     * the write callback at the end of a turn the buffer had already jumped to 1901 lines
     * while scrollHeight still read 6095px - 3.2px a row instead of 15.19px. A wheel notch
     * asking "how many rows is 100px" got 31 rows instead of 6, which is the whole of
     * "scroll up once after a turn and it flies halfway up the run". `clientHeight / rows`
     * is the same 15.19px before, during and after that burst, because neither term of it
     * moves when the buffer grows. Measured both ways across a 1500-line write: the old one
     * read 3.2 / 3.2 / 15.2 / 15.2 across the burst, this one 15.19 at every point.
     */
    const rowHeight = (): number => {
      const vp = viewport()
      const h = vp && t.rows ? vp.clientHeight / t.rows : 0
      return h > 1 ? h : 17
    }
    // Single place that decides "is this pane following, and does the pill show". Used
    // wherever a gesture has *ended*, so it may snap the remaining line or two.
    const settleFollow = (): void => {
      const follow = nearBottom()
      pinned.current = follow
      if (follow && !atBottom()) t.scrollToBottom()
      setScrolledUp(!follow)
    }
    /**
     * Prompt markers. xterm only ever sees keystrokes - there is no "here is the line you
     * submitted" event - so the prompt has to be rebuilt from the bytes on their way to the
     * pty. What it buys is a table of contents down the edge of the pane: every prompt of
     * this run, at the height in the buffer where it was sent, hoverable and clickable.
     *
     * The list is owned by this plain array, not by React state. Markers are disposed from
     * two directions (the cap here, and xterm trimming scrollback), and doing that from
     * inside a state updater would be a side effect in a function React is free to re-run.
     */
    const MARK_CAP = 80
    const list: Mark[] = []
    paneMarks.set(sessionId, list)
    let pending: DraftState = newDraft()
    let dead = false
    const publish = (): void => {
      if (!dead) setMarks(list.slice())
    }

    /**
     * How many rows above the cursor this pane's prompt box starts, or 0 if there is no
     * box to find.
     *
     * The cursor at submit time is not where the prompt is. In a boxed TUI it is on the
     * last row of what was typed, so a one-line prompt puts it one row under the box's top
     * rule and a long one puts it several - measured in a live Claude pane at 80 columns, a
     * 32-character prompt left the cursor 1 row below the rule, a 532-character one 5 rows
     * and an 1134-character one 6. Anchoring the mark at the cursor therefore landed the
     * jump *below* the prompt by an amount that grew with the prompt, which is exactly the
     * "it does not quite get there, and the longer the prompt the further out it is" the
     * rail was reported for.
     *
     * Found rather than estimated: the box's own top rule is still on screen at submit time
     * - the CLI has not redrawn yet - so counting rows up to it is exact and costs nothing,
     * where working the height out from the text length would have to guess the box's
     * padding, its borders and how the CLI wrapped it. A pane with no box at all, like a
     * shell, finds nothing and keeps the old anchor, which is already right there.
     */
    const PROMPT_BOX_SCAN = 40
    const promptBoxTop = (maxUp: number): number => {
      const b = t.buffer.active
      const rows: string[] = []
      for (let up = 0; up <= Math.min(PROMPT_BOX_SCAN, maxUp); up++) {
        const y = b.cursorY - up
        if (y < 0) break
        const line = b.getLine(b.baseY + y)
        if (!line) break
        rows.push(line.translateToString(true))
      }
      // The rule itself is `shared/promptBox.ts` so it can be checked against real panes'
      // rows with no window - which is what caught Codex drawing no rule at all.
      return promptTop(rows)
    }

    /**
     * The terminal, as much of it as re-anchoring a tag needs. See shared/markAnchor.ts:
     * a marker dying is not always a line being forgotten - xterm disposes every marker on
     * a row that `CSI J` blanks, which is how Codex repaints, and it cost that pane a
     * quarter to a half of its prompt tags.
     */
    const markerHost: MarkerHost = {
      cursor: () => t.buffer.active.baseY + t.buffer.active.cursorY,
      length: () => t.buffer.active.length,
      register: (offset) => t.registerMarker(offset),
      defer: (fn) => queueMicrotask(fn)
    }

    const anchor = (entry: Mark, marker: IMarker): void =>
      anchorMark(markerHost, entry, marker, {
        alive: () => !dead && list.indexOf(entry) >= 0,
        drop: () => {
          const at = list.indexOf(entry)
          if (at < 0) return
          list.splice(at, 1)
          publish()
        },
        changed: publish
      })

    /**
     * Rebuild the rail for a pane that came back from disk.
     *
     * The tags are made from keystrokes, so a REPLAYED conversation has none - and since
     * the app restarts itself for every update, that is most panes on this desk most of
     * the time. The CLI's own echo of each submitted prompt is still in the bytes that were
     * replayed, so it is read back out (shared/promptEcho.ts) and a marker registered on
     * the line it was found on.
     *
     * Only when the rail is empty: a pane that has been typed into owns its own tags, and
     * this must never add a second tag for a prompt that already has one. `at` is 0 because
     * the time it was sent is genuinely not known here - `markLabel` prints the text alone
     * rather than inventing a clock reading.
     */
    const seedMarks = (): void => {
      if (list.length) return
      const b = t.buffer.active
      const cursor = b.baseY + b.cursorY
      const rows: string[] = []
      for (let i = 0; i < cursor; i++) rows.push(b.getLine(i)?.translateToString(true) ?? '')
      // One tag per prompt, on the copy that is still in the right place - see
      // `seedPrompts`. Row by row this gave three tags for one ask and a tag on a line of
      // test output, because a replayed screen holds every repaint of the prompt block.
      const found = seedPrompts(rows)
      // Same cap as the live rail, and the same end of the list: past this many the tags
      // are a solid bar, and the newest are the ones being looked for.
      for (const f of found.slice(-MARK_CAP)) {
        const marker = t.registerMarker(f.line - cursor)
        if (!marker) continue
        const entry: Mark = {
          id: marker.id,
          marker,
          line: marker.line,
          text: flatDraft(f.text, RAIL_LABEL_CHARS),
          full: f.text,
          at: 0
        }
        anchor(entry, marker)
        list.push(entry)
      }
      if (list.length) {
        publish()
        syncTotal()
      }
    }

    const addMark = (text: string, full: string): void => {
      // A prompt cannot have been sent above one that was sent before it, so the scan for
      // the box top is not allowed to walk past the last prompt's line.
      //
      // Without that bound it does: the CLI paints over its own box between turns, the
      // rule the previous prompt anchored to stops matching, and the scan carries on up to
      // whatever older tool box is still on screen - up to forty rows above the prompt
      // being sent. Measured on a probe run, that put the newer of two tags 21px HIGHER on
      // an 851px rail than the tag for the prompt sent before it, which is the "the older
      // one is below the newer one" the rail was reported for.
      const b = t.buffer.active
      const prev = list.length ? list[list.length - 1].marker.line : -1
      const room = prev < 0 ? PROMPT_BOX_SCAN : Math.max(0, b.baseY + b.cursorY - prev - 1)
      // Anchored to the top of the prompt box as it stands at submit time. xterm keeps a
      // marker's line right as the buffer scrolls and tells us when that line falls out of
      // scrollback, neither of which a plain line number could do.
      const marker = t.registerMarker(-promptBoxTop(room))
      if (!marker) return
      const entry: Mark = { id: marker.id, marker, line: marker.line, text, full, at: Date.now() }
      anchor(entry, marker)
      list.push(entry)
      // Past this many the tags are a solid bar and stop being aimable, so the oldest go.
      while (list.length > MARK_CAP) list.shift()?.marker.dispose()
      publish()
      syncTotal()
    }

    // One reconstruction, in `shared/draft.ts`, rather than the copy that used to live
    // here. The rail wants a short flattened label and the improver wants the whole thing,
    // so both read one state and take what they need from it.
    const feedInput = (d: string): void => {
      const r = feedDraft(pending, d)
      pending = r.state
      publishDraft(sessionId, r.state)
      for (const line of r.submitted) {
        // `/clear` and friends are the one moment the screen is meant to be thrown away
        // rather than repainted, and this is the only place that knows it: Claude Code
        // v2.1.233 clears by drawing its banner straight over the last turn, with no erase
        // of any kind to notice. So the screen is scrolled into the scrollback HERE, ahead
        // of the CLI's first byte - see keepScrollback. `mayClearScreen` rather than
        // `clearsScreen`, because what was typed is not what was sent: `/cle` plus Enter
        // runs the `/clear` the CLI's own menu had highlighted.
        if (mayClearScreen(line)) {
          const away = keep.arm()
          if (away) t.write(away)
        }
        const text = flatDraft(line, RAIL_LABEL_CHARS)
        // A bare Enter is a confirmation or an accepted menu item, and a lone character is
        // a menu key. Tagging either would bury the real prompts.
        if (text.length > 1) addMark(text, line)
        // The archive is fed here, on the way to the pty, which is why it works the same
        // for every agent: this sees what was typed, not what any particular CLI does with
        // it. `line` rather than `text` - the flattened version is a rail label, and
        // matching wants the words that were actually sent. Anything too short to be an ask
        // is dropped on the other side (MIN_PROMPT_TOKENS), not here.
        // `id` so History can say what this session was working on - the same keystrokes,
        // one more consumer, and the only feed that reads the same for every agent.
        if (text.length > 1) api.promptUsed(line, { cwd: cwdRef.current, id: sessionId })
      }
    }

    // The rail's scale changes as output arrives and as the view moves, but a write only
    // ever shifts a tag by a pixel or two - a setState per burst is not worth that.
    let lastTotal = 0
    let tailSync: number | undefined
    const bumpTotal = (): void => {
      if (!list.length) return
      const now = Date.now()
      if (now - lastTotal < 250) {
        // The dropped call still has to happen. Without this the LAST write of a burst and
        // the LAST notch of a scroll are the two that never land, so the copy icons keep
        // whatever geometry the second-to-last event left them with - which is the position
        // of a row that has since moved, or off the pane entirely.
        window.clearTimeout(tailSync)
        tailSync = window.setTimeout(() => {
          lastTotal = Date.now()
          syncTotal()
        }, 260)
        return
      }
      window.clearTimeout(tailSync)
      lastTotal = now
      syncTotal()
    }

    // The view's real position is the single source of truth for following, so a drag, a
    // wheel notch, a keyboard scroll and a write all end up judged the same way. No snap
    // here: this fires *during* a drag, and yanking the view out from under the mouse is
    // worse than a stale pill for one frame.
    // Where each tag is, one frame behind. `anchor` needs it because xterm blanks a
    // marker's line before it says the marker is going, and eighty numbers a frame is
    // nothing next to the repaint that fires this.
    t.onRender(() => {
      for (const m of list) if (m.marker.line >= 0) m.line = m.marker.line
    })

    t.onScroll(() => {
      const follow = nearBottom()
      pinned.current = follow
      setScrolledUp(!follow)
      bumpTotal()
      // The chip is drawn in pane pixels and the highlight lives on absolute buffer rows,
      // so a scroll moves one and not the other. See refreshSelChip.
      refreshSelChip()
    })

    t.onData((d) => {
      pinned.current = true
      setScrolledUp(false)
      feedInput(d)
      api.write(sessionId, d)
      // Synchronised typing. Only the pane being typed IN fans out, so two panes in the
      // group can never echo each other round in a loop.
      if (syncedPanes.has(sessionId))
        for (const id of syncedPanes) {
          if (id === sessionId) continue
          api.write(id, d)
          paneFeed.get(id)?.(d)
        }
    })

    t.onSelectionChange(() => {
      const s = t.getSelection()
      if (s) lastSelection.current = s
      // The chip follows the highlight itself, not the mouse: a selection made from the
      // keyboard (copy mode, Mod+A) gets the same button a drag does.
      refreshSelChip()
    })

    // A CLI ringing the bell is the only way it has of asking for a person directly,
    // and the app has been eating it: xterm draws nothing and makes no sound for one.
    // It is reported from HERE rather than from the byte stream in main because 0x07
    // is also the terminator of an OSC sequence - every window title a shell sets
    // contains one - and this is the thing that already parses them apart.
    t.onBell(() => api.paneBell(sessionId))

    // The last text this pane put on the clipboard from a *remembered* selection. Copying
    // a phantom selection twice would mean Ctrl+C never interrupts, so it happens once.
    const copied = { current: '' }

    /**
     * Copy what is highlighted, and SAY SO.
     *
     * The clipboard gives no feedback of its own, so a copy that went nowhere and a copy
     * that worked look identical - which is "I press copy and nothing tells me it copied".
     * Every copy a PERSON asked for therefore reports in the window's toast, with the line
     * count as the receipt (the same rule `putOnClipboard` already followed for the turn
     * icons and the selection chip). `announce` is false for exactly one caller: copy on
     * select, which nobody pressed - toasting on every drag of the mouse is noise, and the
     * highlight is its own feedback there.
     */
    const copySelection = (keepHighlight = false, announce = true): boolean => {
      // A visible highlight always wins: Ctrl+C copies it and drops it, so the very next
      // Ctrl+C is an interrupt again. One extra keypress, never a lost prompt.
      const live = t.getSelection()
      if (live) {
        api.copyText(live)
        if (announce) sayCopied(live)
        if (!keepHighlight) t.clearSelection()
        lastSelection.current = ''
        copied.current = live
        return true
      }
      const sel = lastSelection.current
      if (!sel || sel === copied.current) return false
      api.copyText(sel)
      if (announce) sayCopied(sel)
      copied.current = sel
      lastSelection.current = ''
      return true
    }

    const pasteClipboard = (): void => {
      api.readClipboard().then((text) => {
        if (text) {
          t.paste(text)
          return
        }
        // No text usually means an image, and an agent that reads the clipboard itself
        // should be handed the PICTURE - the same thing a drop gives it, which is what
        // makes Cmd+V and a drag land identically. Typing the path of a file it then has
        // to be asked to open is the answer for every OTHER CLI, which sees nothing at all
        // from a ^V, and for a MIRRORED pane, whose agent reads the far desk's clipboard
        // and not this one.
        if (pastesClipboardImage(agentRef.current) && !sessionId.startsWith('@')) {
          api.write(sessionId, RAW_PASTE)
          return
        }
        // It is saved as a file on the machine that owns this pty and the PATH is typed.
        void api.attachClipboardImage(sessionId).then((res) => {
          if (res.paths.length) {
            typePaths(res.paths)
            return
          }
          // A refusal that is about the clipboard being empty is not a refusal: let the
          // key through so an agent that reads it for itself still gets its chance.
          if (res.error && res.error !== NO_IMAGE) {
            toast.current?.(res.error)
            return
          }
          api.write(sessionId, RAW_PASTE)
        })
      })
    }

    t.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || e.altKey) return true
      // Copy mode owns the keyboard while it is on: `j` is a motion, not a keystroke for
      // the agent. Returning false is what stops xterm writing it to the pty - the same
      // door the app's own Ctrl chords use below.
      if (copyKeyRef.current(e)) {
        e.preventDefault()
        return false
      }
      // A highlight you can see and cannot delete is the ordinary state of every terminal,
      // and it was Robert's "can't select all and then delete". Backspace clears it;
      // typing over it replaces it, which is what the selection in every other text field
      // on the machine does. Both refuse quietly when the selection is not on the line the
      // far end is still editing - the highlight is left alone and the key does what it
      // always did. Behind the same setting as click-to-place-cursor: it is the same trick,
      // an intention this window can see turned into keys the pty understands.
      if (
        clickCursorRef.current &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        t.hasSelection() &&
        (e.key === 'Backspace' || e.key === 'Delete' || e.key.length === 1)
      ) {
        const outcome = deleteSelectionRef.current()
        if (outcome === 'done') {
          if (e.key.length !== 1) {
            e.preventDefault()
            return false
          }
          // The character itself still goes through, landing where the selection was.
          return true
        }
        if (outcome === 'refused') {
          // Eligible and not doable: do NOTHING rather than eat one character out of the
          // middle of the highlight. See `deleteSelection`.
          e.preventDefault()
          return false
        }
      }

      const mod = isMac ? e.metaKey : e.ctrlKey
      if (!mod) return true
      const key = e.key.toLowerCase()

      // Select everything typed so far. It hands the key back when there is nothing it can
      // honestly select, which on Windows is what keeps Ctrl+A working as a line editor's
      // own "beginning of line" in a plain shell.
      if (key === 'a' && !e.shiftKey) {
        if (!clickCursorRef.current || !selectInputRef.current()) return true
        e.preventDefault()
        return false
      }

      if (key === 'c') {
        // Cmd+C and Ctrl+Shift+C are copy-only. A bare Ctrl+C copies when there is
        // a pending selection and otherwise stays the agent's interrupt, so nothing
        // can silently swallow SIGINT.
        const copied = copySelection()
        if (!copied && !e.shiftKey && !isMac) return true
        e.preventDefault()
        return false
      }

      if (key === 'v') {
        // Handled here rather than by Chromium: preventDefault stops the native
        // paste so the text cannot be inserted twice.
        e.preventDefault()
        pasteClipboard()
        return false
      }

      return true
    })

    // Typing invalidates a stale selection, so Ctrl+C goes back to interrupting.
    const onKeyClearsSelection = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.altKey || e.metaKey) return
      lastSelection.current = ''
      copied.current = ''
    }
    const onMouseDown = (e: MouseEvent): void => {
      if (e.button === 2) return
      lastSelection.current = ''
      copied.current = ''
    }

    const el = host.current

    /**
     * Claude Code and Codex turn mouse reporting on, and xterm then hands the mouse to
     * them wholesale: a drag selects nothing, so there is nothing to copy, and the wheel
     * is forwarded to the agent instead of scrolling this terminal - which is how a pane
     * ends up stuck a few lines up with no way back down.
     *
     * xterm already has the escape hatch: holding Shift forces a selection and stops the
     * event reaching the app. It is just hidden behind a modifier nobody knows about.
     * Marking the event as shifted before xterm's own handlers see it makes a plain drag
     * behave like every other terminal, and turning the setting off gives the agent its
     * mouse back.
     */
    const mouseGrabbed = (): boolean => t.element?.classList.contains('enable-mouse-events') ?? false

    /**
     * Alt/Option-click puts the cursor where you clicked.
     *
     * A prompt box is drawn text and the pty takes keystrokes, so a click cannot place a
     * caret - it can only be turned into the arrow keys that would have got there. That
     * is what every terminal offering this does, and it is why it is behind a modifier:
     * in a plain shell an up-arrow is the previous command, not a movement, so this may
     * never be what a bare click does. `cursorMove.ts` refuses a click more than a few
     * rows away for the same reason.
     *
     * It runs in the capture phase and swallows the event, otherwise a CLI with mouse
     * reporting on also receives the click and acts on it.
     */
    const placeCursor = (e: MouseEvent): void => {
      if (!clickCursorRef.current) return
      // An arrow is a menu step while a chooser is up - see `askRef`.
      if (askRef.current) return
      if (e.button !== 0 || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
      // The alternate screen is vim, less, a menu - things where an arrow is navigation
      // and there is no line being edited to move along.
      if (t.buffer.active.type === 'alternate') return
      const screen = el.querySelector('.xterm-screen') as HTMLElement | null
      if (!screen) return
      const r = screen.getBoundingClientRect()
      if (!r.width || !r.height) return
      const at = cellAt(e.clientX, e.clientY, r, t.cols, t.rows)
      const b = t.buffer.active
      const keys = keysForClick({
        cursorRow: b.baseY + b.cursorY,
        cursorCol: b.cursorX,
        clickRow: b.viewportY + at.row,
        clickCol: at.col
      })
      e.preventDefault()
      e.stopPropagation()
      // preventDefault on mousedown costs the focus the click would have given it.
      t.focus()
      if (keys) sendKeys(keys)
    }

    /**
     * Swallow a click ON ITS WAY TO THE AGENT, and only then.
     *
     * A highlight that appeared with no button held down, and then followed the pointer
     * around the pane, was this: the click-to-move handlers below run in the CAPTURE phase
     * on the pane's host element and used to call `stopPropagation` unconditionally.
     * xterm's selection service registers its `mousemove` and `mouseup` on the DOCUMENT
     * when a mousedown starts a selection (`_addMouseDownListeners`) and takes them off
     * again in its `mouseup` listener - which is a bubble-phase listener on the document,
     * so a capture-phase `stopPropagation` up here means it never runs. The mousemove
     * listener then stays attached for the life of the pane, and every later mouse
     * MOVEMENT extends the selection xterm still believes is being dragged.
     *
     * The stop is there to keep a CLI with mouse reporting on from acting on the same
     * click, and that is the one case where it costs nothing: with mouse reporting on,
     * xterm has disabled its own selection (`Terminal.ts`, on protocol change), so
     * `handleMouseDown` returned before registering anything and there is nothing to
     * leak. In a pane that is NOT grabbing the mouse there is no agent to protect the
     * click from and xterm's own bookkeeping is the only thing listening, so it is left
     * alone. `preventDefault` still stops the browser's own drag-select either way.
     */
    const stopForAgent = (e: MouseEvent): void => {
      if (mouseGrabbed()) e.stopPropagation()
    }

    /**
     * A bare click puts the cursor where you clicked, as long as it stays on the line
     * being typed.
     *
     * The modifier above is the honest answer for a click anywhere on the screen; it is
     * the wrong answer for the thing people actually do, which is click into the middle of
     * a prompt they have half typed. So a plain click is allowed the safe half of the same
     * move: `keysAlongLine` emits left and right and NOTHING else, and this only runs when
     * the click landed on the cursor's own logical line - its row, or a row the same input
     * wrapped onto. An arrow that could recall a previous command is never reachable from
     * here, so there is nothing to be careful about and no modifier to know.
     *
     * On mouseup, and only when the pointer did not travel: a mousedown that swallowed the
     * click would take drag-selection with it, and copy-on-select is the more important of
     * the two. A drag ends with a selection and leaves this alone.
     */
    let downAt: { x: number; y: number } | null = null
    const markDown = (e: MouseEvent): void => {
      downAt = e.button === 0 && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey
        ? { x: e.clientX, y: e.clientY }
        : null
    }

    /** Whether two absolute buffer rows are the same line to the editor at the far end. */
    const sameLine = (a: number, b: number): boolean => {
      if (a === b) return true
      const [lo, hi] = a < b ? [a, b] : [b, a]
      // A wrapped row says so about ITSELF, so walking up from the lower row and requiring
      // every step to be a continuation is what proves the two are one input.
      for (let r = hi; r > lo; r--) if (!t.buffer.active.getLine(r)?.isWrapped) return false
      return true
    }

    /** What is drawn on an absolute buffer row, trailing blanks off. */
    const rowText = (r: number): string => t.buffer.active.getLine(r)?.translateToString(true) ?? ''

    /** Never past what is written, and never into the input box's own frame. */
    const clampCol = (row: number, col: number): number => {
      const text = rowText(row)
      return Math.min(Math.max(col, inputStart(text)), inputEnd(text))
    }

    /**
     * The whole of what is being typed, as absolute buffer coordinates - the cursor's row
     * plus every row the same input wrapped onto, from past the prompt marker to the last
     * character written.
     */
    /**
     * Where a row's own text begins.
     *
     * `inputStart` hunts for a prompt marker, which is right on the row a CLI drew its
     * prompt on and wrong on every row after it: ordinary prose holds `$ ` and `# ` and
     * `> ` all the time, and moving the start forward there selects fewer characters than
     * were highlighted. Under-selecting is the failure that leaves text behind, which is
     * the bug this is all for. A framed row keeps the hunt - the frame bounds it.
     */
    const contentStart = (text: string, first: boolean): number => {
      if (first || frameAt(text) >= 0) return inputStart(text)
      return leadingBlanks(text)
    }

    /**
     * What is being typed, row by row: the composer the CLI draws when there is one, and
     * otherwise the cursor's row plus whatever xterm wrapped it onto.
     *
     * Both are the same shape to everything downstream - a list of screen spans plus
     * whether each one fills its width - so one piece of arithmetic (`offsetIn`) answers
     * for a shell, for a framed box, and for Claude Code's frameless composer alike.
     */
    const inputRows = (): { top: number; rows: InputRow[] } | null => {
      const b = t.buffer.active
      if (b.type === 'alternate') return null
      const cursorRow = b.baseY + b.cursorY
      const comp = composerAt(rowText, cursorRow)
      if (comp) {
        const rows: InputRow[] = []
        for (let r = comp.top; r <= comp.bottom; r++) {
          const text = rowText(r)
          const start = contentStart(text, r === comp.top)
          const end = Math.max(start, inputEnd(text))
          // Within a column of the far edge counts as FULL, deliberately: a boundary
          // counted as a separator that was not one deletes a character nobody
          // highlighted, and one counted the other way only leaves a character behind.
          rows.push({ start, end, full: end >= comp.width - start - 1 })
        }
        return { top: comp.top, rows }
      }
      let top = cursorRow
      while (top > 0 && b.getLine(top)?.isWrapped) top--
      let bottom = cursorRow
      while (b.getLine(bottom + 1)?.isWrapped) bottom++
      const rows: InputRow[] = []
      for (let r = top; r <= bottom; r++) {
        const text = rowText(r)
        // An xterm wrap is a row that ran out of columns, so it holds no character of its
        // own and every row of one is full by definition.
        rows.push({
          start: r === top ? inputStart(text) : 0,
          end: r === bottom ? inputEnd(text) : t.cols,
          full: true
        })
      }
      return { top, rows }
    }

    /** The last row of what `inputRows` returned, in absolute buffer rows. */
    const spanBottom = (span: { top: number; rows: InputRow[] }): number =>
      span.top + span.rows.length - 1

    const inputSpan = (): { row: number; col: number; end: number; length: number } | null => {
      const span = inputRows()
      if (!span) return null
      const first = span.rows[0]
      const last = span.rows[span.rows.length - 1]
      // Cells, not characters: `t.select` counts across the screen by columns.
      const length = (spanBottom(span) - span.top) * t.cols + (last.end - first.start)
      return length > 0 ? { row: span.top, col: first.start, end: last.end, length } : null
    }

    /**
     * Highlight everything typed so far, so the next Backspace clears it.
     *
     * Returns false - and lets the key through to the agent - whenever there is nothing it
     * can honestly select. On Windows that matters: Ctrl+A is a line editor's own
     * "beginning of line", and swallowing it in a plain shell would be taking a key away
     * to do nothing with it.
     */
    const selectInput = (): boolean => {
      const span = inputSpan()
      if (!span) return false
      t.select(span.col, span.row, span.length)
      return t.hasSelection()
    }

    /**
     * Delete the highlighted text by walking to it and backspacing over it.
     *
     * A selection lives in this window and the far end has never heard of it, which is why
     * no terminal lets you delete one. The arithmetic and every refusal are in
     * `cursorMove.ts`; this half is only about which selections are eligible - all of it
     * inside the one input the far end is editing, which `inputRows` names.
     *
     * Three answers, not two, and the third is the whole point. `no` means the selection is
     * somewhere this cannot act on - scrollback, an alternate screen, another line - and the
     * key must go to the pty untouched. `refused` means the selection IS in the input being
     * edited and the keys still could not be built; there the key must be SWALLOWED, because
     * handing a bare Backspace to the pty in that state removes exactly one character out of
     * a highlighted block and leaves the highlight up. That is what "it doesn't delete fully"
     * was: a refusal reported as ineligibility - and, for two releases, a whole CLI whose
     * composer rows are neither framed nor wrapped, so every multi-row selection took that
     * path.
     */
    const deleteSelection = (): 'done' | 'refused' | 'no' => {
      const pos = t.getSelectionPosition()
      if (!pos || t.buffer.active.type === 'alternate') return 'no'
      // A run of backspaces into a chooser is the same mistake as a run of arrows, and
      // there is no line being edited to delete from anyway - see `askRef`.
      if (askRef.current) return 'no'
      const b = t.buffer.active
      const cursorRow = b.baseY + b.cursorY
      const span = inputRows()
      if (!span) return 'no'
      const bottom = spanBottom(span)
      const inside = (r: number): boolean => r >= span.top && r <= bottom
      if (!inside(cursorRow) || !inside(pos.start.y) || !inside(pos.end.y)) return 'no'
      const keys = keysForRows({
        rows: span.rows,
        cursor: { row: cursorRow - span.top, col: b.cursorX },
        start: { row: pos.start.y - span.top, col: pos.start.x },
        end: { row: pos.end.y - span.top, col: pos.end.x }
      })
      if (!keys) return 'refused'
      sendKeys(keys)
      t.clearSelection()
      lastSelection.current = ''
      return 'done'
    }
    inputRowsRef.current = inputRows
    selectInputRef.current = selectInput
    deleteSelectionRef.current = deleteSelection

    const moveAlongLine = (e: MouseEvent): void => {
      const from = downAt
      downAt = null
      if (!clickCursorRef.current || !from) return
      // An arrow is a menu step while a chooser is up - see `askRef`. Proven by
      // `test:askclick`, whose red case types six right arrows into a live question.
      if (askRef.current) return
      if (Math.abs(e.clientX - from.x) > 3 || Math.abs(e.clientY - from.y) > 3) return
      if (t.getSelection()) return
      if (t.buffer.active.type === 'alternate') return
      const screen = el.querySelector('.xterm-screen') as HTMLElement | null
      if (!screen) return
      const r = screen.getBoundingClientRect()
      if (!r.width || !r.height) return
      const at = cellAt(e.clientX, e.clientY, r, t.cols, t.rows)
      const b = t.buffer.active
      const cursorRow = b.baseY + b.cursorY
      const clickRow = b.viewportY + at.row
      // A composer the CLI draws itself is ONE text field spread over several rows, and the
      // two numbers that matter are offsets into that field: where the far end's cursor is
      // in it, and where the click landed. That covers a framed box and Claude Code's
      // frameless one alike, and it replaces the vertical arrows the box branch used to
      // send - a second line of a draft is a hard newline, worth exactly one left arrow,
      // which is safer than an up arrow the CLI may read as its own history.
      const span = inputRows()
      if (span) {
        const bottom = spanBottom(span)
        const held = (r: number): boolean => r >= span.top && r <= bottom
        if (held(cursorRow) && held(clickRow)) {
          const keys = keysToPoint(
            span.rows,
            { row: cursorRow - span.top, col: b.cursorX },
            { row: clickRow - span.top, col: at.col }
          )
          if (!keys) return
          e.preventDefault()
          stopForAgent(e)
          sendKeys(keys)
          return
        }
      }
      if (!sameLine(cursorRow, clickRow)) return
      // Past the end of what is written is the end of what is written. Without this, a
      // click in the empty half of the row sends a burst of rights that the editor eats one
      // by one for nothing - and on a CLI that reads an arrow as a menu step, does worse.
      const written = b.getLine(clickRow)?.translateToString(true).length ?? 0
      const keys = keysAlongLine({
        cursorCol: b.cursorX,
        clickCol: Math.min(at.col, written),
        rows: clickRow - cursorRow,
        cols: t.cols
      })
      if (!keys) return
      e.preventDefault()
      stopForAgent(e)
      sendKeys(keys)
    }

    const forceSelectable = (e: MouseEvent): void => {
      if (!mouseSelectRef.current || !mouseGrabbed()) return
      if (e.button !== 0 || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return
      try {
        // An own property shadows the prototype getter, so xterm - which sees this event
        // after this capture-phase listener - reads it as a Shift-drag.
        Object.defineProperty(e, 'shiftKey', { value: true, configurable: true })
      } catch {
        /* a synthetic event that will not take the override */
      }
    }

    // Wheel up is the one gesture that means "stop following"; wheeling back down to the
    // last line resumes it. Nothing a write does can flip either way.
    const onWheel = (e: WheelEvent): void => {
      // vim, less and anything else on the alternate screen has no scrollback here, so the
      // wheel belongs to the app. Everywhere else this scrolls the terminal itself.
      //
      // Every pane, not only the ones grabbing the mouse. The browser scrolls the viewport
      // by pixels against a scroll area that is one frame stale, so while a turn is printing
      // the bottom the browser will let you reach is a frame's worth of new lines short of
      // the real last line - wheel down as much as you like and the tail stays out of reach,
      // which is why the pill was the only way back. `scrollLines` is clamped against the
      // buffer instead, which is current, so the tail is always reachable.
      //
      // This does NOT depend on the mouse-select setting. That setting is about drag
      // selection; tying the wheel to it meant that with it off, a wheel anywhere over the
      // text went to the agent and only the strip of pixels over the scrollbar scrolled the
      // pane - the whole middle and left of a pane read as "scrolling is stuck".
      if (t.buffer.active.type !== 'alternate') {
        e.preventDefault()
        e.stopPropagation()
        // A notch has to cover the same ground here as it does in a pane the browser is
        // scrolling itself, and a fixed 40px per line was not close. Measured at this
        // pane's 15.2px rows: 2 lines a notch against the ~7 a native notch of the same
        // deltaY moves. Every agent pane grabs the mouse, so that was every AI session -
        // and while one is printing, 2 lines down against a line of new output per notch
        // means the tail is not reachable by wheel at all, only by the pill.
        //
        // deltaMode says what the number is counted in, and all three have to be handled:
        // a page-scroll mouse reports 2, and dividing a page count by a row height gave
        // 0.06 rows a notch - the `||` fallback then moved a single line per notch.
        const lines =
          e.deltaMode === 1 ? e.deltaY : e.deltaMode === 2 ? e.deltaY * t.rows : e.deltaY / rowHeight()
        t.scrollLines(Math.trunc(lines) || (e.deltaY < 0 ? -1 : 1))
        // Downward, a notch that lands within a line or two of the tail meant the tail. It
        // is the same slack a scrollbar drag gets, and it is what makes "keep wheeling down"
        // end on the newest line rather than just beside it.
        if (e.deltaY > 0 && nearBottom()) {
          if (!atBottom()) t.scrollToBottom()
          pinned.current = true
          setScrolledUp(false)
          return
        }
      }
      // Only the immediate read - the wheel fires before the viewport moves, and onScroll
      // settles the final answer once it has. Wheeling down is left to onScroll, which
      // snaps nothing but does pick the follow back up at the tail.
      if (e.deltaY < 0) {
        pinned.current = false
        setScrolledUp(true)
      }
    }
    const onMouseUp = (): void => {
      // Covers a scrollbar drag and a selection drag alike: wherever the view ended up is
      // now the intent - and a drag that got within a line or two of the tail meant the
      // tail, so it snaps the rest of the way instead of stopping just short.
      settleFollow()
      if (!copyOnSelectRef.current) return
      const sel = t.getSelection()
      if (sel.trim().length < 2) return
      // Keep the highlight: it is the only feedback that the copy happened, and a
      // following Ctrl+C should still copy rather than interrupt. Silent on purpose -
      // nobody pressed anything, so a toast per mouse drag would be noise.
      copySelection(true, false)
    }
    // Right-click: copy when something is selected, paste when nothing is.
    const onContextMenu = (e: MouseEvent): void => {
      e.preventDefault()
      const sel = t.getSelection()
      if (sel) {
        api.copyText(sel)
        // `sel.split('n')` here counted the letter n, so a one-line copy of a word
        // containing an n reported several lines. One counter, one place.
        sayCopied(sel)
        return
      }
      if (!copySelection()) pasteClipboard()
    }
    /**
     * xterm only emits onScroll when *it* moved the view, so in a pane that is not printing
     * a wheel notch or a thumb drag changed nothing anyone was listening to: measured 118
     * lines up from the tail with the pill still hidden and the pane still marked as
     * following, until the next write happened to re-ask the question. The element's own
     * scroll event is the missing half.
     *
     * What it must NOT do is answer from `scrollTop`. That reading is not where the pane
     * is - it is where xterm last got round to putting the scrollbar, and xterm syncs the
     * element to the buffer lazily and out of order. Measured on a live pane with the
     * terminal handed the scroll directly, no wheel handler involved: `scrollLines(-100)`
     * moved the buffer 100 rows off the tail and left scrollTop reading the bottom, still
     * reading the bottom 300ms later; two `scrollLines(+20)` moved the buffer again with
     * scrollTop frozen; the next scroll in the other direction finally moved it 1216px at
     * once. Through a wheel gesture, the buffer tracked every notch exactly (19 rows a
     * notch, 2818 -> 2837 -> ... -> 2932) while scrollTop sat unchanged for seven notches.
     *
     * So the answers this handler was giving were arbitrary. The bad half is the one that
     * reads "at the bottom" while the buffer is a hundred rows up: this pane is then marked
     * as following, the pill is hidden, and the next line the agent prints yanks the view to
     * the tail out from under somebody who is reading. The other half strands a pane that is
     * at the tail with the pill showing and the follow dropped, which is the "I scrolled up
     * and now I cannot get back down to the prompt" it was reported as.
     *
     * The buffer is always right, and one frame later it is right about a thumb drag too -
     * the browser moves scrollTop, xterm turns that into a buffer scroll in its own handler,
     * and a frame is after both of them. So: same question as everywhere else, asked of the
     * buffer, one frame late.
     */
    const vpEl = viewport()
    let scrollFrame = 0
    const onViewportScroll = (): void => {
      cancelAnimationFrame(scrollFrame)
      scrollFrame = requestAnimationFrame(() => {
        const follow = nearBottom()
        pinned.current = follow
        setScrolledUp(!follow)
      })
    }
    vpEl?.addEventListener('scroll', onViewportScroll, { passive: true })

    el.addEventListener('keydown', onKeyClearsSelection, true)
    el.addEventListener('mousedown', placeCursor, true)
    el.addEventListener('mousedown', markDown, true)
    el.addEventListener('mousedown', forceSelectable, true)
    el.addEventListener('mousedown', onMouseDown, true)
    el.addEventListener('mouseup', moveAlongLine, true)
    el.addEventListener('mouseup', onMouseUp)
    el.addEventListener('wheel', onWheel, { capture: true, passive: false })
    el.addEventListener('contextmenu', onContextMenu)

    // Whether this pane has ever had anything to read. A pane that has printed nothing
    // cannot be showing a busy footer, and scanning its empty rows on every tick is pure
    // main-thread cost with a guaranteed answer.
    let sawOutput = false

    // Settle rather than fire: the agent is resuming and painting its own banner over the
    // replay, and a repair made mid-paint is undone by the next frame.
    let fixTimer: number | undefined
    const armRestoreFix = (): void => {
      if (!needRestoreFix.current) return
      window.clearTimeout(fixTimer)
      fixTimer = window.setTimeout(runRestoreFix, RESTORE_FIX_MS)
    }

    // Replay whatever the pty printed before this pane existed (new pane on an
    // existing session, or a remount).
    api.getBuffer(sessionId).then((b) => {
      if (!b) return
      sawOutput = true
      // There is history on this pane, so it was drawn somewhere else first. See
      // `needRestoreFix`.
      needRestoreFix.current = true
      armRestoreFix()
      const done = (): void => {
        // Land on the newest line, not wherever 20k replayed lines happen to leave the view.
        t.scrollToBottom()
        // Held until here rather than dropped before the write: a staged replay resizes
        // the terminal twice, and the dim "Starting…" line is what covers that.
        setBlank(false)
        // The replay IS the conversation this pane is being reopened into, so its
        // prompts get their tags back. See seedMarks.
        seedMarks()
      }
      // Its real shape before a byte lands. xterm opens at 80x24 and the fit otherwise
      // arrives a frame or two later, which is the first half of "after the update
      // restart it looks broken".
      reshape(t, f)
      // The second half, and the one no repaint can undo: the restored part of this
      // buffer was painted in absolute column moves at the OLD pane's width, and a
      // terminal clamps a column it cannot reach. See `shared/replayWidth.ts`.
      const split = splitReplay(b, replayColsRef.current, t.cols)
      if (!split) {
        t.write(keep(b), done)
        return
      }
      const back = t.cols
      replaying.current = true
      t.resize(Math.max(20, split.cols), t.rows)
      // In the write CALLBACK, never after the call: xterm parses what it is given on its
      // own schedule, so a resize issued straight after `write` can land before the bytes
      // it is meant to be wider than.
      t.write(keep(split.before), () => {
        t.resize(back, t.rows)
        replaying.current = false
        // ...and a fit, because a resize that arrived while `replaying` was set was
        // refused, and because a pane put back by hand is only right until the next one.
        reshape(t, f)
        if (split.after) t.write(keep(split.after), done)
        else done()
      })
    })

    /**
     * Whether the agent's own footer still says it is running. The main process cannot
     * see the rendered frame, and without this a long silent tool call looks exactly like
     * a finished turn - which is what made the chime fire in the middle of an answer.
     *
     * Driven by output rather than by a timer: a minimized window has its timers throttled
     * to about once a minute, and a minimized window is precisely when the chime matters.
     * Output arrives over IPC, which is not throttled, so the check runs right after the
     * frame that would decide it.
     */
    let busy = false
    let lastBusyCheck = 0
    // When the main process last heard anything about this pane's busy state.
    let lastReport = 0
    // First tick that read "not running" while we were reporting busy. See below.
    let offSince = 0
    // First tick that read a counter-only `true` while we were reporting idle.
    let onSince = 0
    // The last question this pane reported, arrow position included. See checkBusy.
    let lastAsk = ''
    let settle2: number | undefined
    /** How long a `false` must hold before it is believed. See the grace below. */
    const BUSY_SETTLE_MS = 1200
    /** How far past the grace the re-check is armed, so it cannot land a tick short. */
    const BUSY_SETTLE_STEP_MS = 350
    const checkBusy = (): void => {
      if (!sawOutput) return
      // A mirror never judges this. The machine the agent runs on is reading the same
      // frame in its own window, a few frames ahead of this one, and a second opinion
      // arriving late could only ever contradict it - which is the chime firing
      // mid-turn, the one bug this whole mechanism exists to avoid.
      if (mirrorRef.current) return
      const at = Date.now()
      lastBusyCheck = at
      let now = false
      let reason: BusyReason | null = null
      let text = ''
      try {
        text = screenText(t, BUSY_ROWS)
        // A question on screen is not work in progress, whatever the footer says - that
        // rule and the footers themselves live in shared/busy.ts, against real frames.
        reason = busyReason(text)
        now = reason !== null
      } catch {
        return
      }
      // What the pane just read, where a probe can see it. This bug - a CLI renaming its
      // working line, so no pane ever reported busy again - is invisible from outside:
      // "no footer" is a legal reading, so nothing throws and nothing logs. One line here
      // turns "why did the clock stop" into `node scripts/probe.mjs "window.__paneBusy"`.
      const w = window as unknown as { __paneBusy?: Record<string, unknown> }
      // Keyed by pane: every pane on screen writes here several times a second, and a
      // single slot would only ever show whichever one wrote last.
      ;(w.__paneBusy ??= {})[sessionId] = {
        at,
        reads: now,
        reported: busy,
        grid: `${t.cols}x${t.rows}`,
        buffer: `${t.buffer.active.type} base=${t.buffer.active.baseY} len=${t.buffer.active.length}`,
        rows: text
          .split('\n')
          .filter((l) => l.trim())
          .slice(-4)
      }
      // The main process treats a `false` as the turn boundary and greys the dot at once,
      // so one confirming tick first: a heavy repaint can push the footer out of the
      // frame for a single read, and that must not blink the pane to "waiting for you"
      // in the middle of a turn. A `true` is still reported immediately.
      // A `true` whose only evidence is a duration in a `·` group - no spinner, no
      // "esc to interrupt" - is the weakest reading there is, and it is the one that
      // outlives the turn: the CLI's finished line still carries the number. Taken at
      // face value it does not merely keep the pane green, it RE-ANCHORS the run clock
      // to that stale number (`anchoredStart`), so a pane that had just gone quiet
      // started a phantom turn already 7m57s old and counted on from there. So it is
      // confirmed exactly the way a `false` is: one more tick reading the same thing.
      if (now && !busy && reason === 'counter') {
        if (!onSince) onSince = at
        if (at - onSince < BUSY_SETTLE_MS) {
          window.clearTimeout(settle2)
          settle2 = window.setTimeout(checkBusy, BUSY_SETTLE_MS - (at - onSince) + BUSY_SETTLE_STEP_MS)
          return
        }
      } else onSince = 0
      if (!now && busy) {
        if (!offSince) offSince = at
        if (at - offSince < BUSY_SETTLE_MS) {
          // ...and the confirming tick has to be ARMED, because every other check in
          // here is driven by output and a finished turn prints nothing more. The
          // after-the-burst timer fires at 900ms, which is inside this 1200ms grace, so
          // it deferred a second time and nothing ever asked again: the last thing main
          // heard about the pane was `true`, its run clock kept counting, and the card
          // said Running for the rest of the day. Measured 2026-08-26 on this desk -
          // `attention-audit.log` has PaneForge at quietMs 1507149 with
          // busyOnScreen:true over the frame `✻ Baked for 7m 57s · done 3:08 PM`.
          window.clearTimeout(settle2)
          settle2 = window.setTimeout(checkBusy, BUSY_SETTLE_MS - (at - offSince) + BUSY_SETTLE_STEP_MS)
          return
        }
      }
      offSince = 0
      // Still busy and quiet about it for a while. Reporting only on change was enough
      // until a turn outlived the deadline the main process sets from a `true`, at which
      // point the pane went grey and got announced as waiting for you while the agent was
      // visibly still working - a long tool call is exactly when nothing changes. Saying
      // it again costs one IPC message every couple of minutes.
      //
      // A `false` needs no repeat: that clears the deadline outright.
      // How long the agent itself says this turn has been going. That number, not the
      // app's guess at when the turn started, is what the sidebar's clock is anchored
      // to - so it is worth re-sending far more often than the "still busy" heartbeat:
      // a turn boundary the app read wrong is only corrected on the next one of these.
      const clock = now ? readsElapsedMs(text, true) : null
      const restate = clock ? 15_000 : BUSY_RESTATE
      // A question's own frame, wide enough to hold the whole chooser. Only while the
      // pane is idle - a chooser and a running agent are never on screen together, and
      // this is the one place a wider translate would be paid for every tick of a turn.
      const wide = now ? '' : screenText(t, ASK_ROWS)
      // The SELECTION is part of the signature, not only the question. Answering walks
      // the arrow from where it is now, so a person who arrowed at the desk while a
      // phone was looking at the same pane would otherwise have the phone's button pick
      // the wrong row - silently, and only ever by the distance they moved it.
      const sig = wide ? askSignature(wide) : ''
      if (now === busy && sig === lastAsk && !(now && at - lastReport > restate)) return
      busy = now
      lastAsk = sig
      lastReport = at
      // The frame goes with a `false` only: that is the reading that can ring the bell,
      // and it is the one worth being able to read back afterwards. It is the wide one,
      // so the main process can read a question out of it for the phone and the bot.
      api.setBusy(sessionId, now, now ? undefined : wide, clock ?? undefined, reason ?? undefined)
    }

    /**
     * The link to the other device came back and it re-sent the whole scrollback.
     * Everything already on screen is a prefix of what just arrived, so the pane is
     * wiped and redrawn from it - appending would show the run twice.
     *
     * This is also how a mirror gets its screen in the FIRST place: attaching asks the
     * far end for the pane, which answers with one `buffer` frame, and that arrives here
     * as a reset. So it is the only moment a mirrored pane's prompts can get their rail
     * tags - the disk replay at the top of this effect never runs for one, and everything
     * after this is ordinary streamed output with no prompt echoes in it. That is why the
     * rail was empty on every mirrored pane: nothing here called `seedMarks`.
     */
    const offReset = api.onPaneReset((id) => {
      if (id !== sessionId) return
      t.reset()
      // Every tag was anchored into the buffer that reset just threw away, and the tail
      // about to arrive carries those same prompts for `seedMarks` to read back out.
      // Dropping them is also what LETS it run: it refuses on a rail that is not empty.
      for (const m of list.splice(0)) m.marker.dispose()
      publish()
      void api.getBuffer(sessionId).then((b) => {
        if (dead) return
        sawOutput = Boolean(b)
        if (b) setBlank(false)
        pinned.current = true
        t.write(keep(b), () => {
          t.scrollToBottom()
          seedMarks()
        })
      })
    })

    const off = api.onData((id, data) => {
      if (id !== sessionId) return
      if (!sawOutput) setBlank(false)
      sawOutput = true
      // The resume prints for a second or two after the replay. Repair once it stops.
      armRestoreFix()
      // Once per burst while output is flowing, and once more after it stops: the frame
      // that decides "finished or still working" is the last one drawn.
      if (Date.now() - lastBusyCheck > 600) checkBusy()
      window.clearTimeout(settle2)
      settle2 = window.setTimeout(checkBusy, 900)
      // Follow the tail unless the user deliberately went looking at scrollback. xterm's own
      // rule is "follow only while the viewport sits exactly on the last line", and a wheel
      // notch, a reflow or a resize is enough to leave it a line short - from then on every
      // line lands in scrollback the scrollbar already believes it has reached, the turn
      // looks finished, and only a keypress brings it back (scrollOnUserInput doing what the
      // write should have). Intent cannot drift, so this recovers by itself.
      t.write(keep(data), () => {
        // A wipe is judged once its redraw stops, not on a fixed delay: a banner drawn in
        // three bursts must not be compared with the screen half way through it.
        armWipeCheck()
        if (pinned.current) t.scrollToBottom()
        // Same callback so the rail is measured against a buffer that has already grown,
        // rather than one write behind it.
        bumpTotal()
      })
    })

    /**
     * Full repair of a pane that drew itself wrong: measure again, tell the pty the true
     * size, make the agent repaint its whole frame, then repaint our side and land on the
     * newest line. Everything a manual restart used to be needed for, without losing the run.
     */
    const repair = (): void => {
      try {
        pinned.current = true
        reshape(t, f)
        // Worth doing on a mirror too: the redraw is asked of the far agent, and a
        // torn frame there is exactly what you cannot fix from the other machine.
        api.redraw(sessionId)
        t.refresh(0, t.rows - 1)
        t.scrollToBottom()
        setScrolledUp(false)
      } catch {
        /* hidden or detached - the visibility effect refits it */
      }
    }
    /**
     * Draw this pane's whole byte stream again, at a width no narrower than any width it
     * was painted at.
     *
     * `repair` above asks the CLI to repaint, which redraws the SCREEN. It cannot touch
     * the scrollback, and the scrollback is where mis-widthed drawing ends up: bytes made
     * at one width and clamped into a narrower grid are word-on-word for good, whatever
     * the pane is resized to afterwards. The bytes themselves are still correct - the
     * buffer in main is the raw stream, not this rendering of it - so writing them into a
     * terminal that is wide enough repairs it. See shared/paneGrid.ts for how a pane got
     * into that state at all, which is now fixed at the source; this is the way back for
     * a pane that is already in it.
     *
     * Widest of what we know, never a guess: the pane now, the width a restored tail was
     * painted at, and the grid every pty starts on. A byte drawn at column N is safe in
     * any terminal at least N wide, and the terminal is put back afterwards - xterm
     * re-wraps what is in its buffer, so nothing is lost to the second resize.
     *
     * User-initiated only. It reads the capped buffer, so scrollback older than that cap
     * does not come back, and paying that to un-break a pane is a person's call.
     */
    const redrawHistory = async (): Promise<boolean> => {
      if (mirrorRef.current) return false
      const b = await api.getBuffer(sessionId)
      if (!b) return false
      const back = t.cols
      const wide = Math.max(back, replayColsRef.current ?? 0, START_COLS)
      try {
        replaying.current = true
        t.reset()
        if (wide !== back) t.resize(wide, t.rows)
        await new Promise<void>((res) => t.write(keep(b), () => res()))
        if (wide !== back) t.resize(back, t.rows)
      } finally {
        replaying.current = false
      }
      reshape(t, f)
      t.scrollToBottom()
      setScrolledUp(false)
      seedMarks()
      return true
    }
    paneRedraw.set(sessionId, redrawHistory)
    paneRepair.set(sessionId, repair)
    paneArmClear.set(sessionId, () => {
      const away = keep.arm()
      if (away) t.write(away)
    })
    paneFeed.set(sessionId, feedInput)
    paneTerms.set(sessionId, t)
    paneFocus.set(sessionId, () => {
      try {
        t.focus()
      } catch {
        /* detached mid-teardown - the next active-pane effect focuses it */
      }
    })
    paneFind.set(sessionId, () => {
      setFinding(true)
      // Ctrl+F pressed while the bar is already open means "let me type a new term",
      // so the text is selected rather than the caret left where it was. The wait is the
      // input being mounted by the render this state change causes - and it is a timeout
      // rather than requestAnimationFrame because rAF does not run in a window Windows
      // considers hidden or occluded, which is the same trap the active-pane focus effect
      // documents. Measured: against a minimized window the caret never arrived at all.
      window.setTimeout(() => {
        findInput.current?.focus()
        findInput.current?.select()
      }, 0)
    })
    /**
     * Keyboard copy mode. Everything about WHERE the cursor goes is in
     * `shared/copyMode.ts`; this is the half that only a terminal can do - read the
     * buffer, draw the selection, keep the cursor on screen.
     */
    const lineAt = (row: number): string =>
      t.buffer.active.getLine(row)?.translateToString(true) ?? ''

    /**
     * The last line with anything on it - NOT the last line the buffer has.
     *
     * A terminal's buffer is always a whole number of screens, so an idle pane's buffer
     * ends in as many blank rows as the agent has not filled yet. Measured in a real
     * window: a pane two lines into its life reported `length` 70, so `G` - "the end" -
     * put the cursor 68 rows below the last thing anyone had printed, in blank space,
     * where `$` selects nothing and a yank comes back empty. The scan is bounded by the
     * number of trailing blank rows, which is at most one screen.
     */
    const contentEnd = (): number => {
      const b = t.buffer.active
      let row = b.length - 1
      while (row > 0 && !lineAt(row).trim()) row--
      return row
    }

    const copyCtx = (): CopyCtx => ({
      cols: t.cols,
      lastRow: contentEnd(),
      viewRows: t.rows,
      lineText: lineAt
    })

    const drawCopy = (): void => {
      const s = copy.current
      if (!s) return
      const ctx = copyCtx()
      const to = scrollFor(s, t.buffer.active.viewportY, t.rows)
      if (to !== null) t.scrollToLine(to)
      const sel = selectionOf(s, ctx)
      // A one-cell selection IS the cursor here: with the WebGL renderer there is no DOM
      // to put a caret in, and xterm's own cursor belongs to the shell, not to us.
      t.select(sel.col, sel.row, sel.length)
      setCopySel(Boolean(s.anchor))
    }

    const leaveCopy = (): void => {
      copy.current = null
      setCopyOn(false)
      setCopySel(false)
      t.clearSelection()
      t.focus()
    }

    const enterCopy = (): void => {
      if (copy.current) return leaveCopy()
      const b = t.buffer.active
      // Start where the agent's own cursor is, which is what the person was reading.
      copy.current = startState(b.baseY + b.cursorY, b.cursorX)
      setCopyOn(true)
      t.focus()
      drawCopy()
    }

    /** Returns true when the key was consumed by copy mode. */
    const copyKey = (e: KeyboardEvent): boolean => {
      const s = copy.current
      if (!s) return false
      // Nothing with a modifier except the two half-page chords: the app's own shortcuts
      // (Ctrl+K, Ctrl+Tab, the pane keys) have to keep working with the mode on, or the
      // only way out of a mode nobody meant to enter is the mouse.
      if (e.altKey || e.metaKey) return false
      if (e.ctrlKey && e.key !== 'd' && e.key !== 'u') return false
      const { state, action } = applyKey(s, e.key, e.ctrlKey, copyCtx())
      copy.current = state
      if (action === 'yank') {
        const text = t.getSelection()
        if (text) {
          api.copyText(text)
          sayCopied(text)
        }
        leaveCopy()
        return true
      }
      if (action === 'exit') {
        leaveCopy()
        return true
      }
      if (action === 'find') {
        // One keyboard owner per pane. The find bar takes the keys the moment it opens,
        // so staying in copy mode would mean two things reading the same keystrokes.
        leaveCopy()
        paneFind.get(sessionId)?.()
        return true
      }
      drawCopy()
      return true
    }

    copyKeyRef.current = copyKey
    paneCopyMode.set(sessionId, enterCopy)

    paneInsert.set(sessionId, (text) => {
      // Dictation lands in a pane that may have been scrolled up while it was being
      // transcribed; the point of inserting is to see it, so this follows the tail again.
      pinned.current = true
      setScrolledUp(false)
      t.paste(text)
      t.scrollToBottom()
      t.focus()
    })

    // A hidden pane has zero size; fitting it would resize the pty to 1x1 and wrap
    // the agent's output permanently, so resizes only run while the pane is shown.
    const mountedAt = Date.now()
    let settle: number | undefined
    const ro = new ResizeObserver(() => {
      if (!host.current?.offsetParent) return
      let changed = false
      const wasCols = t.cols
      try {
        changed = reshape(t, f)
        // The rail is measured against the scrollbar, so it has to be re-measured with it.
        // Unconditional: a pane coming back on screen has the same rows but not necessarily
        // the same track geometry, and measuring costs nothing.
        syncTotal()
      } catch {
        /* element detached mid-measure */
      }
      // Showing a pane again fires this observer (0x0 while hidden, real size once shown)
      // at a size the terminal already has. That is not a resize and must not queue a
      // repaint - the repaint is the flash the user sees on every session switch.
      if (!changed) return
      // A phone that opened this pane just bent the pty from the desk's width to its own,
      // and everything on screen was drawn at the OLD one. The CLI hard-wrapped those
      // lines itself - its box drawing, its input frame, its paragraphs are all 157
      // characters wide - so re-wrapping them at 50 is not history, it is soup. That is
      // "I open a pane and it is all messed up and I have to clear it", and this is the
      // clear, minus the agent losing its conversation.
      //
      // Deliberately outside the guards below: `autoFixUi` is about not poking a CLI
      // mid-paint, and the mount grace is about a welcome screen, while this is about a
      // frame that is already unreadable - and a phone's first tap usually lands inside
      // that grace. Only when the COLUMNS moved: the keyboard opening takes rows away and
      // nothing re-wraps, so doing this there would move the screen while you were typing.
      //
      // SCROLLED away, never cleared. `t.clear()` was here and it is why a pane opened on
      // a phone showed nothing at all: the buffer it drops is the one `getBuffer` had just
      // replayed into this browser a beat earlier, so the conversation was seeded and then
      // deleted 400ms later, every time, leaving an empty pane and whatever the redraw
      // printed back. The mis-wrapped frame is still not worth reading, but it is worth
      // KEEPING - a phone is where you go to catch up on what an agent said. So it is
      // pushed above the viewport with a screenful of newlines, which is what puts lines
      // into the scrollback rather than taking them out of it (the same move
      // shared/keepScrollback.ts makes for an agent's own /clear), and the redraw paints
      // the live frame underneath it at the phone's width.
      const rewrapped = t.cols !== wasCols
      if (isPhoneClient() && rewrapped) {
        rewraps.current++
        window.setTimeout(() => {
          if (!host.current?.offsetParent) return
          try {
            t.write('\n'.repeat(t.rows), () => t.scrollToBottom())
          } catch {
            /* detached */
          }
          api.redraw(sessionId)
        }, 400)
      }
      // A resize is where panes get garbled: the agent redraws against a size it half
      // missed and leaves torn boxes behind. Once the dragging stops, make it draw the
      // whole frame again. Held off for the first seconds so a CLI still painting its
      // welcome screen is not poked mid-paint.
      window.clearTimeout(settle)
      settle = window.setTimeout(() => {
        if (!autoFixRef.current || Date.now() - mountedAt < 3000) return
        if (!host.current?.offsetParent) return
        // A mirror changing shape means the far end resized, and the far end has
        // already asked its own agent to repaint. Asking again from here would poke
        // a CLI mid-paint over the network for no reason.
        if (mirrorRef.current) return
        api.redraw(sessionId)
        try {
          t.refresh(0, t.rows - 1)
        } catch {
          /* detached */
        }
      }, 400)
    })
    ro.observe(host.current)

    // Whether the agent's own footer still says it is running. The main process cannot see
    // the rendered frame, and without this a long silent tool call looks exactly like a
    // finished turn - which is what made the chime fire in the middle of an answer.
    // Backstop for anything the output path missed - a repaint xterm made on its own,
    // or a pane that mounted onto an already-quiet session. It is also the only thing
    // running during a long silent tool call, which makes it what carries the periodic
    // "still busy" re-state to the main process. Slowing it down would let a long turn
    // time out and announce itself as finished.
    const busyTick = window.setInterval(checkBusy, 4000)
    checkBusy()

    return () => {
      off()
      offReset()
      coarse.removeEventListener('change', oneComposer)
      ro.disconnect()
      window.clearTimeout(settle)
      window.clearTimeout(settle2)
      window.clearTimeout(fixTimer)
      window.clearTimeout(grantTimer.current)
      window.clearInterval(busyTick)
      paneRepair.delete(sessionId)
      paneRedraw.delete(sessionId)
      paneArmClear.delete(sessionId)
      paneFeed.delete(sessionId)
      paneMarks.delete(sessionId)
      paneCopyMode.delete(sessionId)
      copy.current = null
      // A closed pane cannot be typed into, and leaving its id in the group would send
      // every keystroke to a session that is gone.
      syncedPanes.delete(sessionId)
      paneTerms.delete(sessionId)
      paneInsert.delete(sessionId)
      paneFocus.delete(sessionId)
      paneFind.delete(sessionId)
      paneSearch.delete(sessionId)
      offResults.dispose()
      search.current = null
      el.removeEventListener('keydown', onKeyClearsSelection, true)
      el.removeEventListener('mousedown', placeCursor, true)
      el.removeEventListener('mousedown', markDown, true)
      el.removeEventListener('mousedown', forceSelectable, true)
      el.removeEventListener('mousedown', onMouseDown, true)
      el.removeEventListener('mouseup', moveAlongLine, true)
      el.removeEventListener('mouseup', onMouseUp)
      el.removeEventListener('wheel', onWheel, true)
      vpEl?.removeEventListener('scroll', onViewportScroll)
      cancelAnimationFrame(scrollFrame)
      el.removeEventListener('contextmenu', onContextMenu)
      // Emptied first so the onDispose handlers find nothing to remove and skip publishing
      // into a component that is on its way out.
      dead = true
      window.clearTimeout(tailSync)
      for (const m of list.splice(0)) m.marker.dispose()
      // Before dispose(), so the seat is free for whichever pane asks for it next -
      // t.dispose() takes the addon with it, but only this line gives up the budget.
      glRef.current = null
      glLive.delete(sessionId)
      t.dispose()
    }
  }, [sessionId])

  /**
   * Hold a GPU context only while the pane is on screen.
   *
   * Every session's pane stays mounted - hiding one is a CSS class, not an unmount - so
   * without this a pane you last looked at yesterday keeps its WebGL context and glyph
   * atlas alive for as long as the session does. That is invisible in the renderer's own
   * memory and shows up in the GPU helper process instead, which is why it went unnoticed:
   * seven sessions here held 1.57 GB of GPU memory between them, and at most one or two of
   * those panes were being looked at.
   *
   * Dropping the addon puts that pane back on xterm's DOM renderer, which is slower per
   * frame and does not matter at all for something `display: none` is not painting. It
   * picks the context back up when the pane is shown again; that path is the same one the
   * context-loss handler has always used, so it is not a new way for a pane to be drawn.
   */
  useEffect(() => {
    const t = term.current
    if (!t) return
    if (!visible) {
      glRef.current?.dispose()
      glRef.current = null
      glLive.delete(sessionId)
      return
    }
    if (glRef.current) return
    // Over budget the pane simply stays on the DOM renderer. Refusing here is better than
    // letting Chromium hit its own cap, because Chromium answers by evicting some OTHER
    // pane's context - and that pane is one somebody may well be watching.
    if (glLive.size >= GL_BUDGET) return
    try {
      const gl = new WebglAddon()
      gl.onContextLoss(() => {
        gl.dispose()
        if (glRef.current === gl) glRef.current = null
        glLive.delete(sessionId)
      })
      t.loadAddon(gl)
      glRef.current = gl
      glLive.add(sessionId)
    } catch {
      /* no WebGL on this box - the DOM renderer is already what is drawing */
      glRef.current = null
    }
  }, [visible, sessionId])

  /**
   * Recolour without rebuilding.
   *
   * Assigning `options.theme` repaints the canvas and keeps the buffer, so dragging the
   * accent slider recolours a pane with a running agent in it and loses no scrollback.
   * The guard matters more than it looks: this runs on every render, and handing xterm a
   * fresh object with identical strings still makes it clear and redraw the whole screen.
   */
  useEffect(() => {
    const t = term.current
    if (!t || !termTheme) return
    const now = t.options.theme
    if (now && now.background === termTheme.background && now.cursor === termTheme.cursor) return
    t.options.theme = termTheme
  }, [termTheme])

  // Font size is a live setting: change it and every pane re-lays out immediately.
  useEffect(() => {
    const t = term.current
    if (!t) return
    // A mirror owns its own font size - it is derived from the host's grid, not set -
    // so the setting is only the ceiling it may not exceed. reshape() applies that.
    // Same for a pane whose size a phone is holding: the font is derived from that grid
    // while the borrow lasts, and goes back to the setting when the phone lets go.
    const derived = Boolean(mirror) || Boolean(grid && !isPhoneClient())
    // The font not needing to move is NOT a reason to skip the refit when the pane has
    // just stopped being drawn at somebody else's grid. `mirrorFit` shrinks the font to
    // fit that grid, and the number it lands on is regularly the setting itself - a 50
    // column grid in a wide pane at 12pt asks for 12pt - so the early return below fired
    // on release and the terminal was left at 50x49 while the window (and, once the
    // borrow is given back, the pty) is 157x57. Every line then wraps a third of the way
    // across with nothing left to notice: the resize observer watches pixels, and no
    // pixel moved. So a release always reshapes.
    const released = wasDerived.current && !derived
    wasDerived.current = derived
    if (!derived && !released && t.options.fontSize === fontSize) return
    if (!derived) t.options.fontSize = fontSize
    try {
      if (fit.current) reshape(t, fit.current)
      // Fewer or more rows means a different scale for the rail.
      syncTotal()
    } catch {
      /* hidden pane - the visibility effect will refit it */
    }
    // mirror is in the list so a device reconnecting at a different size reshapes
    // the pane instead of leaving it drawn at the grid it had before the drop.
  }, [fontSize, sessionId, mirror?.cols, mirror?.rows, grid?.cols, grid?.rows])

  // Re-fit when this pane becomes visible again: the terminal was not measurable
  // while hidden, so its cols/rows can be stale.
  //
  // It retries rather than firing once. A single rAF is a bet that this frame will be
  // laid out, and it is lost whenever the window is occluded or minimised at the moment
  // the pane comes back - rAF does not run there at all, and the callback that finally
  // arrives can still measure a 0x0 host. Nothing then refits the pane for the rest of
  // its life, because every other refit path is also keyed on something CHANGING: the
  // observer needs a new box, the font effect needs a new font. Measured on a live pane
  // stuck at 120x30 in a window whose own grid was 104x37 - the CLI drew 30 rows and the
  // bottom fifth of the pane was dead space, and only toggling the grid moved it.
  useEffect(() => {
    if (!visible) return
    let raf = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let left = 12
    const attempt = (): void => {
      raf = requestAnimationFrame(() => {
        let laidOut = false
        try {
          const t = term.current
          const f = fit.current
          if (t && f) {
            const d = f.proposeDimensions()
            laidOut = Boolean(d && d.cols > 0 && d.rows > 0)
            if (laidOut) {
              // Same rule as the observer: only a pane that really changed shape while it
              // was away gets to disturb the pty. Coming back unchanged must be silent.
              reshape(t, f)
              // The buffer kept growing while this pane was hidden, so the rail is stale.
              syncTotal()
              // A restored pane that was hidden until now could not be measured, so its
              // repair was left pending rather than spent on a 0x0 host.
              runRestoreFix()
            }
          }
        } catch {
          /* not laid out yet */
        }
        if (!laidOut && --left > 0) timer = setTimeout(attempt, 250)
      })
    }
    attempt()
    return () => {
      cancelAnimationFrame(raf)
      if (timer) clearTimeout(timer)
    }
  }, [visible, sessionId])

  /**
   * The caret follows the pane you chose - and nothing else moves it.
   *
   * This used to hang off `visible`, which is true for every pane at once in a grid: each
   * pane grabbed the keyboard as it mounted, so starting a session somewhere else took the
   * keys out from under whatever you were typing, and switching panes with Ctrl+2 moved
   * the highlight while the keys kept going to the old pane. Keyed on `active` instead,
   * the two can no longer disagree - in a grid or out of one.
   */
  useEffect(() => {
    if (!visible || !active) return
    // Called straight out of the effect, not from requestAnimationFrame. Focus needs no
    // layout, and rAF does not run in a window Windows considers hidden or occluded - so
    // the pane you switched to with Ctrl+2 got the highlight and not the keyboard, exactly
    // as often as the app happened not to be painting. Measured: Ctrl+2 failed while
    // Ctrl+Tab passed in the same run, which is what a frame-dependent focus looks like.
    try {
      term.current?.focus()
    } catch {
      /* not laid out yet - the next visible/active change focuses it */
    }
  }, [visible, active, sessionId])

  /**
   * Fetch bytes from a URI (http(s) or data:), then build an AttachIn object.
   * For http(s) URIs, uses window.fetch. For data: URIs, decodes the base64 directly.
   * Returns null if fetch fails or URI is invalid.
   */
  const fetchURI = async (uri: string): Promise<AttachIn | null> => {
    try {
      if (uri.startsWith('data:')) {
        // data:image/png;base64,iVBORw0KG... or data:image/png;base64,<hex>
        const match = uri.match(/^data:([^;]+);base64,(.+)$/)
        if (!match) return null
        const [, mime, data] = match
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
        const ext = mime.split('/')[1] || 'bin'
        return { name: `clipboard.${ext}`, data: base64(bytes) }
      } else if (uri.startsWith('http://') || uri.startsWith('https://')) {
        const response = await fetch(uri, { mode: 'cors' })
        if (!response.ok) return null
        const blob = await response.blob()
        const bytes = new Uint8Array(await blob.arrayBuffer())
        if (!bytes.length) return null
        // Extract filename from URL or use a generic name
        const pathname = new URL(uri).pathname
        const filename = pathname.split('/').pop() || 'download'
        return { name: filename, data: base64(bytes) }
      }
      return null
    } catch {
      return null
    }
  }

  /**
   * Dropping files types their paths at the prompt. Getting a screenshot or a PDF in front
   * of an agent otherwise means finding the folder by hand and typing the path; here it is
   * drag, drop, Enter. Nothing is sent for you - the paths land in the input box so they
   * can be described first.
   *
   * Browser drags that only carry text/uri-list (no File objects) are fetched and attached
   * the same way as real files.
   */
  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    setDropping(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length) {
      // An image dropped on an agent that reads the clipboard goes in as the PICTURE, not
      // as a filename it has to go and open. That is the whole point of dropping a
      // screenshot on Claude Code, and typing `/Users/.../Screenshot 2026-08-18.png` at
      // the prompt was a path the agent had to be asked to read before it could see
      // anything. Falls through to the path for every other CLI, which sees nothing at
      // all from a ^V.
      if (pasteImagesInstead(files.map((f) => ({ name: f.name, type: f.type })))) {
        void pasteImages(files.map((file) => ({ file }))).catch(() => void sendFiles(files))
        return
      }
      const paths = files.map((file) => api.pathForFile(file)).filter(Boolean)
      // A path is only true on one machine. This pane's is this one when the id is a plain
      // one, so the file is already where the agent can open it and nothing needs copying.
      // A MIRRORED pane (`@device/id`) runs its agent elsewhere, and a browser has no path
      // for a dropped file at all - both send the bytes and are answered with a path that
      // exists over there.
      if (paths.length === files.length && !sessionId.startsWith('@')) {
        typePaths(paths)
        return
      }
      void sendFiles(files)
      return
    }

    // No File objects - the drag carried only a list of URIs. Two kinds arrive here and
    // they are answered differently: a `file://` one is already a path on this disk (a
    // macOS screenshot dragged off its own preview thumbnail, a Finder drag with Option
    // held) and needs nothing fetched, while an http(s)/data one has to be fetched before
    // an agent can open anything.
    const uriList = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain')
    // The dragover claimed this drag because `types` advertised a uri-list, so returning
    // quietly here is the app swallowing a drop it took responsibility for - and the drop
    // that reaches this line is one where `types` said one thing and `getData` gave
    // nothing. Silence would read as the same bug this whole change fixed.
    if (!uriList) {
      toast.current?.('That drag carried no file and no link the pane could read.')
      return
    }

    const { paths: dropped, uris } = splitDropUris(uriList)
    if (dropped.length) {
      // A path is only true on one machine, same rule as the File branch above. This pane's
      // agent runs here when the id is a plain one, so the file is already where it can be
      // opened; a mirrored pane's runs on the other desk and this path means nothing there,
      // and there is no File object to send its bytes instead - so it is said out loud
      // rather than typed as a link that reads as a missing file.
      if (!sessionId.startsWith('@')) {
        // Same rule as the File branch: an image goes to a clipboard-reading agent as the
        // image. These paths have no File object behind them, so the bytes are read in the
        // main process instead of here.
        if (pasteImagesInstead(dropped.map((p) => ({ name: p }))))
          void pasteImages(dropped.map((path) => ({ path }))).catch(() => typePaths(dropped))
        else typePaths(dropped)
      }
      else
        toast.current?.(
          "That file is on this machine and this pane's agent runs on the other device. " +
            'Drag it from a window on that desk, or copy the image and paste it here.'
        )
      if (!uris.length) return
    }

    if (!uris.length) return

    ;(async () => {
      const payload: AttachIn[] = []
      for (const uri of uris) {
        const item = await fetchURI(uri)
        if (item) payload.push(item)
      }
      if (!payload.length) {
        toast.current?.('Failed to fetch the dropped URI')
        return
      }
      const res = await api.attachFiles(sessionId, payload)
      if (res.error) toast.current?.(res.error)
      typePaths(res.paths)
    })()
  }

  /**
   * Where each tag sits on the rail, oldest first.
   *
   * A tag points at the scrollbar thumb that reaches its line, so it is placed the way
   * Chromium places that thumb: the fraction is of the scrolling range (everything above
   * the last screenful), and the travel is the track less one thumb - which has a 48px
   * floor of its own (the scrollbar block in styles.css). Placed as a plain fraction of
   * the track instead, a tag near the tail sat most of a thumb's height below the thumb it
   * stood for.
   *
   * `floor` is the rail's one promise: top to bottom is oldest to newest. The anchoring in
   * addMark keeps the lines in order as prompts arrive, and this keeps them in order after
   * the fact, whatever the terminal does to the buffer underneath - a tag can be pinned
   * level with the one before it, never drawn above it.
   */
  const thumb = Math.max(48, (rows / Math.max(rows, total)) * track.height)
  let floor = 0
  const raw = marks.map((m) => {
    // -1 means xterm disposed it a frame before the state caught up.
    if (m.marker.line < 0) return null
    floor = Math.max(floor, m.marker.line)
    const frac = Math.min(1, Math.max(0, floor / Math.max(1, total - rows)))
    return { mark: m, top: frac * Math.max(0, track.height - thumb) }
  })

  /**
   * Pull tags that landed on top of each other apart, and give each one only the
   * height it actually owns.
   *
   * A conversation is ask, short answer, ask again, so consecutive prompts sit a
   * few buffer lines apart and their tags land a couple of pixels apart on the
   * rail. Measured on a probe pane (scripts/rail-click-test.mjs): five prompts in
   * a row placed at gaps of 1.7, 1.6, 1.7, 1.7px while the hit box each tag grows
   * is 18px tall - so four of six tags hit-tested to the NEWEST tag in the
   * cluster, and pressing any of them jumped to that prompt instead. When the
   * newest is where the pane already is, pressing does nothing at all, which is
   * what "cannot click the tags" looks like from the desk.
   *
   * The arithmetic is `shared/rail.ts` and is pinned by `npm run test:railplace`,
   * because the greedy version of it that lived here drew tags off the end of the
   * rail and moved others most of the rail's height away from the thumb they point
   * at. Read the numbers in that file before changing this.
   */
  const live = raw.filter(Boolean) as { mark: Mark; top: number }[]
  const span = Math.max(0, track.height - thumb)
  const tags = placeRail(
    live.map((p) => p.top),
    span
  )
  const placed = raw.map((p) => {
    if (!p) return null
    return { ...p, ...tags[live.indexOf(p)] }
  })

  /**
   * A copy button beside every prompt that is on screen, and one under it for the reply.
   *
   * The turn boundaries are the prompt marks the rail already keeps - a turn is a prompt
   * row up to the row before the next prompt. The placement itself is `shared/turnCopy.ts`
   * so it can be checked without a window (`npm run test:turncopy`); all that happens here
   * is looking each row's prompt text back up.
   *
   * A finger's pair is 66px tall and a pointer's is 38, and that number decides which
   * pairs are drawn at all - so it is read from the same query the stylesheet switches on
   * rather than assumed, per render, which is what makes rotating a phone or dragging a
   * window past 720px land on the right one.
   */
  const stackH =
    typeof window !== 'undefined' && window.matchMedia(`(max-width: ${HANDHELD_MAX}px)`).matches
      ? TURN_COPY_H_TOUCH
      : TURN_COPY_H
  const turnCopies = geom
    ? placeTurnCopies(
        marks.map((m) => m.marker.line),
        geom,
        stackH,
        Math.max(0, total - 1)
      ).map((c) => {
        const m = marks.find((x) => x.marker.line === c.row)
        // `full`, never `text`: the rail's label is flattened and capped, and copying that
        // hands back a prompt with its line breaks gone and its tail missing.
        return { ...c, key: m?.id ?? c.row, prompt: m?.full ?? m?.text ?? '' }
      })
    : []

  /**
   * Run the search and land on a match.
   *
   * `incremental` on the forward search is what makes typing feel like a browser's find
   * bar: each new character extends the match under the cursor instead of jumping to the
   * next one somewhere else in 20,000 lines. Stepping with the buttons or Enter turns it
   * off, because there the point is to move.
   *
   * Finding something is also the clearest possible statement that this pane should stop
   * following the tail - the agent printing another line while you read a match from ten
   * minutes ago would otherwise yank the view straight back to the bottom.
   */
  const runFind = (term: string, back: boolean, incremental: boolean): void => {
    const sa = search.current
    if (!sa) return
    if (!term) {
      setMissed(false)
      lastTerm.current = ''
      sa.clearDecorations()
      setHits({ index: -1, count: 0 })
      return
    }
    // The addon only re-scans when the term is not the one it searched for last - and it
    // sets that term itself: 200ms after any output it silently re-runs the last search to
    // move the highlights the new lines shifted under. A term typed into this box after
    // that has happened is "the same term" to the addon, so it keeps whatever that pass
    // left behind and reports its count. Measured against a live pane: three lines
    // containing the word, "no matches" in the box, and pressing Enter - a second search
    // of the same term - answering 1/5. Clearing first costs one scan of the buffer and
    // makes the number in the box always this search's own.
    if (term !== lastTerm.current) {
      lastTerm.current = term
      sa.clearDecorations()
    }
    const opts = {
      caseSensitive: false,
      incremental,
      decorations: {
        matchBackground: '#4a4420',
        matchBorder: '#7a7238',
        matchOverviewRuler: '#c9b84a',
        activeMatchBackground: '#2f5d8a',
        activeMatchBorder: '#7dd3fc',
        activeMatchColorOverviewRuler: '#7dd3fc'
      }
    }
    const found = back ? sa.findPrevious(term, opts) : sa.findNext(term, opts)
    setMissed(!found)
    if (found) {
      pinned.current = false
      setScrolledUp(true)
    }
  }

  const closeFind = (): void => {
    setFinding(false)
    setHits({ index: -1, count: 0 })
    setMissed(false)
    lastTerm.current = ''
    search.current?.clearDecorations()
    // The keyboard goes back where it came from. Leaving it in a closed input is the
    // "why is nothing I type reaching the agent" bug, and it would be this pane's fault.
    term.current?.focus()
  }

  return (
    <div
      ref={wrap}
      // No ring for a live question. The card in the sidebar carries the red bar down its
      // left edge and the "asks you" chip, which is where a person looks to see WHICH pane
      // is owed an answer; drawing it a second time as a border over the agent's own output
      // was the same fact twice, over live text, in the one place it could be mistaken for
      // part of what the agent printed.
      className={'xterm-wrap' + (dropping ? ' dropping' : '')}
      onDragOver={(e) => {
        // `Files` is one of two shapes a dropped file arrives in, and the other one was
        // never claimed. A macOS screenshot dragged off its own preview thumbnail, and a
        // browser image drag, carry `text/uri-list` with no File object at all - so this
        // returned, nothing called preventDefault, no `drop` event was ever delivered
        // here, and Chromium's default action typed the URL into xterm's helper textarea.
        // The agent got `file:///var/folders/…/Screenshot%20….png` as a sentence.
        //
        // `text/plain` is deliberately NOT accepted: a dragged word or sentence is
        // Chromium's own paste into the terminal and is worth keeping. Only a uri-list,
        // which nothing but a link or a file produces, makes this a drop target.
        const kinds = e.dataTransfer.types
        if (!kinds.includes('Files') && !kinds.includes('text/uri-list')) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setDropping(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return
        setDropping(false)
      }}
      onDrop={onDrop}
    >
      <div className="xterm-host" ref={host} />
      {/* Until the pty says something. Not a spinner and not a dialog - one dim line in a
          pane that would otherwise be an empty black box for the seconds the CLI spends
          starting up. It goes on the first byte, whether that byte is the agent's banner
          or a replayed transcript. */}
      {blank && !mirror && <div className="pane-booting">Starting…</div>}
      {finding && (
        <div className="find-bar" onMouseDown={(e) => e.stopPropagation()}>
          <input
            ref={findInput}
            className="find-input"
            placeholder="Find in this pane"
            value={query}
            spellCheck={false}
            onChange={(e) => {
              setQuery(e.target.value)
              runFind(e.target.value, false, true)
            }}
            onKeyDown={(e) => {
              // Handled here and stopped here: the window-level shortcut handler treats a
              // bare Ctrl+F as "open the find bar", and Escape as "close every dialog".
              e.stopPropagation()
              if (e.key === 'Escape') {
                e.preventDefault()
                closeFind()
              } else if (e.key === 'Enter') {
                e.preventDefault()
                runFind(query, e.shiftKey, false)
              } else if (e.key === 'F3') {
                e.preventDefault()
                runFind(query, e.shiftKey, false)
              }
            }}
          />
          <span className="find-count">
            {!query
              ? ''
              : missed
                ? 'no matches'
                : hits.count === 0
                  ? 'found'
                  : hits.index < 0
                    ? `${hits.count}+`
                    : `${hits.index + 1}/${hits.count}`}
          </span>
          <button
            className="find-step"
            title="Previous match (Shift Enter)"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => runFind(query, true, false)}
          >
            ↑
          </button>
          <button
            className="find-step"
            title="Next match (Enter)"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => runFind(query, false, false)}
          >
            ↓
          </button>
          <button className="find-step" title="Close (Escape)" onClick={closeFind}>
            ✕
          </button>
        </div>
      )}
      {/* The two copy affordances. Both are drawn on the wrap rather than inside the
          terminal, because the terminal is a canvas and has nothing to hang a button off,
          and both preventDefault their mousedown for the reason every control in this pane
          does: a mousedown inside the pane takes focus off the terminal and starts a
          selection drag, which would clear the very highlight the button is there to copy. */}
      {/* The copy affordances. All of them are drawn on the wrap rather than inside the
          terminal, because the terminal is a canvas and has nothing to hang a button off,
          and all of them preventDefault their mousedown for the reason every control in
          this pane does: a mousedown inside the pane takes focus off the terminal and
          starts a selection drag, which would clear the very highlight the button is there
          to copy. The pair per turn is icons and not words on purpose - it is drawn for
          every prompt on screen rather than for one hovered turn, and eight "Prompt /
          Reply" buttons down the side of a pane is a second sidebar. */}
      {turnCopies.map((c) => (
        // Keyed on the MARK and not on the row: a marker's line moves whenever scrollback
        // is trimmed, and a changed key unmounts the pair - which throws away the :hover
        // and the half-finished click of the button somebody was reaching for.
        <div className="turn-copy" key={c.key} style={{ top: c.top }}>
          <button
            title="Copy this prompt"
            aria-label="Copy this prompt"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => putOnClipboard(c.prompt, 'Prompt')}
          >
            <CopyIcon size={13} />
          </button>
          <button
            title="Copy what the agent answered"
            aria-label="Copy what the agent answered"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => putOnClipboard(textOf(c.row + 1, c.to), 'Reply')}
          >
            <CopyReplyIcon size={13} />
          </button>
        </div>
      ))}
      {selChip && (
        <button
          className="sel-copy"
          // The coordinates were computed and then thrown away: `.sel-copy` is absolute with
          // no left/top, so it fell to its static position - the pane's top-left corner -
          // and stayed there whatever was highlighted. Every measurement below is what makes
          // the button land beside the selection at all.
          style={{ left: selChip.left, top: selChip.top }}
          title="Copy the highlighted text"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const t = term.current
            const text = t?.getSelection() ?? ''
            putOnClipboard(text, 'Selection')
            // The highlight stays: it is the only thing on screen saying WHAT was copied,
            // and dropping it the instant the button is pressed reads as the click having
            // gone somewhere else.
            term.current?.focus()
          }}
        >
          Copy
        </button>
      )}
      {/* Rendered before the pill and the drop hint on purpose: all three are positioned,
          so DOM order is what keeps a tag near the tail from painting over the pill. */}
      {marks.length > 0 && (
        <div
          className="mark-rail"
          style={{ top: track.top, height: track.height || undefined }}
        >
          {placed.map((p, i) => {
            if (!p) return null
            const { mark: m, top, hitUp, hitDown } = p
            // Never earlier than the tag itself: `railNow` is only refreshed on a bucket
            // turnover, so a prompt sent between two ticks is NEWER than the clock reading
            // it is measured against - and `whenWords` answers a negative age with the full
            // calendar date, which is how a prompt sent one second ago first drew as
            // `26/08/2026, 18:27:42`. Measured in a dev copy before this line existed.
            const label = markLabel(m, Math.max(railNow, m.at))
            const exact = markWhen(m)
            return (
              <button
                key={m.id}
                className={
                  'mark' +
                  // The newest tag stays lit: at a glance it is what the agent is working on.
                  (i === marks.length - 1 ? ' newest' : '') +
                  (flash === m.id ? ' flash' : '')
                }
                style={
                  {
                    top,
                    // The hit box the ::before draws, sized to the gap this tag has
                    // rather than to a constant that reaches into its neighbours.
                    '--hit-up': `${hitUp}px`,
                    '--hit-down': `${hitDown}px`
                  } as React.CSSProperties
                }
                // The tip carries the distance; the hover-hold carries the moment.
                title={exact ? exact + '\n' + label : label}
                aria-label={label}
                // Same reason as the pill: a mousedown inside the pane would take focus off
                // the terminal and start a selection drag.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => jumpTo(m)}
              >
                <span className="mark-tip">{label}</span>
              </button>
            )
          })}
        </div>
      )}
      {scrolledUp && (
        <button
          className="jump-newest"
          title="Back to the newest output"
          // The terminal must not lose focus mid-turn, and a mousedown inside the pane would
          // also start a selection drag.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            pinned.current = true
            term.current?.scrollToBottom()
            setScrolledUp(false)
            term.current?.focus()
          }}
        >
          ↓ Newest
        </button>
      )}
      {/* A modal mode with nothing on screen saying so is the worst kind: every key
          does something else and the pane looks exactly as it did. This is also where
          the keys are documented - a copy mode whose motions have to be looked up is
          slower than the mouse it replaces. */}
      {copyOn && (
        <div className="copy-strip">
          <b>COPY</b>
          <span>hjkl / arrows move</span>
          <span>w b e word</span>
          <span>0 ^ $ line</span>
          <span>g G ends</span>
          <span className={copySel ? 'on' : undefined}>v select</span>
          <span>y yank</span>
          <span>/ find</span>
          <span>Esc exit</span>
        </div>
      )}
      {dropping && <div className="drop-hint">Drop files to put their paths in the prompt</div>}
      {/* The agent asked something with answers on it, so the answers are buttons.
          Drawn over the bottom of the pane rather than in the header: the question is
          on screen a few rows above, and an answer belongs beside what it answers. The
          row the CLI's own arrow is on is marked, so pressing the one already selected
          reads as confirming rather than as choosing something else - and on a phone,
          where there are no arrow keys at all, this is the only way to answer without
          going and finding the machine. `shared/choices.ts` decides what a question is;
          this only draws it. */}
      {ask && (
        <div className="pane-ask">
          {/* The question is NOT repeated here. The CLI has it on screen a few rows to the
              left, in full, with its own wording and its own numbers - drawing it again in
              a card that also carries the answers made two questions out of one, and the
              copy was clamped to two lines so it was the worse of the two. What this holds
              is the part the terminal cannot say: what this app is about to press, when,
              and a target for a pointer or a thumb. */}
          {autoAnswerAt || autoAnswerHeld ? (
            <AskCountdown
              at={autoAnswerAt ?? 0}
              n={autoAnswerN}
              ask={ask}
              held={autoAnswerHeld}
            />
          ) : null}
          <div className="pane-ask-row">
            {ask.options.map((o) => (
              <button
                key={o.n}
                // Three states, not two: where the CLI's own arrow is (`on`), and which
                // one this app is about to press for you (`auto`). They are usually the
                // same row and are not always - the pick is `pickAnswer`'s, which reads
                // the labels rather than the arrow - so a countdown that named an option
                // the eye could not then find on the row was the half of the promise that
                // was missing.
                className={
                  'pane-ask-btn' +
                  (o.n === ask.selected ? ' on' : '') +
                  ((autoAnswerAt || autoAnswerHeld) && o.n === autoAnswerN ? ' auto' : '')
                }
                title={
                  (autoAnswerAt || autoAnswerHeld) && o.n === autoAnswerN
                    ? `${o.n}. ${o.label} - this is the one that will be pressed for you`
                    : `${o.n}. ${o.label}`
                }
                onClick={() => {
                  void api.chooseOption(sessionId, o.n).then((ok) => {
                    // A refusal is the pane having moved on - answered at the desk while
                    // this was on screen. Saying nothing there would leave somebody
                    // believing they had answered it.
                    if (!ok) onToast?.('That question is gone - the pane moved on')
                  })
                }}
              >
                <span className="pane-ask-n">{o.n}</span>
                {o.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Is this the same question, drawn the same way?
 *
 * `ask` arrives from the main process inside a fresh sessions array on every change, so
 * its identity is never stable and comparing it by reference would defeat the memo below
 * outright. What matters to the pane is what it DRAWS: the question, which row the CLI's
 * arrow is on, and the options themselves.
 */
function sameAsk(a?: PaneAsk | null, b?: PaneAsk | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  if (a.question !== b.question || a.selected !== b.selected) return false
  if (a.options.length !== b.options.length) return false
  return a.options.every((o, i) => o.n === b.options[i].n && o.label === b.options[i].label)
}

function sameGrid(a?: { cols: number; rows: number } | null, b?: { cols: number; rows: number } | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.cols === b.cols && a.rows === b.rows
}

/**
 * Whether this pane can skip a render.
 *
 * The sessions list is one array for the whole desk, rebuilt in main whenever ANYTHING
 * about ANY pane changes - and a question being arrowed through rebuilds it on every
 * frame. Without this, a pane's render is work every other pane pays for: measured on
 * 2026-08-20 against a real chooser in a dev copy, five arrow moves cost **34 renders of
 * every pane on the desk**, four of which had no question on them at all. A render is not
 * free either - it re-measures the turn-copy pairs and the prompt rail against the live
 * xterm buffer - which is what made arrowing through an agent's answers feel heavy.
 *
 * Every prop is compared, and the three that are objects are compared by VALUE, because
 * main sends new ones each time and by reference this comparator would always say "no".
 * A prop added to `Props` without a line here is a pane that STOPS UPDATING for it, and
 * nothing catches that: TypeScript has no exhaustiveness check over an object's keys, so
 * the missing comparison compiles, the comparator answers "same", and the pane quietly
 * never re-renders for that prop. It is listed out rather than looped over so the omission
 * is at least visible when reading the function - it is not a compile error. Add the line
 * in the same edit as the prop.
 */
function samePaneProps(a: Props, b: Props): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.cwd === b.cwd &&
    a.visible === b.visible &&
    a.active === b.active &&
    a.fontSize === b.fontSize &&
    a.copyOnSelect === b.copyOnSelect &&
    a.mouseSelect === b.mouseSelect &&
    a.clickMovesCursor === b.clickMovesCursor &&
    a.autoFixUi === b.autoFixUi &&
    a.agent === b.agent &&
    a.onToast === b.onToast &&
    a.autoAnswerAt === b.autoAnswerAt &&
    a.autoAnswerN === b.autoAnswerN &&
    a.autoAnswerHeld === b.autoAnswerHeld &&
    a.replayCols === b.replayCols &&
    sameAsk(a.ask, b.ask) &&
    sameGrid(a.mirror, b.mirror) &&
    sameGrid(a.grid, b.grid) &&
    sameTheme(a.termTheme, b.termTheme)
  )
}

/** The xterm palette, by value: it is derived in App and is a new object every render. */
function sameTheme(a: Props['termTheme'], b: Props['termTheme']): boolean {
  if (a === b) return true
  if (!a || !b) return false
  const ka = Object.keys(a) as (keyof NonNullable<Props['termTheme']>)[]
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k])
}

export default memo(TerminalPane, samePaneProps)
