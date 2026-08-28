// snapPlan(): the live app and the test copy take a half of the EXTERNAL screen each.
//
// The load-bearing half is the refusals. A snap that fires on the laptop alone, or on the
// built-in panel of a two-screen desk, or on a screen too narrow to hold two windows over
// their own minWidth, is the app throwing somebody's window across the desk for nothing.

import { snapPlan, MIN_HALF } from '../src/shared/deskSnap.ts'

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` - ${detail}`}`)
  if (!ok) failures++
}

const builtin = { id: 1, internal: true, workArea: { x: 0, y: 25, width: 1512, height: 945 } }
const ext = { id: 2, internal: false, workArea: { x: 1512, y: 0, width: 1920, height: 1055 } }

// ---------------------------------------------------------------- the two halves

{
  const live = snapPlan([builtin, ext], '')
  const dev = snapPlan([builtin, ext], 'dev')
  check('live app takes the left half', live?.side === 'left', JSON.stringify(live))
  check('test copy takes the right half', dev?.side === 'right', JSON.stringify(dev))
  check(
    'the live half starts at the external screen origin',
    live?.bounds.x === 1512 && live?.bounds.y === 0,
    JSON.stringify(live?.bounds)
  )
  check(
    'the two halves meet and do not overlap',
    live.bounds.x + live.bounds.width === dev.bounds.x,
    `${live.bounds.x + live.bounds.width} vs ${dev.bounds.x}`
  )
  check(
    'the right half ends at the screen edge',
    dev.bounds.x + dev.bounds.width === 1512 + 1920,
    String(dev.bounds.x + dev.bounds.width)
  )
  check('both are full screen height', live.bounds.height === 1055 && dev.bounds.height === 1055)
  check('neither is narrower than the window minimum', Math.min(live.bounds.width, dev.bounds.width) >= 900)
}

// ---------------------------------------------------------------- the refusals

check('the laptop on its own is left alone', snapPlan([builtin], '') === null)
check('the laptop on its own is left alone for the test copy', snapPlan([builtin], 'dev') === null)
check(
  'two built-in screens is not a desk with an external one',
  snapPlan([builtin, { ...builtin, id: 3 }], '') === null
)
check(
  'a screen too narrow to halve is refused',
  snapPlan([builtin, { ...ext, workArea: { ...ext.workArea, width: MIN_HALF * 2 - 2 } }], '') === null
)
check(
  'exactly twice the minimum is still offered',
  snapPlan([builtin, { ...ext, workArea: { ...ext.workArea, width: MIN_HALF * 2 } }], '')?.bounds
    .width === MIN_HALF
)

// ---------------------------------------------------------------- two externals

{
  const small = { id: 4, internal: false, workArea: { x: -1080, y: 0, width: 1080, height: 1920 } }
  const plan = snapPlan([builtin, small, ext], '')
  check('the widest external wins', plan?.bounds.x === 1512, JSON.stringify(plan?.bounds))
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
