// Builds the project list for the launcher sidebar.
//
// Order matters more than completeness: the list is ranked by when each folder last
// had a Claude Code session, which Claude Code records as one transcript folder per
// working directory under ~/.claude/projects, named after the path with every
// non-alphanumeric character replaced by '-'.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { projectsRoot } from './config'
import { looksLikeRoster, readRoster } from './clients'
import { CLIENTS_DIR, clientLabel } from '../shared/clientName'
import { checkoutOwners, type FolderFacts } from '../shared/checkout'
import { folderNameFor } from '../shared/projectName'
import type { Project } from '../shared/types'

const SKIP = new Set([
  'node_modules', '.git', '.vscode', '.claude', '.cursor', '.autosync',
  'assets', 'backups', 'temp', 'dist', 'out'
])

/**
 * Make a project folder from a name somebody typed, and answer with the row for it.
 *
 * The New session box already knows the answer to "which project" for everything that
 * exists; a project that does NOT exist yet meant leaving the app, making a folder in
 * Finder, and coming back. So typing a name nothing matches offers to create it here.
 *
 * It creates a FOLDER and nothing else - no git init, no scaffolding, no README. The
 * first thing that happens in it is an agent, and an agent in an empty folder is the
 * whole point; anything written here would be a guess about a project nobody has
 * described yet.
 *
 * A name that already exists is not an error and is not a second folder: it answers with
 * the row for the folder that is there, which is what "start a session in Car" means
 * whether or not Car was made a moment ago.
 */
export function createProject(typed: string, root = projectsRoot()): Project | null {
  const name = folderNameFor(typed)
  if (!name) return null
  try {
    if (!existsSync(root)) return null
    const path = join(root, name)
    // `recursive` so an existing folder is a success rather than EEXIST - see above.
    mkdirSync(path, { recursive: true })
    if (!statSync(path).isDirectory()) return null
    return listProjects(root).find((p) => p.path === path) ?? { name, path, lastUsed: 0, isGit: false }
  } catch {
    return null
  }
}

export function listProjects(root = projectsRoot()): Project[] {
  if (!existsSync(root)) return []
  const used = lastUsedByPathSlug()

  const projects: Project[] = []
  const facts: FolderFacts[] = []
  for (const name of readdirSync(root)) {
    if (SKIP.has(name) || name.startsWith('.')) continue
    const path = join(root, name)
    let dir = false
    try {
      dir = statSync(path).isDirectory()
    } catch {
      continue
    }
    if (!dir) continue
    // A linked worktree's `.git` is a FILE saying which repository it belongs to, so the
    // two cases are told apart by what `.git` IS, never by what the folder is called.
    const git = gitEntry(join(path, '.git'))
    facts.push({ name, isGit: git.dir, gitFile: git.file })
    projects.push({
      name,
      path,
      lastUsed: used.get(slug(path)) ?? 0,
      isGit: git.dir || Boolean(git.file)
    })
  }
  const owners = checkoutOwners(facts)
  for (const p of projects) {
    const parent = owners.get(p.name)
    if (parent) p.checkoutOf = parent
  }
  // Copies are skipped: `clients-a`, `clients-b` and `clients-c` are lane worktrees of
  // `clients`, each carrying the whole roster, so the launcher offered every client FOUR
  // times over - 68 rows for 17 people, all four reading `Adie Bradley | clients` and
  // nothing on any of them saying which was which (measured in a dev window, 2026-09-04).
  // A client is a person, not a checkout: the roster is read from the project's own
  // folder, and the lane a pane lands in is `laneFor`'s decision as it is everywhere else.
  projects.push(...clientRows(root, used, owners))
  return projects.sort((a, b) => b.lastUsed - a.lastUsed || a.name.localeCompare(b.name))
}

/**
 * One row per client on the roster, a level DEEPER than every other row in this list.
 *
 * `clients` is one folder under the projects root, so the loop above offered exactly one
 * row for the whole roster and picking it opened a pane in the parent of everybody's
 * work. A client is what the session is actually for, and the launcher is where a person
 * says so: each one is its own row now, reading `Alison | clients`, which filters on the
 * client's name and opens straight into their folder - where their README and whatever
 * else is theirs already is, so nothing has to be typed to load it.
 *
 * `readRoster` is the same reading a pane already uses to rename itself in a client tree
 * (`main/clients.ts`), cached there, so this costs one map over an answer the app has. A
 * root with no roster - or one whose children carry no README - returns nothing at all,
 * which is every machine that does no client work.
 */
function clientRows(root: string, used: Map<string, number>, copies: Map<string, string>): Project[] {
  // The roster is not always `<root>/clients`. On this desk the client work lives in a
  // repository OF its own - `Projects/clients` - and the roster is the `clients` folder
  // INSIDE it, which is why `rosterRoot` walks up from a pane rather than guessing from
  // the top. From up here the same fact is one level down, so both are looked at and
  // whichever carries README-bearing children is the one read. Anything else - a `clients`
  // folder that is a build output, an empty one - fails `looksLikeRoster` and is skipped.
  const rosters = [join(root, CLIENTS_DIR)]
  for (const name of readdirSync(root)) {
    if (SKIP.has(name) || name.startsWith('.') || copies.has(name)) continue
    rosters.push(join(root, name, CLIENTS_DIR))
  }
  const rows: Project[] = []
  const seen = new Set<string>()
  for (const dir of rosters) {
    if (seen.has(dir) || !looksLikeRoster(dir)) continue
    seen.add(dir)
    for (const entry of readRoster(dir)) {
      const path = join(dir, entry.slug)
      rows.push({
        name: clientLabel(entry),
        client: entry.name,
        path,
        lastUsed: used.get(slug(path)) ?? 0,
        isGit: existsSync(join(path, '.git'))
      })
    }
  }
  return rows
}

/** What `.git` is here: a repository's own directory, or a linked worktree's pointer. */
function gitEntry(path: string): { dir: boolean; file: string | null } {
  try {
    if (statSync(path).isDirectory()) return { dir: true, file: null }
  } catch {
    return { dir: false, file: null }
  }
  try {
    // Tiny by construction - one `gitdir:` line - so this is a cheap read, not a slurp.
    return { dir: false, file: readFileSync(path, 'utf8').slice(0, 4096) }
  } catch {
    return { dir: false, file: null }
  }
}

function slug(path: string): string {
  return path.replace(/[^A-Za-z0-9]/g, '-').toLowerCase()
}

function lastUsedByPathSlug(): Map<string, number> {
  const out = new Map<string, number>()
  const root = join(homedir(), '.claude', 'projects')
  if (!existsSync(root)) return out
  for (const dir of readdirSync(root)) {
    const full = join(root, dir)
    let newest = 0
    try {
      if (!statSync(full).isDirectory()) continue
      for (const f of readdirSync(full)) {
        if (!f.endsWith('.jsonl')) continue
        const m = statSync(join(full, f)).mtimeMs
        if (m > newest) newest = m
      }
    } catch {
      continue
    }
    if (newest) out.set(dir.toLowerCase(), newest)
  }
  return out
}
