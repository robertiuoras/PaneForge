// Where an uploaded alert sound lives, and the rules it gets in by.
//
// Two things had to be decided and neither is obvious:
//
//   - **The file is copied into userData, not referenced.** A path into Downloads is a
//     sound that works until the folder is tidied, and the failure lands at the moment
//     an alert was supposed to fire - the quietest possible time to break. A copy costs
//     a few hundred KB and can never go missing behind the app's back.
//   - **The renderer gets bytes, not a path.** `file://` reads from a sandboxed renderer
//     are exactly the hole contextIsolation exists to close, and Chromium's own protocol
//     handling for them differs between dev and a packaged asar. One `readFile` here,
//     one `decodeAudioData` there, cached for the session - and the renderer never sees
//     a filesystem path at all.
//
// The validation rules themselves are in `shared/sounds.ts` so they can be tested
// without electron; this file is the part that touches disk.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { app, dialog, type BrowserWindow } from 'electron'
import {
  DEFAULT_SOUNDS,
  MAX_SOUND_BYTES,
  SOUND_EXTS,
  isSoundFile,
  pruneSounds,
  soundFileName,
  soundNameFrom,
  type CustomSound,
  type SoundConfig
} from '../shared/sounds'
import { getConfig, setConfig } from './config'

function dir(): string {
  return join(app.getPath('userData'), 'sounds')
}

/** The saved block, with anything missing filled in from the defaults. */
export function sounds(): SoundConfig {
  const raw = getConfig().sounds
  return { ...DEFAULT_SOUNDS, ...(raw ?? {}), custom: raw?.custom ?? [] }
}

/**
 * Reconcile config.json with what is actually on disk, once, at startup.
 *
 * A custom sound is two things that drift apart on their own - a line in the config and
 * a file in userData - and every way they drift is silent. A profile copied to a new
 * machine brings the config and not the folder; a user clearing app data by hand takes
 * the folder and not the config. Either way an alert stops making a sound and nothing
 * says why. This drops the dead entries and puts any event that pointed at one back on
 * its built-in default.
 */
export function pruneCustomSounds(): void {
  const before = sounds()
  if (!before.custom.length) return
  const after = pruneSounds(before, (file) => existsSync(join(dir(), file)))
  if (after.custom.length !== before.custom.length) setConfig({ sounds: after })
}

/**
 * Ask for a file and take a copy of it.
 *
 * The dialog is parented to the window and only ever opens from a click in Settings -
 * the app may never put a window on screen it was not asked for.
 */
export async function addSound(win: BrowserWindow | null): Promise<{ ok: boolean; sound?: CustomSound; error?: string }> {
  const opts = {
    title: 'Choose a sound',
    properties: ['openFile' as const],
    filters: [{ name: 'Audio', extensions: SOUND_EXTS.map((e) => e.slice(1)) }]
  }
  const picked = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  const src = picked.filePaths?.[0]
  if (picked.canceled || !src) return { ok: false }
  return addSoundFile(src)
}

/** The half of the above that a test, or a drop target later, can call directly. */
export function addSoundFile(src: string): { ok: boolean; sound?: CustomSound; error?: string } {
  if (!isSoundFile(src)) return { ok: false, error: `PaneForge cannot play that kind of file. Use ${SOUND_EXTS.join(', ')}.` }
  let size = 0
  try {
    size = statSync(src).size
  } catch {
    return { ok: false, error: 'That file could not be read.' }
  }
  if (size > MAX_SOUND_BYTES)
    return { ok: false, error: `That file is ${Math.round(size / 1024 / 1024)} MB. An alert sound has to be under ${MAX_SOUND_BYTES / 1024 / 1024} MB.` }
  if (!size) return { ok: false, error: 'That file is empty.' }

  const id = randomBytes(6).toString('hex')
  const file = soundFileName(id, src)
  try {
    mkdirSync(dir(), { recursive: true })
    copyFileSync(src, join(dir(), file))
  } catch {
    return { ok: false, error: 'The sound could not be copied into PaneForge’s own folder.' }
  }
  const sound: CustomSound = { id, name: soundNameFrom(src), file, addedAt: Date.now() }
  const cur = sounds()
  setConfig({ sounds: { ...cur, custom: [...cur.custom, sound] } })
  return { ok: true, sound }
}

/** The bytes, for the renderer to decode. Null covers every "it is not there" case. */
export function soundData(id: string): Uint8Array | null {
  const hit = sounds().custom.find((c) => c.id === id)
  if (!hit) return null
  try {
    const path = join(dir(), hit.file)
    // The stored name is derived from the id, never from the user's text, so this can
    // only ever be a file this app wrote - but the size guard is cheap and stops a
    // hand-edited config from asking the renderer to swallow a DVD image.
    if (statSync(path).size > MAX_SOUND_BYTES) return null
    return readFileSync(path)
  } catch {
    return null
  }
}

/** Forget a sound and delete its copy, putting any alert that used it back on default. */
export function removeSound(id: string): SoundConfig {
  const cur = sounds()
  const hit = cur.custom.find((c) => c.id === id)
  if (hit) {
    try {
      rmSync(join(dir(), hit.file), { force: true })
    } catch {
      /* already gone, or read-only profile - the config entry still goes */
    }
  }
  const next = pruneSounds({ ...cur, custom: cur.custom.filter((c) => c.id !== id) }, () => true)
  // pruneSounds only rewrites events whose sound vanished from `custom`, which is
  // exactly what just happened, so the picked ids fix themselves.
  setConfig({ sounds: next })
  return next
}

/** Rename an uploaded sound. The file on disk keeps its id-derived name. */
export function renameSound(id: string, name: string): SoundConfig {
  const cur = sounds()
  const clean = name.trim().slice(0, 48)
  const next: SoundConfig = {
    ...cur,
    custom: cur.custom.map((c) => (c.id === id ? { ...c, name: clean || c.name } : c))
  }
  setConfig({ sounds: next })
  return next
}

/** Files in the sounds folder that no config entry claims - swept on quit. */
export function orphanSoundFiles(): string[] {
  try {
    const known = new Set(sounds().custom.map((c) => c.file))
    return readdirSync(dir()).filter((f) => !known.has(f))
  } catch {
    return []
  }
}
