// The preferred knowledge provider: the existing `vault-index` CLI.
//
// Robert's vault already has retrieval - `vaultindex.py`, standard-library Python over
// SQLite FTS, with `sources.json` deciding what may be read. Re-implementing that in
// TypeScript would duplicate the one thing that must not be duplicated: the sensitivity
// guarantee is enforced when the index is BUILT, so a `restricted` note's text is never
// in the database, and a second implementation would be a second query-time filter with
// its own way of being wrong.
//
// So this shells out and parses `context --json`. What it adds is the app's own rules:
// a hard deadline, `windowsHide`, and no repo access.
//
// Off unless configured. There is no auto-detection of a path under someone's home
// directory in shipped code - the command is a setting, empty by default, and Settings
// offers a candidate rather than assuming one.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Lifecycle, Sensitivity } from '../../shared/capability'
import type { KnowledgeNote, KnowledgeProvider, KnowledgeQuery } from '../../shared/knowledge'
import { applyPolicy } from '../../shared/knowledge'
import { expandHome } from './markdown'

/** A retrieval that takes longer than this is not worth what it is holding up. */
const DEADLINE_MS = 8000

/**
 * How to start Python, per platform.
 *
 * `py -3` on Windows and never the bare word `python`: on a machine with the Microsoft
 * Store app-execution alias in PATH, `python` is a stub that prints an advert for the
 * Store and exits non-zero, which reads exactly like a missing script.
 */
export function pythonCommand(): { bin: string; leading: string[] } {
  return process.platform === 'win32'
    ? { bin: 'py', leading: ['-3'] }
    : { bin: 'python3', leading: [] }
}

interface RawNote {
  path?: string
  title?: string
  type?: string
  project?: string | null
  status?: string
  sensitivity?: string
  updated?: string
  stale?: boolean
  score?: number
  excerpt?: string
  snippet?: string
}

export interface VaultIndexOptions {
  /** Absolute path to `vaultindex.py`. Empty disables the provider. */
  scriptPath: string
  name?: string
}

export function vaultIndexProvider(options: VaultIndexOptions): KnowledgeProvider {
  const script = expandHome(options.scriptPath)
  const name = options.name ?? 'vault-index'

  return {
    name,
    available(): boolean {
      return Boolean(script) && existsSync(script)
    },
    async search(q: KnowledgeQuery): Promise<KnowledgeNote[]> {
      if (!this.available()) return []
      const { bin, leading } = pythonCommand()
      const args = [...leading, script, 'context', q.task, '--json']
      if (q.project) args.push('--project', q.project)
      args.push('--sensitivity-max', q.sensitivityMax ?? 'internal')
      if (q.includeUntrusted) args.push('--include-untrusted')

      const stdout = await new Promise<string>((resolve) => {
        const child = execFile(
          bin,
          args,
          {
            cwd: dirname(script),
            timeout: DEADLINE_MS,
            windowsHide: true,
            maxBuffer: 4 * 1024 * 1024,
            env: {
              ...process.env,
              // Windows Python defaults stdout to cp1252, and the vault's notes contain
              // arrows and curly quotes. Without this the CLI dies inside json.dumps with
              // a UnicodeEncodeError and the failure looks like an empty vault.
              PYTHONIOENCODING: 'utf-8'
            }
          },
          (err, out) => resolve(err ? '' : out)
        )
        // A retrieval must never be the thing that keeps a process alive.
        child.unref?.()
      })

      if (!stdout.trim()) return []
      let parsed: { notes?: RawNote[] }
      try {
        parsed = JSON.parse(stdout) as { notes?: RawNote[] }
      } catch {
        return []
      }

      const notes: KnowledgeNote[] = (parsed.notes ?? []).map((n, i) => {
        const status = (n.status ?? 'draft') as Lifecycle
        const sensitivity = (n.sensitivity ?? 'internal') as Sensitivity
        return {
          id: n.path ?? `note-${i}`,
          title: n.title ?? n.path ?? 'note',
          provider: name,
          // The vault path, not the absolute one. `abspath` is in the payload and names
          // the user's home directory; it has no business in a prompt.
          source: n.path ?? '',
          status,
          sensitivity,
          updated: n.updated ?? '',
          stale: Boolean(n.stale),
          text: (n.excerpt ?? n.snippet ?? '').trim(),
          score: typeof n.score === 'number' ? n.score : 0,
          trusted: status === 'reviewed' || status === 'verified'
        }
      })

      // The CLI already applied its own policy. This runs anyway: two gates that agree
      // cost nothing, and the one time they disagree is the one that matters.
      return applyPolicy(notes, q).sort((a, b) => b.score - a.score)
    }
  }
}
