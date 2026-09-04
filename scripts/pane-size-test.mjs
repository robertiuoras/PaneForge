// Who owns a pane's shape when two screens are drawing it.
//
// A pane is drawn by the desk window AND, when the app is serving one, by a phone. Both
// fit their own screen and both tell the pty about it, so whoever spoke last won: a phone
// that opened a pane left the pty 50 columns wide and the desk carried on drawing its
// 157-column pane with every line wrapped a third of the way across. Nothing ever gave it
// back. Measured on 2026-08-11, minutes after the phone had been closed: desk terminal
// 157x57, pty 50x50. The report was "the pane is broken, half split in terminal".
//
// So the desk OWNS the size and a phone BORROWS it. Everything below is that sentence:
// a borrowed resize bends the pty and leaves the desk's own size remembered, returning it
// puts the pty back, and a desk resize takes ownership so the phone's number can never
// come back afterwards. The last case is the one that would rot quietly - a phone that
// borrowed hours ago must not snap a window the user has since resized.
//
//   node scripts/pane-size-test.mjs

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'pf-pane-size-'))
mkdirSync(join(work, 'userData'), { recursive: true })

writeFileSync(
  join(work, 'electron-stub.cjs'),
  `const p=require('node:path')
module.exports={app:{isPackaged:true,getVersion:()=>'1.0.0',getPath:()=>p.join(__dirname,'userData')},
  BrowserWindow:{getAllWindows:()=>[]},shell:{openPath:()=>{}},dialog:{}}
`
)

// A pty that only remembers what it was told. This test is about the bookkeeping above
// the pty - who owns the shape - and a real one would need a real shell, a real window
// and 25 seconds; `smoke` already covers the pty layer itself.
writeFileSync(
  join(work, 'pty-stub.cjs'),
  `const off={dispose(){}}
module.exports={spawn:(file,args,opts)=>({
  pid: 4242, file, args,
  cols: opts.cols, rows: opts.rows,
  resizes: [],
  onData(){return off}, onExit(){return off}, write(){}, kill(){},
  resize(c,r){this.cols=c;this.rows=r;this.resizes.push(c+'x'+r)}
})}
`
)

buildSync({
  absWorkingDir: root,
  entryPoints: ['src/main/sessions.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: join(work, 'sessions.bundle.cjs'),
  alias: {
    electron: join(work, 'electron-stub.cjs'),
    '@lydell/node-pty': join(work, 'pty-stub.cjs')
  },
  logLevel: 'silent'
})

// The one piece of arithmetic this suite reads directly: whether any borrow is a screen
// with a person at it. Compiled the same way, so the test holds the shipped file.
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/paneSize.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: join(work, 'paneSize.bundle.cjs'),
  logLevel: 'silent'
})

const req = createRequire(join(work, 'x.cjs'))
const { SessionManager } = req('./sessions.bundle.cjs')
const { watchedBorrow } = req('./paneSize.bundle.cjs')

const fail = []
const ok = (c, n, detail) => {
  console.log((c ? 'ok   ' : 'FAIL ') + n)
  if (!c) {
    if (detail !== undefined) console.log('     ', detail)
    fail.push(n)
  }
}

const manager = new SessionManager()
const meta = manager.start({ cwd: root, agent: 'shell' })
const id = meta.id
const live = manager.sessions.get(id)
ok(Boolean(live), 'a session started')
const sizes = live.proc.resizes

const shape = () => `${live.cols}x${live.rows}`

// ---- 1. the desk fits its window ------------------------------------------------
manager.resize(id, 157, 57)
ok(shape() === '157x57', 'a desk resize sets the pty', shape())
ok(live.deskCols === 157 && live.deskRows === 57, 'and is remembered as the desk size')
ok(live.borrowed !== true, 'and owes nothing back')

// ---- 2. a phone opens the same pane ---------------------------------------------
manager.resize(id, 50, 49, true)
ok(shape() === '50x49', 'a phone bends the pty to its own screen', shape())
ok(live.deskCols === 157 && live.deskRows === 57, 'without forgetting the desk size')
ok(live.borrowed === true, 'and is on record as owing it back')

// ---- 3. the phone looks away -----------------------------------------------------
manager.returnSizes()
ok(shape() === '157x57', 'returning gives the desk its shape back', shape())
ok(live.borrowed !== true, 'and clears the debt')
manager.returnSizes()
ok(shape() === '157x57', 'returning twice changes nothing', shape())

// ---- 4. a desk resize while the phone is still holding it -------------------------
// It is REMEMBERED, not obeyed - and the older rule ("the desk takes ownership back on
// the spot") is what made an agent's output unreadable on a phone. The desk does not only
// resize when a window is dragged: showing a pane, toggling the grid and the window's own
// layout all refit and land here, and each one snapped the pty back to 157 columns under
// a phone still drawing 50. A CLI repaints by counting rows in the width it believes it
// has, so every "thinking" frame then landed under the last one instead of over it.
manager.resize(id, 50, 49, true)
manager.resize(id, 100, 40)
ok(shape() === '50x49', 'a desk resize does not snap the pty out from under a phone', shape())
ok(live.borrowed === true, 'the phone still holds it')
ok(live.deskCols === 100 && live.deskRows === 40, 'and the desk size is what was remembered')
// ...and the reason that rule existed still holds: the number the desk last chose is the
// one it gets back, never the stale one from before it was resized.
manager.returnSizes()
ok(shape() === '100x40', 'a return gives back what the desk chose last', shape())
ok(live.borrowed !== true, 'and clears the debt')

// ---- 5. TWO screens borrowing at once ---------------------------------------------
//
// The bug this was written for, 2026-08-23: "the remote window keeps changing sizes". A
// borrow was one flag and one set of numbers, so a phone and a mirror - or two paired
// devices - each fitted their own window, each wrote the pty, and the pty flipped between
// their two grids for as long as both were open, with the CLI redrawing its whole frame
// every round. Picking a winner is not the fix either: a viewer sent a grid wider than its
// window draws a screen cut off at the edge. They are lent the SMALLEST grid asked for,
// which every one of them can draw.
manager.resize(id, 157, 57)
manager.resize(id, 120, 40, true, 'mirror-a')
ok(shape() === '120x40', 'one borrower gets what it asked for', shape())
manager.resize(id, 90, 50, true, 'phone')
ok(shape() === '90x40', 'a second borrower narrows it to what BOTH can draw', shape())
{
  const n = sizes.length
  manager.resize(id, 120, 40, true, 'mirror-a')
  ok(sizes.length === n, 'and the first one re-stating its size costs the CLI nothing', String(sizes.length - n))
}
manager.resize(id, 200, 60, true, 'mirror-a')
ok(shape() === '90x50', 'a borrower growing hands the floor to the other one', shape())
manager.returnSize(id, 'phone')
ok(shape() === '200x60', 'one screen looking away leaves the other holding the pane', shape())
ok(live.borrowed === true, 'and the pane is still borrowed')
manager.returnSize(id, 'mirror-a')
ok(shape() === '157x57', 'the last one lets go and the desk has its shape back', shape())
ok(live.borrowed !== true, 'and owes nothing')

// A phone looking away may not take a mirror's borrow with it - that is what `returnSizes`
// did before it could be told who was asking.
manager.resize(id, 100, 30, true, 'mirror-a')
manager.resize(id, 60, 20, true, 'phone')
manager.returnSizes('phone')
ok(shape() === '100x30', "the phone leaving does not end the mirror's borrow", shape())
ok(live.borrowed === true, 'which is still on record')
// ...and case 4's rule is untouched by any of it: a desk resize arriving while somebody is
// still holding the pane is REMEMBERED, never obeyed, and is what they get back.
manager.resize(id, 157, 57)
ok(shape() === '100x30', 'a desk resize under a live borrow still does not snap the pty', shape())
manager.returnSizes()
ok(shape() === '157x57', 'and the last thing the desk chose is what it gets back', shape())
ok(live.borrowed !== true, 'with every borrow cleared')

// ---- 5b. THREE screens, and one of them leaving --------------------------------------
// The bug two borrowers cannot show. `smallestBorrow` mins each axis SEPARATELY, so the
// grid it returns is regularly one NOBODY asked for - and `returnSize` used to hand those
// numbers back into `resize()` under the first surviving key, overwriting that viewer's
// real request. With two borrowers the survivor IS the smallest, so the overwrite is a
// no-op and the old code passed. With three it is permanent: every later smallest is then
// computed from a corrupted entry.
manager.returnSizes()
manager.resize(id, 200, 60, true, 'mirror-a')
manager.resize(id, 100, 30, true, 'phone')
manager.resize(id, 150, 25, true, 'tv')
ok(shape() === '100x25', 'three screens are lent the floor of all three, per axis', shape())
manager.returnSize(id, 'phone')
ok(shape() === '150x25', 'one leaving re-applies the floor of the rest', shape())
// The load-bearing line: mirror-a asked for 200x60 and must still be on record as asking
// for it. Under the old code it was rewritten to 150x25 by the step above.
manager.returnSize(id, 'tv')
ok(shape() === '200x60', "the last screen left keeps the size IT asked for", shape())
manager.returnSizes()

// ---- 6. a borrow is a LEASE, not a flag -------------------------------------------
// The bug this closes: a phone that locked, backgrounded or walked out of range never
// sends `pty:return`, and behind a tunnel its stream stays nominally open, so nothing
// ever ended the borrow. Measured 2026-08-25 on the live desk: pane s24-mt81jexv at
// 72x33 with `borrowed: true` while the three panes beside it in the same window were
// 159x57 and a person was sitting at it.
manager.resize(id, 159, 57)
manager.resize(id, 72, 33, true, 'phone')
ok(shape() === '72x33', 'a phone still borrows the pane it is drawing', shape())
// A tick from the desk window renews only ITS OWN lease. The phone's is untouched and
// still fresh, so nothing moves yet - the control for the line below.
manager.touchBorrows('window', [id])
ok(shape() === '72x33', "another screen's tick does not end the phone's borrow", shape())
// Wind the phone's lease past its TTL by hand: this is the phone going quiet, which is
// the only signal there ever is.
live.borrows.get('phone').at = Date.now() - 200_000
manager.touchBorrows('window', [id])
ok(shape() === '159x57', 'a borrow whose screen stopped ticking expires and the desk gets it back', shape())
ok(live.meta.borrowed === false, 'and the pane stops being drawn as borrowed', String(live.meta.borrowed))

// ...and a desk resize is the repair anybody would actually reach for, so it has to work.
// This branch used to swallow every desk resize while `borrowed` was set, which made a
// stuck borrow unrecoverable by construction - dragging the window did nothing and the
// pane stayed at phone width until the app was restarted.
manager.resize(id, 100, 40, true, 'phone')
live.borrows.get('phone').at = Date.now() - 200_000
manager.resize(id, 159, 57)
ok(shape() === '159x57', 'a desk resize under a DEAD borrow is obeyed, not remembered', shape())
// The control: under a LIVE borrow it is still only remembered - a phone somebody is
// reading must not be snapped to the desk's grid mid-turn.
manager.resize(id, 100, 40, true, 'phone')
manager.resize(id, 159, 57)
ok(shape() === '100x40', 'and under a live one it is still only remembered', shape())
manager.returnSizes()

// A screen on the far side of the device link holds NO lease - it has no tick of ours to
// renew with, and expiring it would snap the pty out from under somebody still reading.
manager.resize(id, 90, 40, true, 'guest:1/window')
ok(shape() === '90x40', 'a mirror borrows too', shape())
ok(live.borrows.get('guest:1/window').at === 0, 'a mirror is filed with no lease', String(live.borrows.get('guest:1/window').at))
manager.touchBorrows('window', [id])
ok(shape() === '90x40', 'and no clock can take it away - only the link dropping', shape())
manager.returnSizes()

// ---- 6b. a screen with nobody at it is not somebody looking -----------------------
//
// `watched` is what a headless desk reads as "a person is looking at this pane", and it
// refuses both the idle close clock and the sleep clock. A mirror's borrow never expires
// (see the lease above), so one glance from the other desk used to hold a pane open for
// as long as the link was up: measured 2026-09-04, three panes idle on the PC against a
// 5-minute clock with no close, no countdown, and nothing in reclaim.log for hours.
manager.resize(id, 90, 40, true, 'guest:1/window', true, false)
ok(live.borrows.get('guest:1/window').person === false, 'a borrow records that nobody is there')
ok(watchedBorrow(live.borrows.values()) === false, 'and an empty desk is not watching')
manager.resize(id, 90, 40, true, 'guest:1/window')
ok(
  live.borrows.get('guest:1/window').person === false,
  'a repaint that says nothing about a person leaves the answer alone'
)
manager.resize(id, 90, 40, true, 'guest:1/window', true, true)
ok(watchedBorrow(live.borrows.values()) === true, 'somebody arriving is watching again')
manager.resize(id, 100, 40, true, 'phone')
manager.resize(id, 90, 40, true, 'guest:1/window', true, false)
ok(watchedBorrow(live.borrows.values()) === true, 'and one screen with a person is enough')
manager.returnSizes()

// ---- 6b. the owner takes a mirror's borrow back --------------------------------------
//
// A borrow from a paired device holds no lease: `at` is 0, so `dropStale` can never
// expire it and it ends only with the connection or a `detach`. That is right while
// somebody is drawing the pane and wrong for ever afterwards - measured 2026-09-04 on
// this desk's own s43-mtmmi8yy, a taskdriver pane sitting at 107x40 with `borrowed: true`
// because the PC was still attached to it after the pane had been handed back to the Mac.
// Every desk resize was swallowed by the "a phone is still drawing this" branch, so
// dragging the window and pressing Fix both did nothing and the pane painted 107 columns
// wide with a black margin down the right of it until an ssh to the other machine
// detached the mirror.
manager.resize(id, 157, 57)
manager.resize(id, 107, 40, true, 'guest:1/window')
ok(live.cols === 107 && live.borrowed === true, 'a mirror borrows the pane', `${live.cols}x${live.rows}`)
manager.resize(id, 157, 57)
ok(live.cols === 107, 'and a desk resize under it is remembered, not obeyed', String(live.cols))
manager.returnSize(id)
ok(
  live.cols === 157 && live.rows === 57 && live.borrowed === false,
  'until the owner takes it back - what Fix now asks for',
  `${live.cols}x${live.rows} borrowed=${live.borrowed}`
)

// ---- 6c. and that is what is wired to the Fix button ---------------------------------
const src = (f) => readFileSync(join(root, f), 'utf8')
ok(/takePaneSize: \['send', 'pty:take'\]/.test(src('src/shared/surface.ts')), 'pty:take is on the surface')
ok(
  /ipcMain\.on\('pty:take'[\s\S]{0,400}?manager\.returnSize\(id\)/.test(src('src/main/index.ts')),
  'main answers it by taking the pane back'
)
ok(
  /remote\.owns\(id\)\) return[\s\S]{0,80}?manager\.returnSize\(id\)/.test(src('src/main/index.ts')),
  'and refuses it for a pane this desk does not own'
)
ok(
  /noteFix\('redraw'\)[\s\S]{0,600}?api\.takePaneSize\(sessionId\)/.test(
    src('src/renderer/src/components/TerminalPane.tsx')
  ),
  'Fix asks for the size back before it re-renders'
)

// ---- 7. an exited pane is not resized ---------------------------------------------
const before = sizes.length
live.meta.status = 'exited'
manager.resize(id, 80, 24)
manager.returnSizes()
ok(sizes.length === before, 'nothing is pushed at a pty that has exited', String(sizes.length - before))

rmSync(work, { recursive: true, force: true })

console.log(fail.length ? `\n${fail.length} FAILED` : '\nall good')
process.exit(fail.length ? 1 : 0)
