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
  holdsThisBuild,
  publishPlan,
  readFeed,
  servedMismatches,
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

// 5b. The feed's own byte count is not evidence: a hand-repaired latest-mac.yml is a
//     different length from electron-builder's and that is not a broken build. Only the
//     rows inside it are checked (see feedMismatches below).
is(
  sizeMismatches({ 'latest-mac.yml': 511 }, { 'latest-mac.yml': 510 }).length,
  1,
  'sizeMismatches itself is blind to what a name means'
)
is(
  /filter\(\(\[n\]\) => !n\.endsWith\('\.yml'\)\)/.test(
    readFileSync(new URL('./release.mjs', import.meta.url), 'utf8')
  ),
  true,
  'verify keeps the feed out of the size comparison'
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

// 6b. No dist/ on this machine (the tag's workflow built the release, the normal path):
//     `verify` used to print "nothing in dist/ to check against" and PASS, so
//     "release:verify passes" proved nothing for every CI-built release. With no bytes of
//     our own, the release is held to its own feeds: each row's file is on the release at
//     the size the feed says, hashes to the feed's sha512, and no asset stops on a whole
//     MiB (22,020,096 = 21 MiB was v0.8.183's partial zip). Both platforms, both feeds.
{
  const v = '0.8.236'
  const macFeed = `files:\n  - url: PaneForge-${v}-arm64.zip\n    sha512: ZIPHASH==\n    size: 167357224\n  - url: PaneForge-${v}-arm64.dmg\n    sha512: DMGHASH==\n    size: 170000001\n`
  const winFeed = `files:\n  - url: PaneForge-Setup-${v}.exe\n    sha512: EXEHASH==\n    size: 98765433\n`
  const assets = {
    'latest-mac.yml': 400,
    [`PaneForge-${v}-arm64.zip`]: 167357224,
    [`PaneForge-${v}-arm64.zip.blockmap`]: 180001,
    [`PaneForge-${v}-arm64.dmg`]: 170000001,
    [`PaneForge-${v}-arm64.dmg.blockmap`]: 180003,
    'latest.yml': 350,
    [`PaneForge-Setup-${v}.exe`]: 98765433,
    [`PaneForge-Setup-${v}.exe.blockmap`]: 100005
  }
  const feeds = { 'latest-mac.yml': macFeed, 'latest.yml': winFeed }
  const digests = {
    [`PaneForge-${v}-arm64.zip`]: 'ZIPHASH==',
    [`PaneForge-${v}-arm64.dmg`]: 'DMGHASH==',
    [`PaneForge-Setup-${v}.exe`]: 'EXEHASH=='
  }
  const why = (o) => servedMismatches({ version: v, assets, feeds, digests, ...o }).map((b) => [b.name, b.why])
  is(why({}), [], 'a CI-built release that matches its own feeds passes')
  const { 'latest.yml': _gone, ...macOnly } = assets
  is(
    why({ assets: macOnly, feeds: { ...feeds, 'latest.yml': null } }).map((b) => b[0]),
    ['latest.yml', 'latest.yml'],
    'a missing Windows feed fails (every Windows copy would sit on the old version)'
  )
  is(
    why({ assets: { ...assets, [`PaneForge-${v}-arm64.zip`]: 22020096 } }).map((b) => b[0]),
    [`PaneForge-${v}-arm64.zip`],
    'a served size the feed does not say fails'
  )
  is(
    why({
      assets: { ...assets, [`PaneForge-${v}-arm64.zip`]: 22020096 },
      feeds: { ...feeds, 'latest-mac.yml': macFeed.replace('167357224', '22020096') }
    }).map((b) => b[0]),
    [`PaneForge-${v}-arm64.zip`],
    'a feed that agrees with a whole-MiB partial upload still fails'
  )
  is(
    why({ digests: { ...digests, [`PaneForge-Setup-${v}.exe`]: 'OTHER==' } }).map((b) => b[0]),
    [`PaneForge-Setup-${v}.exe`],
    'bytes that do not hash to the feed fail'
  )
  is(
    why({ feeds: { ...feeds, 'latest.yml': winFeed.replace(`Setup-${v}.exe`, 'Setup-ghost.exe') } }).map(
      (b) => b[0]
    ),
    ['PaneForge-Setup-ghost.exe'],
    'a feed naming a file the release does not carry fails'
  )
  is(
    why({ feeds: { ...feeds, 'latest-mac.yml': 'version: 0.8.236\n' } }).map((b) => b[0]),
    ['latest-mac.yml'],
    'a feed naming no file fails'
  )
}

is(
  holdsThisBuild({ 'latest-mac.yml': { size: 510, sha512: 'x' } }),
  false,
  "a stale feed left in dist/ by another version's build is not this build"
)
is(
  holdsThisBuild({ 'latest-mac.yml': { size: 510, sha512: 'x' }, [`PaneForge-${V}-arm64.zip`]: { size: 1, sha512: 'y' } }),
  true,
  'an installer named for the version is'
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
