// Closes a `npm run try` copy nobody is using any more. try.mjs starts this (detached,
// hidden) for every copy an agent pane launched. Every 60s it asks `pf list` about the
// pane that launched the copy and closes the copy when that pane is gone or has not been
// `working` for 15 minutes. It closes THIS copy only, by its pid - `npm run try -- --close`
// takes every copy under the repo, and another chat's may be mid-test - and exits once the
// copy's process is gone.
//   node scripts/try-reaper.mjs <profile> <copyPid> <paneId> <launchedAtMs>
import { spawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const IDLE_LIMIT_MS = 15 * 60 * 1000
export const POLL_MS = 60 * 1000

/** Pure decision. `listText` = `pf list` output (number, id, state, name, folder; tab separated). */
export function decide({ paneId, listText, now, lastWorkingAt, pidAlive }) {
  if (!pidAlive) return { action: 'exit', reason: 'copy is gone', lastWorkingAt }
  const row = String(listText ?? '')
    .split('\n')
    .map((l) => l.split('\t'))
    .find((c) => c[0]?.trim() === paneId || c[1]?.trim() === paneId)
  if (!row) return { action: 'close', reason: 'launching chat is gone', lastWorkingAt }
  if (row[2]?.trim() === 'working') return { action: 'keep', reason: 'chat is working', lastWorkingAt: now }
  const idle = now - lastWorkingAt
  if (idle >= IDLE_LIMIT_MS) return { action: 'close', reason: `chat idle ${Math.round(idle / 60000)} min`, lastWorkingAt }
  return { action: 'keep', reason: `chat idle ${Math.round(idle / 60000)} min`, lastWorkingAt }
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

const wait = (ms) => new Promise((res) => setTimeout(res, ms))

/**
 * Quit one copy: asked first, then asked again (a copy holding a mid-turn pane refuses
 * the first SIGTERM and dies on the second, 2026-09-25), then killed.
 */
async function closeOne(pid) {
  for (const [signal, ms] of [['SIGTERM', 8000], ['SIGTERM', 3000], ['SIGKILL', 3000]]) {
    try {
      process.kill(pid, signal)
    } catch {
      return 'closed'
    }
    for (let t = 0; t < ms && alive(pid); t += 250) await wait(250)
    if (!alive(pid)) return signal === 'SIGKILL' ? 'killed' : 'closed'
  }
  return 'still running'
}

async function main() {
  const [profile, pidArg, paneId, launchedArg] = process.argv.slice(2)
  const pid = Number(pidArg)
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  // The copy's own data dir is not known to this script, so the log is in the temp dir.
  const logFile = join(tmpdir(), `paneforge-try-reaper-${profile}.log`)
  const log = (m) => {
    try {
      appendFileSync(logFile, `${new Date().toISOString()} ${m}\n`)
    } catch {}
  }
  let lastWorkingAt = Number(launchedArg) || Date.now()
  log(`watching copy ${profile} pid ${pid} for pane ${paneId}`)
  for (;;) {
    const r = spawnSync('pf', ['list'], { encoding: 'utf8', timeout: 20000 })
    if (r.status !== 0 || !r.stdout) {
      // pf unreachable (app restarting): no information, so never close on it.
      log(`pf list failed (status ${r.status}); keeping`)
    } else {
      const d = decide({ paneId, listText: r.stdout, now: Date.now(), lastWorkingAt, pidAlive: alive(pid) })
      lastWorkingAt = d.lastWorkingAt
      log(`${d.action}: ${d.reason}`)
      if (d.action === 'exit') return
      if (d.action === 'close') {
        spawnSync(
          'pf',
          ['tell', paneId, `The test copy of PaneForge named ${profile} was closed because this chat stopped using it.`],
          { stdio: 'ignore', timeout: 20000 }
        )
        log(`close: ${await closeOne(pid)}`)
        const { dropTestAppKeep, keptTestApp } = await import('./test-app.mjs')
        if (keptTestApp() === pid) dropTestAppKeep()
        return
      }
    }
    if (!alive(pid)) return log('copy is gone') // pf down for good must not keep this running
    await wait(POLL_MS)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main()
