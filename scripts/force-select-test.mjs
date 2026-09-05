// A drag that selects nothing, in every pane running an agent, on one of the two machines.
//
// xterm refuses to start a selection while the CLI has mouse reporting on, unless
// `SelectionService.shouldForceSelection` says the event is a forced one. That function
// reads a DIFFERENT key per platform (node_modules/@xterm/xterm/src/browser/services/
// SelectionService.ts): Shift on Windows and Linux, Option on the Mac and only when
// `macOptionClickForcesSelection` is on, which is off by default. The pane stamped Shift
// alone and never set the option, so on the Mac a plain drag over a Codex or Claude Code
// pane selected nothing at all.
//
// The rule is copied into `wouldForce` and checked here against xterm's OWN source, so a
// future xterm that changes it fails this rather than the comment quietly going stale.
//
//   node scripts/force-select-test.mjs

import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-force-select-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const outfile = join(work, 'force.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/forceSelect.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile
})
const { forceKeys, wouldForce } = createRequire(import.meta.url)(outfile)

let checks = 0
const check = (what, ok, detail) => {
  checks++
  assert.ok(ok, `${what}${detail === undefined ? '' : ` — ${detail}`}`)
}

// The rule, read off xterm's own source rather than remembered.
const svc = join(root, 'node_modules/@xterm/xterm/src/browser/services/SelectionService.ts')
if (existsSync(svc)) {
  const src = readFileSync(svc, 'utf8')
  const fn = src.slice(src.indexOf('public shouldForceSelection'))
  const body = fn.slice(0, fn.indexOf('\n  }'))
  check('xterm forces on Option + macOptionClickForcesSelection on a Mac', /isMac[\s\S]*altKey[\s\S]*macOptionClickForcesSelection/.test(body), body.trim().slice(0, 120))
  check('and on Shift everywhere else', /return event\.shiftKey/.test(body))
} else {
  console.log('force select: xterm sources absent, the rule itself is unchecked')
}

const keys = forceKeys()
// The control: what the pane used to stamp. It has to FAIL on the Mac, or this proves nothing.
const shiftOnly = { shiftKey: true, altKey: false }
check('control: Shift alone forces nothing on a Mac', !wouldForce(shiftOnly, true, true))
check('control: which is why a Codex drag there selected nothing', !wouldForce(shiftOnly, true, false))
check('Shift alone was always enough on Windows', wouldForce(shiftOnly, false, false))

const stamped = { shiftKey: keys.shiftKey === true, altKey: keys.altKey === true }
check('the stamp forces a selection on a Mac', wouldForce(stamped, true, true))
check('and on Windows and Linux', wouldForce(stamped, false, false))
check('a plain drag with nothing stamped still reaches the CLI', !wouldForce({ shiftKey: false, altKey: false }, false, false))
check('an unstamped drag reaches the CLI on a Mac too', !wouldForce({ shiftKey: false, altKey: false }, true, true))
check('the Mac half is dead without the option', !wouldForce(stamped, true, false))

// The pane's own two halves: the option, and the order the stamp is registered in.
const pane = readFileSync(join(root, 'src/renderer/src/components/TerminalPane.tsx'), 'utf8')
check('the terminal is built with macOptionClickForcesSelection on', /macOptionClickForcesSelection:\s*true/.test(pane))
const at = (name) => pane.indexOf(`el.addEventListener('mousedown', ${name}, true)`)
check('every mousedown listener is registered', at('placeCursor') > 0 && at('markDown') > 0 && at('onMouseDown') > 0 && at('forceSelectable') > 0)
check('the stamp is registered LAST, so no handler of ours reads the lie', at('forceSelectable') > Math.max(at('placeCursor'), at('markDown'), at('onMouseDown')), `forceSelectable at ${at('forceSelectable')}`)
check('the stamp only runs while the CLI holds the mouse', /forceSelectable = \(e: MouseEvent\): void => \{\s*\n\s*if \(!mouseSelectRef\.current \|\| !mouseGrabbed\(\)\) return/.test(pane))

console.log(`force select: ${checks} checks passed`)
