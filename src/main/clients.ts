// The disk half of shared/clientName.ts: finding the roster, and reading the names in it.
//
// Nothing here is configured. A clients tree is recognised by its SHAPE - a folder called
// `clients` whose children are folders each holding a README - so a person who keeps one
// gets this and a person who does not never sees it. The alternative was a setting
// pointing at a path, which is a thing to maintain in return for nothing: the folder is
// already on disk and already says what it is.
//
// Everything is cached, because the two callers are `start()` (which must not stat a
// directory tree while a person is waiting for a pane) and the keystroke path (which runs
// on every submitted line). A roster that changes while the app is open is picked up
// within a minute, which is faster than a client is added.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  CLIENTS_DIR,
  clientFromPath,
  clientFromText,
  nameFromHeading,
  repeatedClient,
  titleCase,
  withAliases,
  type ClientEntry
} from '../shared/clientName'

/** How long a read roster is trusted. A client is added about once a fortnight. */
const CACHE_MS = 60_000

/** Enough of a README to be sure of reaching its first heading. */
const HEAD_BYTES = 2048

interface Cached {
  at: number
  roster: ClientEntry[]
}

const byRoot = new Map<string, Cached>()
const rootOf = new Map<string, { at: number; root: string | null }>()

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * Does this folder look like a roster - `clients/<who>/README.md`?
 *
 * The README is the load-bearing half. `Projects/clients` also has a `clients` child, and
 * without this test a pane in `Projects/clients/tools/x` would find `Projects/clients` and
 * call `tools` a client. Requiring at least one child that carries a README is what makes
 * this evidence: an empty folder, a build output and a node_modules all fail it.
 */
function looksLikeRoster(dir: string): boolean {
  if (!isDir(dir)) return false
  try {
    return readdirSync(dir, { withFileTypes: true }).some(
      (e) => e.isDirectory() && existsSync(join(dir, e.name, 'README.md'))
    )
  } catch {
    return false
  }
}

/**
 * The nearest clients roster at or above a folder, or null when there is not one.
 *
 * Walking UP rather than scanning down: the answer must be the tree this pane is actually
 * in, and a desk with two client trees on it (an old one archived beside a live one) must
 * not have a pane in one named out of the other.
 */
export function rosterRoot(cwd: string): string | null {
  const hit = rootOf.get(cwd)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.root
  let dir = cwd
  let found: string | null = null
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, CLIENTS_DIR)
    if (looksLikeRoster(candidate)) {
      found = candidate
      break
    }
    const up = dirname(dir)
    if (!up || up === dir) break
    dir = up
  }
  rootOf.set(cwd, { at: Date.now(), root: found })
  return found
}

/** The first `# heading` in a README, or '' when there is not one worth reading. */
function heading(file: string): string {
  try {
    const text = readFileSync(file).subarray(0, HEAD_BYTES).toString('utf8')
    const m = /^#\s+(.+)$/m.exec(text)
    return m ? m[1].trim() : ''
  } catch {
    return ''
  }
}

/** Every client in a roster folder, named and aliased. */
export function readRoster(root: string): ClientEntry[] {
  const hit = byRoot.get(root)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.roster
  let raw: { slug: string; name: string }[] = []
  try {
    raw = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => {
        const h = heading(join(root, e.name, 'README.md'))
        return { slug: e.name, name: h ? nameFromHeading(h, e.name) : titleCase(e.name) }
      })
  } catch {
    raw = []
  }
  const roster = withAliases(raw)
  byRoot.set(root, { at: Date.now(), roster })
  return roster
}

/** The roster a pane in this folder is judged against - empty when it is not in one. */
export function rosterFor(cwd: string): ClientEntry[] {
  const root = rosterRoot(cwd)
  return root ? readRoster(root) : []
}

/** The client a pane's FOLDER proves it belongs to. Evidence, not inference. */
export function clientForCwd(cwd: string): ClientEntry | undefined {
  const roster = rosterFor(cwd)
  return roster.length ? clientFromPath(cwd, roster) : undefined
}

/** The one client a prompt names, when the pane is in a client tree and it names exactly one. */
export function clientForText(cwd: string, text: string): ClientEntry | undefined {
  const roster = rosterFor(cwd)
  return roster.length ? clientFromText(text, roster) : undefined
}

/**
 * The client several asks agree this pane is for - see `repeatedClient`. A name lifted
 * from a sentence is inference, so unlike `clientForCwd` it needs the desk to have said
 * the same thing three times before it is allowed to rename anything.
 */
export function clientForTexts(cwd: string, asks: string[]): ClientEntry | undefined {
  const roster = rosterFor(cwd)
  return roster.length ? repeatedClient(asks, roster) : undefined
}
