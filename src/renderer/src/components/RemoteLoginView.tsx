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
import { lagWord, loginKeys, STEPS, type LoginRequest } from '../../../shared/remoteLogin'

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
  const box = useRef<HTMLDivElement | null>(null)
  const [spot, setSpot] = useState<Spot | null>(null)
  const [typing, setTyping] = useState(false)
  const [fps, setFps] = useState(0)
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
  // The remote page is made the shape of this box, so nothing is letterboxed and no
  // pixel of the picture is spent on a margin. Debounced: a drag resizes 60 times a
  // second and each one restarts the screencast at the far end.
  useEffect(() => {
    const el = box.current
    if (!el) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const ro = new ResizeObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        const r = el.getBoundingClientRect()
        if (r.width > 0 && r.height > 0) window.api.loginSize(req.id, Math.round(r.width), Math.round(r.height))
      }, 150)
    })
    ro.observe(el)
    const r = el.getBoundingClientRect()
    window.api.loginSize(req.id, Math.round(r.width), Math.round(r.height))
    return () => {
      clearTimeout(timer)
      ro.disconnect()
    }
  }, [req.id])

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
      paste: () => {
        void window.api.readClipboard().then((text) => {
          if (text) window.api.loginInput(req.id, { kind: 'text', text })
        })
      },
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
      <header className="login-head">
        <span className="login-site">{req.site}</span>
        <span className="login-where">on {req.machine}</span>
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
          ref={box}
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
            <div className="login-tip">Click the picture to type into it. Press Escape twice to stop.</div>
          )}
        </div>
      )}
    </section>
  )
}
