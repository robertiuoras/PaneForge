// Every polling `git` in the main process goes through here: one gate (`shared/gitGate.ts`)
// so the same command in the same folder runs once however many callers ask, and at most
// GIT_MAX run at once - fewer while the machine is loaded. See that file for the storm
// this exists for.

import { execFile } from 'node:child_process'
import { GIT_MAX, GitGate } from '../shared/gitGate'
import { loadPerCore } from './memory'

// One-minute load per core; 0 on Windows, which the gate reads as unloaded.
const gate = new GitGate(GIT_MAX, loadPerCore)

export interface GitResult {
  /** git's exit code; -1 when it could not be run at all or was killed. */
  status: number
  ok: boolean
  stdout: string
  stderr: string
}

export interface GitRunOptions {
  timeout: number
  maxBuffer?: number
  /**
   * True for a command that only reads. Reads are joined when identical and run with
   * GIT_OPTIONAL_LOCKS=0, so a `status` never takes index.lock or rewrites the index under
   * an agent committing in the same folder.
   */
  read: boolean
  /**
   * False when the answer must reflect the tree as it is AT the call: a status already
   * running started earlier and may predate the last write (`changedNothing.ts` compares
   * the two ends of a turn, and a joined end-of-turn reading could equal the start).
   */
  join?: boolean
}

export function gitRun(cwd: string, args: string[], opts: GitRunOptions): Promise<GitResult> {
  const key = opts.read && opts.join !== false ? `${cwd}\0${args.join('\0')}` : null
  return gate.run(
    key,
    () =>
      new Promise<GitResult>((done) => {
        execFile(
          'git',
          args,
          {
            cwd,
            encoding: 'utf8',
            windowsHide: true,
            timeout: opts.timeout,
            // SIGTERM is what execFile sends by default; a git wedged on a lock or a slow
            // disk is exactly the one that must not outlive its timeout.
            killSignal: 'SIGKILL',
            maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
            env: opts.read ? { ...process.env, GIT_OPTIONAL_LOCKS: '0' } : process.env
          },
          (err, stdout, stderr) => {
            const code = (err as (Error & { code?: number | string }) | null)?.code
            done({
              status: err ? (typeof code === 'number' ? code : -1) : 0,
              ok: !err,
              stdout: stdout ?? '',
              stderr: stderr ?? ''
            })
          }
        )
      })
  )
}

