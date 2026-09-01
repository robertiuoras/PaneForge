// Pins the guard that stands between a green Release workflow and a second local publish.
//
// The bug this is here for: v0.8.183 was published by the workflow, then a local
// `npm run release` ran on top of it, exited 1 for want of a GH_TOKEN, and still left
// PaneForge-0.8.183-arm64.zip at 22,020,096 bytes (a real 167,357,224) with a
// latest-mac.yml recording the truncated size and its own sha512. A feed and a corpse that
// agree look healthy; only dist/ can say otherwise.

import { readFileSync } from 'node:fs'
import {
  expectedAssets,
  feedMismatches,
  publishPlan,
  readFeed,
  sizeMismatches
} from './release.mjs'

let fails = 0
const is = (a, b, what) => {
  const ok = JSON.stringify(a) === JSON.stringify(b)
  if (!ok) {
    fails++
    console.error(`FAIL ${what}\n  got      ${JSON.stringify(a)}\n  expected ${JSON.stringify(b)}`)
  } else console.log(`ok   ${what}`)
}

const V = '0.8.183'
const MAC = expectedAssets(V, 'darwin')
const WIN = expectedAssets(V, 'win32')

is(MAC.includes('latest-mac.yml'), true, 'mac wants the mac feed')
is(MAC.includes(`PaneForge-${V}-arm64.zip`), true, 'mac wants the versioned zip')
is(WIN.includes('latest.yml'), true, 'windows wants its own feed')
is(
  WIN.some((n) => n.endsWith('.dmg')),
  false,
  'windows is never asked for a dmg'
)

// 1. The workflow finished. There is nothing to do, and doing it anyway is the bug.
is(
  publishPlan({ version: V, assets: [...MAC, ...WIN], token: 'gho_x', platform: 'darwin' }).do,
  'skip',
  'a release carrying every asset is not published over'
)
// A token in hand is not a reason either.
is(
  publishPlan({ version: V, assets: MAC, token: 'gho_x', platform: 'darwin' }).do,
  'skip',
  'this platform being complete is enough to stand down'
)

// 2. The failure that started this: no token. Say so BEFORE the five-minute build.
const noToken = publishPlan({ version: V, assets: [], token: '', platform: 'darwin' })
is(noToken.do, 'stop', 'a publish with no token is refused, not attempted')
is(/GH_TOKEN/.test(noToken.why), true, 'the refusal names the missing token')

// 3. Cannot tell is never publish - an unanswerable GitHub is how you get two publishers.
is(
  publishPlan({ version: V, assets: null, token: 'gho_x', platform: 'darwin' }).do,
  'stop',
  'a GitHub that cannot be asked stops the run'
)

// 4. A half-published release with a token is the one case that publishes.
const half = publishPlan({
  version: V,
  assets: MAC.filter((n) => n !== `PaneForge-${V}-arm64.zip`),
  token: 'gho_x',
  platform: 'darwin'
})
is(half.do, 'publish', 'a missing asset with a token in hand is published')
is(half.missing, [`PaneForge-${V}-arm64.zip`], 'the plan names what is missing')

// 5. The truncated upload itself, with the real numbers off the incident.
const REAL = 167357224
const TRUNC = 22020096
is(
  sizeMismatches({ [`PaneForge-${V}-arm64.zip`]: TRUNC }, { [`PaneForge-${V}-arm64.zip`]: REAL }),
  [{ name: `PaneForge-${V}-arm64.zip`, published: TRUNC, local: REAL }],
  'a served asset smaller than dist/ is a mismatch'
)
is(
  sizeMismatches({ [`PaneForge-${V}-arm64.zip`]: REAL }, { [`PaneForge-${V}-arm64.zip`]: REAL }),
  [],
  'the same size is not a mismatch'
)
is(
  sizeMismatches({ 'PaneForge-Setup-9.9.9.exe': 1 }, { [`PaneForge-${V}-arm64.zip`]: REAL }),
  [],
  "the other platform's assets are not ours to judge"
)

// 6. The feed. It was self-consistent with the corpse, which is why it must be read
//    against dist/ and never against the asset it describes.
const feed = `version: ${V}
files:
  - url: PaneForge-${V}-arm64.zip
    sha512: TRUNCATEDHASH==
    size: ${TRUNC}
  - url: PaneForge-${V}-arm64.dmg
    sha512: DMGHASH==
    size: 173439407
path: PaneForge-${V}-arm64.zip
sha512: TRUNCATEDHASH==
releaseDate: '2026-09-01T08:31:19.025Z'
`
is(readFeed(feed).length, 2, 'both files are read out of the feed')
const local = {
  [`PaneForge-${V}-arm64.zip`]: { size: REAL, sha512: 'REALHASH==' },
  [`PaneForge-${V}-arm64.dmg`]: { size: 173439407, sha512: 'DMGHASH==' }
}
is(
  feedMismatches(feed, local).map((b) => [b.url, b.why]),
  [[`PaneForge-${V}-arm64.zip`, 'size']],
  'the feed describing the truncated zip is caught, the good dmg is not'
)
const goodFeed = feed.replace(String(TRUNC), String(REAL)).replaceAll('TRUNCATEDHASH==', 'REALHASH==')
is(feedMismatches(goodFeed, local), [], 'a feed that matches dist/ passes')
// Same size, wrong digest: the shape a rebuilt-but-not-reuploaded file has.
is(
  feedMismatches(goodFeed.replace('REALHASH==\n    size', 'OTHERHASH==\n    size'), local).map(
    (b) => b.why
  ),
  ['sha512'],
  'a matching size with a wrong digest is still a mismatch'
)
is(
  feedMismatches(`files:\n  - url: ghost.zip\n    sha512: x\n    size: 1\n`, local).map(
    (b) => b.why
  ),
  ['the feed names a file this build did not produce'],
  'a feed naming a file no build produced is a mismatch'
)

// 7. The script must not publish as a side effect of being imported - this file is proof,
//    but pin the guard's shape so it survives a rename.
is(
  /\[\\\\\/\]release\\\.mjs\$/.test(readFileSync(new URL('./release.mjs', import.meta.url), 'utf8')),
  true,
  'main runs only when release.mjs is the entry point'
)

console.log(fails ? `\n${fails} failed` : `\nrelease guard ok`)
process.exit(fails ? 1 : 0)
