// What has happened to ONE copy of a project, as a list somebody can read.
//
// The row this opens from says what is true now - "won't merge - needs a decision, 40m".
// The question that has no answer anywhere is the one asked five minutes later: was it
// like that all morning, who had it before, did its work ever go out. Every one of those
// facts was a boolean in the lane ledger that flipped back, and the only place any of them
// was ever said out loud was a sentence a hook printed into another chat.
//
// Same shape and the same stylesheet as ActivityFlyout: a panel beside the thing that was
// pressed, plain-word rows, nothing pressable, Escape closes. Deliberately not a new
// design - the two answer the same kind of question ("what happened, and when") and giving
// them two looks would be two things to learn for one idea.

import { useEffect, useRef } from 'react'
import type { LaneEvent } from '@shared/laneTimeline'
import { LANE_EVENT_WORDS, laneEventLine } from '@shared/laneTimeline'
import { whenWords } from '@shared/elapsed'

export interface LaneTimelineFlyoutProps {
  /** This copy's events, newest first. */
  items: LaneEvent[]
  /** What the copy is called, for the heading. */
  title: string
  /** The row's own rectangle, so the panel opens beside what was pressed. */
  anchor: DOMRect
  onClose: () => void
}

/** How wide the panel is. The clamp below needs the same number. */
const W = 300

export default function LaneTimelineFlyout({
  items,
  title,
  anchor,
  onClose
}: LaneTimelineFlyoutProps): React.JSX.Element {
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    box.current?.querySelector<HTMLButtonElement>('button')?.focus()
    return () => {
      previous?.focus()
    }
  }, [])

  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])

  const width = Math.min(W, window.innerWidth - 16)
  const left = Math.min(Math.max(8, anchor.left), Math.max(8, window.innerWidth - width - 8))
  const top = Math.min(anchor.bottom + 6, Math.max(8, window.innerHeight - 280))

  return (
    <>
      {/* A press anywhere else closes it. Transparent, like the activity list: this is a
          reading, not a decision, so it never dims the app behind it. */}
      <div className="act-back" onMouseDown={onClose} />
      <div
        className="act-fly lane-tl"
        ref={box}
        style={{ left, top, width, maxHeight: Math.max(0, window.innerHeight - top - 8) }}
        role="dialog"
        aria-label={`What happened to ${title}`}
        data-testid="lane-timeline"
      >
        <div className="act-head">
          <span>{title}</span>
          <button className="icon" title="Close" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        {items.length === 0 ? (
          // Never "no history": nothing has been watched yet is a different fact from
          // nothing having happened, and the honest sentence says which.
          <div className="act-empty">Nothing has happened to this copy since the app started.</div>
        ) : (
          <ul className="act-list">
            {items.map((x) => (
              <li key={x.id} className="act-row">
                <span className={'act-kind lane-k-' + x.kind}>{LANE_EVENT_WORDS[x.kind]}</span>
                <span className="act-what">{laneEventLine(x)}</span>
                <span className="act-when">{whenWords(x.at)}</span>
                {x.chat && x.kind !== 'taken' && <span className="act-why">{`the chat called "${x.chat}"`}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  )
}
