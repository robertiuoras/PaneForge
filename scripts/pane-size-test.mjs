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

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

const req = createRequire(join(work, 'x.cjs'))
const { SessionManager } = req('./sessions.bundle.cjs')

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

// ---- 6. an exited pane is not resized ---------------------------------------------
const before = sizes.length
live.meta.status = 'exited'
manager.resize(id, 80, 24)
manager.returnSizes()
ok(sizes.length === before, 'nothing is pushed at a pty that has exited', String(sizes.length - before))

rmSync(work, { recursive: true, force: true })

console.log(fail.length ? `\n${fail.length} FAILED` : '\nall good')
process.exit(fail.length ? 1 : 0)
