// The states a printing pane writes on every painted frame must not reach React when they
// have not changed.
//
// This is a SOURCE test on purpose: the fault it guards is a `useState` that looks
// perfectly correct - React bails out of the re-render, the desk really does render 17
// times over a 3s run - while the dispatcher itself burns the thread. Measured
// 2026-08-29 over eight shells at full blast, before and after, on the same fresh copy:
//
//   before  keystroke -> frame median 297/49/423ms   requestUpdateLane 18-22%   GC 26-38%
//   after   keystroke -> frame median  40/34/ 34ms   requestUpdateLane absent   GC  4-5%
//
// `scripts/type-profile.mjs --blame yi` is the measurement; nothing in it asserts, so the
// only thing that can keep a `useState` from coming back here is this file.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')
let failed = 0
const check = (ok, what, note = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${note ? ` - ${note}` : ''}`)
  if (!ok) failed++
}

const hook = read('src/renderer/src/quietState.ts')
check(/Object\.is\(v, held\.current\)/.test(hook), 'the hook compares before it dispatches')
check(
  hook.indexOf('return') < hook.indexOf('setValue(v)'),
  'and an equal value returns without touching React'
)
check(
  /typeof next === 'function'/.test(hook),
  'the updater form is evaluated here, against the ref'
)

const pane = read('src/renderer/src/components/TerminalPane.tsx')
// Each of these is written from `onRender` or `onScroll` - once per painted frame and once
// per printed line, in every pane on the desk, whether or not the value moved.
for (const [state, why] of [
  ['geom', 'where the rows are, from onRender'],
  ['selChip', 'the selection chip, from every scroll'],
  ['scrolledUp', 'the follow flag, from every scroll']
])
  check(
    new RegExp(`\\[${state}, set[A-Z]\\w*\\] = useQuietState`).test(pane),
    `${state} is a quiet state`,
    why
  )

console.log(failed ? `\n${failed} failed` : '\nall ok')
process.exit(failed ? 1 : 0)
