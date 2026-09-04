/**
 * The change list, read into `shared/tour.ts`'s steps - the main-process half.
 *
 * Only a dev copy ever asks for this (`profileName()` is not the installed app - the
 * same reading `faultNotify.ts` uses to keep a test copy from paging anybody), so the
 * installed app never shells out to git at all: `tour()` refuses before `diffCommits`
 * runs, and `tourCheck()` refuses before a test script does.
 */

import { app } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { profileName } from './profile'
import { which } from './which'
import { diffCommits } from '../../scripts/try-diff.mjs'
import { checkAllowed, makeTour, readCheck, tourAllowed, type TourCheck, type TourState } from '../shared/tour'

function root(): string {
  return app.isPackaged ? process.resourcesPath : app.getAppPath()
}

export function tour(): TourState | null {
  if (!tourAllowed(profileName())) return null
  const r = root()
  const { commits } = diffCommits(r)
  return makeTour(commits, r)
}

/** Runs one of the repo's own `scripts/<name>-test.mjs` and reads its answer. Anything
 * else - the installed app asking, a path outside that shape, a file that is not there -
 * is a failed check that says why, never a run. */
const CHECK_BUDGET_MS = 120_000
export function tourCheck(script: string): Promise<TourCheck> {
  if (!tourAllowed(profileName())) return Promise.resolve(readCheck(script, 1, 'FAIL not a dev copy'))
  if (!checkAllowed(script)) return Promise.resolve(readCheck(script, 1, 'FAIL not a test script this app may run'))
  const r = root()
  const file = join(r, script)
  if (!existsSync(file)) return Promise.resolve(readCheck(script, 1, `FAIL ${script} is not in this checkout`))
  // The suites import `.ts` straight off disk, which the system's node (24) strips and
  // Electron's own (20) cannot - so the same `node` `npm test` uses, never `process.execPath`.
  const node = which('node') || 'node'
  return new Promise((resolve) => {
    execFile(
      node,
      [file],
      { cwd: r, timeout: CHECK_BUDGET_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        // A killed run (timeout) has no numeric code; anything that is not a clean exit is red.
        const raw = err ? (err as { code?: unknown }).code : 0
        const code = typeof raw === 'number' ? raw : 1
        resolve(readCheck(script, code, `${stdout}\n${stderr}`))
      }
    )
  })
}
