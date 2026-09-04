// The tour's LOOK check - the half no node suite can answer, judged with no window.
// See src/shared/lookCheck.ts.
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { lookVerdict, MIN_SPOT } = await import(pathToFileURL(join(root, 'src/shared/lookCheck.ts')).href)

let failed = 0
const ok = (what, cond) => {
  if (cond) console.log('ok    ' + what)
  else {
    failed++
    console.log('FAIL  ' + what)
  }
}
const win = { width: 960, height: 1080 }
const at = (width, height, x = 10, y = 10) => ({ width, height, x, y })

console.log('a ring that covers the window is not pointing at anything')
{
  // The real numbers: `.pane` measured 618x1050 in a 960x1080 window and read as a
  // glowing line down the left edge.
  const v = lookVerdict({ spot: '.pane', open: 'pane' }, { spot: at(618, 1050, 342, 0), surfaceOnScreen: true, win })
  ok('it fails', !v.ok)
  ok('and says the percentage it covers', /6[0-9]% of the window/.test(v.says))
  const good = lookVerdict({ spot: '.pane-title', open: 'pane' }, { spot: at(616, 47), surfaceOnScreen: true, win })
  ok('a header row passes', good.ok)
  ok('and says the size it landed on', /616x47/.test(good.says))
}

console.log('a ring on nothing, and a surface that never opened')
{
  ok('nothing matched is a failure', !lookVerdict({ spot: '.gone', open: 'none' }, { spot: null, surfaceOnScreen: null, win }).ok)
  const shut = lookVerdict({ spot: '.dialog', open: 'newSession' }, { spot: null, surfaceOnScreen: false, win })
  ok('a surface that did not open fails first', !shut.ok && /did not open/.test(shut.says))
  ok('a speck is too small to be pointed at', !lookVerdict({ spot: '.x', open: 'none' }, { spot: at(MIN_SPOT - 1, 20), surfaceOnScreen: null, win }).ok)
  ok('off the edge of the window fails', !lookVerdict({ spot: '.x', open: 'none' }, { spot: at(40, 40, 2000, 10), surfaceOnScreen: null, win }).ok)
}

console.log('a step with nothing to point at is not a failure')
{
  const none = lookVerdict({ open: 'none' }, { spot: null, surfaceOnScreen: null, win })
  ok('it passes', none.ok && /Nothing to look at/.test(none.says))
  const open = lookVerdict({ open: 'settings' }, { spot: null, surfaceOnScreen: true, win })
  ok('a surface with no ring still reports the screen', open.ok && /is open/.test(open.says))
}

console.log('a pane step also proves the pane is RUNNING, not just drawn')
{
  const dead = lookVerdict(
    { spot: '.pane-title', open: 'pane' },
    { spot: at(616, 47), surfaceOnScreen: true, live: false, win }
  )
  ok('a pane with nothing running fails', !dead.ok && /nothing is running in it/.test(dead.says))
  const alive = lookVerdict(
    { spot: '.pane-title', open: 'pane' },
    { spot: at(616, 47), surfaceOnScreen: true, live: true, win }
  )
  ok('a live pane passes and says so', alive.ok && /live pane behind it/.test(alive.says))
  const other = lookVerdict({ spot: '.dialog-head', open: 'settings' }, { spot: at(300, 40), surfaceOnScreen: true, win })
  ok('a step that opens no pane says nothing about one', other.ok && !/pane/.test(other.says))
}

console.log(failed ? `\n${failed} failed` : '\nlook: all good')
process.exit(failed ? 1 : 0)
