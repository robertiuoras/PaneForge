import { useEffect, useRef, useState } from 'react'
import { Terminal, type IMarker } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import './TerminalPane.css'

const api = window.api

interface Props {
  sessionId: string
  visible: boolean
  fontSize: number
  /** put a mouse selection straight on the clipboard, the way most terminals do */
  copyOnSelect: boolean
  /** let a plain drag select text even while the agent has mouse reporting on (the wheel
   *  always scrolls this pane - that is not a setting) */
  mouseSelect: boolean
  /** repaint by itself once a resize settles */
  autoFixUi: boolean
}

// On macOS the clipboard lives on Cmd, which leaves Ctrl+C free to interrupt the agent.
const isMac = navigator.userAgent.includes('Mac')

/**
 * Panes register their repair function here, so the toolbar button, the shortcut and the
 * command palette can all reach the focused pane without threading a ref through App.
 */
export const paneRepair = new Map<string, () => void>()

/**
 * Put text into a pane the way a paste does, from anywhere in the app.
 *
 * Not the same as writing the bytes to the pty. Claude Code, Codex and every other TUI
 * here turn bracketed paste on, and xterm's paste is what wraps text in the markers they
 * are watching for; raw bytes arrive as if they had been typed a character at a time,
 * which those TUIs are free to read as keystrokes rather than as one insertion.
 */
export const paneInsert = new Map<string, (text: string) => void>()

/** Every CLI's "still running" footer. While this is on screen the turn is not over. */
const BUSY_FOOTER =
  /esc to interrupt|esc to cancel|ctrl\+c to (stop|interrupt|cancel)|press esc to stop|working…|thinking…|esc interrupt/i

/**
 * The agent is asking *you* something: a permission prompt, a tool approval, a choice.
 * This outranks the busy footer, because the two are on screen together - the CLI is
 * technically mid-turn, but nothing moves until you answer, and the pane claiming to be
 * working is what makes you leave it sitting there. Numbered-choice lines are matched
 * with their selection arrow only, so a numbered list in an answer cannot trigger it.
 */
const ASK_PROMPT =
  /do you want to (proceed|continue|make|create|allow|run)|allow (this )?(command|tool|edit)\?|❯\s*\d+\.\s|\(y\/n\)\s*$|press enter to (confirm|continue)|waiting for your (input|reply)/im

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
 * The bottom `rows` rows on screen right now - not the scrollback, and not wherever the
 * user scrolled. Only the bottom of the frame is read because that is the only place a
 * "still running" footer ever appears, and translating every visible row of every pane
 * several times a second is enough main-thread work that Windows leaves the mouse on the
 * busy cursor between bursts.
 */
function screenText(t: Terminal, rows: number): string {
  const buf = t.buffer.active
  let out = ''
  for (let i = Math.max(0, t.rows - rows); i < t.rows; i++) {
    const line = buf.getLine(buf.baseY + i)
    if (line) out += line.translateToString(true) + '\n'
  }
  return out
}

/** How far up from the last row the busy footer can be. Generous - it is usually 1-3. */
const BUSY_ROWS = 10

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
  visible,
  fontSize,
  copyOnSelect,
  mouseSelect,
  autoFixUi
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
  const autoFixRef = useRef(autoFixUi)
  autoFixRef.current = autoFixUi
  // Full-screen TUIs (Claude Code, vim) repaint constantly and xterm drops the
  // selection on the next buffer change, so the highlight vanishes before the user
  // can hit Ctrl+C. Remember the last real selection and copy that instead.
  const lastSelection = useRef('')
  // Whether this pane is following the tail. A ref because the resize and font-size effects
  // need it too, and it must survive without re-running the effect that owns the terminal.
  const pinned = useRef(true)
  // Only for the "back to newest" pill: the scroll position itself lives in xterm.
  const [scrolledUp, setScrolledUp] = useState(false)
  const [dropping, setDropping] = useState(false)
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
      theme: {
        background: '#0c0c10',
        foreground: '#e6e6e6',
        cursor: '#7dd3fc',
        selectionBackground: '#2f5d8a',
        selectionForeground: '#ffffff'
      }
    })
    const f = new FitAddon()
    t.loadAddon(f)
    t.open(host.current)
    term.current = t
    fit.current = f

    // Debug handle. Given --remote-debugging-port, an agent can read cols/rows, call fit,
    // and check where the viewport sits, instead of guessing at pixel bugs from screenshots.
    // The window loads no remote content, so nothing untrusted can reach it.
    const dbg = window as unknown as { __pf?: Record<string, unknown> }
    dbg.__pf = { ...(dbg.__pf ?? {}), [sessionId]: { term: t, fit: f, host: host.current } }

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
    /** Rendered height of one row, in px, straight off the thing being scrolled. */
    const rowHeight = (): number => {
      const vp = viewport()
      const rows = t.buffer.active.length
      const h = vp && rows ? vp.scrollHeight / rows : 0
      return h > 1 ? h : 17
    }
    /** Same question as nearBottom, asked of the DOM, so it is answerable mid-scroll. */
    const nearBottomInDom = (): boolean => {
      const vp = viewport()
      if (!vp) return nearBottom()
      return vp.scrollHeight - vp.scrollTop - vp.clientHeight <= rowHeight() * TAIL_SLACK + 1
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
    let pending = ''
    let dead = false
    const publish = (): void => {
      if (!dead) setMarks(list.slice())
    }

    const addMark = (text: string): void => {
      // Anchored to the row the cursor is on at submit time. xterm keeps a marker's line
      // right as the buffer scrolls and tells us when that line falls out of scrollback,
      // neither of which a plain line number could do.
      const marker = t.registerMarker(0)
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

    // What xterm wraps a paste in while the agent has bracketed paste on, which Claude Code
    // and Codex both do - so this, not a run of key events, is the normal path for a pasted
    // prompt. The closing wrapper can land in the same chunk or not, hence the optional tail.
    const BRACKETED = /^\x1b\[200~([\s\S]*?)(?:\x1b\[201~)?$/
    // A prompt longer than this is not readable in a hover label anyway, and the pending
    // buffer must not grow without bound on a session that never submits.
    const MAX_PROMPT = 400
    // A pasted prompt is one prompt however many lines it had, so its newlines join it up
    // rather than submitting it.
    const join = (s: string): string => (pending + s).replace(/[\r\n]+/g, ' ').slice(0, MAX_PROMPT)

    const feedInput = (d: string): void => {
      const paste = BRACKETED.exec(d)
      if (paste) {
        pending = join(paste[1])
        return
      }
      // Arrow keys, function keys, alt+enter - never prompt text.
      if (d.charCodeAt(0) === 0x1b) return
      // Anything longer than a keystroke arrived in one piece, so it is pasted or composed
      // text rather than a key.
      if (d.length > 1) {
        pending = join(d)
        return
      }
      if (d === '\x7f' || d === '\b') {
        pending = pending.slice(0, -1)
        return
      }
      // Ctrl+C and Ctrl+U both throw the line away, so the rail has to as well.
      if (d === '\x03' || d === '\x15') {
        pending = ''
        return
      }
      if (d === '\r' || d === '\n') {
        const text = pending.trim()
        pending = ''
        // A bare Enter is a confirmation or an accepted menu item, and a lone character is
        // a menu key. Tagging either would bury the real prompts.
        if (text.length > 1) addMark(text)
        return
      }
      // Tab, and every other control byte that is not handled above.
      if (d.charCodeAt(0) < 0x20) return
      pending = (pending + d).slice(0, MAX_PROMPT)
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
    })

    t.onSelectionChange(() => {
      const s = t.getSelection()
      if (s) lastSelection.current = s
    })

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
      const mod = isMac ? e.metaKey : e.ctrlKey
      if (!mod) return true
      const key = e.key.toLowerCase()

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
      // wheel belongs to the app. Otherwise scroll this terminal ourselves: xterm skips its
      // own viewport entirely while the agent is asking for mouse events.
      //
      // This does NOT depend on the mouse-select setting. That setting is about drag
      // selection; tying the wheel to it meant that with it off, a wheel anywhere over the
      // text went to the agent and only the strip of pixels over the scrollbar scrolled the
      // pane - the whole middle and left of a pane read as "scrolling is stuck".
      if (mouseGrabbed() && t.buffer.active.type !== 'alternate') {
        e.preventDefault()
        e.stopPropagation()
        // A notch has to cover the same ground here as it does in a pane the browser is
        // scrolling itself, and a fixed 40px per line was not close. Measured at this
        // pane's 15.2px rows: 2 lines a notch against the ~7 a native notch of the same
        // deltaY moves. Every agent pane grabs the mouse, so that was every AI session -
        // and while one is printing, 2 lines down against a line of new output per notch
        // means the tail is not reachable by wheel at all, only by the pill.
        const lines = e.deltaMode === 1 ? e.deltaY : e.deltaY / rowHeight()
        t.scrollLines(Math.trunc(lines) || (e.deltaY < 0 ? -1 : 1))
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
    // xterm only emits onScroll when *it* moved the view, so in a pane that is not printing
    // a wheel notch or a thumb drag changed nothing anyone was listening to: measured 118
    // lines up from the tail with the pill still hidden and the pane still marked as
    // following, until the next write happened to re-ask the question. The element's own
    // scroll event is the missing half, and it reads the DOM because the buffer's viewportY
    // is still a frame behind at this point.
    const vpEl = viewport()
    const onViewportScroll = (): void => {
      const follow = nearBottomInDom()
      pinned.current = follow
      setScrolledUp(!follow)
    }
    vpEl?.addEventListener('scroll', onViewportScroll, { passive: true })

    el.addEventListener('keydown', onKeyClearsSelection, true)
    el.addEventListener('mousedown', forceSelectable, true)
    el.addEventListener('mousedown', onMouseDown, true)
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
        t.write(b, () => t.scrollToBottom())
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
      const at = Date.now()
      lastBusyCheck = at
      let now = false
      let text = ''
      try {
        text = screenText(t, BUSY_ROWS)
        // A question on screen is not work in progress, whatever the footer says.
        now = !ASK_PROMPT.test(text) && BUSY_FOOTER.test(text)
      } catch {
        return
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
      if (now === busy && !(now && at - lastReport > BUSY_RESTATE)) return
      busy = now
      lastReport = at
      // The frame goes with a `false` only: that is the reading that can ring the bell,
      // and it is the one worth being able to read back afterwards.
      api.setBusy(sessionId, now, now ? undefined : text)
    }

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
      t.write(data, () => {
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
        refit(t, f, true)
        api.resize(sessionId, t.cols, t.rows)
        api.redraw(sessionId)
        t.refresh(0, t.rows - 1)
        t.scrollToBottom()
        setScrolledUp(false)
      } catch {
        /* hidden or detached - the visibility effect refits it */
      }
    }
    paneRepair.set(sessionId, repair)
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
      try {
        changed = refit(t, f, pinned.current)
        if (changed) api.resize(sessionId, t.cols, t.rows)
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
      // A resize is where panes get garbled: the agent redraws against a size it half
      // missed and leaves torn boxes behind. Once the dragging stops, make it draw the
      // whole frame again. Held off for the first seconds so a CLI still painting its
      // welcome screen is not poked mid-paint.
      window.clearTimeout(settle)
      settle = window.setTimeout(() => {
        if (!autoFixRef.current || Date.now() - mountedAt < 3000) return
        if (!host.current?.offsetParent) return
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
      ro.disconnect()
      window.clearTimeout(settle)
      window.clearTimeout(settle2)
      window.clearInterval(busyTick)
      paneRepair.delete(sessionId)
      paneInsert.delete(sessionId)
      el.removeEventListener('keydown', onKeyClearsSelection, true)
      el.removeEventListener('mousedown', forceSelectable, true)
      el.removeEventListener('mousedown', onMouseDown, true)
      el.removeEventListener('mouseup', onMouseUp)
      el.removeEventListener('wheel', onWheel, true)
      vpEl?.removeEventListener('scroll', onViewportScroll)
      el.removeEventListener('contextmenu', onContextMenu)
      // Emptied first so the onDispose handlers find nothing to remove and skip publishing
      // into a component that is on its way out.
      dead = true
      for (const m of list.splice(0)) m.marker.dispose()
      t.dispose()
    }
  }, [sessionId])

  // Font size is a live setting: change it and every pane re-lays out immediately.
  useEffect(() => {
    const t = term.current
    if (!t || t.options.fontSize === fontSize) return
    t.options.fontSize = fontSize
    try {
      if (fit.current) refit(t, fit.current, pinned.current)
      api.resize(sessionId, t.cols, t.rows)
      // Fewer or more rows means a different scale for the rail.
      syncTotal()
    } catch {
      /* hidden pane - the visibility effect will refit it */
    }
  }, [fontSize, sessionId])

  // Re-fit when this pane becomes visible again: the terminal was not measurable
  // while hidden, so its cols/rows can be stale.
  useEffect(() => {
    if (!visible) return
    const id = requestAnimationFrame(() => {
      try {
        if (term.current && fit.current) {
          // Same rule as the observer: only a pane that really changed shape while it was
          // away gets to disturb the pty. Coming back unchanged must be silent.
          if (refit(term.current, fit.current, pinned.current)) {
            api.resize(sessionId, term.current.cols, term.current.rows)
          }
          // The buffer kept growing while this pane was hidden, so the rail is stale.
          syncTotal()
        }
        term.current?.focus()
      } catch {
        /* not laid out yet */
      }
    })
    return () => cancelAnimationFrame(id)
  }, [visible, sessionId])

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
      {/* Rendered before the pill and the drop hint on purpose: all three are positioned,
          so DOM order is what keeps a tag near the tail from painting over the pill. */}
      {marks.length > 0 && (
        <div
          className="mark-rail"
          style={{ top: track.top, height: track.height || undefined }}
        >
          {marks.map((m, i) => {
            const line = m.marker.line
            // -1 means xterm disposed it a frame before the state caught up.
            if (line < 0) return null
            // A tag points at the scrollbar thumb that reaches its line, so it is placed
            // the way Chromium places that thumb: the fraction is of the scrolling range
            // (everything above the last screenful), and the travel is the track less one
            // thumb - which has a 48px floor of its own (the scrollbar block in
            // styles.css). Placed as a plain fraction of the track instead, a tag near the
            // tail sat most of a thumb's height below the thumb it stood for.
            const thumb = Math.max(48, (rows / Math.max(rows, total)) * track.height)
            const frac = Math.min(1, Math.max(0, line / Math.max(1, total - rows)))
            const top = frac * Math.max(0, track.height - thumb)
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
                style={{ top }}
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
      {dropping && <div className="drop-hint">Drop files to put their paths in the prompt</div>}
    </div>
  )
}
