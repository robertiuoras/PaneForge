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
// The sprite is a fox, drawn in `currentColor` shades so it re-tints with the accent like
// everything else in this window. It needs no asset - it is ~40 lines of SVG - and every
// moving part of it is a transform or an opacity, which is what `npm run test:anim`
// refuses to let anybody undo.

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
/**
 * The run along the bottom of the window: how long it takes, and how rarely it happens.
 *
 * It is scenery and nothing else - it says nothing, points at nothing and is the one thing
 * here that is not a reading - so it is deliberately rare and it stands down the moment it
 * would be in the way: something to say, the bubble open, a spot somebody dragged it to, or
 * `roam` off. Same law as the walk: one composited `left` transition, no repaint per frame.
 */
const DASH_MS = 5200
const DASH_EVERY_MS = 150_000
/** The lane it runs in, as a fraction of the window height - under every card, over nothing. */
const DASH_Y = 0.955

export default function Mascot(props: MascotProps): JSX.Element | null {
  const cfg = { ...DEFAULT_MASCOT, ...props.config }
  const pinned = cfg.spot ?? null
  const [spot, setSpot] = useState<Spot>(pinned ?? HOME)
  const [bubble, setBubble] = useState<Bubble | null>(null)
  const [typing, setTyping] = useState('')
  const [open, setOpen] = useState(false)
  const [blink, setBlink] = useState(false)
  const [dragging, setDragging] = useState(false)
  // The run: 'port' is the frame in which it is placed at the starting edge with no
  // transition at all (a 5s crawl to the start line is not a run), 'go' is the run itself.
  const [dash, setDash] = useState<{ dir: 'right' | 'left'; phase: 'port' | 'go' } | null>(null)
  const dashDir = useRef<'right' | 'left'>('right')
  const dashTimers = useRef<number[]>([])
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

  /** Stop a run where it is: a drag, something to say, or the component going away. */
  const endDash = useCallback(() => {
    for (const t of dashTimers.current) window.clearTimeout(t)
    dashTimers.current = []
    setDash(null)
  }, [])

  // The run along the bottom. Every refusal below is the walk's, plus one of its own: it
  // never runs while there is a bubble up, because the sprite is then the thing being read.
  useEffect(() => {
    if (!cfg.enabled || !cfg.roam || pinned) return
    const t = window.setInterval(() => {
      if (bubble || open || dragging || dash) return
      const dir = dashDir.current
      dashDir.current = dir === 'right' ? 'left' : 'right'
      setDash({ dir, phase: 'port' })
      setSpot({ x: dir === 'right' ? 0.04 : 0.96, y: DASH_Y })
      // Two frames, not one: the port has to be PAINTED with the transition off, or the
      // browser coalesces both writes and the sprite slides to the start line instead.
      dashTimers.current.push(
        window.setTimeout(() => {
          setDash({ dir, phase: 'go' })
          setSpot({ x: dir === 'right' ? 0.96 : 0.04, y: DASH_Y })
        }, 60),
        window.setTimeout(() => {
          setDash(null)
          setSpot(HOME)
        }, DASH_MS + 120)
      )
    }, DASH_EVERY_MS)
    return () => {
      window.clearInterval(t)
      endDash()
    }
  }, [cfg.enabled, cfg.roam, pinned, bubble, open, dragging, dash, endDash])

  // Anything with words in it beats the scenery - a sprite mid-run cannot be read.
  useEffect(() => {
    if (bubble || open) endDash()
  }, [bubble, open, endDash])

  // The drag itself. Pointer events, so a mouse, a pen and a touch are one path, and the
  // pointer is CAPTURED - without it a fast drag leaves the sprite behind the moment the
  // cursor is over a terminal, and the pane gets the rest of the gesture.
  const onDown = useCallback((e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return
    endDash()
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
  }, [endDash])

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
        className={
          'mascot' +
          (dragging ? ' dragging' : '') +
          (dash ? (dash.phase === 'port' ? ' dash-port' : ' dashing') : '')
        }
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
          className={
            'mascot-body' +
            (blink ? ' blink' : '') +
            (dragging ? ' dragging' : '') +
            (dash ? ' running' : '') +
            (dash?.dir === 'left' ? ' face-left' : '')
          }
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
            // A press closes whatever is up, whichever half of it is up. Toggling `open`
            // alone left a notice bubble on screen with no way to dismiss it from the
            // sprite, which reads as the press not working.
            if (open || bubble) {
              setOpen(false)
              setBubble(null)
              return
            }
            setOpen(true)
            say({ say: 'Ask me - "what is pane 3", "close the idle ones".', key: 'greet' })
          }}
        >
          <svg viewBox="0 0 64 64" width="46" height="46" aria-hidden="true">
            {/* A fox, in four shades all mixed from `currentColor` (the accent) rather than
                from a surface variable: the sprite has to keep its own light-to-dark reading
                on a light theme (Paper) as well as on a dark one, and a surface-derived fill
                inverts between the two.

                The ground shadow sits OUTSIDE the bobbing group so it squashes against a
                ground that does not move - a shadow that rises with the body reads as a
                sticker rather than a lift. The tail sways and the legs only move while it is
                running, and both are transforms, which is the one thing an infinite loop here
                is allowed to touch. */}
            <ellipse className="m-shadow" cx="32" cy="60" rx="15" ry="2.4" />
            <g className="m-bob">
              {/* Tail first, so the body overlaps its root. Its own group so the sway
                  pivots at the hip rather than at the tip. */}
              <g className="m-tail">
                <path
                  className="m-fur"
                  d="M23 47 C12 48 4 41 6 31 C7 25 12 21 15 21 C13 27 13 33 17 37 C19 40 21 42 25 43 Z"
                />
                <path className="m-fur-l" d="M15 21 C13 27 13 33 17 37 C13 34 10 27 12 22 Z" />
              </g>
              {/* Legs. Static and tucked under the body while it stands; the run is a
                  rotate on each of these, out of phase. */}
              <g className="m-legs">
                <rect className="m-leg m-fur-d" x="24" y="48" width="5.4" height="10" rx="2.6" />
                <rect className="m-leg m-fur-d" x="35" y="48" width="5.4" height="10" rx="2.6" />
              </g>
              <path
                className="m-fur"
                d="M32 24 C41 24 46 34 46 44 C46 52 40 56 32 56 C24 56 18 52 18 44 C18 34 23 24 32 24 Z"
              />
              {/* Chest ruff: the one big light shape, and what keeps the silhouette
                  readable at 46px on a dark theme. */}
              <path className="m-fur-l" d="M32 33 C37 33 40 41 40 47 C40 53 36 55 32 55 C28 55 24 53 24 47 C24 41 27 33 32 33 Z" />
              {/* Ears, behind the head so the head's curve cuts their base. */}
              <path className="m-fur" d="M20.5 15 L17.5 4 L28.5 10.5 Z" />
              <path className="m-fur-d" d="M21.5 14 L20 7.5 L26 11.5 Z" />
              <path className="m-fur" d="M43.5 15 L46.5 4 L35.5 10.5 Z" />
              <path className="m-fur-d" d="M42.5 14 L44 7.5 L38 11.5 Z" />
              <path
                className="m-fur"
                d="M32 8 C42 8 47.5 15 47.5 23 C47.5 31.5 40.5 37.5 32 37.5 C23.5 37.5 16.5 31.5 16.5 23 C16.5 15 22 8 32 8 Z"
              />
              {/* Muzzle and cheeks - one shape, so there is no seam to misalign. */}
              <path
                className="m-fur-l"
                d="M32 22 C37.5 22 41 26 41 30.5 C41 35 37 37.5 32 37.5 C27 37.5 23 35 23 30.5 C23 26 26.5 22 32 22 Z"
              />
              <g className="m-eyes">
                <ellipse cx="26" cy="23" rx="2" ry="2.6" />
                <ellipse cx="38" cy="23" rx="2" ry="2.6" />
              </g>
              <ellipse className="m-nose" cx="32" cy="30" rx="2.4" ry="1.9" />
            </g>
          </svg>
        </button>
      </div>
    </div>
  )
}
