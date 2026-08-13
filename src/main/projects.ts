// Builds the project list for the launcher sidebar.
//
// Order matters more than completeness: the list is ranked by when each folder last
// had a Claude Code session, which Claude Code records as one transcript folder per
// working directory under ~/.claude/projects, named after the path with every
// non-alphanumeric character replaced by '-'.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { projectsRoot } from './config'
import { checkoutOwners, type FolderFacts } from '../shared/checkout'
import type { Project } from '../shared/types'

const SKIP = new Set([
  'node_modules', '.git', '.vscode', '.claude', '.cursor', '.autosync',
  'assets', 'backups', 'temp', 'dist', 'out'
])

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
  return projects.sort((a, b) => b.lastUsed - a.lastUsed || a.name.localeCompare(b.name))
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
