// The clipboard shelf - the in-window Stash.
//
// Copy anything, anywhere on the machine, and it lands here: text as a line, a screenshot
// as a thumbnail, a file or clip as a row you can drag back out. Clicking a row puts it
// into the focused pane - text as text, an image as the path of a PNG the app saved,
// which is the form a CLI agent can actually read. Ctrl+Shift+V opens and closes it, and
// open is a state it KEEPS: leave it open and it is still there after a restart, which is
// what "the Stash that was permanently on the screen" means now that the floating overlay
// is summon-only.
//
// It grew up from a five-second peek strip into the whole clipboard manager, because the
// floating overlay is off in the config this app usually runs with, and this panel was
// all there was: it has the count, the type tabs, search, a per-row expand that shows the
// WHOLE clip, and a resize grip. The head's ✕ closes it - it used to be "forget
// everything", which is the one thing an ✕ must never mean.
//
// Bottom-left is where it starts, not where it has to stay: the head is a drag handle and
// wherever it is dropped is remembered. Size is remembered the same way - both are
// renderer-local, a property of the screen they were chosen on.

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

/** The size the user pulled it to. Absent = the stylesheet's default. */
interface Dim {
  w: number
  h: number
}

// Renderer-local on purpose: these are properties of the screen they were chosen on, not
// of the settings that follow the user around, and they must survive a reload with no IPC.
const POS_KEY = 'pf.shelfPos'
const SIZE_KEY = 'pf.shelfSize'

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

function loadSize(): Dim | null {
  try {
    const raw = localStorage.getItem(SIZE_KEY)
    if (!raw) return null
    const d = JSON.parse(raw) as Dim
    return typeof d?.w === 'number' && typeof d?.h === 'number' ? d : null
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

/** A size that always fits the window it is drawn in, and never collapses to nothing. */
function clampDim(d: Dim): Dim {
  return {
    w: Math.min(Math.max(280, d.w), Math.max(280, window.innerWidth - 40)),
    h: Math.min(Math.max(220, d.h), Math.max(220, window.innerHeight - 40))
  }
}

/**
 * What a row IS, for the tabs. A video is a stashed file like any other to the store, but
 * "where is that clip" is a different question from "where is that PDF", so it gets its
 * own tab - told apart by mime, the same test the overlay uses to draw a first frame.
 */
type RowKind = 'text' | 'image' | 'video' | 'file'
type Filter = 'all' | RowKind

function rowKind(it: RecentItem): RowKind {
  if (it.kind === 'file') return it.mime?.startsWith('video/') ? 'video' : 'file'
  return it.kind as RowKind
}

interface Props {
  /** the whole lean list - every kept entry, bodies stripped (see `lean()` in recents.ts) */
  items: RecentItem[]
  /** open because the user asked (keybind/button): stays until dismissed */
  pinned: boolean
  /** open with the search box focused, from the overlay's magnifier */
  searching?: boolean
  /** briefly open because something new arrived (off by default - stashPeekMs) */
  peek: boolean
  onClose: () => void
  /** put this into the focused pane - text, or an image's saved path */
  onSend: (item: RecentItem) => void
  /** open the app's Settings on the Stash page - the gear in the head */
  onSettings: () => void
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
  onSend,
  onSettings
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
  // Which tab. Client-side, over `kind` - the one field the lean list always carries.
  const [filter, setFilter] = useState<Filter>('all')
  // The one row unfolded to its full content. One at a time: the point of the fold is
  // that the LIST stays a list.
  const [openId, setOpenId] = useState<string | null>(null)
  // The unfolded text body, fetched by id when the row opens - it is not in the list.
  const [fullText, setFullText] = useState<{ id: string; text: string } | null>(null)
  // The entry being corrected, and the text as it stands. Held here rather than on the
  // row, because the body is not in the list this window holds - it is fetched by id when
  // the pencil is pressed, and there is only ever one open at a time.
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const search = useRef<HTMLInputElement>(null)
  // Re-render for the age labels while it is open, and never while it is not.
  const [, bump] = useState(0)
  const [pos, setPos] = useState<Pos | null>(loadPos)
  const [dim, setDim] = useState<Dim | null>(loadSize)
  const [dragging, setDragging] = useState(false)
  // A file drag is hovering over the shelf, so it can say it will take it.
  const [over, setOver] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const grab = useRef<{ dx: number; dy: number } | null>(null)
  const resizing = useRef(false)

  const open = pinned || peek || hover

  // Unpinned while the pointer is resting on the panel: hover would hold it open, so
  // Ctrl+Shift+V read as a dead key - the same trap the head's ✕ hit before close()
  // learned to drop hover. The keybind path gets the same cure.
  useEffect(() => {
    if (!pinned) setHover(false)
  }, [pinned])

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

  // An unfolded text row fetches its body, once, by id. Images and files need no fetch -
  // `stash://<id>` serves the file itself.
  useEffect(() => {
    if (!openId) return
    const it = items.find((i) => i.id === openId) ?? found?.find((i) => i.id === openId)
    if (!it || it.kind !== 'text') return
    let live = true
    void api.recentText(openId).then((t) => {
      if (live) setFullText({ id: openId, text: t })
    })
    return () => {
      live = false
    }
  }, [openId])

  // What the list is showing: the search's answer while there is one, otherwise
  // everything, then the tab's slice of that.
  const shown = found ?? items
  const counts: Record<RowKind, number> = { text: 0, image: 0, video: 0, file: 0 }
  for (const it of shown) counts[rowKind(it)]++
  const rows = filter === 'all' ? shown : shown.filter((it) => rowKind(it) === filter)
  const tabs: { key: Filter; label: string; n: number }[] = [
    { key: 'all', label: 'All', n: shown.length },
    { key: 'text', label: 'Text', n: counts.text },
    { key: 'image', label: 'Images', n: counts.image },
    { key: 'video', label: 'Video', n: counts.video },
    { key: 'file', label: 'Files', n: counts.file }
  ]

  // A window that got smaller must not leave the shelf off the edge with no way back.
  useEffect(() => {
    const onResize = (): void => {
      setPos((p) => (p ? clamp(p, box.current?.offsetWidth ?? 300, box.current?.offsetHeight ?? 200) : p))
      setDim((d) => (d ? clampDim(d) : d))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const startDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    // The head carries buttons too; a click on one of those is not a drag.
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
   * The resize grip. When the shelf sits in its default corner it is anchored at the
   * BOTTOM-left, so the grip lives at the top-right and pulling up-and-right grows it.
   * Once it has been dragged somewhere it is anchored top-left, the grip moves to the
   * bottom-right, and pulling down-and-right grows it - each is the corner that can
   * actually move.
   */
  const startResize = (e: React.PointerEvent<HTMLElement>): void => {
    const el = box.current
    if (!el) return
    resizing.current = true
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* the move handler still tracks it */
    }
    e.preventDefault()
    e.stopPropagation()
  }
  const onResizeMove = (e: React.PointerEvent<HTMLElement>): void => {
    if (!resizing.current) return
    const el = box.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const w = e.clientX - r.left
    const h = pos ? e.clientY - r.top : r.bottom - e.clientY
    setDim(clampDim({ w, h }))
  }
  const endResize = (e: React.PointerEvent<HTMLElement>): void => {
    if (!resizing.current) return
    resizing.current = false
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* never captured */
    }
    setDim((d) => {
      if (d)
        try {
          localStorage.setItem(SIZE_KEY, JSON.stringify(d))
        } catch {
          /* the shelf just forgets its size */
        }
      return d
    })
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

  /**
   * The head's ✕. It CLOSES - it used to clear the whole Stash, which read as "the X is
   * broken" because the panel stayed on screen (hover was holding it open) while the
   * history quietly vanished. Hover must be dropped here for the same reason: the pointer
   * is on the button being pressed, so `open` would stay true through the unpin.
   */
  const close = (): void => {
    setHover(false)
    setOpenId(null)
    onClose()
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
      style={{
        ...(pos ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' } : null),
        ...(dim ? { width: dim.w, height: dim.h, maxHeight: 'none' } : null)
      }}
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
        <span className="shelf-count" title={`${items.length} kept`}>
          {items.length}
        </span>
        <span className="spacer" />
        <button
          className="icon small"
          title="Add a file to the Stash - a clip, a recording, anything you want to drag out again"
          onClick={() => {
            void api.pickStashFiles()
          }}
        >
          +
        </button>
        <button className="icon small" title="Stash settings" onClick={onSettings}>
          ⚙
        </button>
        <button
          className="icon small"
          title={keyLabel('Close - Ctrl Shift V brings it back')}
          onClick={close}
        >
          ✕
        </button>
      </div>
      {/*
        Only while it is open because somebody asked for it. The auto-peek is a glance at
        what you just copied, and six lines of explanation arriving on top of a copy is
        the opposite of that.
      */}
      {pinned && <Blurb id="stash" />}
      {/*
        ONE view, however it opened. Search, tabs and the footer used to be pinned-only,
        which drew a second, stripped-down shelf on a peek or a hover - "why is there 2
        separate views". The input is rendered but never focused here (focus is the
        magnifier's deliberate press), so no caret is taken from a pane by a copy.
      */}
      {(
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
                if (!rows.length) return
                setCursor((c) => {
                  const n = c + (e.key === 'ArrowDown' ? 1 : -1)
                  // Wraps, because a list this short is faster to walk round than to
                  // walk back through.
                  return (n + rows.length) % rows.length
                })
              } else if (e.key === 'Enter') {
                const it = rows[cursor]
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
      {items.length > 0 && (
        <div className="shelf-tabs">
          {tabs.map((t) => (
            <button
              key={t.key}
              className={'shelf-tab' + (filter === t.key ? ' on' : '')}
              onClick={() => setFilter(t.key)}
              disabled={t.n === 0 && t.key !== 'all'}
            >
              {t.label}
              <span className="shelf-tab-n">{t.n}</span>
            </button>
          ))}
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
      {!!items.length && !rows.length && <div className="shelf-empty">Nothing of that kind.</div>}
      <div className="shelf-items">
        {rows.map((it, n) => (
          <div key={it.id} className="shelf-row">
            <button
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
              <span
                className="shelf-expand"
                title={openId === it.id ? 'Fold it back up' : 'Show the whole thing'}
                onClick={(e) => {
                  e.stopPropagation()
                  setFullText(null)
                  setOpenId((cur) => (cur === it.id ? null : it.id))
                }}
              >
                {openId === it.id ? '▾' : '▸'}
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
            {openId === it.id && (
              <div className="shelf-full">
                {it.kind === 'text' ? (
                  <pre>{fullText?.id === it.id ? fullText.text : '…'}</pre>
                ) : it.kind === 'image' ? (
                  // `stash://<id>` is main serving that one file and nothing else - the
                  // full PNG, not the 76px thumb the row draws.
                  <img src={`stash://${it.id}`} alt={it.preview} />
                ) : it.mime?.startsWith('video/') ? (
                  <video src={`stash://${it.id}`} controls muted playsInline preload="metadata" />
                ) : (
                  <pre>{(it.name ? it.name + '\n' : '') + (it.path ?? it.preview)}</pre>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      {(
        <div className="shelf-foot">
          <span className="hint">{keyLabel('Click a row to put it in the pane · Ctrl Shift V')}</span>
          <button
            className="ghost small shelf-clear"
            title="Forget everything on the Stash"
            onClick={() => api.clearRecents()}
          >
            clear
          </button>
          <button className="ghost small" onClick={close}>
            Close
          </button>
        </div>
      )}
      <span
        className={'shelf-resize' + (pos ? ' br' : ' tr')}
        title="Drag to resize"
        aria-hidden="true"
        onPointerDown={startResize}
        onPointerMove={onResizeMove}
        onPointerUp={endResize}
        onPointerCancel={endResize}
      />
    </div>
  )
}
