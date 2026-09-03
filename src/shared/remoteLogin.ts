/**
 * Signing in to another machine's automation Chrome, from inside a pane.
 *
 * A scheduled job that hits a login wall cannot type. It says so - `pf needs-login
 * <site> --url <url> --host user@ip` - and the app puts a card up; opening it shows a
 * LIVE picture of that machine's Chrome beside the chat, and the person types the login
 * into it. No RDP and no VNC: the picture is CDP's own `Page.startScreencast`, and the
 * typing is `Input.dispatch*`, over an ssh tunnel the app opens itself.
 *
 * This file is the arithmetic, so the two ends agree on it and a test can drive it with
 * no Chrome and no window: which point on the remote page a click landed on, what a
 * keystroke becomes on a machine that has never heard of Cmd, and - the part that
 * decides whether it is usable over a slow link - when to spend less on each frame.
 *
 * The smoothness model is one sentence: ONE frame in flight, never a queue. The remote
 * sends a frame, the renderer paints it, the renderer says it painted it, and only then
 * is the frame acknowledged to Chrome, which is what asks for the next one. A link that
 * goes slow therefore drops the frame RATE and never grows a backlog, so the picture is
 * always the present rather than a recording of the last ten seconds.
 */

/** What the picture costs, coarsest last. Step 0 is what a healthy link gets. */
export interface Step {
  readonly quality: number
  readonly maxWidth: number
  readonly maxHeight: number
}

export const STEPS: readonly Step[] = [
  { quality: 60, maxWidth: 1440, maxHeight: 900 },
  { quality: 40, maxWidth: 960, maxHeight: 600 },
  { quality: 30, maxWidth: 720, maxHeight: 450 }
]

/** Above this the link is limping; above SLOW_MS it is barely a link. */
export const LAGGY_MS = 250
export const SLOW_MS = 600
/** Recovery is earned, not assumed: this many consecutive quick frames buys one step back. */
export const GOOD_RUN = 20
export const GOOD_MS = 150
/** The median is over the recent past, not the whole session - a stall an hour ago is not now. */
export const RTT_WINDOW = 20

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * The next rung, given where we are and how the link has been behaving.
 *
 * Stepping DOWN is immediate, because the person is looking at a picture that is already
 * late. Stepping UP needs `GOOD_RUN` quick frames in a row, because a link that recovers
 * for one frame and then does not has cost two step changes and bought nothing - and
 * each change restarts the screencast, which is itself a visible hitch.
 */
export function nextStep(current: number, medianRtt: number, goodRun: number): number {
  if (medianRtt > SLOW_MS) return STEPS.length - 1
  if (medianRtt > LAGGY_MS) return Math.max(current, 1)
  if (goodRun >= GOOD_RUN) return Math.max(0, current - 1)
  return current
}

/** How the header says it: amber is limping, red is barely a link. */
export function lagWord(medianRtt: number): 'ok' | 'slow' | 'bad' {
  if (medianRtt > SLOW_MS) return 'bad'
  if (medianRtt > LAGGY_MS) return 'slow'
  return 'ok'
}

/**
 * The flow control, as a state machine with no Chrome in it.
 *
 * `frame()` answers with the frame to paint, or null when one is already out there being
 * painted - in which case the newcomer REPLACES whatever was waiting, so a link that
 * catches up paints the present and not a stale frame it happens to still be holding.
 */
export class Pacer {
  private inFlight: { ack: number; at: number } | null = null
  private pending: { ack: number; at: number } | null = null
  private rtts: number[] = []
  private goodRun = 0
  /** Frames that arrived while one was being painted, and were therefore never drawn. */
  skipped = 0
  step = 0

  /** A frame came off the wire. Returns the ack id to paint now, or null to hold it. */
  frame(ack: number, at: number): number | null {
    if (this.inFlight) {
      if (this.pending) this.skipped++
      this.pending = { ack, at }
      return null
    }
    this.inFlight = { ack, at }
    return ack
  }

  /** The renderer painted it. Returns the next frame to paint, if one was waiting. */
  painted(at: number): { rtt: number; next: number | null } {
    const sent = this.inFlight
    this.inFlight = null
    const rtt = sent ? Math.max(0, at - sent.at) : 0
    if (sent) {
      this.rtts.push(rtt)
      if (this.rtts.length > RTT_WINDOW) this.rtts.shift()
      this.goodRun = rtt < GOOD_MS ? this.goodRun + 1 : 0
      const was = this.step
      this.step = nextStep(this.step, this.medianRtt(), this.goodRun)
      // A step change is a fresh screencast, so the run that earned it is spent.
      if (this.step !== was) this.goodRun = 0
    }
    let next: number | null = null
    if (this.pending) {
      this.inFlight = this.pending
      this.pending = null
      next = this.inFlight.ack
    }
    return { rtt, next }
  }

  /** Never more than one: the whole point. */
  unacked(): number {
    return this.inFlight ? 1 : 0
  }

  medianRtt(): number {
    return median(this.rtts)
  }

  /** A step change restarts the screencast, so the frame that was out there is gone. */
  reset(): void {
    this.inFlight = null
    this.pending = null
  }
}

/** What a screencast frame says about the page it is a picture of. */
export interface FrameMeta {
  readonly deviceWidth: number
  readonly deviceHeight: number
  readonly pageScaleFactor?: number
  readonly offsetTop?: number
}

/**
 * A point on the canvas, in the remote page's own CSS pixels.
 *
 * The JPEG is whatever size the step allows and the canvas is whatever size the pane is,
 * so neither is the page's coordinate system; the metadata's `deviceWidth/Height` is, and
 * it is the viewport, so the page's scroll never enters into it - `Input.dispatchMouseEvent`
 * takes viewport coordinates. Clamped, because a click on the last pixel of a canvas that
 * is one pixel wider than the picture must land on the page rather than beside it.
 */
export function toRemotePoint(
  p: { x: number; y: number },
  canvas: { width: number; height: number },
  meta: FrameMeta
): { x: number; y: number } {
  if (!canvas.width || !canvas.height) return { x: 0, y: 0 }
  const x = (p.x / canvas.width) * meta.deviceWidth
  const y = (p.y / canvas.height) * meta.deviceHeight
  return {
    x: Math.max(0, Math.min(meta.deviceWidth - 1, Math.round(x))),
    y: Math.max(0, Math.min(meta.deviceHeight - 1, Math.round(y)))
  }
}

/** CDP's modifier bitmask. */
export const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const

export interface KeyIn {
  readonly key: string
  readonly code: string
  readonly ctrl?: boolean
  readonly meta?: boolean
  readonly shift?: boolean
  readonly alt?: boolean
}

export interface CdpKey {
  type: 'keyDown' | 'keyUp'
  key: string
  code: string
  windowsVirtualKeyCode: number
  nativeVirtualKeyCode: number
  modifiers: number
  text?: string
  unmodifiedText?: string
}

/**
 * The keys a browser names and Windows numbers. Anything not here that is one character
 * long is its own uppercase code point, which is what a virtual key code is for letters
 * and digits; anything else gets 0, which Chrome reads as "no virtual key" and still
 * delivers as a named key.
 */
const VK: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Shift: 16,
  Control: 17,
  Alt: 18,
  Escape: 27,
  ' ': 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46
}

/**
 * A keystroke, as the remote Chrome would have got it from its own keyboard.
 *
 * `mapMetaToCtrl` is not a nicety: Windows Chrome has no Meta accelerator, so a Mac
 * pressing Cmd+A at a PC's Chrome selects nothing at all unless the Cmd is carried
 * across as a Ctrl. `text` is sent only for a printable key with no accelerator held,
 * because a `text` alongside Ctrl is how you type a literal control character into a
 * password field instead of firing the shortcut.
 */
export function keyEvent(
  k: KeyIn,
  type: 'keyDown' | 'keyUp',
  opts: { mapMetaToCtrl?: boolean } = {}
): CdpKey {
  const meta = Boolean(k.meta)
  const asCtrl = meta && opts.mapMetaToCtrl === true
  const ctrl = Boolean(k.ctrl) || asCtrl
  let modifiers = 0
  if (k.alt) modifiers |= MOD.alt
  if (ctrl) modifiers |= MOD.ctrl
  if (meta && !asCtrl) modifiers |= MOD.meta
  if (k.shift) modifiers |= MOD.shift
  const printable = k.key.length === 1
  // A virtual key code is only a code point for the LETTERS AND DIGITS - the ones whose
  // VK numbers are their ASCII values. Everything else printable has a VK that is nothing
  // to do with its character, and guessing it is worse than sending none: measured
  // 2026-09-03 against the PC's Chrome, `.` was sent as 46, which is VK_DELETE, so typing
  // `robert@example.com` into a login box produced `robert@examplecom` - a character
  // silently swallowed by the key that deleted the one after it. Chrome types the `text`
  // when there is no virtual key claiming to be something else.
  const alnum = printable && /[a-zA-Z0-9]/.test(k.key)
  const vk = VK[k.key] ?? (alnum ? k.key.toUpperCase().charCodeAt(0) : 0)
  const out: CdpKey = {
    type,
    key: k.key,
    code: k.code,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
    modifiers
  }
  if (type === 'keyDown' && printable && !ctrl && !k.alt && !(meta && !asCtrl)) {
    out.text = k.key
    out.unmodifiedText = k.shift ? k.key.toLowerCase() : k.key
  }
  // Enter's own text is what makes a form submit rather than merely move focus.
  if (type === 'keyDown' && k.key === 'Enter') out.text = '\r'
  if (type === 'keyDown' && k.key === 'Tab') out.text = '\t'
  return out
}

/**
 * Keys that stay on THIS machine.
 *
 * Cmd/Ctrl+W would close the remote tab, which is the session the whole feature exists
 * to keep; Cmd/Ctrl+Q and Cmd/Ctrl+N would take the remote browser somewhere nobody can
 * see. The view has its own way out (Esc twice), so nothing is trapped.
 */
export function forwarded(k: KeyIn): boolean {
  const accel = Boolean(k.ctrl) || Boolean(k.meta)
  if (accel && ['w', 'W', 'q', 'Q', 'n', 'N'].includes(k.key)) return false
  return true
}

/**
 * What the view is allowed to say about a pointer or a key.
 *
 * The renderer sends the point it was clicked at ON ITS OWN CANVAS, with the canvas size,
 * and main converts. Putting the conversion in main rather than the renderer means the
 * frame metadata - the only thing that knows the page's real size - never has to be
 * mirrored across the wire, and a phone watching the same view gets the same answer.
 */
export type LoginInput =
  | {
      kind: 'mouse'
      type: 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel'
      x: number
      y: number
      w: number
      h: number
      button?: 'none' | 'left' | 'middle' | 'right'
      buttons?: number
      clickCount?: number
      deltaX?: number
      deltaY?: number
      modifiers?: number
    }
  | { kind: 'key'; type: 'keyDown' | 'keyUp'; k: KeyIn }
  | { kind: 'text'; text: string }

/** Two Escapes inside this long hand the keyboard back to this desk. */
export const ESC_RELEASE_MS = 700

/** What a keystroke bound for the far machine is allowed to do. */
export interface KeyDeck {
  /** Send it to the other computer. */
  send(input: LoginInput): void
  /** A paste is one insert, not a keystroke per character. */
  paste(): void
  /** Give the keyboard back to this desk. */
  release(): void
}

/**
 * As much of a keyboard event as the decision needs, so the decision can be tested with
 * no browser at all. A real `KeyboardEvent` already satisfies this.
 */
export interface KeyEventLike {
  key: string
  code: string
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
  preventDefault(): void
  stopPropagation(): void
  stopImmediatePropagation?(): void
}

/**
 * One keystroke, ONE destination.
 *
 * The bug this exists to stop: while the picture had the keyboard, every letter typed
 * arrived on the far machine AND in the pane it was typed from, because the view only
 * called `preventDefault`. That stops the BROWSER acting on a key; it does not stop
 * another listener hearing it, and the terminal in the pane is exactly such a listener -
 * xterm reads the key off its own hidden textarea and writes it to the pty itself
 * (`TerminalPane.tsx`, `t.onData` -> `api.write`). So a password was typed into the
 * login page and into the agent's prompt at the same time.
 *
 * The listener is on the WINDOW in the capture phase, the first place in the document an
 * event is seen, so stopping propagation here stops it before anything deeper - the
 * terminal, the composer, the app's own dialogs - is ever asked. Keys the far machine
 * must NOT have (`forwarded`) are deliberately left alone and stay on this desk.
 */
export function loginKeys(
  deck: KeyDeck,
  now: () => number = () => Date.now()
): { down(e: KeyEventLike): void; up(e: KeyEventLike): void } {
  let escAt = 0
  /** Take the key off this machine entirely: no default, and no second listener. */
  const claim = (e: KeyEventLike): void => {
    e.preventDefault()
    e.stopPropagation()
    e.stopImmediatePropagation?.()
  }
  const read = (e: KeyEventLike): KeyIn => ({
    key: e.key,
    code: e.code,
    ctrl: Boolean(e.ctrlKey),
    meta: Boolean(e.metaKey),
    shift: Boolean(e.shiftKey),
    alt: Boolean(e.altKey)
  })
  return {
    down(e: KeyEventLike): void {
      const k = read(e)
      // Two Escapes hand the keyboard back. One Escape is a key the login page itself may
      // want (closing a cookie banner), so it is forwarded as well.
      if (k.key === 'Escape') {
        const t = now()
        if (t - escAt < ESC_RELEASE_MS) {
          escAt = 0
          claim(e)
          deck.release()
          return
        }
        escAt = t
      }
      if (!forwarded(k)) return
      claim(e)
      if ((k.meta || k.ctrl) && (k.key === 'v' || k.key === 'V')) {
        deck.paste()
        return
      }
      deck.send({ kind: 'key', type: 'keyDown', k })
    },
    up(e: KeyEventLike): void {
      const k = read(e)
      if (!forwarded(k)) return
      claim(e)
      deck.send({ kind: 'key', type: 'keyUp', k })
    }
  }
}

/** A request from a script that cannot type. */
export interface LoginRequest {
  id: string
  /** What the person will recognise: `facebook`, `linkedin`. */
  site: string
  url: string
  /** `user@address`. Absent means this machine's own automation Chrome. */
  host?: string
  port: number
  /** Words for the machine, for a reader who has never used ssh. */
  machine: string
  at: number
  state: 'waiting' | 'opening' | 'open' | 'signed in' | 'failed'
  /** Set when `state` is `failed`; the ssh or Chrome error, in full. */
  error?: string
  /** Which pane asked, when a pane did. */
  from?: string
  /** Last painted frame's round trip, in ms - what the header badge reads. */
  rtt?: number
  /** Which rung of STEPS the picture is being sent at. */
  step?: number
}

/**
 * Which machine, in words.
 *
 * Robert has two desks and the copy has to name them the way he does. No host means the
 * machine the window is on; a host means the other one. A caller that knows better says
 * so with `--machine`.
 */
export function machineWord(host: string | undefined, platform: string): string {
  const mac = platform === 'darwin'
  if (!host) return mac ? 'this Mac' : 'this PC'
  return mac ? 'the PC' : 'the Mac'
}

export function siteWord(site: string): string {
  const s = site.trim()
  if (!s) return 'A website'
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * The card, for somebody who has never used a terminal. No "CDP", no "host", no "target"
 * - a website wants a password and it has to be typed on a particular computer.
 */
export function loginCardText(req: Pick<LoginRequest, 'site' | 'machine'>): {
  title: string
  body: string
  open: string
} {
  return {
    title: `${siteWord(req.site)} needs you to sign in`,
    body: `A job is waiting for ${siteWord(req.site)} on ${req.machine}. Open it and sign in - the sign-in stays on that computer.`,
    open: 'Open and sign in'
  }
}

/** The pane's own header, once it is open. */
export function loginPaneTitle(req: Pick<LoginRequest, 'site' | 'machine'>): string {
  return `Sign in to ${siteWord(req.site)} on ${req.machine}`
}

/**
 * Does the page look signed in?
 *
 * Best effort and never a decision: it turns the header hint on, and Done stays a human
 * click. A host change is the strong reading (an OAuth hop lands somewhere else); a path
 * that no longer looks like a login is the weak one.
 */
export function looksSignedIn(startUrl: string, nowUrl: string): boolean {
  let a: URL, b: URL
  try {
    a = new URL(startUrl)
    b = new URL(nowUrl)
  } catch {
    return false
  }
  if (a.host !== b.host) return true
  const loginish = /(^|\/)(login|signin|sign-in|auth|sessions?\/new|account\/login)(\/|$)/i
  return loginish.test(a.pathname) && !loginish.test(b.pathname)
}
