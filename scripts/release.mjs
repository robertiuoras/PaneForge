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
import { existsSync, readFileSync, statSync } from 'node:fs'
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

/** electron-builder's own digest: base64 of the raw sha512, not hex. */
export function sha512Of(file) {
  return createHash('sha512').update(readFileSync(file)).digest('base64')
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
    execFileSync('npm', ['test'], { cwd: ROOT, stdio: 'inherit' })
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
  if (Object.keys(local).length === 0) {
    console.log(`${tag}: nothing in dist/ to check against - not judging the release.`)
    return true
  }

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

if (process.argv[1] && /[\\/]release\.mjs$/.test(process.argv[1])) {
  if (process.argv[2] === 'verify') {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    verify({ tag: `v${pkg.version}`, version: pkg.version, dist: join(ROOT, 'dist') })
  } else main()
}
