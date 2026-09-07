/**
 * The other machine's browser, beside the chat.
 *
 * A picture and a keyboard, and nothing else: every fact about the connection is in the
 * main process (`src/main/remoteLogin.ts`), and this file only paints what it is given
 * and says when it has painted it. Saying so is load-bearing - it is what asks for the
 * next frame - so every path out of the paint, including a frame that will not decode,
 * ends in `loginPainted`. A view that forgets once goes black and stays black.
 *
 * Drawn to the surface ladder in `toolstash/design-vault/linear.app.md`, which is what
 * the pane header and `.copy-menu` in this app already follow: one hairline border, the
 * app's own surface tokens, no card shadow, and the two motion durations (--fast for a
 * hover, nothing at all for the picture itself).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  clampSplit,
  splitFor,
  fitZoom,
  lagWord,
  loginKeys,
  STEPS,
  viewportFor,
  zoomStep,
  zoomWords,
  type LoginRequest
} from '../../../shared/remoteLogin'

/** How wide the column was left last time. Per machine, so it is not worth a config key. */
const WIDTH_KEY = 'pf.loginWidth'

/**
 * The room the column and the panes SHARE.
 *
 * Not the window: the sessions list is on the left and never gives its width up, so a
 * column clamped against the window leaves the panes whatever is left over from both.
 * Measured 2026-09-07 in a headless copy - at a 1024px window the column sat at 480px
 * and the terminal beside it was 165px wide, which is a pane in name only.
 */
function roomForSplit(): number {
  const panes = document.querySelector('.panes')
  const w = panes ? panes.getBoundingClientRect().width : 0
  return w > 0 ? Math.round(w) : window.innerWidth
}

function savedWidth(): number {
  const raw = Number(localStorage.getItem(WIDTH_KEY) ?? 0)
  return splitFor(roomForSplit(), raw > 0 ? raw : null)
}

/** The pointer ring is drawn HERE the moment the mouse moves, so it never waits on a frame. */
interface Spot {
  x: number
  y: number
}

export default function RemoteLoginView({
  req,
  onDone,
  onClose,
  onToast
}: {
  req: LoginRequest
  onDone: () => void
  onClose: () => void
  onToast: (s: string) => void
}): React.JSX.Element {
  const canvas = useRef<HTMLCanvasElement | null>(null)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const [spot, setSpot] = useState<Spot | null>(null)
  const [typing, setTyping] = useState(false)
  const [fps, setFps] = useState(0)
  // null means "fit the page": the zoom is recomputed from the column's width, so
  // dragging the column wider shows the same page bigger rather than more of it.
  const [zoom, setZoom] = useState<number | null>(null)
  const [box, setBox] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  const [width, setWidth] = useState(savedWidth)
  /** The width somebody actually asked for, which the room may not have had. */
  const chosen = useRef<number | null>(Number(localStorage.getItem(WIDTH_KEY)) || null)
  const painted = useRef(0)
  const buttons = useRef(0)

  // ---- frames -------------------------------------------------------------------
  useEffect(() => {
    let gone = false
    let inFlight = false
    const off = window.api.onLoginFrame((f) => {
      if (gone || f.id !== req.id) return
      // A frame arriving while the last one is still decoding would put two bitmaps in
      // the air; main will not send one, but a mirror or a phone on the same channel can.
      if (inFlight) return
      inFlight = true
      const say = (): void => {
        inFlight = false
        painted.current++
        window.api.loginPainted(req.id, f.ack)
      }
      let bytes: Uint8Array
      try {
        const bin = atob(f.data)
        bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      } catch {
        // Unreadable, but the stream must not stall on it.
        say()
        return
      }
      // `createImageBitmap` and not `<img src="data:...">`: the img path decodes the
      // base64 AND the JPEG on the main thread every frame, and at 30 frames a second
      // that is the stutter people call "laggy remote desktop".
      void createImageBitmap(new Blob([bytes as unknown as BlobPart], { type: 'image/jpeg' }))
        .then((bmp) => {
          const c = canvas.current
          if (!c) {
            bmp.close()
            return
          }
          if (c.width !== bmp.width || c.height !== bmp.height) {
            c.width = bmp.width
            c.height = bmp.height
          }
          const ctx = c.getContext('2d')
          ctx?.drawImage(bmp, 0, 0)
          bmp.close()
        })
        .catch(() => {
          /* a torn frame is a dropped frame, never a stopped stream */
        })
        .finally(say)
    })
    return () => {
      gone = true
      off()
    }
  }, [req.id])

  // Frames per second, measured rather than assumed - the number the proof is written from.
  useEffect(() => {
    let last = painted.current
    const t = setInterval(() => {
      setFps(painted.current - last)
      last = painted.current
    }, 1000)
    return () => clearInterval(t)
  }, [])

  // ---- size ---------------------------------------------------------------------
  // Two numbers, not one: the BOX is this column in this window's pixels, and the
  // VIEWPORT is how wide the far page is told it is. They were the same number until
  // 2026-09-04, which is why a half-window column gave a 700px browser and every
  // desktop site rendered at its most cramped. Debounced, because a drag resizes 60
  // times a second and each one restarts the screencast at the far end.
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = (): void => {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) setBox({ w: Math.round(r.width), h: Math.round(r.height) })
    }
    const ro = new ResizeObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(read, 150)
    })
    ro.observe(el)
    read()
    return () => {
      clearTimeout(timer)
      ro.disconnect()
    }
  }, [req.id])

  const at = zoom ?? fitZoom(box)

  useEffect(() => {
    if (!(box.w > 0) || !(box.h > 0)) return
    const v = viewportFor(box, at)
    window.api.loginSize(req.id, v.w, v.h, box.w, box.h)
  }, [req.id, box.w, box.h, at])

  // ---- the column's own width -----------------------------------------------------
  // Written as a CSS variable rather than a style on this element, because the panes
  // beside it are padded by the same number and neither may be the other's parent.
  useEffect(() => {
    document.documentElement.style.setProperty('--login-w', `${width}px`)
    return () => {
      document.documentElement.style.removeProperty('--login-w')
    }
  }, [width])

  // A window that changes shape re-decides the column from the WIDTH SOMEBODY CHOSE, not
  // from the width it currently happens to be: clamping the clamped number is a ratchet,
  // and a column squeezed to its floor on a small window stayed 380px wide on a 1440px
  // one for the rest of the session (measured 2026-09-07).
  useEffect(() => {
    const onWindow = (): void => setWidth(splitFor(roomForSplit(), chosen.current))
    window.addEventListener('resize', onWindow)
    return () => window.removeEventListener('resize', onWindow)
  }, [])

  const grip = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent): void => {
      const want = window.innerWidth - ev.clientX
      chosen.current = want
      setWidth(clampSplit(want, roomForSplit()))
    }
    const up = (): void => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      setWidth((w) => {
        // What is remembered is what was asked for, so a drag done in a narrow window is
        // still honoured when there is room for it again.
        localStorage.setItem(WIDTH_KEY, String(chosen.current ?? w))
        return w
      })
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }, [])

  // ---- pointer ------------------------------------------------------------------
  const point = useCallback((e: React.MouseEvent | React.WheelEvent) => {
    const c = canvas.current
    if (!c) return null
    const r = c.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height }
  }, [])

  const mods = (e: React.MouseEvent | React.WheelEvent): number =>
    (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0)

  const moved = useRef<{ x: number; y: number; w: number; h: number } | null>(null)
  const frame = useRef(0)
  const flushMove = useCallback(() => {
    frame.current = 0
    const p = moved.current
    moved.current = null
    if (!p) return
    window.api.loginInput(req.id, {
      kind: 'mouse',
      type: 'mouseMoved',
      ...p,
      buttons: buttons.current,
      button: buttons.current ? 'left' : 'none'
    })
  }, [req.id])

  // ---- keys ---------------------------------------------------------------------
  // The picture owns the keyboard while it is on, and owning it means nothing else on
  // this desk hears the key: `loginKeys` stops the event dead in the capture phase, and
  // the caret is taken off whatever was holding it (the pane's terminal, normally) so the
  // browser has nothing local to type into either. Both halves are needed - the app puts
  // focus back on the active pane after any click, including the click on this picture.
  useEffect(() => {
    if (!typing) return
    const held = document.activeElement as HTMLElement | null
    if (held && held !== document.body) held.blur()
    const { down, up } = loginKeys({
      send: (input) => window.api.loginInput(req.id, input),
      // A paste is one insert, not a keystroke per character: forty key events for a
      // password manager's fill is forty round trips.
      // Main decides what a paste IS: the renderer's clipboard is text-only, so a copied
      // screenshot reached the far page as its own file path until 2026-09-04.
      paste: () => window.api.loginInput(req.id, { kind: 'paste' }),
      release: () => {
        setTyping(false)
        onToast('Keyboard is back on this computer.')
      }
    })
    window.addEventListener('keydown', down, true)
    window.addEventListener('keyup', up, true)
    return () => {
      window.removeEventListener('keydown', down, true)
      window.removeEventListener('keyup', up, true)
    }
  }, [typing, req.id, onToast])

  const rtt = req.rtt ?? 0
  const lag = lagWord(rtt)
  const step = STEPS[Math.min(req.step ?? 0, STEPS.length - 1)]
  const failed = req.state === 'failed'

  return (
    <section className="login-split" aria-label={`Sign in to ${req.site} on ${req.machine}`}>
      <div
        className="login-grip"
        onPointerDown={grip}
        role="separator"
        aria-orientation="vertical"
        aria-label="Drag to resize this column"
        title="Drag to resize"
      />
      <header className="login-head">
        <span className="login-site">{req.site}</span>
        <span className="login-where">on {req.machine}</span>
        {req.fromName && <span className="login-who">for {req.fromName}</span>}
        {/* The one thing a person cannot see in a picture: whose keyboard they are on.
            The outline round the picture says it quietly; this says it in words, because
            a password typed into the wrong machine is the failure that matters here. */}
        {typing && <span className="login-typing">typing into {req.machine}</span>}
        {!typing && req.state === 'open' && <span className="login-where">click the picture to type</span>}
        {req.state === 'signed in' && <span className="login-hint">looks signed in</span>}
        <span className={'login-badge ' + lag} title="How long each picture takes to arrive">
          {rtt}ms
        </span>
        <span className="login-badge q" title="How much detail is being sent - it drops on a slow link">
          {step.quality}
        </span>
        <span className="login-badge q" title="Pictures a second, measured">
          {fps}/s
        </span>
        <span className="login-zoom" role="group" aria-label="How much of the page is shown">
          <button
            className="login-btn"
            onClick={() => setZoom(zoomStep(at, -1))}
            title="Show more of the page"
            aria-label="Show more of the page"
          >
            −
          </button>
          <button className="login-btn" onClick={() => setZoom(null)} title="Fit the whole page in this column">
            {zoom === null ? `Fit ${zoomWords(at)}` : zoomWords(at)}
          </button>
          <button
            className="login-btn"
            onClick={() => setZoom(zoomStep(at, 1))}
            title="Make the page bigger"
            aria-label="Make the page bigger"
          >
            +
          </button>
        </span>
        <button className="login-btn primary" onClick={onDone}>
          Done
        </button>
        <button className="login-btn" onClick={onClose} aria-label="Close this view">
          Close
        </button>
      </header>

      {failed ? (
        <div className="login-failed">
          <p>PaneForge could not reach the browser on {req.machine}.</p>
          <pre>{req.error}</pre>
        </div>
      ) : (
        <div
          className={'login-screen' + (typing ? ' typing' : '')}
          ref={boxRef}
          onMouseDown={(e) => {
            const p = point(e)
            if (!p) return
            buttons.current = 1
            setTyping(true)
            window.api.loginInput(req.id, {
              kind: 'mouse',
              type: 'mousePressed',
              ...p,
              button: 'left',
              buttons: 1,
              clickCount: e.detail || 1,
              modifiers: mods(e)
            })
          }}
          onMouseUp={(e) => {
            const p = point(e)
            if (!p) return
            buttons.current = 0
            window.api.loginInput(req.id, {
              kind: 'mouse',
              type: 'mouseReleased',
              ...p,
              button: 'left',
              buttons: 0,
              clickCount: e.detail || 1,
              modifiers: mods(e)
            })
          }}
          onMouseMove={(e) => {
            const p = point(e)
            if (!p) return
            // The ring follows the hand at once. The remote hears about it once a frame,
            // because a mousemove per pixel is a hundred messages a second down a link
            // that is already the thing being economised.
            setSpot({ x: p.x, y: p.y })
            moved.current = p
            if (!frame.current) frame.current = requestAnimationFrame(flushMove)
          }}
          onMouseLeave={() => setSpot(null)}
          onWheel={(e) => {
            const p = point(e)
            if (!p) return
            // Ctrl/Cmd + wheel is the gesture every browser gives zoom, so it is spent
            // here rather than forwarded: the far page's own zoom would change what the
            // frame metadata means and a click would stop landing where it was aimed.
            if (e.ctrlKey || e.metaKey) {
              setZoom(zoomStep(at, e.deltaY < 0 ? 1 : -1))
              return
            }
            window.api.loginInput(req.id, {
              kind: 'mouse',
              type: 'mouseWheel',
              ...p,
              deltaX: e.deltaX,
              deltaY: e.deltaY,
              modifiers: mods(e)
            })
          }}
        >
          <canvas ref={canvas} className="login-canvas" />
          {spot && <i className="login-spot" style={{ left: spot.x, top: spot.y }} />}
          {!typing && (
            <div className="login-tip">
              Click the picture to type into it. Press Escape twice to stop. Ctrl or Cmd and the wheel zooms.
            </div>
          )}
        </div>
      )}
    </section>
  )
}
