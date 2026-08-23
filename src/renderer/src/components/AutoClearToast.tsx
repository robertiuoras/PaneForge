import { useEffect, useState } from 'react'
import type { ClearAsk } from '@shared/autoclear'

const api = window.api

/**
 * The card in front of an automatic /clear.
 *
 * A Stop hook decides this session is past the context line and its handoff lists work a
 * fresh session could pick up, and asks for the pane to be cleared. Until 2026-08-23 that
 * happened with no warning - Robert's words, "it shouldnt be auto clearing instantly or at
 * least put popup for a countdown when its about to auto clear just so i can stop it".
 *
 * So: what would be continued, how long is left, and a button that stops it. Nobody at the
 * desk means it still happens by itself, which is the point of the feature.
 */
export default function AutoClearToast(): JSX.Element | null {
  const [pending, setPending] = useState<ClearAsk[]>([])
  const [now, setNow] = useState<number>(() => Date.now())

  useEffect(() => {
    void Promise.resolve(api.autoClearPending())
      .then((p) => setPending(p ?? []))
      .catch(() => setPending([]))
    return api.onAutoClear((p) => setPending(p ?? []))
  }, [])

  // Only while something is counting: an interval that runs on an empty desk is a repaint
  // every quarter second for nothing.
  useEffect(() => {
    if (!pending.length) return
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [pending.length])

  const ask = pending[0]
  if (!ask) return null
  const leftMs = Math.max(0, ask.dueAt - now)
  const left = Math.ceil(leftMs / 1000)
  const total = Math.max(1, ask.dueAt - ask.askedAt)
  const pct = Math.max(0, Math.min(100, (leftMs / total) * 100))

  return (
    <div className="update-toast autoclear">
      <div className="ut-text">
        <strong>Clearing {ask.title || 'this pane'} in {left}s</strong>
        <span className="hint">
          Context is past the line and the handoff still lists work, so this session hands
          over to a fresh one that continues:
        </span>
        <ul className="ac-steps">
          {ask.steps.slice(0, 3).map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      </div>
      <div className="ac-bar">
        <i style={{ width: `${pct}%` }} />
      </div>
      <div className="ut-actions">
        <button className="ghost small" onClick={() => void api.answerAutoClear(ask.paneId, 'cancel')}>
          Keep this session
        </button>
        <button className="primary small" onClick={() => void api.answerAutoClear(ask.paneId, 'now')}>
          Clear now
        </button>
      </div>
    </div>
  )
}
