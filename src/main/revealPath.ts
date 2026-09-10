import { readdirSync, statSync } from 'node:fs'
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
export function resolveRevealTarget(
  cwd: string,
  token: string,
  projectsRoot?: string
): RevealTarget | null {
  if (!token || !looksLikePath(token)) return null
  const { path, line } = parsePathToken(token)

  // Only `~/something`. A lone `~` never gets here - it is too short to pass the shape
  // test - and that is the behaviour worth having: a stray tilde in output is not a place.
  let raw = path
  if (raw.startsWith('~/') || raw.startsWith('~\\')) raw = join(homedir(), raw.slice(2))

  const abs = isAbsolute(raw) ? raw : cwd ? resolve(cwd, raw) : null
  if (!abs) return null

  const here = statHit(abs, line)
  if (here) return here

  // A repo-relative path printed by an agent whose folder is NOT this pane's.
  // `shared/rightkey-funnel/proof-ga4-delivery.png` was written by a chat sitting in
  // claude-memory and read in a pane sitting in a client folder, so resolving it against
  // the pane alone found nothing and the line drew no link at all (2026-09-10). The other
  // checkouts on this machine are a small, known list, so ask them too.
  if (!isAbsolute(raw) && !raw.startsWith('~')) {
    const elsewhere = inAnotherCheckout(cwd, raw, line, projectsRoot)
    if (elsewhere) return elsewhere
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
        if (statSync(dir).isDirectory()) return { abs: dir, kind: 'dir', ancestor: true }
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

/** One `stat`, turned into a target or nothing. The only place this module touches disk. */
function statHit(abs: string, line?: number): RevealTarget | null {
  try {
    const st = statSync(abs)
    if (st.isDirectory()) return { abs, kind: 'dir', line }
    if (st.isFile()) return { abs, kind: 'file', line }
  } catch {
    /* gone, unreadable, or never a path in the first place */
  }
  return null
}

/** The checkout a folder is inside, so `src/x.ts` printed from a subfolder still resolves. */
function gitTop(cwd: string): string | null {
  let dir = cwd
  while (dir) {
    if (statHit(join(dir, '.git'))) return dir
    const up = dirname(dir)
    if (up === dir) return null
    dir = up
  }
  return null
}

/**
 * The other project folders on this machine, cached.
 *
 * A hover asks this per token, so the readdir is held for a few seconds and the list is
 * capped: a projects folder with hundreds of entries must not turn one hover into hundreds
 * of stats. Only immediate children - a path is repo-relative, so its repo is one level in.
 */
const ROOTS_TTL_MS = 30_000
const MAX_CHECKOUTS = 80
let rootsFor = ''
let rootsAt = 0
let rootsList: string[] = []
function checkouts(root: string): string[] {
  if (root === rootsFor && Date.now() - rootsAt < ROOTS_TTL_MS) return rootsList
  let out: string[] = []
  try {
    out = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .slice(0, MAX_CHECKOUTS)
      .map((e) => join(root, e.name))
  } catch {
    /* no projects folder, or one that cannot be read */
  }
  rootsFor = root
  rootsAt = Date.now()
  rootsList = out
  return out
}

/**
 * Resolve a repo-relative token against somewhere other than the pane.
 *
 * Two guards keep this from linking the wrong file. It needs a FOLDER in the token - a
 * bare `notes.md` exists in half the checkouts here and would resolve at random - and no
 * `..`, which can climb out of whatever root it is tried against. When more than one
 * checkout holds the path, the NEWEST copy wins: an agent that just wrote the file wrote
 * the newest one, and that is the copy the sentence on screen is talking about.
 */
function inAnotherCheckout(
  cwd: string,
  rel: string,
  line: number | undefined,
  projectsRoot?: string
): RevealTarget | null {
  const parts = rel.split(/[\\/]/)
  if (parts.length < 2 || parts.includes('..')) return null

  // This pane's own repo first, and outright: a path relative to the checkout a pane is
  // somewhere inside is the intended reading, whatever any other folder happens to hold.
  const top = cwd ? gitTop(cwd) : null
  if (top && top !== cwd) {
    const mine = statHit(resolve(top, rel), line)
    if (mine) return mine
  }

  let best: { hit: RevealTarget; at: number } | null = null
  for (const root of projectsRoot ? checkouts(projectsRoot) : []) {
    if (root === cwd || root === top) continue
    const abs = resolve(root, rel)
    const hit = statHit(abs, line)
    if (!hit) continue
    let at = 0
    try {
      at = statSync(abs).mtimeMs
    } catch {
      /* raced with a delete */
    }
    if (!best || at > best.at) best = { hit, at }
  }
  return best?.hit ?? null
}
