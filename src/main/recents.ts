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

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, clipboard, nativeImage } from 'electron'
import type { RecentItem } from '../shared/types'

/** How often the clipboard is looked at. Text only, unless the rules below allow more. */
const TICK_MS = 1200
/** A screenshot that stays on the clipboard is re-read this rarely. */
const IMAGE_RECHECK_MS = 10_000
/** Items kept. Small on purpose: this is a shelf, not a clipboard manager. */
const MAX_ITEMS = 12
/** Text longer than this is stored whole but shown clipped. */
const PREVIEW = 140
/** Anything shorter is noise - a single character copied by accident. */
const MIN_TEXT = 2

let items: RecentItem[] = []
let timer: NodeJS.Timeout | null = null
let lastText = ''
let lastFormats = ''
let lastImageLook = 0
let lastImageKey = ''
let seq = 0
let onChange: ((items: RecentItem[]) => void) | null = null

function dir(): string {
  const d = join(app.getPath('userData'), 'recents')
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}

/** Newest first, which is the order the flyout shows them in. */
export function listRecents(): RecentItem[] {
  return items
}

export function clearRecents(): void {
  items = []
  // The PNGs are ours and nothing else points at them once the shelf is empty.
  try {
    for (const f of readdirSync(dir())) rmSync(join(dir(), f), { force: true })
  } catch {
    /* a file held open by a viewer is not worth failing over */
  }
  onChange?.(items)
}

/** Put an item back on the clipboard, so Ctrl+V in any app pastes it again. */
export function copyRecent(id: string): boolean {
  const it = items.find((i) => i.id === id)
  if (!it) return false
  if (it.kind === 'text') clipboard.writeText(it.text ?? '')
  else if (it.path) clipboard.writeImage(nativeImage.createFromPath(it.path))
  return true
}

export function recentPath(id: string): string {
  return items.find((i) => i.id === id)?.path ?? ''
}

function push(item: RecentItem): void {
  items = [item, ...items.filter((i) => i.key !== item.key)].slice(0, MAX_ITEMS)
  // Drop the PNGs of images that fell off the end, or the folder grows forever.
  const keep = new Set(items.map((i) => i.path).filter(Boolean))
  try {
    for (const f of readdirSync(dir())) {
      const p = join(dir(), f)
      if (!keep.has(p)) rmSync(p, { force: true })
    }
  } catch {
    /* leaving a stale png behind is harmless */
  }
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
  let thumb = ''
  try {
    thumb = img.resize({ width: Math.min(160, width) }).toDataURL()
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
}

/** Called when the window takes focus: catch the image copied while we were elsewhere. */
export function refreshRecents(): void {
  if (timer) tick(true)
}

export function stopRecents(): void {
  if (timer) clearInterval(timer)
  timer = null
  onChange = null
}
