import { useEffect, useRef, useState } from 'react'
import { Terminal, type ILink, type IMarker } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebglAddon } from '@xterm/addon-webgl'
import { readsBusy, readsElapsedMs } from '../../../shared/busy'
import {
  applyKey,
  scrollFor,
  selectionOf,
  startState,
  type CopyCtx,
  type CopyState
} from '../../../shared/copyMode'
import { feedDraft, flatDraft, newDraft, RAIL_LABEL_CHARS, type DraftState } from '../../../shared/draft'
import { cellAt, keysAlongLine, keysForClick, keysForDelete } from '../../../shared/cursorMove'
import { keepScrollback } from '../../../shared/keepScrollback'
import { inputEnd, inputStart, sameBox } from '../../../shared/promptBox'
import { findPathTokens } from '../../../shared/pathToken'
import { placeRail } from '../../../shared/rail'
import type { RevealTarget } from '../../../shared/pathToken'
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
  }
}

// On macOS the clipboard lives on Cmd, which leaves Ctrl+C free to interrupt the agent.
// Same detector the window-level shortcuts use, so the two halves cannot disagree.
import { isMac } from '../platform'
import { isPhoneClient } from '../client'

/**
 * Panes register their repair function here, so the toolbar button, the shortcut and the
 * command palette can all reach the focused pane without threading a ref through App.
 */
export const paneRepair = new Map<string, () => void>()

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
  maxFont: number
): boolean {
  const cols = t.cols
  const rows = t.rows
  const d = f.proposeDimensions()
  if (d && d.cols > 0 && d.rows > 0) {
    const k = Math.min(d.cols / Math.max(1, mirror.cols), d.rows / Math.max(1, mirror.rows))
    const current = t.options.fontSize ?? maxFont
    const next = Math.max(6, Math.min(maxFont, Math.round(current * k)))
    if (next !== current) t.options.fontSize = next
  }
  t.resize(Math.max(20, mirror.cols), Math.max(5, mirror.rows))
  if (pinned) t.scrollToBottom()
  return t.cols !== cols || t.rows !== rows
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
 * How often a pane re-states that it is still busy. The main process holds "busy" as a
 * deadline rather than a flag, so silence eventually reads as finished - which is the right
 * default for a pane that crashed or was closed, and wrong for a turn that is simply taking
 * a long time. Well under that deadline so a few dropped ticks cost nothing.
 */
const BUSY_RESTATE = 120_000

/** A prompt that was submitted to this pane, pinned to the buffer line it was sent on. */
interface Mark {
  id: number
  marker: IMarker
  text: string
  at: number
}

/**
 * What a rail tag reads out on hover. The time is the point of it as much as the text is -
 * "what did I ask at 14:32" is how you find a prompt again hours into a run.
 */
function markLabel(m: Mark): string {
  const time = new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const text = m.text.length > 160 ? m.text.slice(0, 159) + '…' : m.text
  return time + '  ' + text
}

/** Quote a dropped path only when it needs it, so an agent reads it as one argument. */
function quote(p: string): string {
  return /[\s'"]/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p
}

/**
 * One xterm bound to one pty. Output arrives as a global 'pty:data' event, so each
 * pane filters by id rather than opening a channel per session.
 */
export default function TerminalPane({
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
  termTheme
}: Props): JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  const fit = useRef<FitAddon | null>(null)
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
  const deleteSelectionRef = useRef<() => boolean>(() => false)
  const autoFixRef = useRef(autoFixUi)
  autoFixRef.current = autoFixUi
  // A session can be moved into a lane worktree without the pane being rebuilt, and the
  // link provider is attached once per session, so it reads the folder through a ref.
  const cwdRef = useRef(cwd)
  cwdRef.current = cwd
  // Read inside the terminal effect, which is built once per session: a device
  // reconnecting changes these numbers without the pane being rebuilt.
  const mirrorRef = useRef(mirror)
  mirrorRef.current = mirror
  const fontRef = useRef(fontSize)
  fontRef.current = fontSize
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
    const m = mirrorRef.current
    if (m && m.cols > 0 && m.rows > 0) return mirrorFit(t, f, pinned.current, m, fontRef.current)
    const changed = refit(t, f, pinned.current)
    // A phone BORROWS the pty's shape rather than owning it. One pty cannot be 50 columns
    // for a phone and 157 for the window it is also drawn in, and before this the phone
    // simply won and never gave it back - the desk went on drawing a full-width pane whose
    // every line wrapped a third of the way across, for as long as it took somebody to
    // resize the window by hand. See `resize` in main/sessions.ts.
    if (changed) api.resize(sessionId, t.cols, t.rows, isPhoneClient())
    return changed
  }
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

  const syncTotal = (): void => {
    const t = term.current
    if (!t) return
    setTotal(t.buffer.active.baseY + t.rows)
    setRows(t.rows)
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
      fontFamily: 'Cascadia Mono, Consolas, monospace',
      fontSize,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 20000,
      theme: themeRef.current ?? {
        background: '#0c0c10',
        foreground: '#e6e6e6',
        cursor: '#7dd3fc',
        selectionBackground: '#2f5d8a'
      }
    })
    /**
     * Everything an agent writes goes through here first, so that `/clear` stops taking
     * the previous turn with it: the CLI sends `CSI 2 J` and `CSI 3 J` together, and the
     * second one deletes this window's scrollback. See shared/keepScrollback.ts - it is
     * stateful (a sequence is routinely torn across two chunks from the pty), so there is
     * exactly one of it per pane and every write site uses it.
     */
    const keep = keepScrollback(
      () => t.rows,
      () => t.buffer.active.type === 'alternate'
    )
    const f = new FitAddon()
    t.loadAddon(f)
    t.open(host.current)
    term.current = t
    fit.current = f

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
     */
    let gl: WebglAddon | null = null
    try {
      gl = new WebglAddon()
      gl.onContextLoss(() => {
        gl?.dispose()
        gl = null
      })
      t.loadAddon(gl)
    } catch {
      /* no WebGL on this box - the DOM renderer is already what is drawing */
      gl = null
    }

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
      [sessionId]: { term: t, fit: f, host: host.current, dropWebgl: () => gl?.dispose() },
      // The draft is reconstructed from keystrokes rather than read off the screen, so it
      // is the one thing about a pane that no amount of DOM or buffer inspection can
      // answer. `prompt-view-test.mjs` reads it back after typing through xterm's own
      // input path, which is the only honest way to check the reconstruction in a real
      // window.
      draft: (id: string) => paneDraft.get(id) ?? null
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
    // A run of box-drawing characters, which is what these CLIs frame a prompt with -
    // `────` in Claude Code's current build, `╭───╮` in the rounded ones. Anchored at the
    // start so a line of text that merely contains one cannot match.
    const BOX_RULE = /^[─-╿]{4}[─-╿\s]*$/
    const promptBoxTop = (maxUp: number): number => {
      const b = t.buffer.active
      for (let up = 1; up <= Math.min(PROMPT_BOX_SCAN, maxUp); up++) {
        const y = b.cursorY - up
        if (y < 0) return 0
        const line = b.getLine(b.baseY + y)
        if (!line) return 0
        const s = line.translateToString(true).trim()
        if (s.length >= 8 && BOX_RULE.test(s)) return up
      }
      return 0
    }

    const addMark = (text: string): void => {
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
      const entry: Mark = { id: marker.id, marker, text, at: Date.now() }
      marker.onDispose(() => {
        const i = list.indexOf(entry)
        if (i < 0) return
        list.splice(i, 1)
        publish()
      })
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
        const text = flatDraft(line, RAIL_LABEL_CHARS)
        // A bare Enter is a confirmation or an accepted menu item, and a lone character is
        // a menu key. Tagging either would bury the real prompts.
        if (text.length > 1) addMark(text)
        // The archive is fed here, on the way to the pty, which is why it works the same
        // for every agent: this sees what was typed, not what any particular CLI does with
        // it. `line` rather than `text` - the flattened version is a rail label, and
        // matching wants the words that were actually sent. Anything too short to be an ask
        // is dropped on the other side (MIN_PROMPT_TOKENS), not here.
        if (text.length > 1) api.promptUsed(line, { cwd: cwdRef.current })
      }
    }

    // The rail's scale changes as output arrives and as the view moves, but a write only
    // ever shifts a tag by a pixel or two - a setState per burst is not worth that.
    let lastTotal = 0
    const bumpTotal = (): void => {
      if (!list.length) return
      const now = Date.now()
      if (now - lastTotal < 250) return
      lastTotal = now
      syncTotal()
    }

    // The view's real position is the single source of truth for following, so a drag, a
    // wheel notch, a keyboard scroll and a write all end up judged the same way. No snap
    // here: this fires *during* a drag, and yanking the view out from under the mouse is
    // worse than a stale pill for one frame.
    t.onScroll(() => {
      const follow = nearBottom()
      pinned.current = follow
      setScrolledUp(!follow)
      bumpTotal()
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

    const copySelection = (keepHighlight = false): boolean => {
      // A visible highlight always wins: Ctrl+C copies it and drops it, so the very next
      // Ctrl+C is an interrupt again. One extra keypress, never a lost prompt.
      const live = t.getSelection()
      if (live) {
        api.copyText(live)
        if (!keepHighlight) t.clearSelection()
        lastSelection.current = ''
        copied.current = live
        return true
      }
      const sel = lastSelection.current
      if (!sel || sel === copied.current) return false
      api.copyText(sel)
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
        // No text usually means an image on the clipboard. Claude Code reads the OS
        // clipboard itself when it sees a raw ^V, so forward the key rather than
        // swallowing it - otherwise pasting screenshots stops working.
        api.write(sessionId, '\x16')
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
        if (deleteSelectionRef.current()) {
          if (e.key.length !== 1) {
            e.preventDefault()
            return false
          }
          // The character itself still goes through, landing where the selection was.
          return true
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
      if (keys) api.write(sessionId, keys)
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
    const inputSpan = (): { row: number; col: number; end: number; length: number } | null => {
      if (t.buffer.active.type === 'alternate') return null
      const b = t.buffer.active
      const cursorRow = b.baseY + b.cursorY
      let top = cursorRow
      while (top > 0 && b.getLine(top)?.isWrapped) top--
      let bottom = cursorRow
      while (b.getLine(bottom + 1)?.isWrapped) bottom++
      const col = inputStart(rowText(top))
      const end = inputEnd(rowText(bottom))
      const length = (bottom - top) * t.cols + (end - col)
      return length > 0 ? { row: top, col, end, length } : null
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
     * `cursorMove.ts`; this half is only about which selections are eligible - all of it on
     * the line the far end is still editing, which is the cursor's own row and whatever
     * that input wrapped onto.
     */
    const deleteSelection = (): boolean => {
      const pos = t.getSelectionPosition()
      if (!pos || t.buffer.active.type === 'alternate') return false
      const b = t.buffer.active
      const cursorRow = b.baseY + b.cursorY
      if (!sameLine(cursorRow, pos.start.y) || !sameLine(cursorRow, pos.end.y)) return false
      const keys = keysForDelete({
        cursorRow,
        cursorCol: b.cursorX,
        startRow: pos.start.y,
        startCol: clampCol(pos.start.y, pos.start.x),
        endRow: pos.end.y,
        endCol: clampCol(pos.end.y, pos.end.x),
        cols: t.cols,
        // Every row here is part of one wrapped input - `sameLine` walked the chain.
        wrapped: true
      })
      if (!keys) return false
      api.write(sessionId, keys)
      t.clearSelection()
      lastSelection.current = ''
      return true
    }
    selectInputRef.current = selectInput
    deleteSelectionRef.current = deleteSelection

    const moveAlongLine = (e: MouseEvent): void => {
      const from = downAt
      downAt = null
      if (!clickCursorRef.current || !from) return
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
      if (!sameLine(cursorRow, clickRow)) {
        // A second LINE of a draft is a hard newline, not a wrap, so the chain above says
        // the two rows are unrelated and a click on it used to do nothing at all - which is
        // "the cursor can't select exactly where I want, it's very limited". Inside a drawn
        // input box it is safe to send the vertical arrows a bare click may otherwise never
        // send: the box is a text field the CLI is handling itself, so an up-arrow there is
        // a movement and not the previous command. A plain shell draws no box, so this
        // cannot fire in one - see shared/promptBox.ts.
        if (!sameBox(rowText(cursorRow), rowText(clickRow))) return
        const boxKeys = keysForClick({
          cursorRow,
          cursorCol: b.cursorX,
          clickRow,
          clickCol: clampCol(clickRow, at.col),
          rowLimit: 8
        })
        if (!boxKeys) return
        e.preventDefault()
        e.stopPropagation()
        api.write(sessionId, boxKeys)
        return
      }
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
      e.stopPropagation()
      api.write(sessionId, keys)
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
      // following Ctrl+C should still copy rather than interrupt.
      copySelection(true)
    }
    // Right-click: copy when something is selected, paste when nothing is.
    const onContextMenu = (e: MouseEvent): void => {
      e.preventDefault()
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

    // Replay whatever the pty printed before this pane existed (new pane on an
    // existing session, or a remount).
    api.getBuffer(sessionId).then((b) => {
      // Land on the newest line, not wherever 20k replayed lines happen to leave the view.
      if (b) {
        sawOutput = true
        t.write(keep(b), () => t.scrollToBottom())
      }
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
    let settle2: number | undefined
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
      let text = ''
      try {
        text = screenText(t, BUSY_ROWS)
        // A question on screen is not work in progress, whatever the footer says - that
        // rule and the footers themselves live in shared/busy.ts, against real frames.
        now = readsBusy(text)
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
      if (!now && busy) {
        if (!offSince) offSince = at
        if (at - offSince < 1200) return
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
      if (now === busy && !(now && at - lastReport > restate)) return
      busy = now
      lastReport = at
      // The frame goes with a `false` only: that is the reading that can ring the bell,
      // and it is the one worth being able to read back afterwards.
      api.setBusy(sessionId, now, now ? undefined : text, clock ?? undefined)
    }

    /**
     * The link to the other device came back and it re-sent the whole scrollback.
     * Everything already on screen is a prefix of what just arrived, so the pane is
     * wiped and redrawn from it - appending would show the run twice.
     */
    const offReset = api.onPaneReset((id) => {
      if (id !== sessionId) return
      t.reset()
      void api.getBuffer(sessionId).then((b) => {
        if (dead) return
        sawOutput = Boolean(b)
        pinned.current = true
        t.write(keep(b), () => t.scrollToBottom())
      })
    })

    const off = api.onData((id, data) => {
      if (id !== sessionId) return
      sawOutput = true
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
    paneRepair.set(sessionId, repair)
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
        if (text) api.copyText(text)
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
      // nothing re-wraps, so a reset there would wipe the screen while you were typing.
      //
      // `clear`, never `reset`: it drops the buffer and keeps the line the cursor is on,
      // so a plain shell is left holding its prompt rather than a blank pane - a shell has
      // no frame to repaint and `redraw` would print nothing back. `reset` would also put
      // modes and colours back, which is not ours to do to a CLI mid-run.
      const rewrapped = t.cols !== wasCols
      if (isPhoneClient() && rewrapped) {
        window.setTimeout(() => {
          if (!host.current?.offsetParent) return
          try {
            t.clear()
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
      ro.disconnect()
      window.clearTimeout(settle)
      window.clearTimeout(settle2)
      window.clearInterval(busyTick)
      paneRepair.delete(sessionId)
      paneFeed.delete(sessionId)
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
      for (const m of list.splice(0)) m.marker.dispose()
      t.dispose()
    }
  }, [sessionId])

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
    if (!mirror && t.options.fontSize === fontSize) return
    if (!mirror) t.options.fontSize = fontSize
    try {
      if (fit.current) reshape(t, fit.current)
      // Fewer or more rows means a different scale for the rail.
      syncTotal()
    } catch {
      /* hidden pane - the visibility effect will refit it */
    }
    // mirror is in the list so a device reconnecting at a different size reshapes
    // the pane instead of leaving it drawn at the grid it had before the drop.
  }, [fontSize, sessionId, mirror?.cols, mirror?.rows])

  // Re-fit when this pane becomes visible again: the terminal was not measurable
  // while hidden, so its cols/rows can be stale.
  useEffect(() => {
    if (!visible) return
    const id = requestAnimationFrame(() => {
      try {
        if (term.current && fit.current) {
          // Same rule as the observer: only a pane that really changed shape while it was
          // away gets to disturb the pty. Coming back unchanged must be silent.
          reshape(term.current, fit.current)
          // The buffer kept growing while this pane was hidden, so the rail is stale.
          syncTotal()
        }
      } catch {
        /* not laid out yet */
      }
    })
    return () => cancelAnimationFrame(id)
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
   * Dropping files types their paths at the prompt. Getting a screenshot or a PDF in front
   * of an agent otherwise means finding the folder by hand and typing the path; here it is
   * drag, drop, Enter. Nothing is sent for you - the paths land in the input box so they
   * can be described first.
   */
  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    setDropping(false)
    const paths = Array.from(e.dataTransfer.files)
      .map((file) => api.pathForFile(file))
      .filter(Boolean)
    if (!paths.length) return
    api.write(sessionId, paths.map(quote).join(' ') + ' ')
    term.current?.focus()
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
      className={'xterm-wrap' + (dropping ? ' dropping' : '')}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
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
            const label = markLabel(m)
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
                title={label}
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
    </div>
  )
}
