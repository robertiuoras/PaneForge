// The disk half of shared/vaultGraph.ts: finding an Obsidian vault, walking its notes for
// `[[wikilinks]]`, and opening a note in the Obsidian app.
//
// Walked ONCE and cached; re-walked only off an `fs.watch` debounce, never a timer - a vault
// can be a few thousand notes, and nothing here is on a hot path a person is waiting on.

import { existsSync, readdirSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'
import { app, shell } from 'electron'
import { buildVaultGraph, type VaultNoteInput } from '../shared/vaultGraph'
import type { VaultGraph, VaultInfo } from '../shared/types'

/** Debounce between the last filesystem event and the next walk. */
const WATCH_DEBOUNCE_MS = 800

/** Folders an Obsidian vault itself never wants graphed. */
const SKIP_DIRS = new Set(['.git', '.obsidian', 'node_modules', '.trash'])

const WIKILINK_RE = /\[\[([^\]|#]+)/g
const TAG_RE = /(?:^|\s)#([\w/-]+)/g

interface Cached {
  path: string
  notes: VaultNoteInput[]
  graph: VaultGraph
}

let cache: Cached | null = null
let watcher: FSWatcher | null = null
let watchTimer: ReturnType<typeof setTimeout> | null = null

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function walk(root: string, dir: string, out: string[]): void {
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(root, full, out)
    } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') {
      out.push(relative(root, full).split(sep).join('/').replace(/\.md$/i, ''))
    }
  }
}

function readNote(root: string, relPath: string): VaultNoteInput {
  const links: string[] = []
  const tags: string[] = []
  try {
    const text = readFileSync(join(root, `${relPath}.md`), 'utf8')
    for (const m of text.matchAll(WIKILINK_RE)) links.push(m[1].trim())
    for (const m of text.matchAll(TAG_RE)) tags.push(m[1])
  } catch {
    // A note that vanished between the directory walk and the read just carries no links.
  }
  return { path: relPath, links, tags }
}

function walkVault(vaultPath: string): Cached {
  const relPaths: string[] = []
  walk(vaultPath, vaultPath, relPaths)
  const notes = relPaths.map((p) => readNote(vaultPath, p))
  return { path: vaultPath, notes, graph: buildVaultGraph(notes) }
}

function ensureFresh(vaultPath: string): Cached {
  if (cache && cache.path === vaultPath) return cache
  cache = walkVault(vaultPath)
  armWatch(vaultPath)
  return cache
}

function armWatch(vaultPath: string): void {
  watcher?.close()
  watcher = null
  try {
    watcher = watch(vaultPath, { recursive: true }, (_event, filename) => {
      if (filename && extname(filename).toLowerCase() !== '.md') return
      if (watchTimer) clearTimeout(watchTimer)
      watchTimer = setTimeout(() => {
        cache = walkVault(vaultPath)
      }, WATCH_DEBOUNCE_MS)
    })
  } catch {
    // fs.watch's `recursive` option is macOS/Windows only; on an unsupported platform the
    // vault simply re-walks next time it's asked for, which is correct, just not live.
  }
}

/** Whether this machine has something registered for the `obsidian://` scheme. */
function obsidianInstalled(): boolean {
  try {
    return Boolean(app.getApplicationNameForProtocol('obsidian://'))
  } catch {
    return false
  }
}

export function vaultInfo(vaultPath: string): VaultInfo | null {
  if (!vaultPath) return null
  const name = vaultPath.split(/[/\\]/).filter(Boolean).pop() ?? vaultPath
  const appInstalled = obsidianInstalled()
  if (!existsSync(vaultPath)) {
    return { path: vaultPath, name, notes: 0, appInstalled, error: 'This folder does not exist.' }
  }
  if (!isDir(vaultPath)) {
    return { path: vaultPath, name, notes: 0, appInstalled, error: 'This path is not a folder.' }
  }
  const { notes } = ensureFresh(vaultPath)
  if (notes.length === 0) {
    return {
      path: vaultPath,
      name,
      notes: 0,
      appInstalled,
      error: 'No notes (.md files) found in this folder.'
    }
  }
  return { path: vaultPath, name, notes: notes.length, appInstalled }
}

export function vaultGraph(vaultPath: string): VaultGraph {
  if (!vaultPath || !isDir(vaultPath)) return { nodes: [], links: [], readAt: Date.now() }
  return ensureFresh(vaultPath).graph
}

export function vaultOpen(vaultPath: string, note?: string): boolean {
  if (!vaultPath) return false
  const name = vaultPath.split(/[/\\]/).filter(Boolean).pop() ?? vaultPath
  const url = note
    ? `obsidian://open?vault=${encodeURIComponent(name)}&file=${encodeURIComponent(note)}`
    : `obsidian://open?vault=${encodeURIComponent(name)}`
  shell.openExternal(url).catch(() => {})
  return true
}

export function stopVaultWatch(): void {
  watcher?.close()
  watcher = null
  if (watchTimer) clearTimeout(watchTimer)
  cache = null
}
