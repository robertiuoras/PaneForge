// Right-click on a session card.
//
// The card already answers "which pane is this"; everything you might then WANT to do to
// it lived somewhere else - a double-click nobody discovers (rename), a button inside the
// pane header (hand off, clear, close), or nowhere at all (what is this thing, how long has
// it been open). A context menu is where a list row's actions belong on a desktop, so this
// is that: opened at the pointer, dismissed by anything, keyboard-navigable.
//
// It is NOT `PaneMenu`, which is the phone's action sheet: that one is a full-width bottom
// sheet with 52px rows because a finger needs them, and it is anchored to the screen rather
// than to the row. Same actions, different hand.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface MenuItem {
  key: string
  label: string
  hint?: string
  danger?: boolean
  disabled?: boolean
  run(): void
}

interface Props {
  title: string
  x: number
  y: number
  items: MenuItem[]
  onClose(): void
}

/** Keep the whole menu on screen: a card near the bottom right would otherwise open off it. */
function clamp(x: number, y: number, w: number, h: number): { left: number; top: number } {
  const pad = 8
  return {
    left: Math.max(pad, Math.min(x, window.innerWidth - w - pad)),
    top: Math.max(pad, Math.min(y, window.innerHeight - h - pad))
  }
}

export default function SessionMenu({ title, x, y, items, onClose }: Props): JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y })
  const [cursor, setCursor] = useState(-1)
  const live = items.filter((i) => !i.disabled)
  // The keyboard cursor is an INDEX, and the list it indexes is rebuilt whenever the pane
  // changes state (an exited pane loses Hand off, Restart and the editor). If an item
  // above the cursor disappears, every item below it shifts up and the same index is now a
  // different action - so Enter would silently run the row underneath the one being looked
  // at. The guard `live[cursor]` only proves an item is there, never that it is the one
  // that was chosen. So the cursor is dropped whenever the list's own shape changes.
  const shape = live.map((i) => i.key).join('|')
  const lastShape = useRef(shape)
  if (lastShape.current !== shape) {
    lastShape.current = shape
    if (cursor !== -1) setCursor(-1)
  }

  // Measured after the first paint rather than guessed: the menu's height depends on how
  // many actions this particular pane offers (a mirror has fewer), so a fixed number would
  // be wrong for half of them.
  useLayoutEffect(() => {
    const r = box.current?.getBoundingClientRect()
    if (r) setPos(clamp(x, y, r.width, r.height))
  }, [x, y, items.length])

  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        setCursor((c) => {
          const n = live.length
          if (!n) return -1
          const next = e.key === 'ArrowDown' ? c + 1 : c - 1
          return ((next % n) + n) % n
        })
        return
      }
      if (e.key === 'Enter' && cursor >= 0 && live[cursor]) {
        e.preventDefault()
        e.stopPropagation()
        const item = live[cursor]
        onClose()
        item.run()
      }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [onClose, cursor, live])

  return (
    <div
      className="ctx-back"
      onMouseDown={onClose}
      onContextMenu={(e) => {
        // A second right-click closes it instead of asking Chromium for its own menu.
        e.preventDefault()
        onClose()
      }}
      role="presentation"
    >
      <div
        ref={box}
        className="ctx-menu"
        style={{ left: pos.left, top: pos.top }}
        role="menu"
        aria-label={`Actions for ${title}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="ctx-head">{title}</div>
        {items.map((it) => {
          const idx = live.indexOf(it)
          return (
            <button
              key={it.key}
              role="menuitem"
              className={
                'ctx-row' +
                (it.danger ? ' danger' : '') +
                (idx >= 0 && idx === cursor ? ' on' : '')
              }
              disabled={it.disabled}
              onMouseEnter={() => setCursor(idx)}
              onClick={() => {
                onClose()
                it.run()
              }}
            >
              <span className="ctx-label">{it.label}</span>
              {it.hint && <span className="ctx-hint">{it.hint}</span>}
            </button>
          )
        })}
      </div>
    </div>
  )
}
