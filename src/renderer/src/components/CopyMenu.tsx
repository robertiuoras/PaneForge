/**
 * The small menu behind every "copy something out of this pane" gesture.
 *
 * One component, two openers: the copy button in the pane's header (which offers the
 * newest turn) and a right-click on a prompt tag in the rail (which offers THAT turn).
 * Both hand it the same rows, so the two surfaces cannot drift into offering different
 * things - and neither of them moves while it is being reached for, which is the whole
 * point. The pair of icons this replaced was placed off the drawn frame beside every
 * prompt on screen, so it slid away under the pointer whenever the agent printed a line.
 *
 * Each row carries a dim one-line preview of what it would put on the clipboard. A copy
 * you have to press to find out about is a copy you press twice, and the second press is
 * after you have already pasted the wrong thing somewhere.
 *
 * Shaped after the design vault's `linear.app.md`: one surface step above the panel it
 * sits on, hairline border, no shadow theatre, and the only motion is the 120ms fade the
 * rest of the app uses.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface CopyChoice {
  key: string
  label: string
  /** first line of what pressing it copies, already shortened; empty for a non-copy row */
  preview: string
  run(): void
}

/** Keep the whole menu on screen - opened from a header button near the right edge. */
function clamp(x: number, y: number, w: number, h: number): { left: number; top: number } {
  const pad = 8
  return {
    left: Math.max(pad, Math.min(x, window.innerWidth - w - pad)),
    top: Math.max(pad, Math.min(y, window.innerHeight - h - pad))
  }
}

export default function CopyMenu({
  title,
  x,
  y,
  items,
  onClose
}: {
  title: string
  x: number
  y: number
  items: CopyChoice[]
  onClose(): void
}): JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y })
  const [cursor, setCursor] = useState(0)

  useLayoutEffect(() => {
    const r = box.current?.getBoundingClientRect()
    if (r) setPos(clamp(x, y, r.width, r.height))
  }, [x, y, items.length])

  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        setCursor((c) => {
          const n = items.length
          if (!n) return 0
          const next = e.key === 'ArrowDown' ? c + 1 : c - 1
          return ((next % n) + n) % n
        })
        return
      }
      if (e.key === 'Enter' && items[cursor]) {
        e.preventDefault()
        e.stopPropagation()
        const it = items[cursor]
        onClose()
        it.run()
      }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [onClose, cursor, items])

  return (
    <div
      className="copy-menu-back"
      // mousedown, not click: a click outside would land on whatever is under it first,
      // and on a terminal that is the start of a selection drag.
      onMouseDown={onClose}
      onContextMenu={(e) => {
        e.preventDefault()
        onClose()
      }}
      role="presentation"
    >
      <div
        ref={box}
        className="copy-menu"
        style={{ left: pos.left, top: pos.top }}
        role="menu"
        aria-label={`Copy from ${title}`}
        // The pane underneath must not take focus off whatever is being copied.
        onMouseDown={(e) => e.stopPropagation()}
      >
        {items.map((it, i) => (
          <button
            key={it.key}
            role="menuitem"
            className={'copy-row' + (i === cursor ? ' on' : '')}
            onMouseEnter={() => setCursor(i)}
            onClick={() => {
              onClose()
              it.run()
            }}
          >
            <span className="copy-label">{it.label}</span>
            {it.preview && <span className="copy-preview">{it.preview}</span>}
          </button>
        ))}
      </div>
    </div>
  )
}
