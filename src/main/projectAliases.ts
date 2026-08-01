// The names a project answers to.
//
// A folder called `Toolstash` is talked about as toolstash.xyz, as `robertiuoras/toolstash`,
// as the package name in its package.json, and as whatever its README calls itself. A
// message naming any of those names that project, so routing needs all of them - the
// folder name alone would miss every message that mentions the live site instead of the
// checkout, which is most of them.
//
// Everything here is read from files that are already on disk and already cheap: one
// package.json, one git config, the head of one README and one CLAUDE.md. No git process
// is spawned (that would be 50 projects x one process on every dialog open), and nothing
// below the project root is walked.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ProjectAlias, RouteCandidate } from '../shared/projectRoute'
import { TLD, trunkOf } from '../shared/projectRoute'
import type { Project } from '../shared/types'

/** Only the head of a README is a description of the project; the rest is documentation. */
const HEAD_BYTES = 4000

const CACHE = new Map<string, { at: number; aliases: ProjectAlias[] }>()
const TTL = 10 * 60_000

/**
 * Fold lane checkouts into their trunk and give each remaining project its alias set.
 *
 * The fold is not cosmetic. `PaneForge-b` is a worktree another chat may be holding, so
 * offering it as a routing target would start a session in a branch checkout that is not
 * this chat's to touch. Its name still routes - as an alias of the trunk.
 */
export function routeCandidates(projects: Project[], now = Date.now()): RouteCandidate[] {
  const byName = new Map(projects.map((p) => [p.name.toLowerCase(), p]))
  const extra = new Map<string, ProjectAlias[]>()

  const trunks = projects.filter((p) => {
    const base = trunkOf(p.name)
    if (base && byName.has(base.toLowerCase())) {
      const target = byName.get(base.toLowerCase())!
      const list = extra.get(target.path) ?? []
      list.push({ value: p.name, kind: 'dir' })
      extra.set(target.path, list)
      return false
    }
    return true
  })

  return trunks.map((p) => ({
    name: p.name,
    path: p.path,
    aliases: [...aliasesFor(p, now), ...(extra.get(p.path) ?? [])]
  }))
}

export function aliasesFor(project: Project, now = Date.now()): ProjectAlias[] {
  const hit = CACHE.get(project.path)
  if (hit && now - hit.at < TTL) return hit.aliases

  const out: ProjectAlias[] = [
    { value: project.path, kind: 'path' },
    { value: project.name, kind: 'dir' }
  ]
  const seen = new Set(out.map((a) => a.value.toLowerCase()))
  const add = (value: string | undefined, kind: ProjectAlias['kind']): void => {
    const v = (value ?? '').trim().toLowerCase()
    if (!v || v.length < 3 || seen.has(v)) return
    seen.add(v)
    out.push({ value: v, kind })
  }

  // Scoped npm names route on both halves: `@robert/toolstash` is said as "toolstash".
  const pkg = readJson(join(project.path, 'package.json'))
  if (pkg) {
    const name = typeof pkg.name === 'string' ? pkg.name : ''
    add(name.replace(/^@[^/]+\//, ''), 'pkg')
    if (typeof pkg.homepage === 'string') for (const d of domains(pkg.homepage)) add(d, 'domain')
  }

  // `.git/config` rather than `git remote -v`: same answer, no process.
  const cfg = readHead(join(project.path, '.git', 'config'), HEAD_BYTES)
  const remote = /url\s*=\s*(\S+)/.exec(cfg ?? '')?.[1]
  if (remote) {
    const slug = remote.replace(/\.git$/, '').replace(/^.*[:/]([^/]+\/[^/]+)$/, '$1')
    add(slug, 'remote')
    add(slug.split('/').pop(), 'remote')
  }

  for (const file of ['README.md', 'CLAUDE.md']) {
    const text = readHead(join(project.path, file), HEAD_BYTES)
    if (!text) continue
    for (const d of domains(text)) add(d, 'domain')
    if (file === 'README.md') {
      const title = /^#\s+(.+)$/m.exec(text)?.[1]
      if (title && title.length < 40) add(title.replace(/[^\w.-]+/g, ' ').trim(), 'title')
    }
  }

  CACHE.set(project.path, { at: now, aliases: out })
  return out
}

export function clearAliasCache(): void {
  CACHE.clear()
}

/**
 * Hostnames worth routing on. Anything under a vendor domain is dropped: half the READMEs
 * here mention github.com and vercel.app, and a project that routes on "github" routes on
 * every message about a pull request.
 */
const VENDOR =
  /(github|githubusercontent|gitlab|vercel|netlify|npmjs|nodejs|google|anthropic|openai|supabase|stripe|cloudflare|amazonaws|microsoft|apple|localhost|example)\./i

function domains(text: string): string[] {
  const out: string[] = []
  const re = /\b([a-z0-9][a-z0-9-]{1,40}(?:\.[a-z0-9-]{2,20}){1,3})\b/gi
  for (const m of text.matchAll(re)) {
    const host = m[1].toLowerCase()
    if (VENDOR.test(host)) continue
    if (!TLD.has(host.split('.').pop() ?? '')) continue
    out.push(host)
  }
  return out.slice(0, 6)
}

function readJson(path: string): Record<string, unknown> | null {
  const text = readHead(path, 64_000)
  if (!text) return null
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
}

function readHead(path: string, bytes: number): string | null {
  try {
    if (!existsSync(path)) return null
    if (statSync(path).size > 4_000_000) return null
    return readFileSync(path, 'utf8').slice(0, bytes)
  } catch {
    return null
  }
}
