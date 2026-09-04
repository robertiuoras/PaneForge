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

/**
 * How much of the far page fits in the picture.
 *
 * The remote page is made the shape of the box it is drawn into, so a half-window column
 * gave a 700px-wide browser and every desktop site rendered at its most cramped - "way
 * too zoomed in", 2026-09-04. Zoom is that box divided: at 50% the far browser is given
 * a viewport twice as wide as the column, so a whole desktop page is on screen, drawn
 * smaller. Nothing is scaled on this end - the page really is laid out at that width, so
 * text stays sharp and a click still lands where it was aimed.
 */
export const ZOOMS: readonly number[] = [0.33, 0.4, 0.5, 0.67, 0.8, 1, 1.25, 1.5]

/** The width a desktop site expects before it starts folding itself into a phone layout. */
export const PAGE_WIDTH = 1280
/** No remote viewport smaller than this, whatever the column does. */
export const MIN_VIEW = { w: 640, h: 400 }
/** Nor bigger: a viewport nobody can read costs frames for nothing. */
export const MAX_VIEW = { w: 3840, h: 2400 }

/** The viewport to give the far browser, for a box this size at this zoom. */
export function viewportFor(box: { w: number; h: number }, zoom: number): { w: number; h: number } {
  const z = zoom > 0 ? zoom : 1
  return {
    w: Math.max(MIN_VIEW.w, Math.min(MAX_VIEW.w, Math.round(box.w / z))),
    h: Math.max(MIN_VIEW.h, Math.min(MAX_VIEW.h, Math.round(box.h / z)))
  }
}

/**
 * The zoom that shows a whole desktop page in this box: the biggest rung whose viewport
 * is still at least `PAGE_WIDTH` wide. A box already wider than that gets 100%, because
 * shrinking a page that already fits only makes it harder to read.
 */
export function fitZoom(box: { w: number; h: number }): number {
  if (!(box.w > 0)) return 1
  const want = box.w / PAGE_WIDTH
  if (want >= 1) return 1
  let best = ZOOMS[0]
  for (const z of ZOOMS) if (z <= want && z > best) best = z
  return best
}

/** One rung in or out, never off the end of the ladder. */
export function zoomStep(zoom: number, dir: 1 | -1): number {
  const i = ZOOMS.indexOf(zoom)
  if (i < 0) {
    // A zoom that is not on the ladder (a fit) steps to its nearest neighbour in that
    // direction, so pressing + after a fit always makes the page bigger.
    const up = ZOOMS.find((z) => z > zoom)
    const down = [...ZOOMS].reverse().find((z) => z < zoom)
    return (dir === 1 ? up : down) ?? zoom
  }
  return ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, i + dir))] ?? zoom
}

/** What the button says. */
export function zoomWords(zoom: number): string {
  return `${Math.round(zoom * 100)}%`
}

/** How wide the sign-in column may be dragged, in this window. */
export const MIN_SPLIT = 380
/** A pane narrower than this is not a pane any more, so the column stops here. */
export const KEEP_PANE = 300
export function clampSplit(px: number, windowWidth: number): number {
  const most = Math.max(MIN_SPLIT, windowWidth - KEEP_PANE)
  return Math.round(Math.max(MIN_SPLIT, Math.min(most, px)))
}

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
 * Is this desk's own shortcut allowed to act right now?
 *
 * The picture owns the keyboard while it is on, and owning it has to mean the WHOLE
 * keyboard. `loginKeys` stops a key in the capture phase, which silences everything
 * deeper in the page - the terminal, the composer, the dialogs - but not another
 * listener already sitting on `window` in the same phase, and the app's own shortcut
 * list is exactly that. It is registered when the window opens, long before the picture
 * exists, so it runs FIRST and `stopImmediatePropagation` never reaches it.
 *
 * Measured in a real window 2026-09-03, with the picture holding the keyboard: the
 * letters of a password went only to the far machine (nothing reached the pane), but
 * Cmd+F opened this app's own Find box at the same time as the F arrived over there.
 *
 * The line is the one `forwarded` already draws: a key the far machine must not have is
 * a key this desk still owns, and everything else belongs to the picture.
 */
export function chordAllowed(pictureHasKeyboard: boolean, k: KeyIn): boolean {
  if (!pictureHasKeyboard) return true
  return !forwarded(k)
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
  // A paste is decided in MAIN, because only main can see this machine's clipboard as
  // anything but text: a copied screenshot is a picture, and sending its file path is
  // sending a name that means nothing on the other computer.
  | { kind: 'paste' }


/* ------------------------------------------------------------------ pasting a picture

   A clipboard holding a screenshot is not text, and the far machine cannot be handed a
   path: `/Users/robert/Desktop/shot.png` names nothing on the PC. So the bytes travel,
   and the page is given a real `paste` event carrying a real `File` - which is what
   every upload box, comment field and rich editor is already listening for.

   Robert, 2026-09-04: pasting an image "doesnt put the image instead the local url". */

/** What a copied file has to be named for its bytes to be treated as a picture. */
export const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.heic'] as const

export function mimeForImage(path: string): string | null {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return null
  const ext = path.slice(dot).toLowerCase()
  if (!(IMAGE_EXTS as readonly string[]).includes(ext)) return null
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.heic') return 'image/heic'
  return `image/${ext.slice(1)}`
}

/**
 * The picture a clipboard's TEXT is pointing at, if it is pointing at one.
 *
 * macOS puts a copied Finder file on the clipboard as a `file://` line and nothing else,
 * so the text half is the only place the picture is named. Only an absolute path is
 * taken - a relative one is relative to a folder this app is not standing in.
 */
export function imagePathFromText(text: string): string | null {
  const one = text.trim().split(/\r?\n/)[0]?.trim() ?? ''
  if (!one) return null
  let path = one
  if (/^file:\/\//i.test(path)) {
    try {
      path = decodeURIComponent(path.replace(/^file:\/\//i, ''))
    } catch {
      return null
    }
  }
  if (!path.startsWith('/') && !/^[a-z]:[\\/]/i.test(path)) return null
  return mimeForImage(path) ? path : null
}

/**
 * The page's own paste, built in the page.
 *
 * `Input.insertText` can only carry text and a synthetic Cmd+V would paste the FAR
 * machine's clipboard, which is not the one the picture is on. Dispatching the event is
 * the only path that hands a page the bytes; a page that ignores `paste` (a plain
 * `<input type=file>` with no drop handler) gets nothing, and says so by not changing.
 */
export function pasteImageScript(base64: string, mime: string, name: string): string {
  const safe = JSON.stringify({ base64, mime, name })
  return `(() => {
  const a = ${safe};
  const bin = atob(a.base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const file = new File([bytes], a.name, { type: a.mime });
  const dt = new DataTransfer();
  dt.items.add(file);
  const el = document.activeElement && document.activeElement !== document.body
    ? document.activeElement
    : (document.querySelector('[contenteditable="true"], textarea, input[type="file"]') || document.body);
  const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
  const took = el.dispatchEvent(ev);
  if (el.tagName === 'INPUT' && el.type === 'file') { el.files = dt.files; el.dispatchEvent(new Event('change', { bubbles: true })); }
  return took;
})()`
}

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
  /** The pane that asked wants this picture in front now, rather than a card to click. */
  show?: boolean
}

/**
 * What a pane asked for last time, so that asking again can be one word.
 *
 * Robert, 2026-09-03: "allow me to just ask, like that session who wanted it, to open
 * again the login and it knows how to open it." The session that hit the sign-in wall
 * already said which site, which computer and which page; repeating all of it to see the
 * picture a second time is the app making the person do its remembering.
 */
export interface LoginAsk {
  site: string
  url: string
  host?: string
  port?: number
  machine?: string
}

/**
 * The word a person would use for a web address: `https://www.facebook.com/login` is
 * `facebook`. The last label is the suffix (`com`), and a short one in front of it is
 * part of the suffix too (`co.uk`), so the name is what is left after those. An address
 * that is a number is its own name - nobody calls 127.0.0.1 anything else.
 */
export function siteFromUrl(url: string): string {
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    return ''
  }
  host = host.replace(/^www\./i, '').toLowerCase()
  if (!host) return ''
  if (/^[\d.]+$/.test(host) || host.includes(':')) return host
  const labels = host.split('.').filter(Boolean)
  if (labels.length < 2) return host
  const parts = [...labels]
  parts.pop()
  if (parts.length > 1 && parts[parts.length - 1].length <= 3) parts.pop()
  return parts[parts.length - 1] ?? host
}

/**
 * A pane asking again: whatever it says now wins, and everything it leaves out is what it
 * said last time. A pane that has never asked and names no page is refused in a sentence
 * that says what to type, because there is nothing to guess from.
 */
export function askAgain(
  prev: LoginAsk | undefined,
  input: Partial<LoginAsk>
): { ok: true; ask: LoginAsk } | { ok: false; why: string } {
  const url = (input.url ?? '').trim() || prev?.url || ''
  if (!url)
    return {
      ok: false,
      why: 'Say which page to sign in on, like: pf login https://www.facebook.com/login'
    }
  if (!/^https?:\/\//i.test(url))
    return { ok: false, why: `A sign-in page starts with http:// or https:// - got "${url}"` }
  const sameUrl = url === prev?.url
  const site = (input.site ?? '').trim() || (sameUrl ? (prev?.site ?? '') : '') || siteFromUrl(url) || 'the website'
  const host = input.host?.trim() || prev?.host
  const sameHost = host === prev?.host
  return {
    ok: true,
    ask: {
      site,
      url,
      host,
      port: input.port ?? (sameHost ? prev?.port : undefined),
      machine: input.machine?.trim() || (sameHost ? prev?.machine : undefined)
    }
  }
}

/**
 * Which sign-in the window should put in front, if any.
 *
 * A card waits for somebody to walk past it. When the session that hit the wall asks for
 * the picture itself, waiting is wrong - it marks the request `show`, and the window
 * opens it the moment it hears about it. Newest first, and never the one already open,
 * so hearing the same list twice does not reopen anything.
 */
export function raiseLogin(reqs: readonly LoginRequest[], current: string | null): string | null {
  const wanted = [...reqs].filter((r) => r.show).sort((a, b) => b.at - a.at)[0]
  if (!wanted || wanted.id === current) return null
  return wanted.id
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
