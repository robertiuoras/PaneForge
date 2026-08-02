import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
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
  return null
}
