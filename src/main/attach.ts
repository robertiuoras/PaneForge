// Where an attachment lands, on the machine whose pty is going to read it.
//
// The shared half (src/shared/attach.ts) says what a saved file is called and which ones
// are litter; this is the disk. It is deliberately not the Stash: the Stash is a list a
// person curates and every row of it is something they chose to keep, while these files
// exist for as long as it takes an agent to open them.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { app } from 'electron'
import {
  ATTACH_KEEP,
  attachName,
  pruneList,
  tooBig,
  type AttachIn,
  type AttachResult
} from '../shared/attach'

/** `userData/attachments`, made on first use. */
export function attachDir(): string {
  const dir = join(app.getPath('userData'), 'attachments')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Write a batch and answer with the paths, in the order they arrived.
 *
 * The refusals are sentences rather than throws because the only caller is a person who
 * just pasted something: an empty clipboard and a 90 MB video are both ordinary, and
 * neither is a reason for a pane to say nothing at all.
 */
export function writeAttachments(files: AttachIn[], now = Date.now()): AttachResult {
  const list = Array.isArray(files) ? files.filter((f) => f && typeof f.data === 'string') : []
  if (!list.length) return { paths: [], error: 'Nothing to attach' }
  const big = tooBig(list)
  if (big) return { paths: [], error: big }

  const dir = attachDir()
  const paths: string[] = []
  for (let i = 0; i < list.length; i++) {
    const buf = Buffer.from(list[i].data, 'base64')
    if (!buf.length) continue
    const path = join(dir, attachName(list[i].name, buf, now, i + 1))
    try {
      writeFileSync(path, buf)
      paths.push(path)
    } catch (err) {
      return { paths, error: `Could not save the attachment: ${(err as Error).message}` }
    }
  }
  if (!paths.length) return { paths: [], error: 'Nothing to attach' }
  prune()
  return { paths }
}

/**
 * Files on THIS machine's disk, read into the shape that travels.
 *
 * A macOS screenshot dragged off its floating thumbnail, or a file out of Finder, reaches
 * the renderer as a `file://` URI with no File object behind it. On a pane whose agent
 * runs here the path is typed as it is; on a MIRRORED pane the path is true only on this
 * desk, so the bytes are read here and sent, exactly as a pasted image is. All or
 * nothing: one unreadable path refuses the batch, because a drop that half-arrives reads
 * as a missing file on the other end.
 */
export function readAttachIns(paths: string[]): { files: AttachIn[]; error?: string } {
  const list = Array.isArray(paths) ? paths.filter((p) => typeof p === 'string' && p) : []
  if (!list.length) return { files: [], error: 'Nothing to attach' }
  const files: AttachIn[] = []
  for (const path of list) {
    try {
      if (!statSync(path).isFile()) return { files: [], error: `Not a file: ${basename(path)}` }
      const buf = readFileSync(path)
      if (!buf.length) return { files: [], error: `Empty file: ${basename(path)}` }
      files.push({ name: basename(path), data: buf.toString('base64') })
    } catch {
      return { files: [], error: `Could not read ${basename(path)} on this machine` }
    }
  }
  const big = tooBig(files)
  if (big) return { files: [], error: big }
  return { files }
}

/** Delete everything this app wrote beyond the newest `ATTACH_KEEP`. Never throws. */
export function prune(keep = ATTACH_KEEP): void {
  try {
    const dir = attachDir()
    for (const name of pruneList(readdirSync(dir), keep)) {
      try {
        rmSync(join(dir, name), { force: true })
      } catch {
        /* a file an agent still has open - the next write tries again */
      }
    }
  } catch {
    /* no folder yet, or no permission: nothing to prune is not a failure */
  }
}
