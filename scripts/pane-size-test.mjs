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

// ---- 5. an exited pane is not resized ---------------------------------------------
const before = sizes.length
live.meta.status = 'exited'
manager.resize(id, 80, 24)
manager.returnSizes()
ok(sizes.length === before, 'nothing is pushed at a pty that has exited', String(sizes.length - before))

rmSync(work, { recursive: true, force: true })

console.log(fail.length ? `\n${fail.length} FAILED` : '\nall good')
process.exit(fail.length ? 1 : 0)
