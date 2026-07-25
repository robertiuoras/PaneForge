// Builds the project list for the launcher sidebar.
//
// Order matters more than completeness: the list is ranked by when each folder last
// had a Claude Code session, which Claude Code records as one transcript folder per
// working directory under ~/.claude/projects, named after the path with every
// non-alphanumeric character replaced by '-'.

import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Project } from '../shared/types'

const SKIP = new Set([
  'node_modules', '.git', '.vscode', '.claude', '.cursor', '.autosync',
  'assets', 'backups', 'temp', 'dist', 'out'
])

export function defaultRoot(): string {
  return join(homedir(), 'Desktop', 'Projects')
}

export function listProjects(root = defaultRoot()): Project[] {
  if (!existsSync(root)) return []
  const used = lastUsedByPathSlug()

  const projects: Project[] = []
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
    projects.push({
      name,
      path,
      lastUsed: used.get(slug(path)) ?? 0,
      isGit: existsSync(join(path, '.git'))
    })
  }
  return projects.sort((a, b) => b.lastUsed - a.lastUsed || a.name.localeCompare(b.name))
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
