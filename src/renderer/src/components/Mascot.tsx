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
import { GRID, hasPet, petFor, runsOf, type Rect } from '@shared/pets'
import {
  actedWords,
  agoWords,
  hideAfterMs,
  DASH_MS,
  dueDash,
  bubbleSpot,
  clampSpot,
  countdownWords,
  DEFAULT_MASCOT,
  isDestructive,
  notice,
  parse,
  type ActedPane,
  type Intent,
  type MascotConfig,
  type MascotPane
} from '@shared/mascot'
import type { RunningDev } from '@shared/devList'
import { appVisible, onAppVisible } from '../appVisible'
import { setMascotRect } from '../mascotSpot'

/* ---- the card's own icons ---------------------------------------------------
   These were emoji - ⧉ 🔊 🔇 📍 ✕ - and an emoji is the one glyph in this window that
   cannot be themed: it arrives at the font's own weight, in the font's own colours, at a
   size the row cannot control, and it renders differently on every machine that opens the
   app. Everything else this app draws is a stroked path in `currentColor` at 1.5 (the
   sidebar's search, the quick row, the pane header), so these are too - which is also the
   only way the row can go quiet at 0.55 opacity and light up on hover. 13px on a 24px
   button, the same ratio the sidebar's icons use. */
function Ico(props: { children: React.ReactNode }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {props.children}
    </svg>
  )
}
const IconCopy = (): React.JSX.Element => (
  <Ico>
    <rect x="5.6" y="5.6" width="8" height="8" rx="2" />
    <path d="M10.7 3.4a2 2 0 0 0-1.8-1.1H4.3a2 2 0 0 0-2 2v4.6a2 2 0 0 0 1.1 1.8" />
  </Ico>
)
const IconTick = (): React.JSX.Element => (
  <Ico>
    <path d="M3 8.6 6.3 12 13 4.6" />
  </Ico>
)
const IconSpeak = (): React.JSX.Element => (
  <Ico>
    <path d="M8.4 2.6 4.9 5.5H2.4v5h2.5l3.5 2.9z" />
    <path d="M11.2 5.9a3 3 0 0 1 0 4.2M13.2 3.9a5.8 5.8 0 0 1 0 8.2" />
  </Ico>
)
const IconMute = (): React.JSX.Element => (
  <Ico>
    <path d="M8.4 2.6 4.9 5.5H2.4v5h2.5l3.5 2.9z" />
    <path d="m11.4 6.3 3.2 3.4M14.6 6.3l-3.2 3.4" />
  </Ico>
)
const IconWalk = (): React.JSX.Element => (
  <Ico>
    <path d="M8 14.2s4.6-4 4.6-7.2a4.6 4.6 0 1 0-9.2 0c0 3.2 4.6 7.2 4.6 7.2z" />
    <circle cx="8" cy="6.9" r="1.6" />
  </Ico>
)
const IconClose = (): React.JSX.Element => (
  <Ico>
    <path d="m4 4 8 8M12 4l-8 8" />
  </Ico>
)
const IconSend = (): React.JSX.Element => (
  <Ico>
    <path d="M2.6 8h9.6M8.4 4.2 12.2 8l-3.8 3.8" />
  </Ico>
)

/** A close the app has decided on and has not done yet. The person gets the seconds. */
export interface CloseSoon {
  ids: string[]
  /** `paneWord` strings, so the sentence names panes the way the rest of the app does. */
  names: string[]
  deadline: number
  why: 'idle' | 'pressure'
  /**
   * Set when the countdown is a MOVE to another machine rather than a close.
   *
   * One countdown, two outcomes, because they are the same decision at different rungs of
   * one ladder - and a move used to have no countdown at all: `runHandoffs` reported into
   * a console nobody has open, so a pane left this desk with nothing on screen saying so.
   */
  move?: { device: string; deviceName: string }
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
  /** The automatic handoff is on and has somewhere to move a pane to. */
  willMove: boolean
  /** Something the ladder did by itself, so an invisible action gets a sentence. */
  acted?: { what: 'closed' | 'moved' | 'trimmed'; panes: ActedPane[]; mb?: number; at: number; where?: string }
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
  /**
   * The report of something the ladder did, kept as its parts rather than as a sentence.
   *
   * "Closed pane 3 just now" is a READING, and it goes stale while it is on screen - so
   * the words are built at render time against the clock rather than once, when it was
   * said. Everything else the pet says is fixed the moment it is said.
   */
  acted?: { what: 'closed' | 'moved' | 'trimmed'; panes: ActedPane[]; mb?: number; at: number; where?: string }
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
  /** A copy is silent otherwise, and a button that gives no receipt reads as broken. */
  const [copied, setCopied] = useState(false)
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
  /** The sprite itself, measured for the panes it is standing over. See `spriteReserve`. */
  const body = useRef<HTMLButtonElement | null>(null)
  const [bubbleSize, setBubbleSize] = useState({ w: 0, h: 0 })

  const panes = props.panes
  const soon = props.closeSoon
  // Ten of them, one drawing machine (shared/pets.ts). Only THIS one's layers are ever
  // mounted, and each layer is walked into horizontal runs once per app run and cached by
  // identity - so switching pet costs one walk and changing nothing costs none.
  const pet = petFor(cfg.pet)
  const A = pet.art
  /**
   * Is an animal drawn at all?
   *
   * `pet: 'none'` keeps every reading and drops the sprite: the card then docks in the
   * bottom-right corner and stays there, because with nothing to point AT there is nothing
   * for a walk to mean. Everything else - the countdown, the two presses, the ask box, the
   * notice - is identical, which is the whole reason this is a pet id rather than a second
   * switch beside `enabled`. Turning the mascot OFF used to be the only way to say "no
   * animal, please", and it took the only report of the resource ladder with it.
   */
  const drawn = hasPet(cfg.pet)

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
      // Nothing is drawn, so there is nothing to move and nowhere for it to point.
      if (!drawn) return
      if (!cfg.roam) return setSpot(HOME)
      const el = id ? document.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`) : null
      if (!el) return
      const r = el.getBoundingClientRect()
      setSpot({
        x: Math.min(0.9, (r.right + 30) / window.innerWidth),
        y: Math.min(0.9, (r.top + r.height / 2) / window.innerHeight)
      })
    },
    [cfg.roam, pinned, drawn]
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
    const n = notice(panes, { idleCloseOn: props.idleCloseOn, willMove: props.willMove })
    if (!n || said.current.has(n.key)) return
    said.current.add(n.key)
    walkTo(n.about)
    say({ say: n.say, action: n.action, key: n.key })
  }, [panes, cfg.enabled, props.idleCloseOn, props.willMove, bubble, open, soon, say, walkTo])

  // ...and the one report that is not a suggestion: the ladder acted, so it says what it
  // did. This is the whole reason the mascot is worth having - those three sweeps have
  // been closing and moving panes into a console nobody reads.
  useEffect(() => {
    const a = props.acted
    if (!cfg.enabled || !a) return
    const key = `acted:${a.at}`
    if (said.current.has(key)) return
    said.current.add(key)
    say({ say: actedWords(a.what, a.panes, a.mb, Date.now() - a.at, a.where), acted: a, key })
  }, [props.acted, cfg.enabled, say])

  // A report of something that HAPPENED carries how long ago, and that number is only true
  // for a few seconds. Five seconds rather than one: `agoWords` rounds to five below a
  // minute, so a faster tick re-renders the layer for a string that has not changed.
  useEffect(() => {
    if (!bubble?.acted) return
    const t = window.setInterval(() => setTick((n) => n + 1), 5000)
    return () => window.clearInterval(t)
  }, [bubble?.key, bubble?.acted])

  /**
   * ...and then it takes itself away.
   *
   * Everything the pet says is a reading, and a reading left on screen stops being one: it
   * is a box over the corner of the window saying something that was true a while ago. The
   * timer restarts on every keystroke in the ask box (`typing` is a dependency), so it can
   * never close over somebody mid-sentence, and a COUNTDOWN is exempt - that bubble has a
   * deadline of its own and two named answers, and taking it away would take the press
   * that stops the close with it.
   */
  /**
   * A press anywhere else takes it away.
   *
   * The bubble already goes on its own timer, and until now that timer was the ONLY way
   * out short of pressing the sprite again - so a reading left on screen had to be
   * dismissed by going back to the thing that opened it, which is the one place a person
   * is not looking. Pointerdown and not click, so it closes on the way to whatever was
   * pressed rather than after it.
   *
   * A COUNTDOWN is exempt for the same reason it is exempt from the hide timer: it is a
   * plan to close somebody's pane and its two buttons are the only way to answer it. A
   * press inside the layer is exempt too - that is the sprite, the ask box and the tools.
   */
  useEffect(() => {
    if ((!bubble && !open) || soon) return
    const off = (e: PointerEvent): void => {
      const t = e.target as HTMLElement | null
      if (t?.closest('.mascot-layer')) return
      setBubble(null)
      setOpen(false)
    }
    document.addEventListener('pointerdown', off, true)
    return () => document.removeEventListener('pointerdown', off, true)
  }, [bubble, open, soon])

  useEffect(() => {
    const ms = hideAfterMs(cfg)
    if (!ms || soon) return
    if (!bubble && !open) return
    const t = window.setTimeout(() => {
      setBubble(null)
      setOpen(false)
    }, ms)
    return () => window.clearTimeout(t)
  }, [bubble?.key, open, typing, cfg.hideSeconds, soon])

  useEffect(() => {
    if (!cfg.enabled || !drawn) return
    const t = window.setInterval(() => {
      setBlink(true)
      window.setTimeout(() => setBlink(false), 160)
    }, 5200)
    return () => window.clearInterval(t)
  }, [cfg.enabled, drawn])

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
    if (!cfg.enabled || !drawn) return
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
  }, [cfg.enabled, cfg.roam, pinned, bubble, open, soon, awake, drawn])

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

  /**
   * Tell the panes underneath where the sprite is, so none of them draws a line under it.
   *
   * Measured off the element rather than worked out from `at`: the sprite is centred on
   * its spot with a transform and it scales on hover, so the fraction is not the box. The
   * walk is a 900ms CSS transition and a `left`/`top` transition emits no event per frame,
   * so the box is re-read on a frame loop for as long as one can be running - `DASH_MS`
   * covers the walk and the longer dash both - and the loop stops on its own. See
   * `spriteReserve` in shared/mascot.ts for what a pane does with it.
   */
  useEffect(() => {
    if (!drawn || !cfg.enabled) {
      setMascotRect(null)
      return
    }
    let raf = 0
    const stop = Date.now() + DASH_MS + 200
    const read = (): void => {
      const el = body.current
      if (el) {
        const r = el.getBoundingClientRect()
        setMascotRect({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })
      }
      if (Date.now() < stop) raf = requestAnimationFrame(read)
    }
    read()
    return () => {
      cancelAnimationFrame(raf)
    }
  }, [drawn, cfg.enabled, spot.x, spot.y, dash])

  useEffect(() => () => setMascotRect(null), [])

  if (!cfg.enabled) return null

  // Read fresh on every render, and re-rendered once a second by the countdown's own
  // interval. `tick` is the dependency that makes that true.
  void tick
  const left = soon ? soon.deadline - Date.now() : 0
  const counting = !!soon && left > -1000
  const secs = Math.max(0, Math.ceil(left / 1000))
  const showBubble = counting || !!bubble || open



  /**
   * What is on screen, as one string.
   *
   * The card used to build its sentence inline in two places, so a copy button would have
   * had to build a THIRD - and the readings that go stale (`agoWords`, the countdown) would
   * then have been copied at a different moment from the one being read. One expression,
   * rendered and copied.
   */
  const saidText = counting && soon
    ? countdownWords(soon.names, left, soon.why, soon.move?.deviceName)
    : bubble?.acted
      ? actedWords(
          bubble.acted.what,
          bubble.acted.panes,
          bubble.acted.mb,
          Date.now() - bubble.acted.at,
          bubble.acted.where
        )
      : (bubble?.say ?? '')

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
            (drawn ? '' : ' dock') +
            (box.above ? '' : ' below') +
            (dragging ? ' dragging' : '') +
            (counting ? ' counting' : '')
          }
          role="status"
          style={drawn ? { left: box.left, top: box.top, maxWidth: box.max } : undefined}
        >
          {counting && soon && (
            <>
              <div className="mascot-count">
                <span className="mascot-secs">{secs}</span>
                <span className="mascot-count-say">{saidText}</span>
              </div>
              <div className="mascot-acts">
                <button className="primary small" onClick={() => props.onKeep(soon.ids)}>
                  Keep {soon.ids.length > 1 ? 'them' : 'it'} {soon.move ? 'here' : 'open'}
                </button>
                <button className="ghost small" onClick={() => props.onCloseNow(soon.ids)}>
                  {soon.move ? 'Move now' : 'Close now'}
                </button>
              </div>
            </>
          )}
          {!counting && bubble && (
            <div className="mascot-say">{saidText}</div>
          )}
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
            /* One field, not a field beside a button: the send is INSIDE the box, which is
               what every composer in this app and outside it looks like, and it lights up
               only once there is something to send - a button that is always live on an
               empty box is a button that does nothing most of the time it is looked at.
               Return still sends, and is what nearly everybody uses. */
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
              <button
                className={'mascot-send' + (typing.trim() ? ' live' : '')}
                title="Ask (Return)"
                onClick={submit}
              >
                <IconSend />
              </button>
            </div>
          )}
          <div className="mascot-tools">
            {/* Every reading here is a sentence somebody may want in a commit message or a
                message to somebody else, and a card is the one surface in this window whose
                text is NOT in a terminal buffer. The text is selectable as well; this is
                the one press that gets all of it including the part scrolled out. */}
            <button
              className="mascot-icon"
              title="Copy this"
              onClick={() => {
                void navigator.clipboard?.writeText(saidText)
                setCopied(true)
                window.setTimeout(() => setCopied(false), 1200)
              }}
            >
              {copied ? <IconTick /> : <IconCopy />}
            </button>
            {/* The speaker is the only way a voice is ever turned on: nothing this app
                decided by itself may make a noise into somebody's room. */}
            <button
              className="mascot-icon"
              title={cfg.voice ? 'Stop talking out loud' : 'Say it out loud'}
              onClick={() => props.onConfig({ voice: !cfg.voice })}
            >
              {cfg.voice ? <IconSpeak /> : <IconMute />}
            </button>
            {pinned && (
              <button
                className="mascot-icon"
                title="Let it walk to the pane it is talking about again"
                onClick={() => props.onConfig({ spot: null })}
              >
                <IconWalk />
              </button>
            )}
            <button
              className="mascot-icon"
              title="Hide the mascot (Settings brings it back)"
              onClick={() => props.onConfig({ enabled: false })}
            >
              <IconClose />
            </button>
          </div>
        </div>
      )}
      {drawn ? (
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
          ref={body}
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
      ) : (
        !showBubble && (
          /* With no animal there is nothing to press, so the ask box would be unreachable.
             One pill in the corner, the same corner the card docks in, carrying the reading
             it opens onto. */
          <button
            className="mascot-dock-open"
            title="Ask about this machine"
            onClick={() => {
              setOpen(true)
              say({ say: 'Ask me - "what is open", "what dev servers are running".', key: 'greet' })
            }}
          >
            <span className="mascot-dock-dot" />
            {panes.length} {panes.length === 1 ? 'pane' : 'panes'}
            {total ? ` · ${Math.round(total)} MB` : ''}
          </button>
        )
      )}
    </div>
  )
}
