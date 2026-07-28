// The page inside the floating Stash.
//
// This is the Stash - the only one. Anything you copy anywhere on the machine lands here,
// and it sits on top of every other window, wherever you drag it, whether or not PaneForge
// is on screen. Clicking a row puts it back on the OS clipboard rather than into a pane,
// because this window is for the times PaneForge is not the app you are in: copy here,
// Ctrl+V in the browser you were already typing in. The arrow sends it to the focused pane
// instead, for when you are in the app.
//
// Three states, and the main process resizes the window to match each one (see
// shelfWindow.ts):
//
//   collapsed  a pill with the number of things on it
//   expanded   the list itself, newest first, one click per item
//   tall       the same, with the settings panel open underneath the header
//
// It never takes focus (the window is `focusable: false`), so there is no keyboard here at
// all - no search box, no arrow keys, and every setting is a click on a choice rather than
// a number you type. For the same reason it cannot use a draggable window region: moving
// it is done by hand, from the pointer's screen coordinates.

import { StrictMode, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { RecentItem, StashConfig } from '@shared/types'
import './shelf.css'

const shelf = window.shelf

type Filter = 'all' | 'text' | 'image' | 'file'

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
  if (it.pinned || !it.expires) return s
  const mins = Math.max(0, Math.round((it.expires - Date.now()) / 60_000))
  if (mins < 60) return `${s} · ${mins}m left`
  const hrs = Math.round(mins / 60)
  return hrs < 48 ? `${s} · ${hrs}h left` : `${s} · ${Math.round(hrs / 24)}d left`
}

/**
 * Drag the window by whatever this is put on. Pointer capture is what makes it survive the
 * pointer leaving the window, which it does immediately - the window is moving out from
 * under it. `moved` is handed back so a click on the same element can be ignored when it
 * turns out to have been a drag.
 */
function useWindowDrag(): {
  handlers: React.HTMLAttributes<HTMLElement>
  wasDrag: () => boolean
  dragging: () => boolean
} {
  const from = useRef<{ x: number; y: number } | null>(null)
  const moved = useRef(false)
  // The newest pointer position that has not been sent yet, and the frame that will send
  // it. Moving this window costs main several milliseconds (see shelfWindow.ts), and a
  // pointer reports faster than that, so sending every event built a backlog the window
  // was still working through after the mouse had stopped. One send per frame, always
  // the latest position: nothing to queue, so nothing to fall behind by.
  const next = useRef<{ x: number; y: number } | null>(null)
  const frame = useRef(0)

  const send = (): void => {
    frame.current = 0
    const p = next.current
    next.current = null
    if (p) shelf.dragWindow.move(p.x, p.y)
  }

  return {
    handlers: {
      onPointerDown: (e: React.PointerEvent) => {
        // The header carries the buttons as well as the grip; a press on one of those is
        // a press on the button, not the start of a drag.
        if (e.button !== 0 || (e.target as HTMLElement).closest?.('button')) return
        from.current = { x: e.screenX, y: e.screenY }
        moved.current = false
        ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
        shelf.dragWindow.start()
      },
      onPointerMove: (e: React.PointerEvent) => {
        if (!from.current) return
        // A few pixels of travel is a click with a shaky hand, not a drag. Below the
        // threshold nothing moves, so clicking a header button still works.
        if (
          !moved.current &&
          Math.abs(e.screenX - from.current.x) + Math.abs(e.screenY - from.current.y) < 4
        )
          return
        moved.current = true
        next.current = { x: e.screenX, y: e.screenY }
        if (!frame.current) frame.current = requestAnimationFrame(send)
      },
      onPointerUp: (e: React.PointerEvent) => {
        if (!from.current) return
        ;(e.target as HTMLElement).releasePointerCapture?.(e.pointerId)
        from.current = null
        // Let go between frames: where the pointer finished is where it should end up.
        if (frame.current) cancelAnimationFrame(frame.current)
        send()
        shelf.dragWindow.end()
      }
    },
    wasDrag: () => moved.current,
    dragging: () => !!from.current
  }
}

/** One setting: a label and a row of choices, because there is no keyboard here. */
function Choice({
  label,
  hint,
  value,
  options,
  onPick
}: {
  label: string
  hint?: string
  value: number
  options: { value: number; label: string }[]
  onPick: (v: number) => void
}): JSX.Element {
  return (
    <div className="opt">
      <div className="opt-label">
        {label}
        {hint && <span className="opt-hint">{hint}</span>}
      </div>
      <div className="seg">
        {options.map((o) => (
          <button
            key={o.value}
            className={'seg-btn' + (o.value === value ? ' on' : '')}
            onClick={() => onPick(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function Settings({
  config,
  patch,
  onClose
}: {
  config: StashConfig | null
  patch: (p: Partial<StashConfig>) => void
  onClose: () => void
}): JSX.Element {
  if (!config) return <div className="panel-empty">Loading…</div>
  return (
    <div className="panel">
      <Choice
        label="Pop open for"
        hint="when something new lands"
        value={config.stashPeekMs}
        options={[
          { value: 0, label: 'never' },
          { value: 2000, label: '2s' },
          { value: 5000, label: '5s' },
          { value: 10_000, label: '10s' },
          { value: 30_000, label: '30s' }
        ]}
        onPick={(v) => patch({ stashPeekMs: v })}
      />
      <Choice
        label="Closes itself after"
        hint="once the pointer leaves"
        value={config.stashAutoCloseMs}
        options={[
          { value: 0, label: 'never' },
          { value: 2000, label: '2s' },
          { value: 5000, label: '5s' },
          { value: 10_000, label: '10s' },
          { value: 30_000, label: '30s' }
        ]}
        onPick={(v) => patch({ stashAutoCloseMs: v })}
      />
      <Choice
        label="Keep"
        hint="entries, oldest drop off"
        value={config.stashMaxItems}
        options={[
          { value: 25, label: '25' },
          { value: 50, label: '50' },
          { value: 200, label: '200' },
          { value: 1000, label: '1000' }
        ]}
        onPick={(v) => patch({ stashMaxItems: v })}
      />
      <Choice
        label="Screenshots"
        hint="a PNG each on disk"
        value={config.stashMaxImages}
        options={[
          { value: 0, label: 'none' },
          { value: 6, label: '6' },
          { value: 24, label: '24' },
          { value: 60, label: '60' }
        ]}
        onPick={(v) => patch({ stashMaxImages: v })}
      />
      <Choice
        label="Dropped files last"
        hint="then the copy is deleted"
        value={config.stashFileHours}
        options={[
          { value: 1, label: '1h' },
          { value: 6, label: '6h' },
          { value: 24, label: '1d' },
          { value: 168, label: '1w' },
          { value: 0, label: 'forever' }
        ]}
        onPick={(v) => patch({ stashFileHours: v })}
      />
      <Choice
        label="Biggest file"
        hint="bigger ones are refused"
        value={config.stashMaxFileMb}
        options={[
          { value: 128, label: '128M' },
          { value: 512, label: '512M' },
          { value: 2048, label: '2G' },
          { value: 0, label: 'any' }
        ]}
        onPick={(v) => patch({ stashMaxFileMb: v })}
      />
      <div className="panel-foot">
        <button className="mini" onClick={() => shelf.reveal()} title="Open the Stash folder">
          folder
        </button>
        <button
          className="mini"
          onClick={() => shelf.focusApp()}
          title="Bring PaneForge to the front"
        >
          PaneForge
        </button>
        <span className="spacer" />
        <button
          className="mini danger"
          onClick={() => patch({ clipboardOverlay: false })}
          title="Hide this window. Ctrl+Alt+V brings it back."
        >
          hide
        </button>
        <button className="mini" onClick={onClose}>
          done
        </button>
      </div>
      <div className="panel-note">
        Pinned entries (📌) are kept through every limit above, and through Clear.
      </div>
    </div>
  )
}

function Overlay(): JSX.Element {
  const [items, setItems] = useState<RecentItem[]>([])
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [settings, setSettings] = useState(false)
  const [config, setConfig] = useState<StashConfig | null>(null)
  // A file drag is over the overlay right now.
  const [over, setOver] = useState(false)
  // Opened by the hotkey, not by the mouse: it must not vanish the moment the pointer
  // crosses it on the way to the window underneath.
  const sticky = useRef(false)
  const asked = useRef(false)
  const closeTimer = useRef<number>()
  const copiedTimer = useRef<number>()
  const drag = useWindowDrag()

  useEffect(() => {
    shelf.list().then(setItems)
    shelf.getConfig().then(setConfig)
    const offItems = shelf.onItems(setItems)
    const offConfig = shelf.onConfig(setConfig)
    const offOpen = shelf.onExpanded((next) => {
      // Anything that opened it other than this page's own hover is a deliberate ask.
      if (next && !asked.current) sticky.current = true
      if (!next) sticky.current = false
      asked.current = false
      setOpen(next)
      if (!next) setSettings(false)
    })
    return () => {
      offItems()
      offConfig()
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
    // Nothing resizes this window while it is being moved. Every path that opens the list
    // goes through here, so this is one place rather than four - and main refuses as well,
    // because the timer that asks may fire between two frames of the drag.
    if (next && drag.dragging()) return
    asked.current = true
    shelf.setExpanded(next)
  }

  /**
   * Hovering the pill opens it, but not the instant the pointer touches it. The pill is
   * also the window's handle: at zero delay, reaching for it to move it opened the list
   * under your hand every time, and you ended up dragging the big card instead of the
   * small pill you aimed at. A third of a second is longer than a pointer crossing the
   * corner on its way somewhere else, and shorter than a deliberate reach.
   */
  const HOVER_OPEN_MS = 320
  const openTimer = useRef<number>()
  /** The pointer is on the grip: that is a reach for the handle, never a reach for the list. */
  const onGrip = useRef(false)
  /** Just let go of a drag - the pointer is still on the pill, and that is not a hover. */
  const holdOff = useRef(0)

  const cancelOpen = (): void => window.clearTimeout(openTimer.current)

  const scheduleOpen = (): void => {
    cancelOpen()
    if (onGrip.current || drag.dragging() || Date.now() < holdOff.current) return
    openTimer.current = window.setTimeout(() => {
      if (!onGrip.current && !drag.dragging()) want(true)
    }, HOVER_OPEN_MS)
  }

  // Opened and then forgotten: fold back to the pill by itself. The hover path already
  // closes 350ms after the pointer leaves, but a hotkey open is sticky - it used to sit
  // over whatever window was underneath until someone closed it by hand, an hour after
  // the paste it was opened for. So once the pointer is elsewhere (or never arrived),
  // the list gives itself this long and then puts itself away. The settings panel and a
  // file drag are deliberate stops, so they hold it open.
  const idleTimer = useRef<number>()
  const inside = useRef(false)

  const armIdle = (): void => {
    window.clearTimeout(idleTimer.current)
    const ms = config?.stashAutoCloseMs ?? 5000
    if (!open || !ms || settings || over || inside.current) return
    idleTimer.current = window.setTimeout(() => {
      sticky.current = false
      want(false)
    }, ms)
  }

  useEffect(() => {
    armIdle()
    return () => window.clearTimeout(idleTimer.current)
  }, [open, settings, over, config?.stashAutoCloseMs])

  const enter = (): void => {
    inside.current = true
    window.clearTimeout(idleTimer.current)
    window.clearTimeout(closeTimer.current)
    if (!open) scheduleOpen()
  }

  const leave = (): void => {
    inside.current = false
    cancelOpen()
    armIdle()
    // The settings panel is a deliberate stop, not a glance: it must not close itself out
    // from under the pointer on the way to a choice near the edge.
    if (sticky.current || settings) return
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

  const showSettings = (next: boolean): void => {
    setSettings(next)
    sticky.current = next || sticky.current
    shelf.setTall(next)
  }

  const patch = (p: Partial<StashConfig>): void => {
    // Answered by main with what it actually stored, so a refused value never sticks on
    // screen as though it had been taken.
    void shelf.setConfig(p).then(setConfig)
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
          {...drag.handlers}
          // Capture, so these run whatever the drag handlers do with the same event.
          onPointerDownCapture={cancelOpen}
          onPointerUpCapture={() => {
            // A press that turned into a move leaves the pointer sitting on the pill. That
            // is the end of a drag, not the start of a hover, so it must not open.
            if (drag.wasDrag()) holdOff.current = Date.now() + 600
          }}
          onClick={(e) => {
            // The grip is the handle. Clicking it does nothing on purpose: a miss while
            // reaching to move the pill should not throw the list open.
            if ((e.target as HTMLElement).closest?.('.pill-grip')) return
            if (!drag.wasDrag()) want(true)
          }}
          title="Stash — Ctrl+Alt+V. Drop a file here to park it. Drag it by the grip on the right."
        >
          <span className="glyph" aria-hidden="true">
            ▤
          </span>
          <span className="count">{items.length}</span>
          <span className="label">{over ? 'drop it' : items.length ? 'stashed' : 'stash'}</span>
          {/* The handle, at the far right where a window's grip belongs. Always drawn: it
              used to fade in only on hover, which made the pill look like a button that
              could not be moved, so nobody moved it. Faint at rest, solid under the
              pointer. */}
          <span
            className="pill-grip"
            aria-hidden="true"
            title="Drag to move the Stash — any corner, any screen. It stays there."
            onMouseEnter={() => {
              onGrip.current = true
              cancelOpen()
            }}
            onMouseLeave={() => {
              onGrip.current = false
              // Off the grip but still on the pill: that is a hover again.
              if (!open) scheduleOpen()
            }}
          />
        </div>
      </div>
    )
  }

  const shown = filter === 'all' ? items : items.filter((i) => i.kind === filter)
  const counts = {
    text: items.filter((i) => i.kind === 'text').length,
    image: items.filter((i) => i.kind === 'image').length,
    file: items.filter((i) => i.kind === 'file').length
  }
  const tabs: { key: Filter; label: string; n: number }[] = [
    { key: 'all', label: 'All', n: items.length },
    { key: 'text', label: 'Text', n: counts.text },
    { key: 'image', label: 'Shots', n: counts.image },
    { key: 'file', label: 'Files', n: counts.file }
  ]

  return (
    <div className="wrap" onMouseEnter={enter} onMouseLeave={leave} {...dragProps}>
      <div className={'card' + (over ? ' over' : '')}>
        <div className="head" {...drag.handlers} title="Drag to move the Stash anywhere">
          <span className="grip" aria-hidden="true" />
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
          <button
            className={'mini' + (settings ? ' on' : '')}
            onClick={() => showSettings(!settings)}
            title="Stash settings"
          >
            ⚙
          </button>
          <button
            className="mini"
            onClick={() => shelf.clear()}
            title="Forget everything except the pinned entries"
          >
            clear
          </button>
          <button
            className="mini"
            onClick={() => {
              sticky.current = false
              showSettings(false)
              want(false)
            }}
            title="Shrink back to the pill"
          >
            ✕
          </button>
        </div>

        {settings ? (
          <Settings config={config} patch={patch} onClose={() => showSettings(false)} />
        ) : (
          <>
            {items.length > 0 && (
              <div className="tabs">
                {tabs.map((t) => (
                  <button
                    key={t.key}
                    className={'tab' + (filter === t.key ? ' on' : '')}
                    onClick={() => setFilter(t.key)}
                    disabled={t.n === 0 && t.key !== 'all'}
                  >
                    {t.label}
                    <span className="tab-n">{t.n}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="list">
              {!items.length && (
                <div className="empty">
                  <span className="empty-glyph" aria-hidden="true">
                    ▤
                  </span>
                  Copy anything, anywhere — or drop a file on here — and it stays.
                </div>
              )}
              {!!items.length && !shown.length && <div className="empty">Nothing of that kind.</div>}
              {shown.map((it) => (
                <div
                  key={it.id}
                  className={
                    'item' + (copied === it.id ? ' copied' : '') + (it.pinned ? ' pinned' : '')
                  }
                  title={
                    it.kind === 'text'
                      ? it.preview
                      : `${it.preview} — click to put it in the pane, drag it out`
                  }
                  onClick={() => {
                    // Clicking is the whole gesture: the thing you came here for is
                    // almost always "put that back where I am typing", and that used to
                    // be a second aim at a 12px arrow. It still reaches the clipboard on
                    // the way, so a click is never less than it used to be.
                    shelf.copy(it.id)
                    shelf.toPane(it.id)
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
                  ) : (
                    <span className="texttile" aria-hidden="true">
                      {it.lines && it.lines > 1 ? '¶' : 'T'}
                    </span>
                  )}
                  <span className="body">
                    <span className="text">
                      {copied === it.id
                        ? 'copied'
                        : it.kind === 'file'
                          ? (it.name ?? it.preview)
                          : it.preview}
                    </span>
                    <span className="meta">
                      {it.pinned && <span className="pin-dot">📌</span>}
                      {it.kind === 'image'
                        ? `${it.width}×${it.height}`
                        : it.kind === 'file'
                          ? left(it)
                          : `${it.chars} chars`}
                      {' · '}
                      {ago(it.at)}
                    </span>
                  </span>
                  <span className="acts">
                    <span
                      className={'pin' + (it.pinned ? ' on' : '')}
                      title={it.pinned ? 'Stop keeping this one' : 'Keep this one, whatever else goes'}
                      onClick={(e) => {
                        e.stopPropagation()
                        shelf.pin(it.id, !it.pinned)
                      }}
                    >
                      📌
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
            <div className="foot">Click puts it in the pane · also copies · drag a tile out · Ctrl+Alt+V</div>
          </>
        )}
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Overlay />
  </StrictMode>
)
