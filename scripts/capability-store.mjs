// Reading and writing capability records from a script.
//
// `catalogue.ts` owns this at runtime; this is the same store seen from outside Electron,
// where `app.getPath('userData')` does not exist. One module rather than a copy in each
// CLI, for the reason the rest of this repository keeps saying: three readers of the same
// files is three answers to "which record wins".
//
// A record lives in exactly one file and is rewritten in place. The alternative - appending
// an updated copy to a second file and letting load order decide - is a store whose answer
// depends on `readdirSync` ordering, which is alphabetical here and is not guaranteed
// anywhere.

import { buildSync } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Matches `catalogue.ts`'s `userDir()`.
 *
 * `claude-orchestrator`, not `PaneForge`: package.json's `name` stays put because Electron
 * builds `%APPDATA%\<name>` from it, so renaming it would move the installed app's config.
 * See the repository's CLAUDE.md.
 */
export function capabilityDir() {
  if (process.env.PF_CAPABILITY_DIR) return process.env.PF_CAPABILITY_DIR
  const name = 'claude-orchestrator'
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), name, 'capabilities')
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', name, 'capabilities')
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), name, 'capabilities')
}

export function vaultPath() {
  return process.env.PF_VAULT || join(homedir(), 'Documents', 'Obsidian Vault')
}

export function indexScriptPath() {
  if (process.env.PF_INDEX_SCRIPT) return process.env.PF_INDEX_SCRIPT
  const projects =
    process.platform === 'win32' ? join(homedir(), 'Desktop', 'Projects') : join(homedir(), 'Projects')
  return join(projects, 'claude-memory', 'claude-config', 'vault-index', 'vaultindex.py')
}

let cached = null
/** The shared validators, built from the source the app itself runs. */
export function shared() {
  if (cached) return cached
  const work = join(tmpdir(), 'pf-cap-store')
  mkdirSync(work, { recursive: true })
  const req = createRequire(import.meta.url)
  const load = (entry, name) => {
    const out = join(work, name)
    buildSync({ absWorkingDir: root, entryPoints: [entry], bundle: true, format: 'cjs', platform: 'node', outfile: out })
    return req(out)
  }
  cached = {
    capability: load('src/shared/capability.ts', 'capability.cjs'),
    research: load('src/shared/research.ts', 'research.cjs')
  }
  return cached
}

/** Every user record, with the file and line it came from so it can be written back. */
export function loadAll(dir = capabilityDir()) {
  const { capability } = shared()
  const out = []
  if (!existsSync(dir)) return out
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
    let text
    try {
      text = readFileSync(join(dir, file), 'utf8')
    } catch {
      continue
    }
    const lines = text.split(/\r?\n/)
    lines.forEach((line, i) => {
      if (!line.trim()) return
      let raw
      try {
        raw = JSON.parse(line)
      } catch {
        return
      }
      const parsed = capability.parseCapability(raw)
      // A record that fails validation is dropped, never repaired - the same rule
      // `catalogue.ts` states, for the same reason: a half-understood record is how a
      // licence or a security note goes missing.
      if (parsed.ok) out.push({ file: join(dir, file), line: i, record: parsed.value })
    })
  }
  return out
}

export function find(id, dir = capabilityDir()) {
  return loadAll(dir).find((e) => e.record.id === id) ?? null
}

/**
 * Rewrite one record in the file that holds it.
 *
 * Read-modify-write of the whole file rather than a line patch: the lines are JSON of
 * varying length, and an in-place patch that gets the offset wrong corrupts the record
 * either side of it.
 */
export function update(id, mutate, dir = capabilityDir()) {
  const entry = find(id, dir)
  if (!entry) return null
  const text = readFileSync(entry.file, 'utf8')
  const lines = text.split(/\r?\n/)
  const next = mutate({ ...entry.record })
  lines[entry.line] = JSON.stringify(next)
  writeFileSync(entry.file, lines.join('\n'), 'utf8')
  return next
}

/** Ask the index to notice what changed. A failure is reported, never fatal. */
export function reindex() {
  const script = indexScriptPath()
  if (!existsSync(script)) return null
  try {
    const bin = process.platform === 'win32' ? 'py' : 'python3'
    const leading = process.platform === 'win32' ? ['-3'] : []
    execFileSync(bin, [...leading, script, 'sync'], {
      cwd: dirname(script),
      timeout: 60_000,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      stdio: 'ignore'
    })
    return true
  } catch {
    return false
  }
}

/**
 * Carry a status change onto the record's Obsidian note.
 *
 * Without this the two stores disagree: the catalogue says `verified` while the note a
 * person reads still says `inbox`, and the index - which ranks on the NOTE's status - keeps
 * the promoted capability out of trusted retrieval forever. It was visible as
 * `awaiting_review: 1` on the agent's own dashboard for a record that had been verified.
 *
 * Frontmatter only. The body is a person's to edit and is never rewritten from here.
 */
export function syncNoteStatus(id, status, stageWord) {
  const path = join(vaultPath(), '30 Knowledge', 'capabilities', `${id}.md`)
  if (!existsSync(path)) return null
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  const end = text.indexOf('\n---', 4)
  if (!text.startsWith('---') || end < 0) return null
  const head = text
    .slice(0, end)
    .replace(/^status:.*$/m, `status: ${status}`)
    .replace(/^updated:.*$/m, `updated: ${today()}`)
  let body = text.slice(end)
  // The one human-readable line that repeats the stage, kept honest too.
  body = body.replace(/^stage \*\*[A-Za-z -]+\*\*.*$/m, `stage **${stageWord}**`)
  try {
    writeFileSync(path, head + body, 'utf8')
    return path
  } catch {
    return null
  }
}

/** Untrusted text going into Markdown: never let it open a fence or a frontmatter block. */
export function safe(text) {
  return String(text ?? '').replace(/\r/g, '').replace(/^---$/gm, '- - -').replace(/```/g, "'''").trim()
}

export function today() {
  return new Date().toISOString().slice(0, 10)
}
