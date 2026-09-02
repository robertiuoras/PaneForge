// One quiet card in the corner, saying one thing this app can do.
//
// Everything with a judgement in it is in `shared/tips.ts` - the catalogue, the gaps, the
// four refusals and when the off switch is offered - and is pinned by `npm run test:tips`.
// What is here is the card, the two presses and the clock.
//
// It obeys the app's own standing law: it never takes the screen. No focus, no dialog, no
// sound, nothing raised. It is a card that can be ignored, and the one thing it always
// eventually says is how to stop it.

import { useEffect, useRef, useState } from 'react'
import {
  afterShown,
  dueTip,
  offersOff,
  SHOW_MS,
  TIPS as TIPS_ALL,
  type Tip,
  type TipsConfig
} from '@shared/tips'
import { appVisible } from '../appVisible'
import CardX from './CardX'

interface Props {
  cfg: TipsConfig
  /** Anything already asking for attention - a dialog, an update card, a pairing card. */
  busy: boolean
  /** A pane is holding an agent's question. The one thing a tip may never sit over. */
  asking: boolean
  /** When this window opened, so the first tip is not the first thing anybody sees. */
  since: number
  onConfig: (patch: Partial<TipsConfig>) => void
}

/** How often the clock LOOKS. Almost every look does nothing, so it is cheap and rare. */
const TICK_MS = 60_000

export default function Tips(props: Props): JSX.Element | null {
  const [tip, setTip] = useState<Tip | null>(null)
  const [offer, setOffer] = useState(false)
  // The card's own dismissal, so a tip nobody touched goes away on its own.
  const gone = useRef<number | null>(null)

  // Whether anybody is looking. `document.hidden` is dead code in this window
  // (backgroundThrottling is off - see appVisible.ts), so the answer comes from the main
  // process, and it is asked ON THE TICK that is about to use it rather than cached: a
  // cached flag that goes stale spends a tip on a minimised window.
  const [visible, setVisible] = useState(true)
  const { cfg, busy, asking, since } = props
  useEffect(() => {
    if (tip) return
    const look = (): void => {
      void appVisible().then((v) => setVisible(v))
      const t = dueTip(cfg, Date.now(), { busy, asking, visible, upMs: Date.now() - since })
      if (!t) return
      setOffer(offersOff(cfg.shown))
      setTip(t)
      // Written the moment it is SHOWN, not when it is dismissed: a window closed with a
      // tip on screen must not show the same one again on the next launch.
      props.onConfig(afterShown(cfg, t, Date.now()))
      gone.current = window.setTimeout(() => setTip(null), SHOW_MS)
    }
    // A probe cannot wait four minutes and forty for the first card, and a card nobody has
    // ever seen drawn is exactly the kind of thing that ships broken. This is the same
    // shape as `window.__pfTicks` and `window.__pfRenders`: a hook a test can reach that
    // changes nothing about how the feature behaves on its own.
    ;(window as unknown as { __pfTip?: () => void }).__pfTip = () => {
      const t = TIPS_ALL[Math.floor(Math.random() * TIPS_ALL.length)]
      setOffer(true)
      setTip(t)
    }
    const t = window.setInterval(look, TICK_MS)
    return () => window.clearInterval(t)
  }, [cfg, busy, asking, visible, since, tip, props])

  // A tip already on screen goes the moment something else needs the corner.
  useEffect(() => {
    if (tip && (busy || asking)) setTip(null)
  }, [busy, asking, tip])

  useEffect(
    () => () => {
      if (gone.current) window.clearTimeout(gone.current)
    },
    []
  )

  if (!tip || !cfg.enabled) return null

  return (
    <div className="tip-toast" role="status">
      <CardX onDismiss={() => setTip(null)} />
      <div className="tip-head">
        <span className="tip-dot" />
        Did you know
      </div>
      <div className="tip-say">{tip.say}</div>
      {offer && (
        <div className="tip-off">
          If you would rather not have these, turn them off here - Settings brings them back.
        </div>
      )}
      <div className="tip-acts">
        {offer && (
          <button
            className="ghost small"
            onClick={() => {
              props.onConfig({ enabled: false })
              setTip(null)
            }}
          >
            Turn tips off
          </button>
        )}
        <button className="primary small" onClick={() => setTip(null)}>
          Got it
        </button>
      </div>
    </div>
  )
}
