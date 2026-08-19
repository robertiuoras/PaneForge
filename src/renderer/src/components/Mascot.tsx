// The face on the resource ladder - see `src/shared/mascot.ts` for why it exists at all.
//
// Everything with a judgement in it is in that module, which has no DOM in it and is
// pinned by `npm run test:mascot`. What is here is the drawing, the walk and the two
// presses, and the three rules it is drawn under are the app's own:
//
//   - It may never take the screen. It never focuses, never raises a window, never opens
//     a dialog, and its overlay is `pointer-events: none` everywhere except the sprite
//     and the bubble - a mascot that eats a click meant for a terminal is a bug in the
//     one place this app cannot afford one.
//   - A looping animation may move `transform` and `opacity` and nothing else
//     (`scripts/anim-cost-test.mjs`, which measured a `box-shadow` loop at 136% of a GPU
//     core on idle panes). The walk is a transform transition; the blink is opacity.
//   - It is drawn in `currentColor` and the theme's own variables, never a literal, so it
//     re-tints with the accent like every other colour in this window (`shared/theme.ts`).
//
// The sprite is the app's own icon geometry: three panes, the middle one wearing the
// face. It is a character made of the thing it looks after rather than a mascot bought
// in from somewhere, which is also why it needs no asset - it is ~40 lines of SVG.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from 'react'
import {
  actedWords,
  clampSpot,
  closeable,
  DEFAULT_MASCOT,
  isDestructive,
  notice,
  parse,
  type Intent,
  type MascotConfig,
  type MascotPane
} from '@shared/mascot'

export interface MascotProps {
  panes: MascotPane[]
  config: MascotConfig
  /** Walk to this pane's card and point at it. */
  onReveal: (id: string) => void
  onClose: (ids: string[]) => void
  onHandoff: (ids: string[]) => void
  /** Turned off from the bubble's own menu, so it can always be dismissed where it is. */
  onConfig: (patch: Partial<MascotConfig>) => void
  /** Whether the app's own idle-close clock is running - it stays quiet if so. */
  idleCloseOn: boolean
  /** Something the ladder did by itself, so an invisible action gets a sentence. */
  acted?: { what: 'closed' | 'moved' | 'trimmed'; panes: string[]; mb?: number; at: number }
}

interface Bubble {
  say: string
  /** Offered as a press. Nothing destructive ever runs without one. */
  action?: Intent
  /** Dismissed once said, so the same notice is not repeated. */
  key: string
}

/** Where it stands, as a fraction of the window, so a resize never strands it. */
interface Spot {
  x: number
  y: number
}

const HOME: Spot = { x: 0.06, y: 0.86 }
/** How often it may wander when it has nothing to say. Slow: this is scenery, not a signal. */
const WANDER_MS = 24_000
/** Below this the gesture was a press, not a drag. A finger is never still. */
const DRAG_SLOP = 4

export default function Mascot(props: MascotProps): JSX.Element | null {
  const cfg = { ...DEFAULT_MASCOT, ...props.config }
  const pinned = cfg.spot ?? null
  const [spot, setSpot] = useState<Spot>(pinned ?? HOME)
  const [bubble, setBubble] = useState<Bubble | null>(null)
  const [typing, setTyping] = useState('')
  const [open, setOpen] = useState(false)
  const [blink, setBlink] = useState(false)
  const [dragging, setDragging] = useState(false)
  const said = useRef(new Set<string>())
  const input = useRef<HTMLInputElement | null>(null)
  // A drag ends in a `click` on the same element, so the press that opens the bubble has
  // to be told which gesture it was - otherwise every move also opens or closes it.
  const drag = useRef<{ moved: boolean; id: number; x: number; y: number; dx: number; dy: number } | null>(
    null
  )
  // `dragging` is state (it draws), but the click arrives after it has been cleared, so
  // the suppression is a ref - reading the state there re-opens the bubble on every drop.
  const justDragged = useRef(false)

  const panes = props.panes

  /** Say it, and - only if the speaker has been pressed - say it out loud. */
  const say = useCallback(
    (b: Bubble) => {
      setBubble(b)
      if (!cfg.voice || typeof speechSynthesis === 'undefined') return
      try {
        speechSynthesis.cancel()
        const u = new SpeechSynthesisUtterance(b.say.replace(/\s+/g, ' ').slice(0, 300))
        u.rate = 1.05
        speechSynthesis.speak(u)
      } catch {
        // A machine with no voices is not an error worth a card.
      }
    },
    [cfg.voice]
  )

  // A spot somebody put it in outlives a reload, and beats anything automatic below.
  useEffect(() => {
    if (pinned) setSpot(pinned)
  }, [pinned?.x, pinned?.y])

  // Walk to a pane's card. The card is the only anchor that is always on screen - a pane
  // in a grid may be hidden, and pointing at nothing is worse than standing still.
  const walkTo = useCallback(
    (id?: string) => {
      // Dragged there by a person: the walk would take it straight back, which reads as
      // the drag not having worked at all.
      if (pinned) return
      if (!cfg.roam) return setSpot(HOME)
      const el = id ? document.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`) : null
      if (!el) return
      const r = el.getBoundingClientRect()
      setSpot({
        x: Math.min(0.9, (r.right + 30) / window.innerWidth),
        y: Math.min(0.9, (r.top + r.height / 2) / window.innerHeight)
      })
    },
    [cfg.roam, pinned]
  )

  // The unasked notice. One at a time, said once, and only ever an OFFER.
  useEffect(() => {
    if (!cfg.enabled || bubble || open) return
    const n = notice(panes, { idleCloseOn: props.idleCloseOn })
    if (!n || said.current.has(n.key)) return
    said.current.add(n.key)
    walkTo(n.about)
    say({ say: n.say, action: n.action, key: n.key })
  }, [panes, cfg.enabled, props.idleCloseOn, bubble, open, say, walkTo])

  // ...and the one report that is not a suggestion: the ladder acted, so it says what it
  // did. This is the whole reason the mascot is worth having - those three sweeps have
  // been closing and moving panes into a console nobody reads.
  useEffect(() => {
    const a = props.acted
    if (!cfg.enabled || !a) return
    const key = `acted:${a.at}`
    if (said.current.has(key)) return
    said.current.add(key)
    say({ say: actedWords(a.what, a.panes, a.mb), key })
  }, [props.acted, cfg.enabled, say])

  // Wander, and blink. Both are decoration and both are transform/opacity only.
  useEffect(() => {
    if (!cfg.enabled || !cfg.roam || pinned) return
    const t = window.setInterval(() => {
      if (bubble || open) return
      const pick = closeable(panes)[0] ?? panes[0]
      if (pick) walkTo(pick.id)
      else setSpot(HOME)
    }, WANDER_MS)
    return () => window.clearInterval(t)
  }, [cfg.enabled, cfg.roam, pinned, panes, bubble, open, walkTo])

  useEffect(() => {
    if (!cfg.enabled) return
    const t = window.setInterval(() => {
      setBlink(true)
      window.setTimeout(() => setBlink(false), 160)
    }, 5200)
    return () => window.clearInterval(t)
  }, [cfg.enabled])

  // The drag itself. Pointer events, so a mouse, a pen and a touch are one path, and the
  // pointer is CAPTURED - without it a fast drag leaves the sprite behind the moment the
  // cursor is over a terminal, and the pane gets the rest of the gesture.
  const onDown = useCallback((e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return
    // The GRAB offset, not the pointer. `left/top` place the sprite's centre, so writing
    // the raw pointer there teleports it under the cursor on the first millimetre of the
    // gesture and drops it half a sprite away from where it was let go.
    const box = e.currentTarget.closest('.mascot')?.getBoundingClientRect()
    drag.current = {
      moved: false,
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      dx: box ? box.left + box.width / 2 - e.clientX : 0,
      dy: box ? box.top + box.height / 2 - e.clientY : 0
    }
    // Capture keeps the move and up events coming once the pointer is over a terminal.
    // A synthetic pointer id has none to capture, which is a throw and not a reason to
    // drop the drag.
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // no capture, still draggable while the pointer is over the sprite
    }
  }, [])

  const onMove = useCallback((e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    if (!d.moved) {
      // A press is never perfectly still, with a mouse or with a finger. Under the slop
      // this is still a click and the sprite must not twitch.
      if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) < DRAG_SLOP) return
      d.moved = true
      setDragging(true)
    }
    setSpot(clampSpot((e.clientX + d.dx) / window.innerWidth, (e.clientY + d.dy) / window.innerHeight))
  }, [])

  const onUp = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>) => {
      const d = drag.current
      if (!d || d.id !== e.pointerId) return
      drag.current = null
      setDragging(false)
      if (!d.moved) return
      justDragged.current = true
      // Where it was dropped is where it stays - across a reload, and against the walk.
      props.onConfig({
        spot: clampSpot((e.clientX + d.dx) / window.innerWidth, (e.clientY + d.dy) / window.innerHeight)
      })
    },
    [props]
  )

  const run = useCallback(
    (i: Intent) => {
      if (i.kind === 'close') props.onClose(i.ids)
      else if (i.kind === 'handoff') props.onHandoff(i.ids)
      setBubble(null)
    },
    [props]
  )

  const submit = useCallback(() => {
    const text = typing.trim()
    if (!text) return
    setTyping('')
    const i = parse(text, panes)
    if (i.kind !== 'say' && i.ids.length) {
      walkTo(i.ids[0])
      props.onReveal(i.ids[0])
    }
    // A report has nothing to press; an action is offered and waits. Never both.
    say({ say: i.say, action: isDestructive(i) ? i : undefined, key: `typed:${Date.now()}` })
  }, [typing, panes, walkTo, props, say])

  useEffect(() => {
    if (open) input.current?.focus()
  }, [open])

  const total = useMemo(
    () => panes.reduce((n, p) => n + (p.memMb ?? 0), 0),
    [panes]
  )

  if (!cfg.enabled) return null

  return (
    <div className="mascot-layer" aria-hidden={false}>
      <div
        className={'mascot' + (dragging ? ' dragging' : '')}
        style={{ left: `${spot.x * 100}%`, top: `${spot.y * 100}%` }}
        data-open={open ? '1' : '0'}
      >
        {(bubble || open) && (
          <div className="mascot-bubble" role="status">
            {bubble && <div className="mascot-say">{bubble.say}</div>}
            {bubble?.action && (
              <div className="mascot-acts">
                <button className="primary small" onClick={() => run(bubble.action as Intent)}>
                  {bubble.action.kind === 'close' ? 'Close' : 'Move it'}
                </button>
                <button className="ghost small" onClick={() => setBubble(null)}>
                  Leave it
                </button>
              </div>
            )}
            {open && (
              <div className="mascot-ask">
                <input
                  ref={input}
                  value={typing}
                  placeholder={`${panes.length} panes, ${Math.round(total)} MB - ask me`}
                  onChange={(e) => setTyping(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submit()
                    if (e.key === 'Escape') setOpen(false)
                  }}
                />
                <button className="ghost small" onClick={submit}>
                  Ask
                </button>
              </div>
            )}
            <div className="mascot-tools">
              {/* The speaker is the only way a voice is ever turned on: nothing this app
                  decided by itself may make a noise into somebody's room. */}
              <button
                className="mascot-icon"
                title={cfg.voice ? 'Stop talking out loud' : 'Say it out loud'}
                onClick={() => props.onConfig({ voice: !cfg.voice })}
              >
                {cfg.voice ? '🔊' : '🔇'}
              </button>
              {pinned && (
                <button
                  className="mascot-icon"
                  title="Let it walk to the pane it is talking about again"
                  onClick={() => props.onConfig({ spot: null })}
                >
                  📍
                </button>
              )}
              <button
                className="mascot-icon"
                title="Hide the mascot (Settings brings it back)"
                onClick={() => props.onConfig({ enabled: false })}
              >
                ✕
              </button>
            </div>
          </div>
        )}
        <button
          className={'mascot-body' + (blink ? ' blink' : '') + (dragging ? ' dragging' : '')}
          title="Ask about this machine - drag to move it"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={() => {
            drag.current = null
            setDragging(false)
          }}
          onClick={(e) => {
            // The gesture that just ended was a move, not a press.
            if (dragging || justDragged.current) {
              justDragged.current = false
              e.preventDefault()
              return
            }
            setOpen((v) => !v)
            if (!bubble) say({ say: 'Ask me - "what is pane 3", "close the idle ones".', key: 'greet' })
          }}
        >
          <svg viewBox="0 0 64 64" width="46" height="46" aria-hidden="true">
            {/* Still the app's own three-pane geometry - the outer two are the project,
                the middle one is the chassis wearing the face - but grown into a machine:
                a visor instead of eyes on a rectangle, vent slats, feet, and an ember on
                the antenna. Every fill is derived from `currentColor` (the accent) so it
                re-tints with the theme, and the shadow sits OUTSIDE the bobbing group so
                it squashes against a ground that does not move. */}
            <ellipse className="m-shadow" cx="32" cy="59.5" rx="14" ry="2.4" />
            <g className="m-bob">
              <g className="m-side">
                <rect className="m-deep" x="3" y="19" width="12.5" height="33" rx="3.6" />
                <rect className="m-void" x="5" y="21" width="8.5" height="29" rx="2.4" />
                <rect className="m-ln" x="6.4" y="24.5" width="5.6" height="1.4" rx="0.7" />
                <rect className="m-ln" x="6.4" y="28.5" width="4.2" height="1.4" rx="0.7" />
                <rect className="m-ln" x="6.4" y="32.5" width="5" height="1.4" rx="0.7" />
              </g>
              {/* Mirrored rather than drawn twice: x maps to 64 - x. */}
              <g className="m-side" transform="translate(64,0) scale(-1,1)">
                <rect className="m-deep" x="3" y="19" width="12.5" height="33" rx="3.6" />
                <rect className="m-void" x="5" y="21" width="8.5" height="29" rx="2.4" />
                <rect className="m-ln" x="6.4" y="24.5" width="5.6" height="1.4" rx="0.7" />
                <rect className="m-ln" x="6.4" y="28.5" width="4.2" height="1.4" rx="0.7" />
                <rect className="m-ln" x="6.4" y="32.5" width="5" height="1.4" rx="0.7" />
              </g>
              <path className="m-ant" d="M32 9 V4.6" />
              <circle className="m-bead" cx="32" cy="3" r="2.1" />
              <rect className="m-mid" x="18.5" y="9" width="27" height="45" rx="7.5" />
              <rect className="m-shell" x="20.4" y="11" width="23.2" height="41" rx="6" />
              <rect className="m-void" x="22" y="15.5" width="20" height="14" rx="5.5" />
              {/* The scanline is clipped to the visor, so the loop is one translate. */}
              <clipPath id="pf-mascot-visor">
                <rect x="22" y="15.5" width="20" height="14" rx="5.5" />
              </clipPath>
              <g clipPath="url(#pf-mascot-visor)">
                <rect className="m-scan" x="22" y="13" width="20" height="3.4" />
              </g>
              <g className="m-eyes">
                <rect x="26" y="19.8" width="3.6" height="5.4" rx="1.8" />
                <rect x="34.4" y="19.8" width="3.6" height="5.4" rx="1.8" />
              </g>
              <rect className="m-void" x="26.5" y="33" width="11" height="5.6" rx="2.2" />
              <g className="m-grille">
                <rect x="28.2" y="34.5" width="7.6" height="1" rx="0.5" />
                <rect x="28.2" y="36.4" width="7.6" height="1" rx="0.5" />
              </g>
              <rect className="m-vent" x="24" y="43.4" width="16" height="1.5" rx="0.75" />
              <rect className="m-vent" x="24" y="46.6" width="16" height="1.5" rx="0.75" />
              <rect className="m-deep" x="22.5" y="53" width="7" height="3.4" rx="1.7" />
              <rect className="m-deep" x="34.5" y="53" width="7" height="3.4" rx="1.7" />
            </g>
          </svg>
        </button>
      </div>
    </div>
  )
}
