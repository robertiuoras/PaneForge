// The face on the resource ladder - see `src/shared/mascot.ts` for why it exists at all.
//
// Everything with a judgement in it is in that module, which has no DOM in it and is
// pinned by `npm run test:mascot`. What is here is the drawing, the walk, the countdown
// and the two presses, and the three rules it is drawn under are the app's own:
//
//   - It may never take the screen. It never focuses, never raises a window, never opens
//     a dialog, and its overlay is `pointer-events: none` everywhere except the sprite
//     and the bubble - a mascot that eats a click meant for a terminal is a bug in the
//     one place this app cannot afford one.
//   - A looping animation may move `transform` and `opacity` and nothing else
//     (`scripts/anim-cost-test.mjs`, which measured a `box-shadow` loop at 136% of a GPU
//     core on idle panes). Every loop on the sprite is an opacity step.
//   - It is drawn in `currentColor` and the theme's own variables, never a literal, so it
//     re-tints with the accent like every other colour in this window (`shared/theme.ts`).
//
// Two things it deliberately no longer does. It does not BOB - the old fox floated on a
// 4.2s vertical loop and that is the first thing anybody said about it - and it does not
// wander or run along the bottom of the window for something to do. Movement here is a
// sentence: it walks to the card of the pane it is talking about, and otherwise it stands
// still. What replaced the scenery is the countdown, which is the thing it was always
// supposed to be for.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from 'react'
import { GRID, petFor, runsOf, type Rect } from '@shared/pets'
import {
  actedWords,
  DASH_MS,
  dueDash,
  bubbleSpot,
  clampSpot,
  countdownWords,
  DEFAULT_MASCOT,
  isDestructive,
  notice,
  parse,
  type Intent,
  type MascotConfig,
  type MascotPane
} from '@shared/mascot'
import type { RunningDev } from '@shared/devList'
import { appVisible, onAppVisible } from '../appVisible'

/** A close the app has decided on and has not done yet. The person gets the seconds. */
export interface CloseSoon {
  ids: string[]
  /** `paneWord` strings, so the sentence names panes the way the rest of the app does. */
  names: string[]
  deadline: number
  why: 'idle' | 'pressure'
}

export interface MascotProps {
  panes: MascotPane[]
  config: MascotConfig
  /** Walk to this pane's card and point at it. */
  onReveal: (id: string) => void
  onClose: (ids: string[]) => void
  onHandoff: (ids: string[]) => void
  /**
   * The dev servers running right now.
   *
   * Asked for rather than polled: reading them is a full `ps -Ao command=` of the whole
   * machine, which is a keystroke's worth of work and not a timer's.
   */
  devs?: RunningDev[]
  /** Read them again - called when the ask box opens and before a question is answered. */
  onRefreshDevs?: () => void
  /** Stop these, by pid. A dev server is routinely not a descendant of any pane. */
  onStopDev?: (pids: number[]) => void
  /** Turned off from the bubble's own menu, so it can always be dismissed where it is. */
  onConfig: (patch: Partial<MascotConfig>) => void
  /** Whether the app's own idle-close clock is running - it stays quiet if so. */
  idleCloseOn: boolean
  /** Something the ladder did by itself, so an invisible action gets a sentence. */
  acted?: { what: 'closed' | 'moved' | 'trimmed'; panes: string[]; mb?: number; at: number }
  /** A close that is about to happen, counted down out loud. */
  closeSoon?: CloseSoon
  /** Stop that close and leave those panes alone for a while. */
  onKeep: (ids: string[]) => void
  /** Do it now rather than waiting out the count. */
  onCloseNow: (ids: string[]) => void
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
/** How big it is drawn, in CSS pixels. The bubble clears it rather than covering it. */
const SPRITE = 48
/** Below this the gesture was a press, not a drag. A finger is never still. */
const DRAG_SLOP = 4
/** Where a dash starts and ends, along the bottom of the window. */
const DASH_LEFT = 0.06
const DASH_RIGHT = 0.94
const DASH_Y = 0.93
/** How often the dash timer LOOKS at whether it may run. It almost always may not. */
const DASH_TICK_MS = 30_000

/**
 * One layer of the sprite, as horizontal runs rather than as cells: the whole robot is
 * ~90 rects instead of 576, and a run of one colour is what a pixel row actually is. The
 * art is module-level constants, so the walk over it is cached by identity and every
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
  /**
   * The run along the bottom of the window, in two frames.
   *
   * 'port' places the sprite at the starting edge with the transition OFF for exactly one
   * frame; without that frame the browser coalesces both writes and it slides gently to
   * the start line instead of appearing there and then running. 'run' is then a single
   * `left` transition across the window - one composited property, and the only thing
   * about this pet that ever moves horizontally.
   */
  const [dash, setDash] = useState<null | 'port' | 'run'>(null)
  /** Is anybody looking? A pet animating behind a minimised window is pure waste. */
  const [awake, setAwake] = useState(true)
  // Re-read once a second while a close is counting down, and never otherwise: the number
  // on screen is the only thing that changes, and a timer running when nothing is pending
  // is a re-render of the whole layer for no reading at all.
  const [tick, setTick] = useState(0)
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
  const soon = props.closeSoon
  // Ten of them, one drawing machine (shared/pets.ts). Only THIS one's layers are ever
  // mounted, and each layer is walked into horizontal runs once per app run and cached by
  // identity - so switching pet costs one walk and changing nothing costs none.
  const pet = petFor(cfg.pet)
  const A = pet.art

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

  // The countdown owns the sprite while it is running: it walks to the first pane it is
  // about, and it re-reads once a second so the number on the bubble is a real clock and
  // not a sentence written once.
  useEffect(() => {
    if (!soon) return
    walkTo(soon.ids[0])
    const t = window.setInterval(() => setTick((n) => n + 1), 500)
    return () => window.clearInterval(t)
  }, [soon?.deadline, soon?.ids.join(','), walkTo])

  // The unasked notice. One at a time, said once, and only ever an OFFER. Silent while a
  // countdown is up - that IS the app talking about idle panes already.
  useEffect(() => {
    if (!cfg.enabled || bubble || open || soon) return
    const n = notice(panes, { idleCloseOn: props.idleCloseOn })
    if (!n || said.current.has(n.key)) return
    said.current.add(n.key)
    walkTo(n.about)
    say({ say: n.say, action: n.action, key: n.key })
  }, [panes, cfg.enabled, props.idleCloseOn, bubble, open, soon, say, walkTo])

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

  useEffect(() => {
    if (!cfg.enabled) return
    const t = window.setInterval(() => {
      setBlink(true)
      window.setTimeout(() => setBlink(false), 160)
    }, 5200)
    return () => window.clearInterval(t)
  }, [cfg.enabled])

  // Whether anybody is looking. `document.hidden` is dead code in this window
  // (backgroundThrottling is off, so Chromium never marks it hidden - see appVisible.ts),
  // so the answer comes from the main process. Asleep the whole sprite's animations are
  // paused in CSS and the dash never starts: a pet is the one thing in this app with
  // literally no reason to run when it cannot be seen.
  useEffect(() => {
    if (!cfg.enabled) return
    let live = true
    void appVisible().then((v) => live && setAwake(v))
    const off = window.api.onAppVisible?.((v: boolean) => setAwake(v))
    return () => {
      live = false
      off?.()
    }
  }, [cfg.enabled])

  // The dash. Everything about it is a refusal: it is checked twice a minute, runs at most
  // once every DASH_EVERY_MS, and stands down for anything the pet is already saying, a
  // spot somebody dragged it to, `roam` off and a window nobody is looking at.
  const lastDash = useRef(Date.now())
  useEffect(() => {
    if (!cfg.enabled) return
    const t = window.setInterval(() => {
      if (
        !dueDash({
          enabled: cfg.enabled,
          roam: cfg.roam,
          pinned: !!pinned,
          saying: !!bubble || open || !!soon,
          visible: awake,
          sinceMs: Date.now() - lastDash.current
        })
      )
        return
      lastDash.current = Date.now()
      setDash('port')
      // One frame at the start line with no transition, THEN the run.
      requestAnimationFrame(() => requestAnimationFrame(() => setDash('run')))
      window.setTimeout(() => setDash(null), DASH_MS + 120)
    }, DASH_TICK_MS)
    return () => window.clearInterval(t)
  }, [cfg.enabled, cfg.roam, pinned, bubble, open, soon, awake])

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
      else if (i.kind === 'stopDev') props.onStopDev?.(i.pids)
      setBubble(null)
    },
    [props]
  )

  const submit = useCallback(() => {
    const text = typing.trim()
    if (!text) return
    setTyping('')
    const i = parse(text, panes, props.devs ?? [])
    if ('ids' in i && i.ids.length) {
      walkTo(i.ids[0])
      props.onReveal(i.ids[0])
    }
    // A report has nothing to press; an action is offered and waits. Never both.
    say({ say: i.say, action: isDestructive(i) ? i : undefined, key: `typed:${Date.now()}` })
  }, [typing, panes, walkTo, props, say])

  useEffect(() => {
    if (!open) return
    input.current?.focus()
    // Read the machine's dev servers once, here, so an answer is about what is running now
    // rather than about what was running when the window opened.
    props.onRefreshDevs?.()
  }, [open, props])

  const total = useMemo(() => panes.reduce((n, p) => n + (p.memMb ?? 0), 0), [panes])

  if (!cfg.enabled) return null

  // Read fresh on every render, and re-rendered once a second by the countdown's own
  // interval. `tick` is the dependency that makes that true.
  void tick
  const left = soon ? soon.deadline - Date.now() : 0
  const counting = !!soon && left > -1000
  const secs = Math.max(0, Math.ceil(left / 1000))
  const showBubble = counting || !!bubble || open

  // Where it is DRAWN. A dash overrides the walk for its two and a half seconds and then
  // hands the sprite straight back - it never writes `spot`, so nothing about the run
  // outlives it.
  const at = dash ? { x: dash === 'port' ? DASH_LEFT : DASH_RIGHT, y: DASH_Y } : spot

  const ground = A.shadow ?? { cx: GRID / 2 - 0.5, cy: GRID - 1.4, rx: GRID / 3, ry: 1 }

  const box = bubbleSpot({
    cx: at.x * vp.w,
    cy: at.y * vp.h,
    sprite: SPRITE,
    width: bubbleSize.w,
    height: bubbleSize.h,
    vw: vp.w,
    vh: vp.h
  })

  return (
    <div className={'mascot-layer' + (awake ? '' : ' asleep')} aria-hidden={false}>
      {/* Something to chase. It is drawn only while the run is on, it is a circle with a
          transform on it and nothing else, and it leads the pet by a little so the run
          reads as chasing rather than as fleeing. */}
      {dash && (
        <div
          className={'mascot-ball' + (dash === 'port' ? ' port' : '')}
          style={{ left: `${(dash === 'port' ? DASH_LEFT + 0.05 : DASH_RIGHT + 0.04) * 100}%`, top: `${DASH_Y * 100}%` }}
        />
      )}
      {/* The bubble is a SIBLING of the sprite, not a child of it. As a child it widened
          the sprite's own box - which is centred on the spot - so saying anything shoved
          the sprite ~155px sideways and hung the left half of the bubble off the window.
          It is placed in pixels and clamped instead (`bubbleSpot`), so the sprite never
          moves because something was said and the words are always on screen. */}
      {showBubble && (
        <div
          ref={bubbleEl}
          className={
            'mascot-bubble' +
            (box.above ? '' : ' below') +
            (dragging ? ' dragging' : '') +
            (counting ? ' counting' : '')
          }
          role="status"
          style={{ left: box.left, top: box.top, maxWidth: box.max }}
        >
          {counting && soon && (
            <>
              <div className="mascot-count">
                <span className="mascot-secs">{secs}</span>
                <span className="mascot-count-say">{countdownWords(soon.names, left, soon.why)}</span>
              </div>
              <div className="mascot-acts">
                <button className="primary small" onClick={() => props.onKeep(soon.ids)}>
                  Keep {soon.ids.length > 1 ? 'them' : 'it'} open
                </button>
                <button className="ghost small" onClick={() => props.onCloseNow(soon.ids)}>
                  Close now
                </button>
              </div>
            </>
          )}
          {!counting && bubble && <div className="mascot-say">{bubble.say}</div>}
          {!counting && bubble?.action && (
            <div className="mascot-acts">
              <button className="primary small" onClick={() => run(bubble.action as Intent)}>
                {bubble.action.kind === 'close'
                  ? 'Close'
                  : bubble.action.kind === 'stopDev'
                    ? 'Stop it'
                    : 'Move it'}
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
          (dash === 'port' ? ' dash-port' : '') +
          (dash === 'run' ? ' dashing' : '')
        }
        style={{ left: `${at.x * 100}%`, top: `${at.y * 100}%` }}
        data-open={open ? '1' : '0'}
      >
        <button
          className={
            'mascot-body' + (blink ? ' blink' : '') + (dragging ? ' dragging' : '') + (counting ? ' alert' : '')
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
            // sprite, which reads as the press not working. A countdown is NOT dismissed
            // by it - that bubble has two named answers and neither of them is a stray
            // click on the sprite.
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
            className="bot"
            viewBox={`0 0 ${GRID} ${GRID}`}
            width="48"
            height="48"
            shapeRendering="crispEdges"
            aria-hidden="true"
          >
            {/* The ground shadow. It is the one thing here not on the pixel grid: a 1px-tall
                ellipse would be a rectangle. Nothing above it translates vertically, so the
                shadow is still - the first mascot bobbed, and a floating pet is what the
                pixel grid replaced. A hovering pet (the drone, the wisp) puts its own
                shadow lower and fainter, which is the only thing that says it is off the
                ground at all. */}
            <ellipse
              className="m-shadow"
              cx={ground.cx}
              cy={ground.cy}
              rx={ground.rx}
              ry={ground.ry}
              style={ground.opacity ? { opacity: ground.opacity } : undefined}
            />
            <g className="m-rig">
              {/* Moving parts first, so the body overlaps their roots. Every pose is its
                  own drawing and the motion is WHICH drawing is showing - a pixel grid
                  cannot be rotated without resampling, so an opacity step is the only free
                  move. Standing still is four clocks that never line up. A pet that leaves
                  a slot out is simply stiller; nothing here is required. */}
              {A.arms && (
                <>
                  <Layer art={A.arms.a} cls="m-arm-a" />
                  <Layer art={A.arms.b} cls="m-arm-b" />
                  <Layer art={A.arms.c} cls="m-arm-c" />
                </>
              )}
              {A.treads && (
                <>
                  <Layer art={A.treads.a} cls="m-treads m-treads-a" />
                  <Layer art={A.treads.b} cls="m-treads m-treads-b" />
                </>
              )}
              <Layer art={A.body} cls="m-body" />
              {A.antenna && (
                <>
                  <Layer art={A.antenna.mast} cls="m-antenna" />
                  <Layer art={A.antenna.tilt} cls="m-antenna-tilt" />
                </>
              )}
              {A.beacon && (
                <>
                  <Layer art={A.beacon.off} cls="m-beacon-off" />
                  <Layer art={A.beacon.on} cls="m-beacon-on" />
                </>
              )}
              {A.eyes && (
                <>
                  <Layer art={A.eyes.ahead} cls="m-eye-ahead" />
                  <Layer art={A.eyes.look} cls="m-eye-look" />
                </>
              )}
              {A.blink && <Layer art={A.blink} cls="m-lid" />}
            </g>
          </svg>
        </button>
      </div>
    </div>
  )
}
