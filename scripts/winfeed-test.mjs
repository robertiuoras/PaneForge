// npm run test:winfeed
//
// Which release the Windows dev channel points its feed at. The tag list is real: these
// are this repo's own releases on 2026-08-18, where v0.8.104 was cut from the Mac and
// carries latest-mac.yml and two arm64 archives and nothing else - so it 404s for a
// Windows install and is the exact release the error card kept naming.

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-winfeed-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const outfile = join(work, 'winfeed.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/winFeed.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile
})
const { pickWinTag } = createRequire(import.meta.url)(outfile)

const TAGS = ['v0.8.104', 'v0.8.103', 'v0.8.102', 'v0.8.101', 'v0.8.100']
const asked = []
const has = (installable) => async (tag) => {
  asked.push(tag)
  return installable.includes(tag)
}

// The case this exists for: the newest release is mac-only, so the one below it is taken.
asked.length = 0
assert.equal(await pickWinTag(TAGS, has(TAGS.slice(1))), 'v0.8.103')
assert.deepEqual(asked, ['v0.8.104', 'v0.8.103'], 'it must stop at the first hit, not ask all five')

// Newest first, and the newest wins when it IS installable.
assert.equal(await pickWinTag(TAGS, has(TAGS)), 'v0.8.104')

// Several mac-only builds in a row - the run this repo actually produces when the Mac cuts
// an evening's worth of releases.
assert.equal(await pickWinTag(TAGS, has(['v0.8.101', 'v0.8.100'])), 'v0.8.101')

// Nothing installable is a FACT, and the answer is "leave the feed alone". Returning the
// newest anyway is the wedge this exists to stop: the updater would ask for a latest.yml
// that is not there, fail, retry, and pick the same tag for ever.
assert.equal(await pickWinTag(TAGS, has([])), '', 'no installable release must resolve to nothing')

// No tags at all (gh missing, not logged in, no network) is the same answer, not a throw.
assert.equal(await pickWinTag([], has(TAGS)), '')

console.log('winfeed: ok')
