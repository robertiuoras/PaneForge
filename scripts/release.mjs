// `npm run release`, and the only thing allowed to publish a build from this machine.
//
// The tag push is what publishes a release: `.github/workflows` builds mac AND win and
// uploads every asset. A local `electron-builder --publish always` on top of a green run
// is not a second opinion, it is a race, and on 2026-09-01 it cost us a broken update
// feed for v0.8.183:
//
//   - bare `npm run release` carries no GH_TOKEN (only lane.mjs's publishFallback injects
//     one, and only after waiting for Actions), so it exited 1 - but not before replacing
//     PaneForge-0.8.183-arm64.zip with 22,020,096 bytes against a real 167,357,224 and
//     writing a latest-mac.yml that recorded the truncated size and its sha512.
//   - a feed and a corpse that agree with each other look healthy from every angle except
//     the one nobody checked: the bytes in dist/.
//
// So this script does three things the raw electron-builder line could not:
//   1. asks GitHub what the release already carries, and REFUSES to publish over a
//      complete one (exit 0 - there is nothing wrong, the workflow did the job);
//   2. demands a token BEFORE the five-minute build rather than after it;
//   3. after its own publish, compares every served asset and the feed it wrote against
//      the bytes in dist/, and repairs a partial upload instead of leaving it live.
//
// The decisions are pure functions so `npm run test:release` can pin them with no network.

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The files a finished release for this platform carries. A release holding all of them
 * was published by something that ran to the end - the workflow, or an earlier local run -
 * and must not be published over.
 *
 * Windows keeps two names for the installer because install.ps1 fetches the fixed one; the
 * versioned name is the one electron-updater reads out of latest.yml, so it is the one
 * asked for here.
 */
export function expectedAssets(version, platform = process.platform) {
  const v = String(version)
  if (platform === 'darwin')
    return [
      'latest-mac.yml',
      `PaneForge-${v}-arm64.dmg`,
      `PaneForge-${v}-arm64.dmg.blockmap`,
      `PaneForge-${v}-arm64.zip`,
      `PaneForge-${v}-arm64.zip.blockmap`
    ]
  return ['latest.yml', `PaneForge-Setup-${v}.exe`, `PaneForge-Setup-${v}.exe.blockmap`]
}

/**
 * What to do, decided BEFORE anything is built.
 *
 * `assets` is the names the release already carries (null = the release does not exist, or
 * GitHub could not be asked). An unanswerable GitHub is not a reason to publish blind: it
 * is the same "cannot tell" that lane.mjs treats as do-nothing, and a second publisher is
 * exactly what we are guarding against.
 */
export function publishPlan({ version, assets, token, platform = process.platform }) {
  const want = expectedAssets(version, platform)
  if (assets == null) return { do: 'stop', why: 'cannot ask GitHub what the release carries' }
  const missing = want.filter((n) => !assets.includes(n))
  if (missing.length === 0)
    return { do: 'skip', why: `the release already carries every ${platform} asset` }
  if (!token)
    return {
      do: 'stop',
      why: `no GH_TOKEN, so a publish would fail after the build (missing: ${missing.join(', ')})`
    }
  return { do: 'publish', why: `missing: ${missing.join(', ')}`, missing }
}

/**
 * Served sizes against the bytes in dist/. Only names present in both are compared - the
 * other platform's assets are somebody else's build and are not ours to judge.
 */
export function sizeMismatches(published, local) {
  const bad = []
  for (const [name, size] of Object.entries(published)) {
    const mine = local[name]
    if (mine == null) continue
    if (mine !== size) bad.push({ name, published: size, local: mine })
  }
  return bad
}

/** Every `url:`/`size:`/`sha512:` triple a latest*.yml declares, in file order. */
export function readFeed(text) {
  const out = []
  const re = /url:\s*(\S+)\s*\n\s*sha512:\s*(\S+)\s*\n\s*size:\s*(\d+)/g
  let m
  while ((m = re.exec(text))) out.push({ url: m[1], sha512: m[2], size: Number(m[3]) })
  return out
}

/**
 * A feed that agrees with a corpse still reads healthy, so the feed is checked against
 * dist/ and never against the thing it describes.
 */
export function feedMismatches(text, local) {
  const bad = []
  for (const row of readFeed(text)) {
    const mine = local[row.url]
    if (!mine) {
      bad.push({ url: row.url, why: 'the feed names a file this build did not produce' })
      continue
    }
    if (mine.size !== row.size)
      bad.push({ url: row.url, why: 'size', said: row.size, real: mine.size })
    else if (mine.sha512 !== row.sha512)
      bad.push({ url: row.url, why: 'sha512', said: row.sha512, real: mine.sha512 })
  }
  return bad
}

/**
 * A release this machine did not build (the tag's workflow builds every one now) held to
 * what it says about itself, since there is no dist/ here to hold it to.
 *
 * `verify` used to print "nothing in dist/ to check against" and pass, so a green
 * release:verify proved nothing for any CI-built release. A feed that agrees with a corpse
 * is the gap this cannot close alone, so a size on a whole MiB fails too: that is where an
 * upload stops (v0.8.183's zip: 22,020,096 bytes = 21 MiB), and a real build lands there
 * one time in a million. Both platforms: one leg shipping alone strands the other's copies.
 *
 * `assets` {name: served bytes}, `feeds` {latest*.yml: text, null = not downloadable},
 * `digests` {name: sha512 of the downloaded file}.
 */
export function servedMismatches({ version, assets, feeds, digests }) {
  const bad = []
  for (const platform of ['darwin', 'win32'])
    for (const n of expectedAssets(version, platform))
      if (!(n in assets)) bad.push({ name: n, why: 'not on the release' })
  for (const [feed, text] of Object.entries(feeds)) {
    if (text == null) {
      bad.push({ name: feed, why: 'could not be downloaded' })
      continue
    }
    const rows = readFeed(text)
    if (rows.length === 0) bad.push({ name: feed, why: 'names no file' })
    for (const row of rows) {
      const served = assets[row.url]
      if (served == null) bad.push({ name: row.url, why: `${feed} names it, the release does not carry it` })
      else if (served !== row.size)
        bad.push({ name: row.url, why: `served ${served} bytes, ${feed} says ${row.size}` })
      else if (digests[row.url] !== row.sha512)
        bad.push({ name: row.url, why: `does not hash to the sha512 in ${feed}` })
    }
  }
  for (const [name, size] of Object.entries(assets))
    if (size > 0 && size % 1048576 === 0 && !bad.some((b) => b.name === name))
      bad.push({ name, why: `${size} bytes is a whole MiB, where a partial upload stops` })
  return bad
}

/**
 * Is dist/ this version's build, to judge the release against? Only an installer named for
 * the version says so. The unversioned latest-mac.yml alone is whatever build last ran here
 * (this Mac's dist/ held 0.8.183's on 2026-10-03), and judging v0.8.236 by it failed every
 * feed row as "a file this build did not produce" - a false alarm on a good release.
 */
export function holdsThisBuild(local) {
  return Object.keys(local).some((n) => !n.endsWith('.yml'))
}

/** electron-builder's own digest: base64 of the raw sha512, not hex. Read in chunks, so
 *  hashing a 170 MB installer does not hold it in memory. */
export function sha512Of(file) {
  const hash = createHash('sha512')
  const buf = Buffer.alloc(1 << 20)
  const fd = openSync(file, 'r')
  try {
    let n
    while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n))
  } finally {
    closeSync(fd)
  }
  return hash.digest('base64')
}

const gh = (args, opts = {}) =>
  execFileSync('gh', args, { encoding: 'utf8', timeout: 120_000, ...opts })

function ghSafe(args, opts) {
  try {
    return { ok: true, out: gh(args, opts).trim() }
  } catch (e) {
    return { ok: false, out: String(e?.stdout || e?.message || e) }
  }
}

function main() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const version = pkg.version
  const tag = `v${version}`
  const dist = join(ROOT, 'dist')

  const listed = ghSafe(['release', 'view', tag, '--json', 'assets'])
  let assets = null
  if (listed.ok) {
    try {
      assets = JSON.parse(listed.out).assets.map((a) => a.name)
    } catch {
      assets = null
    }
  } else if (/release not found|Not Found/i.test(listed.out)) {
    assets = []
  }

  const token = process.env.GH_TOKEN || ghSafe(['auth', 'token']).out || ''
  const plan = publishPlan({ version, assets, token })

  if (plan.do === 'skip') {
    console.log(`${tag}: ${plan.why} - nothing to publish.`)
    console.log(`Check the bytes with: npm run release:verify`)
    return
  }
  if (plan.do === 'stop') {
    console.error(`${tag}: ${plan.why}`)
    console.error(
      'The tag push publishes a release on its own. Watch it with:\n' +
        `  gh run list --repo ${pkg.build.publish[0].owner}/${pkg.build.publish[0].repo} --limit 3`
    )
    process.exit(1)
  }

  console.log(`${tag}: publishing - ${plan.why}`)
  console.log(`${tag}: running test suite...`)
  try {
    // --full: a release runs the lane suites test-all skips when their scripts already passed.
    execFileSync('npm', ['test', '--', '--full'], { cwd: ROOT, stdio: 'inherit' })
  } catch (e) {
    console.error(`${tag}: tests failed - refusing to publish.`)
    process.exit(1)
  }
  execFileSync('npx', ['electron-vite', 'build'], { cwd: ROOT, stdio: 'inherit' })
  execFileSync('npx', ['electron-builder', '--publish', 'always'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, GH_TOKEN: token, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
  })

  verify({ tag, version, dist, repair: true })
}

/**
 * The step the old one-liner had no room for. Reads what the release is SERVING and holds
 * it against dist/; `repair` re-uploads what disagrees rather than leaving a corpse live.
 */
export function verify({ tag, version, dist, repair = false }) {
  const names = expectedAssets(version)
  const local = {}
  for (const n of names) {
    const f = join(dist, n)
    if (existsSync(f)) local[n] = { size: statSync(f).size, sha512: sha512Of(f) }
  }
  if (!holdsThisBuild(local)) return verifyServed({ tag, version })

  const listed = ghSafe(['release', 'view', tag, '--json', 'assets'])
  if (!listed.ok) {
    console.error(`${tag}: cannot read the release: ${listed.out}`)
    process.exitCode = 1
    return false
  }
  const published = Object.fromEntries(
    JSON.parse(listed.out).assets.map((a) => [a.name, a.size])
  )
  // The feed is judged by what it DECLARES, not by its own byte count: a feed rewritten
  // by hand to repair a bad upload is a different length from the one electron-builder
  // left in dist/, and that difference says nothing about the build.
  const sizes = Object.fromEntries(
    Object.entries(local)
      .filter(([n]) => !n.endsWith('.yml'))
      .map(([n, v]) => [n, v.size])
  )
  let bad = sizeMismatches(published, sizes)

  const feedName = names[0]
  const served = ghSafe(['release', 'download', tag, '-p', feedName, '-O', '-'])
  const feedBad = served.ok ? feedMismatches(served.out, local) : []

  if (bad.length === 0 && feedBad.length === 0) {
    console.log(`${tag}: every ${process.platform} asset matches dist/, feed included.`)
    return true
  }

  for (const b of bad)
    console.error(`${tag}: ${b.name} is ${b.published} bytes, dist/ has ${b.local}`)
  for (const b of feedBad) console.error(`${tag}: ${feedName} ${b.why} for ${b.url}`)

  if (!repair) {
    process.exitCode = 1
    return false
  }

  const files = [...new Set([...bad.map((b) => b.name), feedName])].map((n) => join(dist, n))
  console.error(`${tag}: re-uploading ${files.length} file(s)`)
  const up = ghSafe(['release', 'upload', tag, ...files, '--clobber'], { timeout: 900_000 })
  if (!up.ok) {
    console.error(`${tag}: re-upload failed: ${up.out}`)
    process.exitCode = 1
    return false
  }
  return verify({ tag, version, dist, repair: false })
}

/** No dist/ here: download every file the feeds name and hold the release to its feeds. */
function verifyServed({ tag, version }) {
  const listed = ghSafe(['release', 'view', tag, '--json', 'assets'])
  if (!listed.ok) {
    console.error(`${tag}: cannot read the release: ${listed.out}`)
    process.exitCode = 1
    return false
  }
  const assets = Object.fromEntries(JSON.parse(listed.out).assets.map((a) => [a.name, a.size]))
  const dir = mkdtempSync(join(tmpdir(), 'pf-release-verify-'))
  try {
    const feeds = {}
    for (const feed of ['latest-mac.yml', 'latest.yml']) {
      const got = ghSafe(['release', 'download', tag, '-p', feed, '-O', '-'])
      feeds[feed] = got.ok ? got.out : null
    }
    const digests = {}
    for (const text of Object.values(feeds)) {
      for (const row of readFeed(text ?? '')) {
        if (!(row.url in assets) || row.url in digests) continue
        const got = ghSafe(['release', 'download', tag, '-p', row.url, '-D', dir, '--clobber'], {
          timeout: 900_000
        })
        digests[row.url] = got.ok ? sha512Of(join(dir, row.url)) : null
        if (got.ok) rmSync(join(dir, row.url), { force: true })
      }
    }
    const bad = servedMismatches({ version, assets, feeds, digests })
    if (bad.length === 0) {
      const files = Object.keys(digests).length
      console.log(
        `${tag}: no dist/ here, so held to its own feeds - all ${Object.keys(assets).length} ` +
          `assets present, ${files} feed files downloaded and match size + sha512, none on a whole MiB.`
      )
      return true
    }
    for (const b of bad) console.error(`${tag}: ${b.name} ${b.why}`)
    process.exitCode = 1
    return false
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

if (process.argv[1] && /[\\/]release\.mjs$/.test(process.argv[1])) {
  if (process.argv[2] === 'verify') {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    verify({ tag: `v${pkg.version}`, version: pkg.version, dist: join(ROOT, 'dist') })
  } else main()
}
