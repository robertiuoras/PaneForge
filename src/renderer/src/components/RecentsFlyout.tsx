// The clipboard shelf, bottom-left.
//
// Copy anything, anywhere on the machine, and it appears here for five seconds: text as a
// line, a screenshot as a thumbnail. Clicking either puts it into the focused pane - text
// as text, an image as the path of a PNG the app saved for you, which is the form a CLI
// agent can actually read. Hovering holds it open, Ctrl+Shift+V brings it back, and an
// image can be dragged out into any other app.
//
// It is deliberately not a clipboard manager: twelve items, no search, no pinning. The
// job is "the thing I just copied, into the agent, now".

import { useEffect, useState } from 'react'
import type { RecentItem } from '@shared/types'

const api = window.api

interface Props {
  items: RecentItem[]
  /** open because the user asked (keybind/button): stays until dismissed */
  pinned: boolean
  /** briefly open because something new arrived */
  peek: boolean
  onClose: () => void
  /** put this into the focused pane - text, or an image's saved path */
  onSend: (item: RecentItem) => void
}

/** "2m" - short enough to sit in the corner of a tile. */
function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  return `${Math.round(s / 3600)}h`
}

export default function RecentsFlyout({ items, pinned, peek, onClose, onSend }: Props): JSX.Element | null {
  const [hover, setHover] = useState(false)
  // Re-render for the age labels while it is open, and never while it is not.
  const [, bump] = useState(0)

  const open = pinned || peek || hover

  useEffect(() => {
    if (!open) return
    const t = window.setInterval(() => bump((n) => n + 1), 15_000)
    return () => window.clearInterval(t)
  }, [open])

  if (!open || !items.length) return null

  return (
    <div
      className={'shelf' + (pinned ? ' pinned' : '')}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div className="shelf-head">
        <strong>Recently copied</strong>
        <span className="hint">click to put in the pane</span>
        <button
          className="icon small"
          title="Forget everything on the shelf"
          onClick={() => api.clearRecents()}
        >
          ✕
        </button>
      </div>
      <div className="shelf-items">
        {items.map((it) => (
          <button
            key={it.id}
            className={'shelf-item ' + it.kind}
            title={
              it.kind === 'image'
                ? `${it.preview} - click to type its path, drag it anywhere`
                : it.preview
            }
            onClick={() => onSend(it)}
            // Images are real files on disk, so the OS drag layer can carry them into
            // any other app. Started in main: only it can put a file in a drag.
            draggable={it.kind === 'image'}
            onDragStart={(e) => {
              if (it.kind !== 'image') return
              e.preventDefault()
              api.dragRecent(it.id)
            }}
          >
            {it.kind === 'image' && it.thumb ? (
              <img src={it.thumb} alt="" />
            ) : (
              <span className="shelf-text">{it.preview}</span>
            )}
            <span className="shelf-meta">
              <span>{it.kind === 'image' ? `${it.width}x${it.height}` : `${it.chars} chars`}</span>
              <span>{ago(it.at)}</span>
            </span>
            <span
              className="shelf-copy"
              title="Copy back to the clipboard"
              onClick={(e) => {
                e.stopPropagation()
                api.copyRecent(it.id)
              }}
            >
              copy
            </span>
          </button>
        ))}
      </div>
      {pinned && (
        <div className="shelf-foot">
          <span className="hint">Ctrl Shift V closes - Esc too</span>
          <button className="ghost small" onClick={onClose}>
            Close
          </button>
        </div>
      )}
    </div>
  )
}
