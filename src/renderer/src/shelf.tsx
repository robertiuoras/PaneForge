// The page inside the floating clipboard overlay.
//
// Two states, and the window resizes to match each one (the main process owns the size -
// see shelfWindow.ts):
//
//   collapsed  a pill with the number of things on the clipboard history
//   expanded   the history itself, newest first, one click per item
//
// Clicking a row puts it back on the OS clipboard rather than into a pane, because this
// window is for the times PaneForge is not the app you are in: copy here, Ctrl+V in the
// browser you were already typing in. The arrow sends it to the focused pane instead,
// which is the old in-window shelf's behaviour, kept for when you are in the app.
//
// It never takes focus (the window is `focusable: false`), so there is no keyboard here
// at all - no search box, no arrow keys. Everything is one click.

import { StrictMode, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { RecentItem } from '@shared/types'
import './shelf.css'

const shelf = window.shelf

function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86_400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86_400)}d`
}

function Overlay(): JSX.Element {
  const [items, setItems] = useState<RecentItem[]>([])
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  // Opened by the hotkey, not by the mouse: it must not vanish the moment the pointer
  // crosses it on the way to the window underneath.
  const sticky = useRef(false)
  const asked = useRef(false)
  const closeTimer = useRef<number>()
  const copiedTimer = useRef<number>()

  useEffect(() => {
    shelf.list().then(setItems)
    const offItems = shelf.onItems(setItems)
    const offOpen = shelf.onExpanded((next) => {
      // Anything that opened it other than this page's own hover is a deliberate ask.
      if (next && !asked.current) sticky.current = true
      if (!next) sticky.current = false
      asked.current = false
      setOpen(next)
    })
    return () => {
      offItems()
      offOpen()
    }
  }, [])

  // The "2m ago" labels only move while the list is on screen; a collapsed pill has no
  // clock in it and must not wake the machine to keep one.
  const [, bump] = useState(0)
  useEffect(() => {
    if (!open) return
    const t = window.setInterval(() => bump((n) => n + 1), 20_000)
    return () => window.clearInterval(t)
  }, [open])

  const want = (next: boolean): void => {
    asked.current = true
    shelf.setExpanded(next)
  }

  const enter = (): void => {
    window.clearTimeout(closeTimer.current)
    if (!open) want(true)
  }

  const leave = (): void => {
    if (sticky.current) return
    window.clearTimeout(closeTimer.current)
    // A short grace period: the pointer crossing a gap between the pill and the card
    // during the resize must not close what it just opened.
    closeTimer.current = window.setTimeout(() => want(false), 350)
  }

  const flashCopied = (id: string): void => {
    setCopied(id)
    window.clearTimeout(copiedTimer.current)
    copiedTimer.current = window.setTimeout(() => setCopied(null), 900)
  }

  if (!open) {
    return (
      <div className="wrap" onMouseEnter={enter} onMouseLeave={leave}>
        <div className="pill" onClick={() => want(true)} title="Clipboard history - Ctrl+Alt+V">
          <span className="glyph" aria-hidden="true">
            ▤
          </span>
          <span className="count">{items.length}</span>
          <span className="label">{items.length ? 'copied' : 'clipboard'}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="wrap" onMouseEnter={enter} onMouseLeave={leave}>
      <div className="card">
        <div className="head">
          <strong>Clipboard</strong>
          <span className="count">{items.length}</span>
          <span className="spacer" />
          <button className="mini" onClick={() => shelf.focusApp()} title="Bring PaneForge to the front">
            app
          </button>
          <button
            className="mini"
            onClick={() => shelf.clear()}
            title="Forget everything in the history"
          >
            clear
          </button>
          <button
            className="mini"
            onClick={() => {
              sticky.current = false
              want(false)
            }}
            title="Close"
          >
            ✕
          </button>
        </div>
        <div className="list">
          {!items.length && (
            <div className="empty">
              Nothing yet. Copy anything, anywhere, and it lands here and stays.
            </div>
          )}
          {items.map((it) => (
            <div
              key={it.id}
              className={'item' + (copied === it.id ? ' copied' : '')}
              title={it.kind === 'image' ? `${it.preview} - click to copy, drag it anywhere` : it.preview}
              onClick={() => {
                shelf.copy(it.id)
                flashCopied(it.id)
              }}
            >
              {it.kind === 'image' && it.thumb ? (
                <img
                  src={it.thumb}
                  alt=""
                  draggable
                  onDragStart={(e) => {
                    // Only the main process can put a real file in an OS drag.
                    e.preventDefault()
                    shelf.drag(it.id)
                  }}
                />
              ) : null}
              <span className="body">
                <span className="text">{copied === it.id ? 'copied' : it.preview}</span>
                <span className="meta">
                  {it.kind === 'image' ? `${it.width}x${it.height}` : `${it.chars} chars`} · {ago(it.at)}
                </span>
              </span>
              <span className="acts">
                <span
                  title="Put it in the focused PaneForge pane"
                  onClick={(e) => {
                    e.stopPropagation()
                    shelf.toPane(it.id)
                  }}
                >
                  →
                </span>
                <span
                  className="del"
                  title="Forget this one"
                  onClick={(e) => {
                    e.stopPropagation()
                    shelf.remove(it.id)
                  }}
                >
                  ✕
                </span>
              </span>
            </div>
          ))}
        </div>
        <div className="foot">Click copies · → sends to the pane · ✕ forgets · Ctrl+Alt+V</div>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Overlay />
  </StrictMode>
)
