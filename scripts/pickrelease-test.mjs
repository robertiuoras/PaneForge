// Which release a Mac may take.
//
// The bug: v0.8.61 was cut from the Windows machine alone, so its release carries
// latest.yml and the exe and NO mac asset. The dev channel picked the newest tag full
// stop, `macUpdate.download` asked for PaneForge-0.8.61-arm64.zip, GitHub answered 404,
// and the poll retried the same tag for ever - a Mac stuck behind an error card that
// no restart could clear, because nothing in the loop ever looked at the release below.
//
//   node scripts/pickrelease-test.mjs

import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-pickrelease-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const out = join(work, 'pickRelease.mjs')
buildSync({
  entryPoints: [join(root, 'src', 'shared', 'pickRelease.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: out
})
const { pickRelease } = await import(`file://${out.replace(/\\/g, '/')}`)

const arm = (v) => `PaneForge-${v}-arm64.zip`
const rel = (tag, assets) => ({ tag_name: tag, assets: assets.map((name) => ({ name })) })

// The real shapes, off the releases API on 2026-08-14.
const live = [
  rel('v0.8.62', ['latest-mac.yml', 'latest.yml', 'PaneForge-0.8.62-arm64.zip', 'PaneForge-Setup-0.8.62.exe']),
  rel('v0.8.61', ['latest.yml', 'PaneForge-0.8.61-win.zip', 'PaneForge-Setup-0.8.61.exe']),
  rel('v0.8.60', ['latest-mac.yml', 'PaneForge-0.8.60-arm64.zip'])
]

let fails = 0
const ok = (name, got, want) => {
  const good = got === want
  if (!good) fails++
  console.log(`${good ? 'ok  ' : 'FAIL'} ${name}${good ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`)
}

ok('newest release with a mac zip wins', pickRelease(live, arm), 'v0.8.62')

// The case the whole thing exists for: the newest release is win-only, so the mac must
// fall THROUGH it rather than pick it and 404 for ever.
ok('a win-only newest release is skipped', pickRelease(live.slice(1), arm), 'v0.8.60')

// And windows is unaffected by the same list.
ok('windows picks its own newest', pickRelease(live, (v) => `PaneForge-Setup-${v}.exe`), 'v0.8.62')

// A release with no installable asset for this platform at all is not offered: an empty
// answer leaves the caller reporting "no update", never a download that cannot exist.
ok('nothing installable is nothing offered', pickRelease([live[1]], arm), '')

// Drafts are invisible whatever they carry.
ok(
  'a draft is skipped',
  pickRelease([{ ...rel('v0.9.0', [arm('0.9.0')]), draft: true }, ...live], arm),
  'v0.8.62'
)

// /releases/latest answers ONE object, GitHub's promoted release: taken as given.
ok('a single object is taken as given', pickRelease(rel('v0.8.32', []), arm), 'v0.8.32')

// A response carrying no asset lists at all (a stub, an older API shape) must behave
// exactly as it used to - refusing everything there would be the same wedge reversed.
ok('no assets known falls back to newest', pickRelease([{ tag_name: 'v0.8.62' }, { tag_name: 'v0.8.61' }], arm), 'v0.8.62')

rmSync(work, { recursive: true, force: true })
console.log(fails ? `${fails} failed` : 'all green')
process.exit(fails ? 1 : 0)
