// A process-group kill must never reach pid 0 or 1.
//
// 2026-10-06 3:10am and 3:16am: a test pane's fake pty pid of 1 reached process.kill(-1, 'SIGHUP') and every
// app on the Mac quit. kill(-1) signals every process the user owns, kill(0) the caller's own group, and the
// descendants of pid 1 are every process on the machine.
// No real signal leaves this file: process.kill is replaced before anything is loaded and every probe says "gone".
//
//   node scripts/signal-guard-test.mjs

import { build } from 'esbuild'
import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const sent = []
const realKill = process.kill
process.kill = (pid, sig) => {
  sent.push([pid, sig])
  if (sig === 0 || sig === undefined) throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
  return true
}
const safeTarget = (pid) => Number.isInteger(pid) && Math.abs(pid) > 1 && Math.abs(pid) !== process.pid
const dangerous = () => sent.filter(([pid, sig]) => sig !== 0 && !safeTarget(pid))

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const OUT = join(ROOT, 'node_modules', '.pf-test')
mkdirSync(OUT, { recursive: true })
const bundle = async (entry, name, extra = {}) => {
  const outfile = join(OUT, name)
  await build({ entryPoints: [join(ROOT, entry)], outfile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent', ...extra })
  return import(pathToFileURL(outfile).href)
}
// strays.ts and devServers.ts import electron only for paths; a stub keeps them loadable outside the app.
const electronStub = {
  name: 'electron-stub',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: "export const app = { getPath: () => '/nonexistent-pf-signal-guard', isPackaged: false }; export default { app }", loader: 'js' }))
  }
}

let failed = 0
const ok = (what, cond, extra = '') => {
  if (cond) console.log(`  ok  ${what}`)
  else {
    console.error(`FAIL  ${what} ${extra}`)
    failed++
  }
}

console.log('signal guard')
const strays = await bundle('src/main/strays.ts', 'signal-guard-strays.mjs', { plugins: [electronStub] })
const devs = await bundle('src/main/devServers.ts', 'signal-guard-devs.mjs', { plugins: [electronStub] })
const guard = await bundle('src/shared/signalGuard.ts', 'signal-guard-shared.mjs')
const scriptsGuard = await import(pathToFileURL(join(ROOT, 'scripts/signal-guard.mjs')).href)

const bad = [1, 0, -1, -0, undefined, Number.NaN, 1.5, '1', null, process.pid]
for (const pid of bad) {
  sent.length = 0
  strays.killPaneStrays('fake-pane', pid)
  ok(`closing a pane whose pty reports pid ${String(pid)} signals no process group`, dangerous().length === 0, JSON.stringify(sent))
}
for (const [label, g] of [['src/shared', guard], ['scripts', scriptsGuard]]) {
  for (const pid of bad) {
    sent.length = 0
    for (const target of [pid, typeof pid === 'number' ? -pid : pid]) g.signal(target, 'SIGKILL')
    ok(`${label} signal() refuses ${String(pid)}`, sent.length === 0, JSON.stringify(sent))
  }
  sent.length = 0
  ok(`${label} signal() sends to a real pid and to its group`, g.signal(999999, 'SIGTERM') && g.signal(-999999, 'SIGTERM') && sent.length === 2)
}
sent.length = 0
const stopped = await devs.stopDevServer(1)
ok('a dev-server stop on pid 1 is refused and signals nothing', stopped.ok === false && sent.length === 0, JSON.stringify(sent))
ok('the dev-server walk from pid 1 or 0 finds nothing', devs.descendants([{ pid: 5, ppid: 1, cmd: 'x' }, { pid: 6, ppid: 0, cmd: 'y' }], 1).length === 0 && devs.descendants([{ pid: 6, ppid: 0, cmd: 'y' }], 0).length === 0)
ok('the stray walk from pid 1 or 0 finds nothing', strays.descendantsOf([{ pid: 5, ppid: 1 }, { pid: 6, ppid: 0 }], [1, 0]).length === 0)
const sh = strays.reapStraysSh([{ pid: 1, started: 'a' }, { pid: 0, started: 'b' }, { pid: 42, started: 'c' }], 0)
ok('the stray sweep script never names pid 0 or 1', !/kill -9 [01]\b/.test(sh) && /kill -9 42/.test(sh), sh)

// Statically: any raw process.kill( outside the guards and not a signal-0 probe fails.
// Tests that kill a process they spawned themselves are not scanned.
const offenders = []
const walk = (dir) => {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(rel); continue }
    if (!/\.(ts|tsx|mjs|js|cjs)$/.test(entry.name)) continue
    if (/-test\.mjs$|-live\.mjs$/.test(entry.name)) continue
    if (rel === 'src/shared/signalGuard.ts' || rel === 'scripts/signal-guard.mjs') continue
    const text = readFileSync(join(ROOT, rel), 'utf8')
    for (const m of text.matchAll(/process\.kill\(([^()]*)\)/g)) {
      const args = m[1].trim()
      if (/,\s*0$/.test(args)) continue
      if (rel === 'scripts/lane.mjs' && args === '-pid, name') continue // signalGroup, the guarded copy
      if (rel === 'src/shared/installWedge.ts' && /kill: \(pid: number, signal: 0\)/.test(text)) continue // typed as a signal-0 probe
      offenders.push(`${rel}: ${m[0]}`)
    }
  }
}
walk('src')
walk('scripts')
ok('every process.kill( outside the guard is a signal-0 probe', offenders.length === 0, '\n  ' + offenders.join('\n  '))

// A shell kill built from a pid goes through the guard first.
for (const file of ['src/main/watchdog-child.ts', 'src/main/strays.ts']) {
  const text = readFileSync(join(ROOT, file), 'utf8')
  ok(`${file} checks the pid with signalable() before a shell kill`, /signalable\(/.test(text))
}

process.kill = realKill
if (failed) {
  console.error(`signal-guard-test: ${failed} FAILED`)
  process.exit(1)
}
console.log('signal-guard-test: OK')
