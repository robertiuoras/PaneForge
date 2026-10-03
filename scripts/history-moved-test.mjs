// A chat sent to another computer must not read as a chat that finished.
//
// 2026-10-03: s37 "Plugin recommendations for workflow" was moved to the PC (handoff.log
// "running there after 61990 ms - resume confirmed", reclaim.log `moved`). The copy here
// closed, History drew it red `closed`, and Robert took the chat for finished while it sat
// open on the PC as card 12. The row now carries where it went (`movedTo`, written by
// `recordMoved` after the close) and `movedView` says `open on <computer>` while that
// computer's own pane list still has the chat.
//
//   node scripts/history-moved-test.mjs

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'pf-history-moved-test-'))
const userData = join(work, 'userData')
mkdirSync(join(userData, 'history'), { recursive: true })

const fail = []
const ok = (c, n, detail) => {
  console.log((c ? 'ok   ' : 'FAIL ') + n)
  if (!c) {
    if (detail !== undefined) console.log('     ', detail)
    fail.push(n)
  }
}
const read = (p) => readFileSync(join(root, p), 'utf8')

// --- the row: written on the move, dropped when the id opens here again -------------
writeFileSync(
  join(work, 'electron-stub.cjs'),
  `const p=require('node:path')
module.exports={app:{isPackaged:true,getVersion:()=>'1.0.0',getPath:()=>p.join(__dirname,'userData')}}
`
)
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/main/history.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: join(work, 'history.bundle.cjs'),
  alias: { electron: join(work, 'electron-stub.cjs') }
})
const h = createRequire(join(work, 'x.cjs'))('./history.bundle.cjs')
const has = typeof h.recordMoved === 'function'
ok(has, 'history.ts exports recordMoved')

const here = join(work, 'a-folder')
mkdirSync(here, { recursive: true })
const session = (id) => ({ id, title: 'assistant', cwd: here, agent: 'claude', createdAt: Date.now() - 60_000, cols: 120, rows: 40 })
const row = (id) => h.list().find((r) => r.id === id)
const to = { device: 'e38080cc645760c5', name: 'DESKTOP-CMSUCM1', pane: 's29-muroccsh' }

if (has) {
  h.recordStart(session('s37-moved'))
  await h.recordMoved('s37-moved', to)
  ok(row('s37-moved')?.movedTo === undefined, 'a row still open is never stamped as moved (a refused close leaves no mark)', JSON.stringify(row('s37-moved')))

  h.recordEnd('s37-moved', '196d41b3-8c9d-487b-913a-c1e8c1c9c59c')
  await h.recordMoved('s37-moved', to)
  const moved = row('s37-moved')
  ok(JSON.stringify(moved?.movedTo) === JSON.stringify(to), 'the closed copy records where it went', JSON.stringify(moved))
  ok(typeof moved?.endedAt === 'number' && moved.resumeId === '196d41b3-8c9d-487b-913a-c1e8c1c9c59c',
    'and keeps its end time and conversation', JSON.stringify(moved))
  // The killed process exits after the move is written and `onExit` stamps the end again
  // (`main/sessions.ts`): that second stamp is the same close, not a new one.
  h.recordEnd('s37-moved')
  ok(JSON.stringify(row('s37-moved')?.movedTo) === JSON.stringify(to), 'the process exit after the move keeps the mark', JSON.stringify(row('s37-moved')))

  // The same id coming back and closing another way (restore, then a person closing it)
  // is a close, not a move.
  h.recordStart(session('s37-moved'))
  ok(row('s37-moved')?.movedTo === undefined, 'a restart of that pane clears the mark', JSON.stringify(row('s37-moved')))
  h.recordEnd('s37-moved')
  ok(row('s37-moved')?.movedTo === undefined, 'a plain close after that restart has no mark', JSON.stringify(row('s37-moved')))

  await h.recordMoved('no-such-row', to)
  ok(true, 'a pane with no History row is not an error')
}

// --- what the row says ---------------------------------------------------------------
const view = join(work, 'historyMoved.mjs')
let movedView
try {
  buildSync({ absWorkingDir: root, entryPoints: ['src/shared/historyMoved.ts'], bundle: true, format: 'esm', platform: 'node', outfile: view, logLevel: 'silent' })
  movedView = (await import(pathToFileURL(view).href)).movedView
} catch {
  /* reported below, as a failure rather than a crash */
}
ok(typeof movedView === 'function', 'shared/historyMoved.ts exports movedView')

if (typeof movedView === 'function') {
  const NOW = Date.now()
  const peer = (over = {}) => ({ id: to.device, name: 'DESKTOP-CMSUCM1', status: 'online', panes: [{ id: 's29-muroccsh' }, { id: 's11-muqpnmcl' }], ...over })
  // The shape of the real file: s37-murnx1zj.json carried no `movedTo`.
  const real = { id: 's37-murnx1zj', endedAt: NOW, resumeId: '196d41b3-8c9d-487b-913a-c1e8c1c9c59c' }
  const sent = { ...real, movedTo: to }

  ok(movedView(real, [peer()]) === null, 'a row with no mark is an ordinary row')
  ok(movedView({ movedTo: to }, [peer()]) === null, 'a row that has not ended is left to the open-since reading')
  const open = movedView(sent, [peer()])
  ok(open?.open === true && open.name === 'DESKTOP-CMSUCM1', 'the computer is connected and still has the chat: open on it', JSON.stringify(open))
  ok(movedView(sent, [peer({ name: 'The PC' })])?.name === 'The PC', "the name is what the computer calls itself now")
  const off = movedView(sent, [peer({ status: 'off', panes: [] })])
  ok(off?.open === false && off.name === 'DESKTOP-CMSUCM1', 'the computer is not connected: moved there, last known, never closed', JSON.stringify(off))
  ok(movedView(sent, undefined)?.open === false, 'peers not loaded yet: moved there, never closed')
  ok(movedView(sent, [])?.open === false, 'a computer this one no longer knows: moved there, never closed')
  ok(movedView(sent, [peer({ panes: [] })])?.open === false, 'connected but its list has not arrived: not proof of closed')
  ok(movedView(sent, [peer({ panes: [{ id: 's11-muqpnmcl' }] })]) === null, 'connected and the chat is gone from its list: it was closed there, so closed')
  ok(movedView(sent, [peer({ id: 'someone-else' })])?.open === false, 'another computer holding a pane of that id is not it')
}

// --- the wiring, which no helper test can see -----------------------------------------
const handoff = read('src/main/handoff.ts')
const sendKill = handoff.indexOf('deps.kill(pane.id)')
ok(sendKill > 0 && /rememberMove\?\.\(pane\.id, \{ device, name: where, pane: result\.session\.id \}\)/.test(handoff.slice(sendKill, sendKill + 400)),
  'a proven move tells History where it went, right after the copy here closes')
ok(/rememberMove: \(id, to\) => history\.recordMoved\(id, to\)/.test(read('src/main/index.ts')), 'the move wires rememberMove to History')
const dialog = read('src/renderer/src/components/HistoryDialog.tsx')
ok(/movedView\(e, peers\)/.test(dialog) && /\$\{there\.open \? 'open on' : 'moved to'\} \$\{there\.name\}/.test(dialog) && /closed \? 'closed' : 'live'/.test(dialog),
  'History draws a moved row green and names the computer')
ok(/peers=\{remote\?\.peers\}/.test(read('src/renderer/src/App.tsx')), 'the window hands History the computers it knows')

console.log(fail.length ? `\n${fail.length} FAILED` : '\nall passed')
process.exit(fail.length ? 1 : 0)
