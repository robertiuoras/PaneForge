// The profile reading, pinned. Nothing here needs Electron: `shared/renderCost.ts` is
// arithmetic over a `Profiler.stop` payload, which is why it is a separate file from the
// attaching half in `main/renderCost.ts`.

import { buildSync } from 'esbuild'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = join(mkdtempSync(join(tmpdir(), 'pf-rendercost-')), 'renderCost.mjs')
buildSync({
  entryPoints: ['src/shared/renderCost.ts'],
  outfile: out,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
})
const { readProfile, costWords } = await import(pathToFileURL(out).href)

let passed = 0
const check = (what, ok, detail = '') => {
  if (ok) {
    passed++
    return
  }
  console.error(`FAIL: ${what}${detail ? ` - ${detail}` : ''}`)
  process.exitCode = 1
}

// A profile shaped the way V8 sends one: a flat node list, a sample per gap.
const frame = (id, functionName, url, lineNumber) => ({
  id,
  callFrame: { functionName, url, lineNumber },
})
const profile = {
  startTime: 1_000_000,
  endTime: 2_000_000, // one second
  nodes: [
    frame(1, '(root)'),
    frame(2, '(idle)'),
    frame(3, 'checkBusy', 'file:///app/App-abc.js', 41),
    frame(4, 'fits', 'file:///app/App-abc.js', 17),
    frame(5, '', 'file:///app/App-abc.js', 99),
  ],
  samples: [2, 2, 3, 4, 5, 2],
  timeDeltas: [400_000, 200_000, 250_000, 100_000, 50_000, 0],
}

const cost = readProfile(profile)
check('the span comes off the profile\'s own clock', cost.spanMs === 1000, `${cost.spanMs}`)
check('idle is every V8 housekeeping frame added up', Math.round(cost.idlePct) === 60, `${cost.idlePct}`)
check('busy is the rest of the span', Math.round(cost.busyPct) === 40, `${cost.busyPct}`)
check('the idle frame is not a row', !cost.rows.some((r) => r.name === '(idle)'))
check('heaviest first', cost.rows[0].name === 'checkBusy', cost.rows[0].name)
check('a row carries file and line', cost.rows[0].where === 'App-abc.js:42', cost.rows[0].where)
check('a nameless frame is not blank on screen', cost.rows[2].name === '(anonymous)', cost.rows[2].name)
check('a row\'s share is of the whole span', Math.round(cost.rows[0].pct) === 25, `${cost.rows[0].pct}`)

// A short profile must read as less time MEASURED, never as time invented: the 88% that
// started this was a lifetime average passing for a live one, and the same mistake made
// twice would be a number nobody could trust.
const short = readProfile({
  nodes: [frame(1, 'fits', 'file:///app/App-abc.js', 17)],
  samples: [1, 1],
  timeDeltas: [100_000, undefined],
})
check('a missing gap counts as nothing', short.rows[0].us === 100_000, `${short.rows[0].us}`)
check('no declared clock falls back to what was counted', short.spanMs === 100, `${short.spanMs}`)

const empty = readProfile(null)
check('no profile is an empty reading, not a crash', empty.spanMs === 0 && empty.rows.length === 0)
check('an empty reading claims no busy time', empty.busyPct === 0 && empty.idlePct === 0)

// The verdict beside the table is the point: a number with no sentence gets read as
// whatever the reader already believed.
const quiet = readProfile({
  startTime: 0,
  endTime: 1_000_000,
  nodes: [frame(1, '(idle)'), frame(2, 'fits', 'file:///app/App-abc.js', 17)],
  samples: [1, 2],
  timeDeltas: [950_000, 50_000],
})
check(
  'a quiet window says the cost is not JS',
  costWords(quiet).includes('JS is not the cost here'),
  costWords(quiet).split('\n')[1]
)
const hot = readProfile({
  startTime: 0,
  endTime: 1_000_000,
  nodes: [frame(1, '(idle)'), frame(2, 'checkBusy', 'file:///app/App-abc.js', 41)],
  samples: [1, 2],
  timeDeltas: [100_000, 900_000],
})
check('a hot window says the rows are where it went', costWords(hot).includes('JS is the cost'))
check('...and says how much', Math.round(hot.busyPct) === 90, `${hot.busyPct}`)
check(
  'a window with nothing above the floor says so rather than printing an empty table',
  costWords(readProfile({ nodes: [frame(1, '(idle)')], samples: [1], timeDeltas: [1000] })).includes(
    'the window is quiet'
  )
)

console.log(`render cost: ${passed} checks passed`)
