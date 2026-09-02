// A pane that comes back after a restart comes back with what was on it.
//
// Orca advertises this by name and ours did not have it: `scrollback: 20000` in the
// terminal lives in the RENDERER's memory, so quit, crash or - the one that actually
// happens - update, and every pane reopens blank. `test:restore` is a different promise
// and is easy to mistake for this one: it hands the agent its `--resume`, which brings
// back the CONVERSATION and not one line of the screen.
//
// The bytes were never the missing part. `history.ts` has appended every pane's raw
// output to userData/history/<id>.log all along. What was missing was the id: a restored
// pane is a NEW session, so the desk has to carry `scrollbackId` or nothing joins the two.
//
// Both halves are pinned here, because each is silently useless without the other:
//   - `history.tail` gives back RAW bytes (a stripped tail replays as plain text), cut on
//     a line boundary (a cut inside an escape sequence prints its tail as literal junk).
//   - the manager seeds a started pane's buffer from it, and only when the desk asked.
//
//   node scripts/scrollback-test.mjs

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'pf-scrollback-test-'))
const userData = join(work, 'userData')
const histDir = join(userData, 'history')
mkdirSync(histDir, { recursive: true })

const fail = []
const ok = (c, n, detail) => {
  console.log((c ? 'ok   ' : 'FAIL ') + n)
  if (!c) {
    if (detail !== undefined) console.log('     ', detail)
    fail.push(n)
  }
}

// ------------------------------------------------------------------ stubs and the bundle

writeFileSync(
  join(work, 'electron-stub.cjs'),
  `const p=require('node:path')
module.exports={
  app:{isPackaged:true,getVersion:()=>'1.0.0',getPath:()=>p.join(__dirname,'userData'),getAppPath:()=>${JSON.stringify(root)}},
  BrowserWindow:{getAllWindows:()=>[]},
  ipcMain:{on(){},handle(){}},
  shell:{openPath(){}}
}
`
)

// A pty that never spawns anything. The manager only needs the shape: something to
// listen to, something to write to, something to kill.
writeFileSync(
  join(work, 'pty-stub.cjs'),
  `exports.spawn = () => ({
  pid: 4242,
  onData: () => ({ dispose(){} }),
  onExit: () => ({ dispose(){} }),
  write(){}, resize(){}, kill(){}
})
`
)

const bundle = join(work, 'sessions.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/main/sessions.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: bundle,
  alias: {
    electron: join(work, 'electron-stub.cjs'),
    '@lydell/node-pty': join(work, 'pty-stub.cjs')
  }
})

const require_ = createRequire(join(work, 'x.cjs'))
const { SessionManager } = require_(bundle)

const history = join(work, 'history.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/main/history.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: history,
  alias: { electron: join(work, 'electron-stub.cjs') }
})
const h = require_(history)

// ------------------------------------------------------------------ history.tail itself

const RAW = '\x1b[32mgreen\x1b[0m line one\nline two\n\x1b[1mbold tail\x1b[0m'
writeFileSync(join(histDir, 'old.log'), RAW)

ok(h.tail('old', 1_000) === RAW, 'a whole log under the cap comes back byte for byte', JSON.stringify(h.tail('old', 1_000)))
ok(h.tail('old', 1_000).includes('\x1b[32m'), 'and it is RAW - a stripped tail would replay as plain text')
ok(h.tail('nobody-at-all', 1_000) === '', 'a log that does not exist is empty, not a throw')

const cut = h.tail('old', 20)
ok(cut.length <= 20, 'a log over the cap is cut to it', `${cut.length}`)
ok(!cut.includes('\n') || cut.startsWith('\x1b[1mbold'), 'and the cut lands on a line boundary', JSON.stringify(cut))
ok(RAW.endsWith(cut), 'the tail is the END of the log, not the start', JSON.stringify(cut))

// A cut that would land inside an escape sequence: the byte before the slice point is
// mid-`\x1b[31m`, so a naive slice replays "31mred..." as literal text on line one.
writeFileSync(join(histDir, 'mid.log'), 'first line\n\x1b[31mred text that runs on and on\n')
const midCut = h.tail('mid', 15)
ok(!/^\d+m/.test(midCut), 'a cut inside an escape sequence does not leak its tail as text', JSON.stringify(midCut))

// ------------------------------------------------------------------ and the pane itself

const manager = new SessionManager()
const started = manager.start({ cwd: work, agent: 'claude' })
ok(manager.buffer(started.id) === '', 'a pane nobody asked to restore starts empty', JSON.stringify(manager.buffer(started.id)))

const restored = manager.start({ cwd: work, agent: 'claude', scrollbackId: 'old' })
const back = manager.buffer(restored.id)
ok(back.startsWith(RAW), 'a pane restored from a desk starts with what was on it', JSON.stringify(back.slice(0, 40)))
ok(/above: this pane before the restart/.test(back), 'and says where the old output ends', JSON.stringify(back.slice(-80)))
ok(back.includes('\x1b[0m\r\n\x1b[2m'), 'the mark resets first, so a colour left mid-run does not bleed into it')

// The restored pane's OWN log carries what it was given, so the restart after this one
// (which names THIS id) has something to replay. An asleep pane prints nothing, and its
// log used to hold only the marks.
h.flush()
const chained = manager.start({ cwd: work, agent: 'claude', scrollbackId: restored.id })
ok(manager.buffer(chained.id).startsWith(RAW), 'a pane restored from a restored pane still starts with the original screen', JSON.stringify(manager.buffer(chained.id).slice(0, 40)))
ok(h.colsOf(restored.id) === h.colsOf('old'), 'and the painted width travels with it', String(h.colsOf(restored.id)))

const missing = manager.start({ cwd: work, agent: 'claude', scrollbackId: 'a-pane-whose-log-was-pruned' })
ok(manager.buffer(missing.id) === '', 'a desk naming a transcript that has been pruned restores nothing', JSON.stringify(manager.buffer(missing.id)))

// ------------------------------------------------------------------ the id the desk carries

const specs = manager.snapshot()
ok(specs.length >= 3, 'the desk holds the open panes', `${specs.length}`)
ok(
  specs.every((s) => typeof s.scrollbackId === 'string' && s.scrollbackId),
  'and every one of them carries the id its output is stored under',
  JSON.stringify(specs.map((s) => s.scrollbackId))
)
ok(
  new Set(specs.map((s) => s.scrollbackId)).size === specs.length,
  'one per pane - two panes must not restore the same screen',
  JSON.stringify(specs.map((s) => s.scrollbackId))
)
// The whole point of the field: it is the id of the pane being SAVED, which the restored
// pane will not have. A desk carrying the new id restores nothing, silently, forever.
ok(
  specs.some((s) => s.scrollbackId === restored.id),
  'the id saved is the live session id, the one its log is named after',
  JSON.stringify(specs.map((s) => s.scrollbackId))
)

// ------------------------------------------------------------------ what it may cost

// It inherits history's cap rather than adding a store of its own, so there is nothing
// new to prune - but a pane must not replay more than a pane keeps in memory.
writeFileSync(join(histDir, 'huge.log'), 'x'.repeat(2_000_000))
const huge = manager.start({ cwd: work, agent: 'claude', scrollbackId: 'huge' })
const hugeBack = manager.buffer(huge.id)
ok(
  hugeBack.length < 450_000,
  'a 2 MB transcript replays as the buffer cap, not as 2 MB',
  `${hugeBack.length}`
)

rmSync(work, { recursive: true, force: true })
console.log(fail.length ? `\n${fail.length} failed` : '\nall good')
process.exit(fail.length ? 1 : 0)
