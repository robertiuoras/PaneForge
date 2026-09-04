import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'
import { looksLikePath, parsePathToken } from '../shared/pathToken'
import type { RevealTarget } from '../shared/pathToken'

/**
 * Turning a path an agent printed into somewhere on this machine.
 *
 * The renderer only has a string out of a terminal buffer: no `path`, no `fs`, and no idea
 * which folder the pane is running in. So it hands the raw token and the pane's cwd over
 * here, and gets back an absolute path or nothing.
 *
 * "Or nothing" is the important half. It is what stops every word that happens to contain
 * a slash from being underlined, and it means a link is never offered for something that
 * cannot be opened.
 */
/**
 * Resolve one token against one working directory, or return null.
 *
 * Absolute paths are taken as they are, `~` expands, and everything else is relative to the
 * pane - which is the whole point, since agents print repo-relative paths almost exclusively.
 *
 * Paths outside the cwd are allowed on purpose: agents print absolute paths from other
 * checkouts all the time, and the only thing that ever happens to the result is that a file
 * manager is pointed at it. Existence is the guard, not containment.
 */
export function resolveRevealTarget(cwd: string, token: string): RevealTarget | null {
  if (!token || !looksLikePath(token)) return null
  const { path, line } = parsePathToken(token)

  // Only `~/something`. A lone `~` never gets here - it is too short to pass the shape
  // test - and that is the behaviour worth having: a stray tilde in output is not a place.
  let raw = path
  if (raw.startsWith('~/') || raw.startsWith('~\\')) raw = join(homedir(), raw.slice(2))

  const abs = isAbsolute(raw) ? raw : cwd ? resolve(cwd, raw) : null
  if (!abs) return null

  try {
    const st = statSync(abs)
    if (st.isDirectory()) return { abs, kind: 'dir', line }
    if (st.isFile()) return { abs, kind: 'file', line }
  } catch {
    /* gone, unreadable, or never a path in the first place */
  }
  // A spaced, rooted path whose tail is not there is usually a path the CLI wrapped onto
  // the next row (`.../_deliverables/Jacob - phone` / `clips full frame comparison.mp4`,
  // 2026-09-04): the row only ever holds the front of it. The deepest folder of it that
  // exists is what "open that folder" means, so that is what the link reveals. Only for
  // a run with a space in it and only below home or the root - `/foo/bar.ts` planned
  // and not yet written stays no link.
  if (/\s/.test(path) && (path.startsWith('~') || isAbsolute(path))) {
    const floor = path.startsWith('~') ? homedir() : parse(abs).root
    let dir = dirname(abs)
    // ...and never the pane's own folder: that is where the pane already is.
    while (dir.length > floor.length && dir !== cwd) {
      try {
        if (statSync(dir).isDirectory()) return { abs: dir, kind: 'dir' }
      } catch {
        /* keep climbing */
      }
      const up = dirname(dir)
      if (up === dir) break
      dir = up
    }
  }
  return null
}
