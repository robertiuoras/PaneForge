// A mirrored pane repairs its own torn frame.
//
// A mirror shows the far desk's bytes, and those bytes were painted for the FAR desk's
// grid. Land them in a narrower grid here and every absolute column the far CLI printed is
// clamped, which draws rows over the top of each other - the picture Robert sent on
// 2026-09-17 ("remote view of pc session always looks broken and display should be fixed
// itself at all times"). The far pane looks perfect over there, so nothing over there ever
// asks for a repaint.
//
// A SOURCE test, like `quiet-state-test.mjs`: both faults are a single `if` that reads as
// obviously correct, in a component no headless suite mounts cheaply. `npm run
// test:restorefix` and `npm run test:panegrid` cover the repair itself in a real window;
// nothing but this file can stop the two mirror bails coming back.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(root, 'src/renderer/src/components/TerminalPane.tsx'), 'utf8')
let failed = 0
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`)
  if (!ok) failed++
}

// 1. The one restore repair is not thrown away on a mirror.
const restore = src.slice(src.indexOf('const runRestoreFix'), src.indexOf('const runRestoreFix') + 1400)
check(restore.length > 200, 'runRestoreFix is still where this test looks for it')
check(
  /if \(!autoFixRef\.current\) \{/.test(restore),
  'the restore repair is refused for autoFixUi alone'
)
check(
  !/!autoFixRef\.current \|\| mirrorRef\.current/.test(restore),
  '...and never because the pane is a mirror'
)
// The repair itself has to keep reaching the far agent, which is the only thing that can
// repaint a frame this window did not print.
check(/api\.redraw\(sessionId\)/.test(src), 'the repair still asks the far agent to redraw')

// 2. A resize repairs a mirror when the WIDTH moved, and only then. A rows-only change is
//    the far desk resizing, and it has already asked its own agent to repaint.
check(
  /if \(mirrorRef\.current && !rewrapped\) return/.test(src),
  'a resize repair on a mirror is refused only when the width did not change'
)
// The bail sits in the resize settle, which is the only place in this file that may turn
// a mirror away from a REPAINT. (`checkBusy` refuses a mirror too, and rightly: the far
// window is already judging that frame.)
const settle = src.slice(src.indexOf('const rewrapped = t.cols !== wasCols'), src.indexOf('ro.observe(host.current)'))
check(
  !/if \(mirrorRef\.current\) return/.test(settle),
  '...and never refused outright'
)
check(
  src.indexOf('const rewrapped = t.cols !== wasCols') < src.indexOf('if (mirrorRef.current && !rewrapped) return'),
  'and the width reading is taken before it is used'
)

// 3. A remote snapshot stays covered until xterm has parsed the complete replacement.
const reset = src.slice(src.indexOf('const offReset'), src.indexOf('const writeData'))
check(/if \(mirrorRef\.current\) setBlank\(true\)/.test(reset), 'a mirror reset covers the old frame before replacement')
check(!/if \(snapshot\) setBlank\(false\)/.test(reset), 'the cover is never dropped before xterm parses the snapshot')
check(/if \(snapshot && !awaitingInitialReplay\) setBlank\(false\)/.test(reset), 'the complete snapshot is revealed only from the write callback')

console.log(failed ? `mirror repair: ${failed} FAILED` : 'mirror repair: 10 checks passed')
process.exit(failed ? 1 : 0)
