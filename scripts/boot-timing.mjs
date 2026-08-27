// How long a desk restore really takes, per pane, from launch to a composer you can type in.
//
// The complaint this exists for is "after an update restart it shows the panes and then
// takes ages before I can type". Three different things sit inside that sentence and only
// a measurement separates them: the window appearing, the OLD screen being put back, and
// the agent CLI booting far enough to draw its composer. This prints all three, per pane.
//
//   npm run build && node scripts/boot-timing.mjs --panes 8
//   node scripts/boot-timing.mjs --panes 8 --stagger 400
//
// It drives the DEV copy (never the app you are sitting in): it seeds that profile's
// desk.json from the live one - same folders, same scrollback logs - and launches the
// build in out/. Nothing about the live app's own desk is touched.
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { profileData } from './dev-profile.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const num = (name, dflt) => {
  const i = args.indexOf(name)
  return i < 0 ? dflt : Number(args[i + 1])
}
const PANES = num('--panes', 8)
const STAGGER = num('--stagger', -1)
const PORT = num('--port', Number(process.env.PF_PORT ?? 9333))
const RUN_MS = num('--for', 45000)

const LIVE = profileData('')
const DEV = profileData('dev')

const deskFile = join(LIVE, 'desk.json')
if (!existsSync(deskFile)) {
  console.error(`no live desk at ${deskFile} - open some panes in the real app first`)
  process.exit(2)
}
const live = JSON.parse(readFileSync(deskFile, 'utf8'))
// The saved resumeId is dropped on purpose: two CLIs appending to one transcript is a
// real conversation mangled for a measurement. The pane still replays its old screen,
// which is the half this script is timing.
const specs = live.specs.slice(0, PANES).map((s) => ({ ...s, resumeId: undefined, resume: false }))
mkdirSync(join(DEV, 'history'), { recursive: true })
for (const s of specs)
  for (const ext of ['.log', '.json']) {
    const from = join(LIVE, 'history', (s.scrollbackId ?? '') + ext)
    if (s.scrollbackId && existsSync(from)) copyFileSync(from, join(DEV, 'history', s.scrollbackId + ext))
  }
// `update` is the one reason that restores without asking, which is the case being timed.
writeFileSync(join(DEV, 'desk.json'), JSON.stringify({ specs, at: Date.now(), clean: true, reason: 'update' }, null, 2))
console.log(`seeded ${specs.length} panes into the dev profile`)

if (!existsSync(join(root, 'out', 'renderer', 'index.html'))) {
  console.error('no build in out/ - run `npm run build` first (a stale build measures the wrong code)')
  process.exit(2)
}

// A dev copy still holding the profile's single-instance lock makes the new launch exit
// with no window, which reads exactly like "the app did not start". Wait for it to be gone.
spawnSync('node', [join(root, 'scripts/try.mjs'), '--close'], { stdio: 'ignore' })
for (let i = 0; i < 30; i++) {
  const r = spawnSync('pgrep', ['-f', 'PaneForge[^/]*/node_modules/electron'], { encoding: 'utf8' })
  if (!r.stdout.trim()) break
  await new Promise((r) => setTimeout(r, 500))
}

const electron = join(root, 'node_modules/electron/dist', process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron.exe')
const t0 = Date.now()
const ms = () => Date.now() - t0
const env = { ...process.env, PANEFORGE_PROFILE: 'dev' }
if (STAGGER >= 0) env.PF_RESTORE_STAGGER_MS = String(STAGGER)
const child = spawn(electron, ['.', '--minimized', `--remote-debugging-port=${PORT}`], { cwd: root, env })
const mainLog = []
for (const s of [child.stdout, child.stderr]) {
  let buf = ''
  s.on('data', (d) => {
    buf += d
    const parts = buf.split('\n')
    buf = parts.pop()
    for (const line of parts) if (!/caffeinate user activity/.test(line)) mainLog.push(`${String(ms()).padStart(6)}ms ${line}`)
  })
}

async function findPage() {
  for (let i = 0; i < 400; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && !(t.url ?? '').includes('shelf'))
      if (p) return p
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`no debuggable window on ${PORT}`)
}
const page = await findPage()
const pageAt = ms()
const ws = new WebSocket(page.webSocketDebuggerUrl)
const pending = new Map()
let seq = 0
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  const p = pending.get(m.id)
  if (!p) return
  pending.delete(m.id)
  m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result)
})
const send = (method, params) => {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((res, rej) => pending.set(id, { res, rej }))
}
await new Promise((r) => ws.addEventListener('open', r, { once: true }))

// Read every pane's terminal, not the DOM: a pane's text is in xterm's buffer.
// `mark` is the dim caption restoredTail puts between the old screen and the new
// process, so anything below it is this launch's own output.
const EXPR = `(() => {
  const pf = window.__pf || {}
  const line = (t, y) => { const l = t.buffer.active.getLine(y); return l ? l.translateToString(true) : '' }
  return Object.keys(pf).map((id) => {
    const t = pf[id].term
    const len = t.buffer.active.length
    let markAt = -1
    for (let y = len - 1; y >= 0 && y > len - 4000; y--) if (line(t, y).includes('above: this pane before the restart')) { markAt = y; break }
    let tail = ''
    for (let y = Math.max(0, len - 25); y < len; y++) tail += line(t, y) + '\\n'
    return { id, rows: len, cols: t.cols, live: markAt < 0 ? -1 : len - markAt - 1, tail }
  })
})()`

const first = new Map()
const stamp = (map, id, at) => { if (!map.has(id)) map.set(id, at) }
const mounted = new Map()
const printed = new Map()
const composer = new Map()
const COMPOSER = /for shortcuts|Try "|esc to interrupt|\? for/
const until = Date.now() + RUN_MS
while (Date.now() < until) {
  try {
    const r = await send('Runtime.evaluate', { expression: EXPR, returnByValue: true, awaitPromise: true })
    for (const p of r.result?.value ?? []) {
      stamp(mounted, p.id, ms())
      if (p.live > 0) stamp(printed, p.id, ms())
      if (COMPOSER.test(p.tail)) stamp(composer, p.id, ms())
    }
    if (composer.size >= specs.length) break
  } catch {
    /* the window is busy or gone; keep asking */
  }
  await new Promise((r) => setTimeout(r, 250))
}

const ids = [...mounted.keys()]
console.log(`\nwindow debuggable at ${pageAt}ms, ${ids.length} panes`)
console.log('pane                 mounted   printed  composer')
for (const id of ids)
  console.log(
    id.padEnd(18),
    String(mounted.get(id) ?? '-').padStart(8),
    String(printed.get(id) ?? '-').padStart(9),
    String(composer.get(id) ?? '-').padStart(9)
  )
const done = [...composer.values()].sort((a, b) => a - b)
console.log(
  `\npanes=${specs.length} stagger=${STAGGER < 0 ? 'default' : STAGGER}  ` +
    `composer: median ${done[Math.floor(done.length / 2)] ?? '-'}ms  last ${done[done.length - 1] ?? '-'}ms  (${done.length}/${specs.length} reached one)`
)
console.log('\n--- main process')
for (const l of mainLog) console.log(l)
process.exit(0)
