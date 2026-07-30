// What the improver is told about the project, in a few hundred tokens.
//
// References, not copies. `"verify: npm run test:view"` rather than the test file;
// `"see .paneforge/MEMORY.md"` rather than its contents once it is long. The improved
// prompt is going to an agent that is sitting IN this repository with a filesystem - it
// does not need the repository sent to it, it needs to know what to look at.
//
// Everything here is keyed on one `cwd` and assembled per request. There is no global
// corpus and no cross-project cache, which is the whole of the leakage mitigation: there
// is no code path by which project A's memory can reach project B's prompt, because
// nothing is ever held between requests.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { GitInfo } from '../shared/types'
import { estimateTokens, fitTokens } from '../shared/promptBudget'
import { memoryPath } from './board'

/** Files whose presence names a stack without reading anything. */
const MARKERS: Array<{ file: string; says: string; stack: string }> = [
  { file: 'next.config.js', says: 'Next.js', stack: 'next' },
  { file: 'next.config.mjs', says: 'Next.js', stack: 'next' },
  { file: 'next.config.ts', says: 'Next.js', stack: 'next' },
  { file: 'nuxt.config.ts', says: 'Nuxt', stack: 'nuxt' },
  { file: 'svelte.config.js', says: 'SvelteKit', stack: 'svelte' },
  { file: 'vite.config.ts', says: 'Vite', stack: 'vite' },
  { file: 'astro.config.mjs', says: 'Astro', stack: 'astro' },
  { file: 'tailwind.config.js', says: 'Tailwind', stack: 'tailwind' },
  { file: 'tailwind.config.ts', says: 'Tailwind', stack: 'tailwind' },
  { file: 'Cargo.toml', says: 'Rust', stack: 'rust' },
  { file: 'go.mod', says: 'Go', stack: 'go' },
  { file: 'pyproject.toml', says: 'Python', stack: 'python' },
  { file: 'requirements.txt', says: 'Python', stack: 'python' },
  { file: 'Gemfile', says: 'Ruby', stack: 'ruby' },
  { file: 'Dockerfile', says: 'Docker', stack: 'docker' },
  { file: 'justfile', says: 'just', stack: 'just' }
]

/** Script names worth naming to an agent, in the order they are worth naming. */
const VERIFY_SCRIPTS = [
  'typecheck',
  'test',
  'lint',
  'build',
  'check',
  'test:unit',
  'test:e2e',
  'smoke'
]

export interface ProjectContext {
  /** Lowercase framework ids, for capability compatibility filtering. */
  stack: string[]
  /** Lowercase dependency names, for the overlap check. */
  dependencies: string[]
  /** Project slug - the folder name. Used to scope private knowledge. */
  project: string
  /** The rendered pack. */
  text: string
  tokens: number
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Assemble the pack for one working directory.
 *
 * Synchronous file reads on purpose: every one is a small file in the folder the pane is
 * already sitting in, and this runs on a deliberate user action rather than on a timer.
 * The one thing that is NOT read synchronously anywhere near here is `git status` - that
 * is `git.ts`'s async cache, and it stays async because a sync spawn blocks the window
 * message loop and Windows answers a stalled message loop with the busy cursor.
 */
export function buildContextPack(
  cwd: string,
  git: GitInfo | null,
  budgetTokens: number
): ProjectContext {
  const project = basename(cwd) || 'project'
  const lines: string[] = []
  const stack: string[] = []
  const dependencies: string[] = []

  lines.push(`Project: ${project}`)
  if (git) {
    const bits = [`branch ${git.branch || 'detached'}`]
    if (git.dirty) bits.push(`${git.dirty} uncommitted file${git.dirty === 1 ? '' : 's'}`)
    lines.push(`Git: ${bits.join(', ')}`)
  }

  const pkg = readJson(join(cwd, 'package.json'))
  if (pkg) {
    const deps = {
      ...((pkg.dependencies as Record<string, string>) ?? {}),
      ...((pkg.devDependencies as Record<string, string>) ?? {})
    }
    for (const name of Object.keys(deps)) dependencies.push(name.toLowerCase())

    // Named rather than listed: an agent in this folder can read package.json, and the
    // whole dependency list is the single easiest way to spend the entire budget.
    const notable = Object.keys(deps).filter((d) =>
      /^(react|vue|svelte|next|nuxt|astro|express|fastify|electron|three|@?tailwind|typescript)/.test(
        d
      )
    )
    if (notable.length) lines.push(`Key dependencies: ${notable.slice(0, 8).join(', ')}`)

    const scripts = (pkg.scripts as Record<string, string>) ?? {}
    const verify = VERIFY_SCRIPTS.filter((s) => scripts[s]).slice(0, 3)
    if (verify.length) {
      lines.push(`Verify with: ${verify.map((s) => `npm run ${s}`).join(', ')}`)
    }
    if (deps.react) stack.push('react')
    if (deps.vue) stack.push('vue')
    if (deps.svelte) stack.push('svelte')
    if (deps.next) stack.push('next')
    if (deps.electron) stack.push('electron')
    stack.push('node')
  }

  const found: string[] = []
  for (const m of MARKERS) {
    if (existsSync(join(cwd, m.file))) {
      found.push(m.says)
      if (!stack.includes(m.stack)) stack.push(m.stack)
    }
  }
  if (found.length) lines.push(`Stack markers: ${[...new Set(found)].join(', ')}`)

  // Agent instructions the repo already carries. Named, not inlined - these files are the
  // reason the downstream agent does not need them repeated at it.
  const guides = ['CLAUDE.md', 'AGENTS.md', 'CONTRIBUTING.md', '.cursorrules'].filter((f) =>
    existsSync(join(cwd, f))
  )
  if (guides.length) lines.push(`Repo instructions the agent will already read: ${guides.join(', ')}`)

  // The project's own memory, which board.ts writes into the folder precisely so an agent
  // can read it. Head only, and referenced by path once it stops being short.
  const mem = memoryPath(cwd)
  if (existsSync(mem)) {
    try {
      const text = readFileSync(mem, 'utf8').trim()
      if (text) {
        const head = fitTokens(text, Math.min(200, Math.floor(budgetTokens / 3)))
        lines.push(`Project memory (.paneforge/MEMORY.md):\n${head}`)
        if (head.length < text.length) lines.push('(memory truncated - the agent can read the file)')
      }
    } catch {
      /* unreadable memory file is not a reason to fail an improvement */
    }
  }

  // Top-level layout, so "the login page" can be resolved to a folder rather than guessed.
  try {
    const entries = readdirSync(cwd, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => e.name)
      .slice(0, 12)
    if (entries.length) lines.push(`Top-level folders: ${entries.join(', ')}`)
  } catch {
    /* unreadable cwd - the rest of the pack still stands */
  }

  const text = fitTokens(lines.join('\n'), budgetTokens)
  return {
    stack: [...new Set(stack)],
    dependencies,
    project,
    text,
    tokens: estimateTokens(text)
  }
}
