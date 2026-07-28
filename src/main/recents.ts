// The shelf: the last things you copied or screenshotted, one click from an agent.
//
// Getting an image in front of a CLI agent is the clumsiest part of using one. You take a
// screenshot, it lands on the clipboard, and the agent needs a *file path* - so it means
// saving the image by hand, finding the folder, and typing the path. Windows shows a
// little flyout of recent captures for exactly this reason, but nothing it offers can put
// a path into a terminal.
//
// So PaneForge keeps its own shelf. Anything you copy - here or in any other app - shows
// up in the bottom-left corner: text as a line you can click to paste into the focused
// pane, an image as a thumbnail that clicks straight in as a saved PNG path (and drags
// out to any other app). Ctrl+Shift+V reopens it after it hides itself.
//
// Cost matters: this runs forever in the background on a machine that must stay quiet.
// Text is a string compare on a slow timer. Images are the expensive read (a 4K
// screenshot is a ~33MB bitmap), so they are only decoded when the clipboard's format
// list says there is one AND either the formats just changed, the window took focus, or
// the last look was a while ago. Sitting on a copied screenshot costs one read per
// IMAGE_RECHECK_MS, not one per tick.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, extname, join } from 'node:path'
import { app, clipboard, nativeImage } from 'electron'
import type { RecentItem } from '../shared/types'

/** How often the clipboard is looked at. Text only, unless the rules below allow more. */
const TICK_MS = 1200
/** A screenshot that stays on the clipboard is re-read this rarely. */
const IMAGE_RECHECK_MS = 10_000
/**
 * Defaults for the three caps the user can move in Settings. They stay here as well as in
 * config.ts because the watcher can start before a config has been read (a first run), and
 * an unbounded history is the one failure mode that eats the disk quietly.
 */
const MAX_ITEMS = 200
const MAX_IMAGES = 24
/** Files are capped in count as well as by age: a stash of 4K clips is gigabytes. */
const MAX_FILES = 24
/** Text longer than this is stored whole but shown clipped. */
const PREVIEW = 140
/** Anything shorter is noise - a single character copied by accident. */
const MIN_TEXT = 2
/** History is rewritten this long after the last change, never on every copy. */
const SAVE_DEBOUNCE_MS = 800
/** How often expired files are looked for. They expire in hours; a minute is precise enough. */
const SWEEP_MS = 60_000

/** What Settings currently says. Replaced wholesale by configureRecents(). */
let caps = { maxItems: MAX_ITEMS, maxImages: MAX_IMAGES, fileHours: 24, maxFileMb: 512 }

let items: RecentItem[] = []
let timer: NodeJS.Timeout | null = null
let sweepTimer: NodeJS.Timeout | null = null
let saveTimer: NodeJS.Timeout | null = null
let lastText = ''
let lastFormats = ''
let lastImageLook = 0
let lastImageKey = ''
let seq = 0
let loaded = false
let onChange: ((items: RecentItem[]) => void) | null = null

/**
 * Settings changed. Applied to what is already on the Stash straight away rather than
 * only to the next thing added: turning the history down from 200 to 20 has to actually
 * forget 180 things, or the setting reads as broken.
 */
export function configureRecents(next: Partial<typeof caps>): void {
  const before = JSON.stringify(caps)
  caps = { ...caps, ...next }
  if (JSON.stringify(caps) === before) return
  load()
  // A shorter file life has to move the clocks already ticking, not just new arrivals.
  items = items.map((i) =>
    i.kind === 'file' && !i.pinned
      ? { ...i, expires: caps.fileHours ? i.at + caps.fileHours * 3_600_000 : undefined }
      : i
  )
  if (trim()) {
    sweepFiles()
    save()
    onChange?.(items)
  }
}

function dir(): string {
  const d = join(app.getPath('userData'), 'recents')
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}

function historyFile(): string {
  return join(dir(), 'history.json')
}

/** The letter an id starts with, per kind. Only used to keep ids readable in a log. */
function tag(kind: RecentItem['kind']): string {
  return kind === 'image' ? 'i' : kind === 'file' ? 'f' : 't'
}

/**
 * Bring the history back after a restart. Image thumbnails live in the file with the
 * items (they are ~10KB data URLs), but an item whose copy on disk has been deleted from
 * under us is dropped - clicking it would type a path to nothing. A file whose clock ran
 * out while the app was closed is dropped on the same pass.
 */
function load(): void {
  if (loaded) return
  loaded = true
  try {
    const raw = JSON.parse(readFileSync(historyFile(), 'utf8')) as RecentItem[]
    if (!Array.isArray(raw)) return
    const now = Date.now()
    items = raw
      .filter(
        (i) =>
          i &&
          typeof i.id === 'string' &&
          (i.kind === 'text' || i.kind === 'image' || i.kind === 'file')
      )
      .filter((i) => i.kind === 'text' || (i.path && existsSync(i.path)))
      .filter((i) => i.pinned || i.kind !== 'file' || !i.expires || i.expires > now)
      .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.at - a.at)
      .slice(0, caps.maxItems)
    // Ids are handed out per run; carry on past whatever the last run reached so a
    // restored item and a fresh one can never collide.
    seq = items.length
    items = items.map((i, n) => ({ ...i, id: `${tag(i.kind)}r${n}` }))
  } catch {
    /* no history yet, or a half-written file - starting empty is the right fallback */
  }
}

function save(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      writeFileSync(historyFile(), JSON.stringify(items))
    } catch {
      /* a full disk must not take the app down over a clipboard list */
    }
  }, SAVE_DEBOUNCE_MS)
  saveTimer.unref?.()
}

/** Delete the PNGs of items that are no longer on the list. */
function sweepFiles(): void {
  const keep = new Set(items.map((i) => i.path).filter(Boolean))
  try {
    for (const f of readdirSync(dir())) {
      const p = join(dir(), f)
      if (p === historyFile()) continue
      if (!keep.has(p)) rmSync(p, { force: true })
    }
  } catch {
    /* leaving a stale png behind is harmless */
  }
}

/** Newest first, which is the order the flyout shows them in. */
export function listRecents(): RecentItem[] {
  load()
  return items
}

/**
 * Empty the Stash - except for what was pinned. A pin is the one thing here that says
 * "keep this", and a Clear that threw those away would make pinning pointless: you would
 * never dare press it, and the button that tidies up is the one you press most.
 */
export function clearRecents(): void {
  load()
  items = items.filter((i) => i.pinned)
  sweepFiles()
  if (!items.length) {
    try {
      rmSync(historyFile(), { force: true })
    } catch {
      /* a file held open by a viewer is not worth failing over */
    }
  } else {
    save()
  }
  // The "already seen this" markers are deliberately left alone: whatever is on the
  // clipboard right now was just cleared on purpose, and resetting them would put it
  // straight back on the list a second later.
  onChange?.(items)
}

/**
 * Forget one item. The clipboard is a place passwords and one-off tokens land by
 * accident, so removing a single line has to be as easy as copying it was.
 */
export function removeRecent(id: string): boolean {
  const before = items.length
  const gone = items.find((i) => i.id === id)
  items = items.filter((i) => i.id !== id)
  if (items.length === before) return false
  // Deleting the newest text item has to also clear the "already seen this" marker, or
  // the watcher will not put it back if it is copied again while still on the clipboard.
  if (gone?.kind === 'text' && gone.text === lastText) lastText = ''
  if (gone?.kind === 'image') lastImageKey = ''
  sweepFiles()
  save()
  onChange?.(items)
  return true
}

/**
 * Keep one entry through everything: the caps, the file clock, and the sweep. The Stash
 * forgets on purpose, which is right for the hundred things you copied by accident and
 * wrong for the one API key you are pasting all afternoon - so that one gets to opt out.
 * Pinned entries also sort above the rest, because a list that forgets is browsed from the
 * top and a pin you have to scroll to is not a pin.
 */
export function pinRecent(id: string, on: boolean): boolean {
  load()
  const it = items.find((i) => i.id === id)
  if (!it || !!it.pinned === on) return false
  items = items.map((i) => (i.id === id ? { ...i, pinned: on || undefined } : i))
  order()
  // Unpinning can put the list back over a cap it was being held above.
  if (!on) trim()
  save()
  onChange?.(items)
  return true
}

/** Pinned first, then newest first inside each group. */
function order(): void {
  items = [...items].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.at - a.at)
}

/** Put an item back on the clipboard, so Ctrl+V in any app pastes it again. */
export function copyRecent(id: string): boolean {
  load()
  const it = items.find((i) => i.id === id)
  if (!it) return false
  if (it.kind === 'text') clipboard.writeText(it.text ?? '')
  // A file is not something Electron can put on the Windows clipboard as a file, and a
  // video written as an image would be an empty bitmap. Its path is the useful thing to
  // hold anyway: it is what an agent, an upload box and a shell all take.
  else if (it.kind === 'file') clipboard.writeText(it.path ?? '')
  else if (it.path) clipboard.writeImage(nativeImage.createFromPath(it.path))
  return true
}

export function recentPath(id: string): string {
  load()
  return items.find((i) => i.id === id)?.path ?? ''
}

/** The full item, for the overlay's "put this in the focused pane". */
export function getRecent(id: string): RecentItem | undefined {
  load()
  return items.find((i) => i.id === id)
}

/**
 * Enforce the three caps and the file clock. Returns whether anything was dropped, so a
 * caller can skip writing the history and waking the UI when nothing changed.
 *
 * Text is cheap to keep 200 of; screenshots and dropped files are not, so each falls off
 * its own, shorter list rather than waiting to reach the end of the long one.
 */
function trim(): boolean {
  const before = items.length
  const now = Date.now()
  // A pin is an explicit "keep this", so it is held out of every rule below and put back
  // at the end. It still takes a slot on screen; it just never loses one.
  const pinned = items.filter((i) => i.pinned)
  let rest = items.filter((i) => !i.pinned)
  rest = rest.filter((i) => i.kind !== 'file' || !i.expires || i.expires > now)
  rest = rest.slice(0, Math.max(0, caps.maxItems - pinned.length))
  for (const [kind, cap] of [
    ['image', caps.maxImages],
    ['file', MAX_FILES]
  ] as const) {
    const of = rest.filter((i) => i.kind === kind)
    if (of.length > cap) {
      const drop = new Set(of.slice(cap).map((i) => i.id))
      rest = rest.filter((i) => !drop.has(i.id))
    }
  }
  items = [...pinned, ...rest]
  order()
  return items.length !== before
}

function push(item: RecentItem): void {
  load()
  items = [item, ...items.filter((i) => i.key !== item.key)]
  trim()
  // Drop the files of items that fell off the end, or the folder grows forever.
  sweepFiles()
  save()
  onChange?.(items)
}

/** Extensions worth naming. Everything else is a file with a size, which is enough. */
const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.gif': 'image/gif',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip'
}

/** "4.2 MB" - the only thing a file row can say about itself without opening it. */
function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/**
 * Take copies of files dropped on the Stash (or chosen in its picker) and put them on the
 * list. Copied rather than referenced on purpose: the whole point is that the recording
 * you just made is still draggable after you have moved, renamed or deleted the original,
 * and a row pointing at a path that has gone is worse than no row.
 *
 * Returns how many were taken. The refusals are size (over the cap - a 4GB file copied
 * silently is a disk filled silently) and anything unreadable.
 */
export function addRecentFiles(paths: string[]): number {
  load()
  let added = 0
  const limit = caps.maxFileMb * 1024 * 1024
  for (const src of paths) {
    if (!src || typeof src !== 'string') continue
    let bytes = 0
    try {
      const st = statSync(src)
      if (!st.isFile()) continue
      bytes = st.size
    } catch {
      continue
    }
    if (limit > 0 && bytes > limit) continue
    const name = basename(src)
    const ext = extname(name).toLowerCase()
    // Our copy keeps the extension: Windows decides what a drop is by the extension, and
    // a video dropped into a chat app as `.tmp` is a file the other end cannot play.
    const dest = join(dir(), `stash-${Date.now()}-${++seq}${ext}`)
    try {
      copyFileSync(src, dest)
    } catch {
      continue
    }
    const at = Date.now()
    push({
      id: `f${seq}`,
      // The name and size together: dropping the same clip twice is one row, dropping a
      // different cut of it with the same name is two.
      key: `f:${name}:${bytes}`,
      kind: 'file',
      at,
      path: dest,
      name,
      bytes,
      mime: MIME[ext] ?? '',
      preview: `${name} · ${size(bytes)}`,
      expires: caps.fileHours ? at + caps.fileHours * 3_600_000 : undefined
    })
    added++
  }
  return added
}

/** Where the copies live, for the "open the folder" button. */
export function recentsDir(): string {
  return dir()
}

/**
 * Drop the files whose clock ran out. Runs on a slow timer while the watcher is on, so a
 * machine left alone overnight comes back to a Stash that has already tidied itself.
 */
function sweepExpired(): void {
  if (!items.some((i) => i.kind === 'file' && !i.pinned && i.expires && i.expires <= Date.now()))
    return
  if (!trim()) return
  sweepFiles()
  save()
  onChange?.(items)
}

function readText(): void {
  let text = ''
  try {
    text = clipboard.readText()
  } catch {
    return
  }
  if (text === lastText) return
  lastText = text
  const trimmed = text.trim()
  if (trimmed.length < MIN_TEXT) return
  push({
    id: `t${++seq}`,
    key: `t:${trimmed}`,
    kind: 'text',
    at: Date.now(),
    text,
    preview: trimmed.length > PREVIEW ? trimmed.slice(0, PREVIEW) + '…' : trimmed,
    lines: text.split('\n').length,
    chars: text.length
  })
}

function readImage(): void {
  lastImageLook = Date.now()
  let img: Electron.NativeImage
  try {
    img = clipboard.readImage()
  } catch {
    return
  }
  if (img.isEmpty()) return
  const { width, height } = img.getSize()
  // The thumbnail doubles as the fingerprint: two different screenshots of the same
  // window are the same size, and comparing scaled-down pixels is the cheap way to
  // tell them apart without hashing 33MB.
  //
  // JPEG, not PNG: the thumb rides in history.json and over IPC to two windows on every
  // clipboard change, and PNG data URLs of screenshots averaged ~60KB each - over half a
  // megabyte of a 98-item history was thumbnails. The same 160px thumb as JPEG is ~5KB,
  // and at 54px tall nobody can see the difference.
  let thumb = ''
  try {
    const small = img.resize({ width: Math.min(160, width) })
    thumb = `data:image/jpeg;base64,${small.toJPEG(72).toString('base64')}`
    if (thumb.length < 40) thumb = small.toDataURL()
  } catch {
    return
  }
  const key = `i:${width}x${height}:${thumb.length}:${thumb.slice(-48)}`
  if (key === lastImageKey) return
  lastImageKey = key
  const path = join(dir(), `clip-${Date.now()}.png`)
  try {
    writeFileSync(path, img.toPNG())
  } catch {
    return
  }
  push({
    id: `i${++seq}`,
    key,
    kind: 'image',
    at: Date.now(),
    path,
    thumb,
    preview: `${width}x${height} image`,
    width,
    height
  })
}

function tick(force = false): void {
  readText()
  let formats = ''
  try {
    formats = clipboard.availableFormats().join(',')
  } catch {
    return
  }
  const hasImage = /image\//.test(formats)
  const changed = formats !== lastFormats
  lastFormats = formats
  if (!hasImage) {
    lastImageKey = ''
    return
  }
  // Freshly copied, just came back to the window, or long enough since the last look
  // that a replacement image would otherwise be missed.
  if (force || changed || Date.now() - lastImageLook > IMAGE_RECHECK_MS) readImage()
}

/**
 * Start watching. Safe to call again: the second call only re-reads, which is what a
 * window regaining focus wants (you copied something in another app and came back).
 */
export function startRecents(notify: (items: RecentItem[]) => void): void {
  onChange = notify
  load()
  // The clipboard's current contents are not "recent" - they were there before the app
  // started, and showing them at launch would open the shelf over an empty desk.
  if (!timer) {
    try {
      lastText = clipboard.readText()
      lastFormats = clipboard.availableFormats().join(',')
    } catch {
      /* an empty clipboard reads as '' anyway */
    }
    timer = setInterval(() => tick(), TICK_MS)
    // Windows kills a process that is only holding a timer far less politely than one
    // that says it does not need it; unref keeps this out of the quit path entirely.
    timer.unref?.()
  }
  if (!sweepTimer) {
    sweepTimer = setInterval(sweepExpired, SWEEP_MS)
    sweepTimer.unref?.()
  }
}

/** Called when the window takes focus: catch the image copied while we were elsewhere. */
export function refreshRecents(): void {
  if (timer) tick(true)
}

export function stopRecents(): void {
  if (timer) clearInterval(timer)
  if (sweepTimer) clearInterval(sweepTimer)
  timer = null
  sweepTimer = null
  onChange = null
}
