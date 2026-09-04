/**
 * The change list, read into `shared/tour.ts`'s steps - the main-process half.
 *
 * Only a dev copy ever asks for this (`profileName()` is not the installed app - the
 * same reading `faultNotify.ts` uses to keep a test copy from paging anybody), so the
 * installed app never shells out to git at all: `tour()` refuses before `diffCommits`
 * runs, and `tourCheck()` refuses before a test script does.
 */

import { app } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { profileName } from './profile'
import { which } from './which'
import { diffCommits } from '../../scripts/try-diff.mjs'
import { checkAllowed, makeTour, readCheck, tourAllowed, type TourCheck, type TourProgress, type TourState } from '../shared/tour'

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

/**
 * Runs one of the repo's own `scripts/<name>-test.mjs` and reads its answer, SAYING WHAT
 * IT IS DOING while it does it.
 *
 * `execFile` was enough while the card only had to draw a verdict, and it is not enough
 * now: a check that takes twenty seconds behind a card that says `Checking…` is a card
 * that looks stuck, which is the whole reason the tour felt like it was doing nothing
 * (Robert, 2026-09-04: "maybe show what its running and stuff realtime in that card").
 * So this spawns instead, splits stdout on newlines, and hands each finished line back as
 * it lands - a line at a time, never a buffer at the end.
 *
 * `onLine` is optional and never awaited: a renderer that has moved on, a window that has
 * gone, a card that was closed mid-check must not be able to hold or fail the run.
 */
export function tourCheck(script: string, onLine?: (p: TourProgress) => void): Promise<TourCheck> {
  if (!tourAllowed(profileName())) return Promise.resolve(readCheck(script, 1, 'FAIL not a dev copy'))
  if (!checkAllowed(script)) return Promise.resolve(readCheck(script, 1, 'FAIL not a test script this app may run'))
  const r = root()
  const file = join(r, script)
  if (!existsSync(file)) return Promise.resolve(readCheck(script, 1, `FAIL ${script} is not in this checkout`))
  // The suites import `.ts` straight off disk, which the system's node (24) strips and
  // Electron's own (20) cannot - so the same `node` `npm test` uses, never `process.execPath`.
  const node = which('node') || 'node'
  return new Promise((resolve) => {
    const child = spawn(node, [file], { cwd: r, windowsHide: true })
    let out = ''
    let rest = ''
    let passed = 0
    let failed = 0
    let done = false
    const timer = setTimeout(() => {
      if (!done) child.kill()
    }, CHECK_BUDGET_MS)
    const eat = (chunk: string): void => {
      out += chunk
      rest += chunk
      const lines = rest.split('\n')
      rest = lines.pop() ?? ''
      for (const raw of lines) {
        const line = raw.trim()
        if (!line) continue
        if (/^ok\b/i.test(line)) passed++
        else if (/^FAIL\b/.test(line)) failed++
        else continue
        // Only the lines that COUNT are sent. A suite's section headings are prose about
        // the code, written for whoever is reading the file - putting them on the card is
        // the fluff this card was just stripped of.
        try {
          onLine?.({ script, passed, failed, line })
        } catch {
          // A dead window is not a failed check.
        }
      }
    }
    child.stdout?.on('data', (d: Buffer) => eat(d.toString()))
    child.stderr?.on('data', (d: Buffer) => {
      out += d.toString()
    })
    child.on('error', () => {
      done = true
      clearTimeout(timer)
      resolve(readCheck(script, 1, `${out}\nFAIL could not start ${script}`))
    })
    child.on('close', (code) => {
      done = true
      clearTimeout(timer)
      if (rest.trim()) eat('\n')
      resolve(readCheck(script, code, out))
    })
  })
}
