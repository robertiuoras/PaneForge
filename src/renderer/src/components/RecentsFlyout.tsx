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
// wherever it is dropped is remembered. That corner is the one the sidebar footer and a
// long pane title also want, so a shelf nailed to it would sooner or later sit on the one
// thing being read.

import { useEffect, useRef, useState } from 'react'
import type { RecentItem } from '@shared/types'
import Blurb from './Blurb'
import { keyLabel, modKey } from '../platform'

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
  /** the newest handful, which is what a peek shows. Search goes past this - see below. */
  items: RecentItem[]
  /** open because the user asked (keybind/button): stays until dismissed */
  pinned: boolean
  /** open with the search box focused, from the overlay's magnifier */
  searching?: boolean
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

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/**
 * What a stashed file's meta line says: how big it is, and how long it has left. The clock
 * is the point - a file on the Stash is a thing you are about to drag somewhere, not
 * storage, and it says so rather than disappearing unannounced.
 */
function left(it: RecentItem): string {
  const s = size(it.bytes ?? 0)
  if (!it.expires) return s
  const mins = Math.max(0, Math.round((it.expires - Date.now()) / 60_000))
  if (mins < 60) return `${s} · ${mins}m left`
  const hrs = Math.round(mins / 60)
  return hrs < 48 ? `${s} · ${hrs}h left` : `${s} · ${Math.round(hrs / 24)}d left`
}

export default function RecentsFlyout({
  items,
  pinned,
  searching,
  peek,
  onClose,
  onSend
}: Props): JSX.Element | null {
  const [hover, setHover] = useState(false)
  // What is typed in the search box, and what came back for it. Two states rather than a
  // filter over `items`, because the answer comes from the main process: the list this
  // window holds has had every clip's body stripped out of it, so a filter here could
  // only ever match the first 140 characters of one.
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<RecentItem[] | null>(null)
  // Which row Enter would take. -1 is "none", which is where it starts: a shelf that
  // opens with a row already chosen invites pressing Enter without reading it.
  const [cursor, setCursor] = useState(-1)
  // The entry being corrected, and the text as it stands. Held here rather than on the
  // row, because the body is not in the list this window holds - it is fetched by id when
  // the pencil is pressed, and there is only ever one open at a time.
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const search = useRef<HTMLInputElement>(null)
  // Re-render for the age labels while it is open, and never while it is not.
  const [, bump] = useState(0)
  const [pos, setPos] = useState<Pos | null>(loadPos)
  const [dragging, setDragging] = useState(false)
  // A file drag is hovering over the shelf, so it can say it will take it.
  const [over, setOver] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const grab = useRef<{ dx: number; dy: number } | null>(null)

  const open = pinned || peek || hover

  useEffect(() => {
    if (!open) return
    const t = window.setInterval(() => bump((n) => n + 1), 15_000)
    return () => window.clearInterval(t)
  }, [open])

  // Opened by the overlay's magnifier: the point of the press was to type, so the caret
  // is already there. Never on an ordinary open - taking the keyboard off a pane because
  // a shelf appeared is the thing this app does not do.
  useEffect(() => {
    if (searching) search.current?.focus()
  }, [searching])

  // Ask main for matches. Debounced, because a keystroke is cheap here and a walk over
  // 200 bodies is not - and an empty box is not a search, it is the shelf as it was.
  useEffect(() => {
    if (!query.trim()) {
      setFound(null)
      setCursor(-1)
      return
    }
    let live = true
    const t = window.setTimeout(() => {
      void api.searchRecents(query).then((r) => {
        if (!live) return
        setFound(r)
        setCursor(r.length ? 0 : -1)
      })
    }, 90)
    return () => {
      live = false
      window.clearTimeout(t)
    }
  }, [query])

  // What the list is showing: the search's answer while there is one, otherwise the
  // newest handful the peek was built for.
  const shown = found ?? items

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

  /**
   * Files dropped on the shelf. Electron removed `File.path`, so the only way to a real
   * path is the preload's webUtils - a browser preview has no paths at all and drops
   * nothing, which is the honest outcome there.
   */
  const drop = (e: React.DragEvent<HTMLDivElement>): void => {
    setOver(false)
    const files = [...(e.dataTransfer?.files ?? [])]
    if (!files.length) return
    // The shelf floats over the panes, and a pane's own file drop types paths at the
    // prompt. A drop meant for the Stash must not also do that.
    e.preventDefault()
    e.stopPropagation()
    const paths = files.map((f) => api.pathForFile(f)).filter(Boolean)
    if (paths.length) void api.addStashFiles(paths)
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
      className={
        'shelf' + (pinned ? ' pinned' : '') + (dragging ? ' dragging' : '') + (over ? ' over' : '')
      }
      style={pos ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' } : undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onDragOver={(e) => {
        // Only a file drag: dragging a shelf item back onto the shelf is not an add.
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setOver(true)
      }}
      onDragLeave={(e) => {
        if (!box.current?.contains(e.relatedTarget as Node)) setOver(false)
      }}
      onDrop={drop}
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
        <strong>Stash</strong>
        <span className="hint">click to put in the pane</span>
        <button
          className="icon small"
          title="Add a file to the Stash - a clip, a recording, anything you want to drag out again"
          onClick={() => {
            void api.pickStashFiles()
          }}
        >
          +
        </button>
        <button
          className="icon small"
          title="Forget everything on the Stash"
          onClick={() => api.clearRecents()}
        >
          ✕
        </button>
      </div>
      {/*
        Only while it is open because somebody asked for it. The five-second auto-peek is
        a glance at what you just copied, and six lines of explanation arriving on top of
        every copy is the opposite of that.
      */}
      {pinned && <Blurb id="stash" />}
      {/*
        Only while it is open on purpose. A five-second peek at what you just copied is
        not a thing anybody searches, and a caret appearing over a pane on every copy
        would be the app taking the keyboard - which it does not do.
      */}
      {pinned && (
        <div className="shelf-search">
          <input
            ref={search}
            className="search"
            type="text"
            value={query}
            placeholder="Search the Stash"
            onChange={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                if (!shown.length) return
                setCursor((c) => {
                  const n = c + (e.key === 'ArrowDown' ? 1 : -1)
                  // Wraps, because a list this short is faster to walk round than to
                  // walk back through.
                  return (n + shown.length) % shown.length
                })
              } else if (e.key === 'Enter') {
                const it = shown[cursor]
                if (!it) return
                e.preventDefault()
                onSend(it)
              } else if (e.key === 'Escape' && query) {
                // The first Escape empties the box, the second closes the shelf. The
                // half that lets this run at all is in App.tsx: its Escape handler is a
                // CAPTURE listener on the window, so it sees the key before this field
                // does and a stopPropagation here would be far too late.
                e.preventDefault()
                setQuery('')
              }
            }}
          />
          {found && (
            <span className="hint">
              {found.length ? `${found.length} match${found.length === 1 ? '' : 'es'}` : 'nothing'}
            </span>
          )}
        </div>
      )}
      {editing && (
        <div className="shelf-edit">
          <textarea
            autoFocus
            rows={5}
            value={editing.text}
            onChange={(e) => setEditing({ ...editing, text: e.currentTarget.value })}
            onKeyDown={(e) => {
              // Enter alone is a newline - this is a text box and a clip can be a
              // paragraph. Save is the modifier, the way every other multi-line field
              // in the app works.
              if (e.key === 'Enter' && modKey(e)) {
                e.preventDefault()
                api.editRecent(editing.id, editing.text)
                setEditing(null)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                setEditing(null)
              }
            }}
          />
          <div className="shelf-edit-row">
            <span className="hint">{keyLabel('Ctrl Enter saves, Esc throws it away')}</span>
            <button className="ghost small" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button
              className="small"
              onClick={() => {
                api.editRecent(editing.id, editing.text)
                setEditing(null)
              }}
            >
              Save
            </button>
          </div>
        </div>
      )}
      {!items.length && !found && (
        <div className="shelf-empty">
          Nothing on the Stash yet. Copy text or a screenshot anywhere on the machine, or drop a
          file here, and it lands on the Stash.
        </div>
      )}
      <div className="shelf-items">
        {shown.map((it, n) => (
          <button
            key={it.id}
            className={'shelf-item ' + it.kind + (n === cursor ? ' on' : '')}
            title={
              it.kind === 'text'
                ? it.preview
                : `${it.preview} - click to type its path, drag it anywhere`
            }
            onClick={() => onSend(it)}
            // Images and stashed files are real files on disk, so the OS drag layer can
            // carry them into any other app. Started in main: only it can put a file in
            // a drag.
            draggable={it.kind !== 'text'}
            onDragStart={(e) => {
              if (it.kind === 'text') return
              e.preventDefault()
              api.dragRecent(it.id)
            }}
          >
            {it.kind === 'image' && it.thumb ? (
              <img src={it.thumb} alt="" />
            ) : it.kind === 'file' ? (
              <span className="shelf-file">
                <span className="shelf-file-glyph" aria-hidden="true">
                  {it.mime?.startsWith('video/') ? '▶' : it.mime?.startsWith('audio/') ? '♪' : '▤'}
                </span>
                <span className="shelf-text">{it.name ?? it.preview}</span>
              </span>
            ) : (
              <span className="shelf-text">{it.preview}</span>
            )}
            <span className="shelf-meta">
              <span>
                {it.kind === 'image'
                  ? `${it.width}x${it.height}`
                  : it.kind === 'file'
                    ? left(it)
                    : `${it.chars} chars`}
              </span>
              <span>{ago(it.at)}</span>
            </span>
            {it.kind === 'text' && (
              <span
                className="shelf-copy"
                title="Correct this entry - for the moment a copied path names the wrong branch"
                onClick={(e) => {
                  e.stopPropagation()
                  // The body is not in this list - see `lean()` in recents.ts - so the
                  // one being edited is fetched, and only then.
                  void api.recentText(it.id).then((t) => setEditing({ id: it.id, text: t }))
                }}
              >
                edit
              </span>
            )}
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
          <span className="hint">
            {keyLabel('Drag the title to move it - Ctrl Shift V or Esc closes')}
          </span>
          <button className="ghost small" onClick={onClose}>
            Close
          </button>
        </div>
      )}
    </div>
  )
}
