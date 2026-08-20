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
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from 'react'
import { BLINK, BODY, DUST, EARS, EYES, GRID, LEGS, runsOf, TAILS, type Rect } from '@shared/foxSprite'
import {
  actedWords,
  bubbleSpot,
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
/** How big the fox is drawn, in CSS pixels. The bubble clears it rather than covering it. */
const SPRITE = 48
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

/**
 * One layer of the sprite, as horizontal runs rather than as cells: the whole fox is ~90
 * rects instead of 576, and a run of one colour is what a pixel row actually is. The art
 * is module-level constants, so the walk over it is cached by identity and every
 * re-render after the first reuses the rects.
 */
const LAYERS = new Map<string[], Rect[]>()
function Layer({ art, cls }: { art: string[]; cls: string }): JSX.Element {
  let rects = LAYERS.get(art)
  if (!rects) {
    rects = runsOf(art)
    LAYERS.set(art, rects)
  }
  return (
    <g className={cls}>
      {rects.map((r, i) => (
        <rect key={i} className={r.cls} x={r.x} y={r.y} width={r.w} height={1} />
      ))}
    </g>
  )
}

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
  // The bubble is placed in the LAYER in pixels rather than beside the sprite, so both of
  // those readings are needed here: the window it has to stay inside, and its own size.
  const [vp, setVp] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }))
  const bubbleEl = useRef<HTMLDivElement | null>(null)
  const [bubbleSize, setBubbleSize] = useState({ w: 0, h: 0 })

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

  useEffect(() => {
    const on = (): void => setVp({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])

  // Measured every paint, deliberately: the bubble's height is what decides whether it goes
  // above or below, and it changes with the message, the buttons and the ask box. React
  // bails out of a set with the same value, so this cannot loop.
  useLayoutEffect(() => {
    const el = bubbleEl.current
    const w = el ? el.offsetWidth : 0
    const h = el ? el.offsetHeight : 0
    setBubbleSize((b) => (b.w === w && b.h === h ? b : { w, h }))
  })

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

  const box = bubbleSpot({
    cx: spot.x * vp.w,
    cy: spot.y * vp.h,
    sprite: SPRITE,
    width: bubbleSize.w,
    height: bubbleSize.h,
    vw: vp.w,
    vh: vp.h
  })

  return (
    <div className="mascot-layer" aria-hidden={false}>
      {/* The bubble is a SIBLING of the sprite, not a child of it. As a child it widened
          the sprite's own box - which is centred on the spot - so saying anything shoved
          the fox ~155px sideways and hung the left half of the bubble off the window. It
          is placed in pixels and clamped instead (`bubbleSpot`), so the fox never moves
          because something was said and the words are always on screen. */}
      {(bubble || open) && (
        <div
          ref={bubbleEl}
          className={'mascot-bubble' + (box.above ? '' : ' below') + (dragging ? ' dragging' : '')}
          role="status"
          style={{ left: box.left, top: box.top, maxWidth: box.max }}
        >
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
      <div
        className={
          'mascot' +
          (dragging ? ' dragging' : '') +
          (dash ? (dash.phase === 'port' ? ' dash-port' : ' dashing') : '')
        }
        style={{ left: `${spot.x * 100}%`, top: `${spot.y * 100}%` }}
        data-open={open ? '1' : '0'}
      >
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
          <svg
            className="fox"
            viewBox={`0 0 ${GRID} ${GRID}`}
            width="48"
            height="48"
            shapeRendering="crispEdges"
            aria-hidden="true"
          >
            {/* The ground shadow sits OUTSIDE the bobbing group so it squashes against a
                ground that does not move - a shadow that rises with the body reads as a
                sticker rather than a lift. It is the one thing here not on the pixel
                grid: a 1px-tall ellipse would be a rectangle. */}
            <ellipse className="m-shadow" cx="11" cy="22.4" rx="7" ry="1" />
            <g className="m-bob">
              {/* Tail first, so the body overlaps its root. Every pose is its own drawing
                  and the motion is WHICH drawing is showing - a pixel grid cannot be
                  rotated without resampling, so an opacity step is the only free move. The
                  standing fox is not one frame: the tail sways over three, the weight
                  shifts between two leg poses, an ear flicks and the eye darts, each on its
                  own clock so they never line up into a loop anybody can count. */}
              <Layer art={TAILS.idleA} cls="m-tail-a" />
              <Layer art={TAILS.idleB} cls="m-tail-b" />
              <Layer art={TAILS.idleC} cls="m-tail-c" />
              <Layer art={TAILS.run} cls="m-tail-run" />
              <Layer art={LEGS.stand} cls="m-legs-stand m-legs-stand-a" />
              <Layer art={LEGS.standB} cls="m-legs-stand m-legs-stand-b" />
              <Layer art={LEGS.run1} cls="m-legs-run m-legs-run1" />
              <Layer art={LEGS.run2} cls="m-legs-run m-legs-run2" />
              <Layer art={LEGS.run3} cls="m-legs-run m-legs-run3" />
              <Layer art={LEGS.run4} cls="m-legs-run m-legs-run4" />
              <Layer art={BODY} cls="m-body" />
              {/* Ears and eye are drawn OVER the head rather than inside it: a part that
                  moves cannot live in the drawing that does not, or there is a second head
                  to keep in step with this one. */}
              <Layer art={EARS.perk} cls="m-ear-perk" />
              <Layer art={EARS.flick} cls="m-ear-flick" />
              <Layer art={EARS.back} cls="m-ear-back" />
              <Layer art={EYES.ahead} cls="m-eye-ahead" />
              <Layer art={EYES.look} cls="m-eye-look" />
              <Layer art={BLINK} cls="m-lid" />
              <Layer art={DUST} cls="m-dust" />
            </g>
          </svg>
        </button>
      </div>
    </div>
  )
}
