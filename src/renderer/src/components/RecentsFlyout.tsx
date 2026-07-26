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
//
// Bottom-left is where it starts, not where it has to stay: the head is a drag handle and
// wherever it is dropped is remembered. That corner is the one the broadcast box and a
// long pane title also want, so a shelf nailed to it would sooner or later sit on the one
// thing being read.

import { useEffect, useRef, useState } from 'react'
import type { RecentItem } from '@shared/types'

const api = window.api

/** Where the user dragged it, window coordinates. Absent = the default corner. */
interface Pos {
  x: number
  y: number
}

// Renderer-local on purpose: this is a property of the screen it was dragged on, not of
// the settings that follow the user around, and it must survive a reload with no IPC.
const POS_KEY = 'pf.shelfPos'

function loadPos(): Pos | null {
  try {
    const raw = localStorage.getItem(POS_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as Pos
    return typeof p?.x === 'number' && typeof p?.y === 'number' ? p : null
  } catch {
    return null
  }
}

/** Never off screen: a shelf dropped near an edge must survive the window getting smaller. */
function clamp(p: Pos, w: number, h: number): Pos {
  const m = 6
  return {
    x: Math.min(Math.max(m, p.x), Math.max(m, window.innerWidth - w - m)),
    y: Math.min(Math.max(m, p.y), Math.max(m, window.innerHeight - h - m))
  }
}

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
  const [pos, setPos] = useState<Pos | null>(loadPos)
  const [dragging, setDragging] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const grab = useRef<{ dx: number; dy: number } | null>(null)

  const open = pinned || peek || hover

  useEffect(() => {
    if (!open) return
    const t = window.setInterval(() => bump((n) => n + 1), 15_000)
    return () => window.clearInterval(t)
  }, [open])

  // A window that got smaller must not leave the shelf off the edge with no way back.
  useEffect(() => {
    const onResize = (): void =>
      setPos((p) => (p ? clamp(p, box.current?.offsetWidth ?? 300, box.current?.offsetHeight ?? 200) : p))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const startDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    // The head carries the clear button too; a click on it is not a drag.
    if ((e.target as HTMLElement).closest('button')) return
    const el = box.current
    if (!el) return
    const r = el.getBoundingClientRect()
    grab.current = { dx: e.clientX - r.left, dy: e.clientY - r.top }
    // Switch from "pinned to the corner" to explicit coordinates at the position it is
    // already at, so the first pixel of the drag does not jump.
    setPos(clamp({ x: r.left, y: r.top }, r.width, r.height))
    setDragging(true)
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* no capture for this pointer - the move handler still tracks it */
    }
    e.preventDefault()
  }

  const onDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    const g = grab.current
    const el = box.current
    if (!g || !el) return
    setPos(clamp({ x: e.clientX - g.dx, y: e.clientY - g.dy }, el.offsetWidth, el.offsetHeight))
  }

  const endDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!grab.current) return
    grab.current = null
    setDragging(false)
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* never captured */
    }
    const el = box.current
    if (!el) return
    const r = el.getBoundingClientRect()
    try {
      localStorage.setItem(POS_KEY, JSON.stringify({ x: r.left, y: r.top }))
    } catch {
      /* storage full or blocked - the shelf just forgets where it was */
    }
  }

  /** Back to the bottom-left corner it starts in - the way out of a bad drop. */
  const resetPos = (): void => {
    setPos(null)
    try {
      localStorage.removeItem(POS_KEY)
    } catch {
      /* nothing to undo */
    }
  }

  // Opened by hand with nothing on it, the old shelf drew nothing at all, which reads as a
  // broken keybind rather than an empty shelf. A peek with no items still stays silent.
  if (!open) return null
  if (!items.length && !pinned) return null

  return (
    <div
      ref={box}
      className={'shelf' + (pinned ? ' pinned' : '') + (dragging ? ' dragging' : '')}
      style={pos ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' } : undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div
        className="shelf-head"
        title="Drag to move - double-click to put it back in the corner"
        onPointerDown={startDrag}
        onPointerMove={onDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={resetPos}
      >
        <span className="shelf-grip" aria-hidden="true">
          ⠿
        </span>
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
      {!items.length && (
        <div className="shelf-empty">
          Nothing copied yet. Copy text or a screenshot anywhere on the machine and it lands here.
        </div>
      )}
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
            <span
              className="shelf-forget"
              title="Forget this one"
              onClick={(e) => {
                e.stopPropagation()
                api.removeRecent(it.id)
              }}
            >
              ✕
            </span>
          </button>
        ))}
      </div>
      {pinned && (
        <div className="shelf-foot">
          <span className="hint">Drag the title to move it - Ctrl Shift V or Esc closes</span>
          <button className="ghost small" onClick={onClose}>
            Close
          </button>
        </div>
      )}
    </div>
  )
}
