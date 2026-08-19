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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  actedWords,
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

export default function Mascot(props: MascotProps): JSX.Element | null {
  const cfg = { ...DEFAULT_MASCOT, ...props.config }
  const [spot, setSpot] = useState<Spot>(HOME)
  const [bubble, setBubble] = useState<Bubble | null>(null)
  const [typing, setTyping] = useState('')
  const [open, setOpen] = useState(false)
  const [blink, setBlink] = useState(false)
  const said = useRef(new Set<string>())
  const input = useRef<HTMLInputElement | null>(null)

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

  // Walk to a pane's card. The card is the only anchor that is always on screen - a pane
  // in a grid may be hidden, and pointing at nothing is worse than standing still.
  const walkTo = useCallback(
    (id?: string) => {
      if (!cfg.roam) return setSpot(HOME)
      const el = id ? document.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`) : null
      if (!el) return
      const r = el.getBoundingClientRect()
      setSpot({
        x: Math.min(0.9, (r.right + 30) / window.innerWidth),
        y: Math.min(0.9, (r.top + r.height / 2) / window.innerHeight)
      })
    },
    [cfg.roam]
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
    if (!cfg.enabled || !cfg.roam) return
    const t = window.setInterval(() => {
      if (bubble || open) return
      const pick = closeable(panes)[0] ?? panes[0]
      if (pick) walkTo(pick.id)
      else setSpot(HOME)
    }, WANDER_MS)
    return () => window.clearInterval(t)
  }, [cfg.enabled, cfg.roam, panes, bubble, open, walkTo])

  useEffect(() => {
    if (!cfg.enabled) return
    const t = window.setInterval(() => {
      setBlink(true)
      window.setTimeout(() => setBlink(false), 160)
    }, 5200)
    return () => window.clearInterval(t)
  }, [cfg.enabled])

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
        className="mascot"
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
          className={'mascot-body' + (blink ? ' blink' : '')}
          title="Ask about this machine"
          onClick={() => {
            setOpen((v) => !v)
            if (!bubble) say({ say: 'Ask me - "what is pane 3", "close the idle ones".', key: 'greet' })
          }}
        >
          <svg viewBox="0 0 48 48" width="46" height="46" aria-hidden="true">
            {/* The app's own three-pane geometry: the outer two are the project, the
                middle one is the face. Same 0.043 gap the icon uses. */}
            <rect className="m-pane" x="2" y="10" width="10" height="28" rx="3" />
            <rect className="m-pane" x="36" y="10" width="10" height="28" rx="3" />
            <rect className="m-face" x="14" y="6" width="20" height="34" rx="5" />
            <g className="m-eyes">
              <circle cx="20" cy="19" r="2.1" />
              <circle cx="28" cy="19" r="2.1" />
            </g>
            <path className="m-mouth" d="M20 27 q4 3.5 8 0" fill="none" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  )
}
