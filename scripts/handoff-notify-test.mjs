// A queued handoff must SAY what happened, on screen, not only in the main-process log.
//
// The bug this locks down: `HandoffQueue` reported every outcome through `log()` alone,
// which is `console.info`. The queue is the path a mid-turn move takes - and every move
// asked for from the phone - so it finishes minutes after the button was pressed, with
// the dialog that flashed "it goes as soon as the turn ends" long closed. The pane was
// killed on success and nothing appeared anywhere the person could see it. On the desk
// it left, that is indistinguishable from a session that froze (2026-08-17: a pane was
// handed from the Mac to the PC mid-turn and the Mac was asked "why is it paused?").
//
// Three outcomes, three messages: moved, could not move, gave up waiting. The name has to
// survive the move too - a successful handoff kills the pane, so a title read after the
// promise resolves is gone.

import { buildSync } from 'esbuild'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = mkdtempSync(join(tmpdir(), 'pf-handoff-notify-'))
let failures = 0
let checks = 0

function ok(what, cond, detail = '') {
  checks++
  if (cond) return console.log(`  ok   ${what}`)
  failures++
  console.log(`  FAIL ${what}${detail ? ' - ' + detail : ''}`)
}

const bundle = join(out, 'queue.mjs')
buildSync({
  entryPoints: [join(root, 'src/main/handoffQueue.ts')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent'
})
const { HandoffQueue } = await import(pathToFileURL(bundle).href)

const NOW = 1_700_000_000_000
const CFG = { enabled: true, minIdleMinutes: 5, maxPerSweep: 1, cooldownMinutes: 10, waitMinutes: 30 }

function harness(overrides = {}) {
  const said = []
  const logged = []
  let panes = [{ id: 'p1', title: 'assistant - upwork pricing', status: 'running' }]
  const deps = {
    list: () => panes,
    busy: () => false,
    send: async () => [{ id: 'p1', title: 'assistant - upwork pricing', ok: true, notes: [] }],
    mark: () => {},
    deviceName: () => 'DESKTOP-CMSUCM1',
    config: () => CFG,
    log: (line) => logged.push(line),
    notify: (line) => said.push(line),
    now: () => NOW,
    ...overrides
  }
  return { deps, said, logged, queue: new HandoffQueue(deps), setPanes: (p) => (panes = p) }
}

// 1. The success case - the one that killed the pane and said nothing.
{
  const h = harness()
  h.queue.add('p1', 'dev-pc')
  h.queue.tick()
  await new Promise((r) => setTimeout(r, 20))
  ok('a completed move is said on screen', h.said.length === 1, JSON.stringify(h.said))
  ok('the message names the pane', (h.said[0] ?? '').includes('assistant - upwork pricing'), h.said[0])
  ok('the message names the device it went to', (h.said[0] ?? '').includes('DESKTOP-CMSUCM1'), h.said[0])
}

// 2. The name must be read BEFORE the move: a successful handoff kills the pane, so a
//    title looked up afterwards is already gone and the message would name an id.
{
  const h = harness({
    send: async () => {
      h.setPanes([]) // the pane is killed the moment the far end confirms
      return [{ id: 'p1', ok: true, notes: [] }]
    }
  })
  h.queue.add('p1', 'dev-pc')
  h.queue.tick()
  await new Promise((r) => setTimeout(r, 20))
  ok('the title survives the pane being killed', (h.said[0] ?? '').includes('assistant - upwork pricing'), h.said[0])
}

// 3. A refused move must say WHY, or the pane just sits there looking stuck.
{
  const h = harness({ send: async () => [{ id: 'p1', ok: false, error: 'Receiver has uncommitted work', notes: [] }] })
  h.queue.add('p1', 'dev-pc')
  h.queue.tick()
  await new Promise((r) => setTimeout(r, 20))
  ok('a refused move is said on screen', h.said.length === 1, JSON.stringify(h.said))
  ok('it carries the reason', (h.said[0] ?? '').includes('uncommitted work'), h.said[0])
}

// 4. A thrown transport error is an outcome too, not a swallowed one.
{
  const h = harness({
    send: async () => {
      throw new Error('Push failed, so the code cannot follow')
    }
  })
  h.queue.add('p1', 'dev-pc')
  h.queue.tick()
  await new Promise((r) => setTimeout(r, 20))
  ok('a thrown move failure is said on screen', (h.said[0] ?? '').includes('Push failed'), h.said[0])
}

// 5. Giving up after the wait budget: the pane STAYS, and that has to be visible too -
//    silence here reads as "it moved" when nothing moved.
{
  let clock = NOW
  const h = harness({ busy: () => true, now: () => clock })
  h.queue.add('p1', 'dev-pc')
  clock = NOW + (CFG.waitMinutes + 1) * 60_000
  h.queue.tick()
  ok('giving up is said on screen', h.said.length === 1, JSON.stringify(h.said))
  ok('it says the pane stayed', /stays here/.test(h.said[0] ?? ''), h.said[0])
}

// 6. notify is optional: a caller that never wired it must not crash the queue.
{
  const h = harness({ notify: undefined })
  h.queue.add('p1', 'dev-pc')
  h.queue.tick()
  await new Promise((r) => setTimeout(r, 20))
  ok('a queue with no notify still logs and does not throw', h.logged.length >= 1)
}

// 7. Waiting is not moving. Three panes sat under a chip reading `moving` on 2026-08-23
//    while every one of them was queued behind its own live turn, and it read as a broken
//    handoff. The mark carries WHEN it was queued, and drops that the moment it goes.
{
  const marks = []
  const h = harness({
    busy: () => true, // mid-turn: it can only wait
    mark: (id, on, queuedAt) => marks.push({ id, on, queuedAt })
  })
  h.queue.add('p1', 'dev-pc')
  ok('a queued pane is marked with the time it started waiting', marks[0]?.on === true && marks[0]?.queuedAt === NOW, JSON.stringify(marks[0]))
  h.queue.tick()
  ok('...and stays waiting while the turn runs', marks.length === 1, JSON.stringify(marks))

  const going = []
  const g = harness({ mark: (id, on, queuedAt) => going.push({ id, on, queuedAt }) })
  g.queue.add('p1', 'dev-pc')
  g.queue.tick()
  await new Promise((r) => setTimeout(r, 20))
  ok('the move itself re-marks the pane with no wait time', going.some((m) => m.on === true && m.queuedAt === undefined), JSON.stringify(going))
  ok('...and the mark comes off at the end', going.at(-1)?.on === false, JSON.stringify(going.at(-1)))
}

// 8. Changing your mind. `drop` is what the window calls to take a pane off the queue, and
//    its ANSWER is the whole point: a move already in flight has left the map, so a `true`
//    there would tell somebody their pane was staying while it left.
{
  const marks = []
  const h = harness({ busy: () => true, mark: (id, on, queuedAt) => marks.push({ id, on, queuedAt }) })
  h.queue.add('p1', 'dev-pc')
  ok('dropping a queued pane says it did', h.queue.drop('p1') === true)
  ok('...and the mark comes off, so nothing still reads as moving', marks.at(-1)?.on === false, JSON.stringify(marks.at(-1)))
  ok('...and it is no longer waiting', h.queue.pending().length === 0)
  ok('dropping it twice does NOT claim a second success', h.queue.drop('p1') === false)
  ok('dropping a pane that was never queued says so', h.queue.drop('never') === false)
}

// 9. ...and the window has to actually call it. `remote:handoffCancel` shipped with the
//    queue and nothing in the renderer ever invoked it, so the only way off the list was a
//    script - which is how two panes sat under a `waiting` chip for 13 and 18 minutes.
{
  const app = readFileSync(join(root, 'src/renderer/src/App.tsx'), 'utf8')
  ok('the renderer calls cancelHandoff', /api\s*\n?\s*\.cancelHandoff\(/.test(app) || /api\.cancelHandoff\(/.test(app))
  const at = app.indexOf('waiting <Elapsed')
  const opens = at > 0 ? app.slice(Math.max(0, at - 800), at) : ''
  ok('the waiting chip is a button, not a label', at > 0 && opens.lastIndexOf('<button') > opens.lastIndexOf('<span'), 'the chip that reports the wait must be the control that ends it')
  ok('the chip presses stopMove', /stopMove\(s\)/.test(app))
  ok('the context menu and the phone sheet both offer it', (app.match(/'stop-move'/g) ?? []).length >= 2)
  const main = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
  ok('the channel returns the queue answer rather than a bare true', /handoffCancel'[^\n]*handoffQueue\.drop\(String\(id\)\)\)/.test(main), 'remote:handoffCancel')
}

rmSync(out, { recursive: true, force: true })
console.log(`handoff-notify: ${checks} checks, ${failures} failed`)
process.exit(failures ? 1 : 0)
