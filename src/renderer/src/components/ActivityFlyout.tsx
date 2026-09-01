// What the app did on its own, as a list somebody can read.
//
// Every automatic thing in this app already announces itself in a card that is gone in
// seconds - a pane closing, a session clearing itself, a pane renaming itself. Robert,
// 2026-09-01: "would be good for notifications icon somewhere where i can check activity
// / notifs like closed ... or like auto cleared ... just easy to see what happened
// recently like 3min ago etc."
//
// So: one bell in the sidebar with a count, and this panel behind it. It is a READING and
// nothing else - no row does anything when pressed, because everything here has already
// happened, and the things that have NOT happened yet are cards in the corner where they
// can still be stopped. `shared/activity.ts` owns every word and every judgement.

import { useEffect, useRef, useState } from 'react'
import type { ActivityEntry } from '@shared/activity'
import { KIND_WORDS } from '@shared/activity'
import { whenWords } from '@shared/elapsed'

export interface ActivityFlyoutProps {
  items: ActivityEntry[]
  /** The bell's own rectangle, so the panel opens beside the thing that was pressed. */
  anchor: DOMRect
  onClose: () => void
}

/** How wide the panel is. Kept here because the clamp below needs the same number. */
const W = 300

export default function ActivityFlyout({ items, anchor, onClose }: ActivityFlyoutProps): React.JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  // A minute, never a second: every line in here is `4 min ago`, and a clock that wakes
  // the panel once a second to redraw the same words is a wakeup for nothing.
  const [, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(t)
  }, [])
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])

  const left = Math.min(Math.max(8, anchor.left), Math.max(8, window.innerWidth - W - 8))
  const top = Math.min(anchor.bottom + 6, Math.max(8, window.innerHeight - 160))

  return (
    <>
      {/* A press anywhere else closes it. Transparent: this is a reading, not a decision,
          so it never dims the app behind it the way a dialog does. */}
      <div className="act-back" onMouseDown={onClose} />
      <div
        className="act-fly"
        ref={box}
        style={{ left, top, width: W }}
        role="dialog"
        aria-label="Recent activity"
        data-testid="activity-flyout"
      >
        <div className="act-head">
          <span>Recently</span>
          <button className="icon" title="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        {items.length === 0 ? (
          // Never "no notifications": the honest sentence is that the app has not had to
          // do anything, which is the good state rather than an empty container.
          <div className="act-empty">Nothing has happened on its own yet.</div>
        ) : (
          <ul className="act-list">
            {items.map((x) => (
              <li key={x.id} className="act-row">
                <span className={'act-kind k-' + x.kind}>{KIND_WORDS[x.kind]}</span>
                <span className="act-what">{x.what}</span>
                <span className="act-when">{whenWords(x.at)}</span>
                {x.why && <span className="act-why">{x.why}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  )
}
