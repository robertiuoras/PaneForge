import { useEffect, useState } from 'react'
import type { WhatsNew } from '@shared/whatsNew'

const api = window.api

/**
 * One card, once, the first time you are on a new build: what changed, in sentences.
 *
 * It sits where `UpdateToast` sits and looks like it on purpose - that card is the one
 * that offered the restart, and this is the answer to it. It is NOT a dialog: nothing the
 * app decided by itself may take the screen (see "Never take the screen"), so this draws
 * in the renderer, takes no focus, and goes away on a press or on its own.
 *
 * `api.whatsNew()` is asked exactly once and answers null for every launch that is not
 * the first one on a newer build - including one that could not reach GitHub - so the
 * common case costs one IPC round trip that returns null.
 */
export default function WhatsNewCard(): JSX.Element | null {
  const [news, setNews] = useState<WhatsNew | null>(null)
  const [gone, setGone] = useState(false)

  useEffect(() => {
    let live = true
    // A beat after the desk comes back. The launch tick is busy restoring panes and this
    // is the least urgent thing in the app; arriving into a settled window also stops the
    // card from being the thing that flashes while the grid is still laying itself out.
    const t = setTimeout(() => {
      void api
        .whatsNew()
        .then((n) => live && setNews(n))
        .catch(() => undefined)
    }, 2500)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [])

  if (!news || gone || !news.bullets.length) return null

  return (
    <div className="update-toast whatsnew">
      <div className="ut-text">
        <strong>What changed in {news.version}</strong>
        <ul className="wn-list">
          {news.bullets.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
        {news.more > 0 ? (
          <span className="hint">
            {news.more} more {news.more === 1 ? 'change' : 'changes'} in the full notes.
          </span>
        ) : null}
      </div>
      <div className="ut-actions">
        <button className="ghost small" onClick={() => api.openExternal(news.url)}>
          Full notes
        </button>
        <button className="primary small" onClick={() => setGone(true)}>
          Got it
        </button>
      </div>
    </div>
  )
}
