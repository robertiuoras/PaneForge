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

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** Size plus how long a stashed file has left, because it is going to disappear. */
function left(it: RecentItem): string {
  const s = size(it.bytes ?? 0)
  if (!it.expires) return s
  const mins = Math.max(0, Math.round((it.expires - Date.now()) / 60_000))
  if (mins < 60) return `${s} · ${mins}m left`
  const hrs = Math.round(mins / 60)
  return hrs < 48 ? `${s} · ${hrs}h left` : `${s} · ${Math.round(hrs / 24)}d left`
}

function Overlay(): JSX.Element {
  const [items, setItems] = useState<RecentItem[]>([])
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  // A file drag is over the overlay right now.
  const [over, setOver] = useState(false)
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

  // Files dragged onto the overlay from anywhere on the desktop. The pill accepts them
  // too, collapsed: dropping a clip on a 172px pill is the fastest way to park one.
  const dragProps = {
    onDragOver: (e: React.DragEvent): void => {
      if (!e.dataTransfer.types.includes('Files')) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy' as const
      if (!over) setOver(true)
    },
    onDragLeave: (): void => setOver(false),
    onDrop: (e: React.DragEvent): void => {
      setOver(false)
      const files = [...(e.dataTransfer?.files ?? [])]
      if (!files.length) return
      e.preventDefault()
      const paths = files.map((f) => shelf.pathForFile(f)).filter(Boolean)
      if (paths.length) void shelf.add(paths)
    }
  }

  if (!open) {
    return (
      <div className="wrap" onMouseEnter={enter} onMouseLeave={leave} {...dragProps}>
        <div
          className={'pill' + (over ? ' over' : '')}
          onClick={() => want(true)}
          title="Stash - Ctrl+Alt+V. Drop a file here to park it."
        >
          <span className="glyph" aria-hidden="true">
            ▤
          </span>
          <span className="count">{items.length}</span>
          <span className="label">{over ? 'drop it' : items.length ? 'stashed' : 'stash'}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="wrap" onMouseEnter={enter} onMouseLeave={leave} {...dragProps}>
      <div className={'card' + (over ? ' over' : '')}>
        <div className="head">
          <strong>Stash</strong>
          <span className="count">{items.length}</span>
          <span className="spacer" />
          <button
            className="mini"
            onClick={() => {
              void shelf.pick()
            }}
            title="Add a file to the Stash"
          >
            +
          </button>
          <button className="mini" onClick={() => shelf.focusApp()} title="Bring PaneForge to the front">
            app
          </button>
          <button
            className="mini"
            onClick={() => shelf.clear()}
            title="Forget everything on the Stash"
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
              Nothing yet. Copy anything, anywhere - or drop a file on here - and it stays.
            </div>
          )}
          {items.map((it) => (
            <div
              key={it.id}
              className={'item' + (copied === it.id ? ' copied' : '')}
              title={
                it.kind === 'text'
                  ? it.preview
                  : `${it.preview} - click to copy, drag it anywhere`
              }
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
              ) : it.kind === 'file' ? (
                // A video shows its own first frame, which is the only way to tell two
                // clips apart at 54px. `stash://` is main handing this window that one
                // file and nothing else; `preload="metadata"` stops it fetching the body.
                it.mime?.startsWith('video/') ? (
                  <video
                    className="vid"
                    src={`stash://${it.id}`}
                    muted
                    playsInline
                    preload="metadata"
                    draggable
                    onDragStart={(e) => {
                      e.preventDefault()
                      shelf.drag(it.id)
                    }}
                  />
                ) : (
                  <span
                    className="filetile"
                    draggable
                    onDragStart={(e) => {
                      e.preventDefault()
                      shelf.drag(it.id)
                    }}
                  >
                    {it.mime?.startsWith('audio/') ? '♪' : '▤'}
                  </span>
                )
              ) : null}
              <span className="body">
                <span className="text">
                  {copied === it.id ? 'copied' : it.kind === 'file' ? (it.name ?? it.preview) : it.preview}
                </span>
                <span className="meta">
                  {it.kind === 'image'
                    ? `${it.width}x${it.height}`
                    : it.kind === 'file'
                      ? left(it)
                      : `${it.chars} chars`}{' '}
                  · {ago(it.at)}
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
        <div className="foot">
          Click copies · drag a tile into any app · → sends to the pane · Ctrl+Alt+V
        </div>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Overlay />
  </StrictMode>
)
