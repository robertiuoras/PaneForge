// Updating PaneForge on a Mac, without a signing certificate.
//
// Why this file exists at all: electron-updater installs a macOS update through
// Squirrel.Mac, and Squirrel.Mac validates the code signature of both the running app and
// the one replacing it. This app is built with `identity: null`, so the bundle carries
// only an ad-hoc linker signature whose hash changes with every build - there is nothing
// for Squirrel to match, and it refuses. That is why every Mac release so far ended with
// "PaneForge 0.3.x is out" and a link, and a manual trip to the GitHub page.
//
// Nothing about that requires Squirrel. A .app is a folder: the update is a zip of the
// new folder, and installing it is `mv` - once the old process has let go of its own
// files. So the app downloads the release zip itself, expands it beside its own data,
// checks that the bundle inside really is the version it asked for, and leaves a small
// shell script to do the swap after this process exits (the same moment the Windows
// installer runs). The relaunch is `open -g`, which is the whole reason to do it this way
// rather than with `dialog` and Finder: nothing appears, nothing takes the screen.
//
// Two things are deliberately NOT done here:
//   - No quarantine flag is ever set, because the zip is fetched over https from this
//     process. Only LaunchServices marks downloads, so no "PaneForge is damaged" prompt.
//   - No signature is checked, because there is none to check. What is verified instead
//     is the version inside the bundle, which is the failure this could actually have:
//     an asset for another release, or a truncated download that does not expand.

import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  accessSync,
  constants,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { get } from 'node:https'
import { dirname, join } from 'node:path'
import { app } from 'electron'

const OWNER = 'robertiuoras'
const REPO = 'PaneForge'

type Log = (...parts: unknown[]) => void
let log: Log = () => undefined

export function setMacUpdateLog(fn: Log): void {
  log = fn
}

/** Where the downloaded zip and the expanded bundle live until the swap. */
function staging(): string {
  return join(app.getPath('userData'), 'mac-update')
}

/**
 * The running app bundle, or '' when this is not one.
 *
 * `/Applications/PaneForge.app/Contents/MacOS/PaneForge` -> the .app three levels up.
 * In `npm run dev` the exec path is Electron inside node_modules, which has a .app of its
 * own - hence the productName check, so a dev run never stages an update over Electron.
 */
export function bundlePath(): string {
  if (process.platform !== 'darwin') return ''
  const exec = process.execPath
  const bundle = dirname(dirname(dirname(exec)))
  if (!bundle.endsWith('.app')) return ''
  if (!/\/(PaneForge|PaneForge-[^/]*)\.app$/.test(bundle)) return ''
  return bundle
}

/**
 * Can this Mac swap itself, or does it get the release page like before?
 *
 * Refused when the app is not a bundle (dev run), when the folder holding it is not
 * writable (a managed /Applications, or a copy still inside a mounted .dmg - read-only,
 * and the one place a first-time user is most likely to run it from), and when the
 * release has no zip for this architecture. The build only produces arm64.
 */
export function canSwap(): boolean {
  const bundle = bundlePath()
  if (!bundle || !app.isPackaged) return false
  if (process.arch !== 'arm64') return false
  try {
    // W_OK on the parent, not the bundle: replacing it is a rename inside that folder.
    accessSync(dirname(bundle), constants.W_OK)
    return true
  } catch {
    return false
  }
}

/** The release asset this Mac wants: `PaneForge-0.3.52-arm64.zip`. */
export function assetFor(version: string): string {
  return `PaneForge-${version}-${process.arch}.zip`
}

// --- fetching ---------------------------------------------------------------

function fetchTo(url: string, file: string, onPercent: (p: number) => void, redirects = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'))
    const req = get(url, { headers: { 'user-agent': `PaneForge/${app.getVersion()}` }, timeout: 30_000 }, (res) => {
      const code = res.statusCode ?? 0
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume()
        return fetchTo(res.headers.location, file, onPercent, redirects + 1).then(resolve, reject)
      }
      if (code !== 200) {
        res.resume()
        return reject(new Error(`${code} for ${url.split('/').pop()}`))
      }
      const total = Number(res.headers['content-length'] ?? 0)
      let seen = 0
      let last = -1
      const out = createWriteStream(file)
      res.on('data', (c: Buffer) => {
        seen += c.length
        if (!total) return
        const pct = Math.round((seen / total) * 100)
        if (pct !== last) {
          last = pct
          onPercent(pct)
        }
      })
      res.pipe(out)
      out.on('error', reject)
      out.on('finish', () => resolve())
    })
    req.on('timeout', () => req.destroy(new Error('download timed out')))
    req.on('error', reject)
  })
}

/**
 * The zip, from the public release download URL.
 *
 * Falls back to the `gh` CLI on any failure, for the same reason the feed does: this
 * account has been hidden from anonymous requests before (anti-abuse flag, 2026-07-28)
 * and every anonymous read 404'd while the releases themselves were fine.
 */
async function download(version: string, onPercent: (p: number) => void): Promise<string> {
  const name = assetFor(version)
  const dir = staging()
  mkdirSync(dir, { recursive: true })
  const zip = join(dir, name)
  rmSync(zip, { force: true })
  const url = `https://github.com/${OWNER}/${REPO}/releases/download/v${version}/${name}`
  try {
    await fetchTo(url, zip, onPercent)
    return zip
  } catch (e) {
    log('mac download failed, trying the gh CLI', (e as Error)?.message ?? String(e))
    rmSync(zip, { force: true })
    await new Promise<void>((resolve, reject) => {
      execFile(
        'gh',
        ['release', 'download', `v${version}`, '--repo', `${OWNER}/${REPO}`, '--pattern', name, '--dir', dir],
        { timeout: 15 * 60_000 },
        (err) => (err ? reject(err) : resolve())
      )
    })
    if (!existsSync(zip)) throw new Error(`gh release download produced no ${name}`)
    return zip
  }
}

/** sha512 of the zip as electron-builder writes it into latest-mac.yml (base64). */
function sha512(file: string): string {
  return createHash('sha512').update(readFileSync(file)).digest('base64')
}

/**
 * The release's own checksum, when the release has a mac feed.
 *
 * Optional on purpose: a release cut from the Windows machine has no `latest-mac.yml` at
 * all (that is the whole bug behind the last three Mac releases), and refusing to update
 * because the checksum file is missing would put this back where it started. A checksum
 * that IS published and does not match aborts.
 */
async function feedSha(version: string): Promise<string> {
  const url = `https://github.com/${OWNER}/${REPO}/releases/download/v${version}/latest-mac.yml`
  const body = await text(url).catch(() => '')
  if (!body) return ''
  // The zip's entry in the files list; the dmg has one right below it and it is not this.
  const want = assetFor(version)
  const lines = body.split('\n')
  const at = lines.findIndex((l) => l.includes(want))
  for (let i = at; i >= 0 && i < at + 4; i++) {
    const m = /sha512:\s*(\S+)/.exec(lines[i] ?? '')
    if (m) return m[1]
  }
  return ''
}

/**
 * A small text GET that follows redirects.
 *
 * Every release asset URL on github.com answers 302 to objects.githubusercontent.com, so a
 * reader that does not follow one reads nothing. That is exactly what happened to the
 * checksum on the first run of this code: `latest-mac.yml` was there, the app reported
 * "no published checksum", and the verification silently downgraded to the version check.
 */
function text(url: string, redirects = 0): Promise<string> {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'))
    const req = get(url, { headers: { 'user-agent': `PaneForge/${app.getVersion()}` }, timeout: 15_000 }, (res) => {
      const code = res.statusCode ?? 0
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume()
        return text(res.headers.location, redirects + 1).then(resolve, reject)
      }
      if (code !== 200) {
        res.resume()
        return reject(new Error(`${code}`))
      }
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => {
        body += c
      })
      res.on('end', () => resolve(body))
    })
    req.on('timeout', () => req.destroy(new Error('timed out')))
    req.on('error', reject)
  })
}

// --- expanding --------------------------------------------------------------

/** `CFBundleShortVersionString` out of a bundle, without a plist parser. */
function bundleVersion(bundle: string): string {
  try {
    const plist = readFileSync(join(bundle, 'Contents', 'Info.plist'), 'utf8')
    const m = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)
    return m ? m[1].trim() : ''
  } catch {
    return ''
  }
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10 * 60_000 }, (err) => (err ? reject(err) : resolve()))
  })
}

/**
 * Expand a downloaded zip into a staged bundle and prove it is the build we asked for.
 *
 * `ditto`, never `unzip`: an Electron app is full of symlinks (every framework's
 * `Versions/A` chain) and unzip flattens them, which produces a bundle that looks fine
 * and cannot launch. Exported so `npm run test:macupdate` can drive it on a real zip.
 */
export async function stageFromZip(zip: string, version: string): Promise<string> {
  const dest = join(staging(), version)
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  await run('/usr/bin/ditto', ['-x', '-k', zip, dest])
  const entry = readdirSync(dest).find((f) => f.endsWith('.app'))
  if (!entry) throw new Error('no .app inside the release zip')
  const staged = join(dest, entry)
  const got = bundleVersion(staged)
  if (got !== version) {
    rmSync(dest, { recursive: true, force: true })
    throw new Error(`release zip contains ${got || 'no version'}, expected ${version}`)
  }
  // Belt and braces. Nothing here sets the quarantine flag, but a bundle that carries one
  // is refused by Gatekeeper with a dialog, and a dialog is the one thing this app must
  // never produce on its own.
  await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', staged]).catch(() => undefined)
  return staged
}

let stagedApp = ''
let stagedFor = ''

/** The version sitting expanded on disk waiting for a restart, '' when there is none. */
export function staged(): string {
  return stagedApp && existsSync(stagedApp) ? stagedFor : ''
}

/**
 * Download and expand a release, ready for `swapAndRelaunch()`.
 *
 * Throws with a readable message on any failure - the caller turns that into the badge's
 * error text and falls back to handing over the release page.
 */
export async function stageMacUpdate(version: string, onPercent: (p: number) => void): Promise<void> {
  const zip = await download(version, onPercent)
  const want = await feedSha(version)
  if (want) {
    const got = sha512(zip)
    if (got !== want) {
      rmSync(zip, { force: true })
      throw new Error('sha512 checksum mismatch on the mac zip')
    }
    log('mac zip checksum ok')
  } else {
    log('mac zip has no published checksum - verifying by bundle version only')
  }
  const bundle = await stageFromZip(zip, version)
  rmSync(zip, { force: true })
  stagedApp = bundle
  stagedFor = version
  log('mac update staged', version, bundle)
}

// --- swapping ---------------------------------------------------------------

/** A path inside a single-quoted shell string. */
function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * Replace the running bundle with the staged one, then bring it back.
 *
 * Runs as a detached `/bin/sh` because the process doing it has to outlive this one: a
 * bundle cannot be moved while its own executable is running. The script waits for this
 * pid to disappear (the caller exits immediately after), keeps the old bundle until the
 * new one is in place - so a failed move leaves a working app rather than none - and
 * relaunches with `open -g`, which starts it without taking the screen.
 *
 * Returns false when there is nothing staged, so the caller can leave the app running.
 *
 * `relaunch` false is the quit path: the update still installs, but an app the user closed
 * on purpose must not come back on its own. Next launch is the new version.
 */
export function swapAndRelaunch(relaunch = true): boolean {
  const target = bundlePath()
  if (!target || !staged()) return false
  const dir = staging()
  mkdirSync(dir, { recursive: true })
  const script = join(dir, 'swap.sh')
  const logFile = join(dir, 'swap.log')
  const old = `${target}.pf-old`
  writeFileSync(
    script,
    `#!/bin/sh
exec >>${q(logFile)} 2>&1
echo "--- $(date -u +%FT%TZ) swap ${stagedFor} pid $$"
i=0
while kill -0 ${process.pid} 2>/dev/null && [ $i -lt 300 ]; do sleep 0.2; i=$((i+1)); done
if kill -0 ${process.pid} 2>/dev/null; then echo "old process still running - not swapping"; exit 1; fi
[ -d ${q(stagedApp)} ] || { echo "staged bundle vanished"; exit 1; }
rm -rf ${q(old)}
mv ${q(target)} ${q(old)} || { echo "could not move the old bundle aside"; exit 1; }
mv ${q(stagedApp)} ${q(target)} || { echo "move in failed - putting the old one back"; mv ${q(old)} ${q(target)}; exit 1; }
rm -rf ${q(old)}
echo "swapped${relaunch ? ', relaunching' : ' - not relaunching, the user quit'}"
${relaunch ? `open -g -a ${q(target)}` : 'exit 0'}
`,
    { mode: 0o755 }
  )
  const child = spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' })
  child.unref()
  log('mac swap started', stagedFor, `pid ${child.pid}`)
  return true
}

/** True when `a` is a strictly newer dotted version than `b`. 0.3.9 vs 0.3.10 needs it. */
function ahead(a: string, b: string): boolean {
  const pa = a.split(/[.-]/).map(Number)
  const pb = b.split(/[.-]/).map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}

/**
 * A bundle expanded by an earlier run that never got its restart.
 *
 * Without this, quitting with "later" and starting again re-downloaded 120 MB every time,
 * because the staged bundle is only remembered in memory. Anything that is not a bundle
 * of the version its own folder claims is deleted rather than trusted. Returns the version
 * adopted, '' when there was nothing usable - the caller decides whether it is newer than
 * what is running.
 */
export function adoptStaged(): string {
  const dir = staging()
  if (process.platform !== 'darwin' || !existsSync(dir)) return ''
  let best = ''
  for (const name of readdirSync(dir)) {
    // Only the version folders this module creates. The zip mid-download, `swap.sh` and
    // `swap.log` live here too and deleting those would be deleting the evidence.
    if (!/^\d+\.\d+\.\d+/.test(name)) continue
    const holder = join(dir, name)
    const entry = (() => {
      try {
        return readdirSync(holder).find((f) => f.endsWith('.app'))
      } catch {
        return undefined
      }
    })()
    const bundle = entry ? join(holder, entry) : ''
    if (!bundle || bundleVersion(bundle) !== name) {
      rmSync(holder, { recursive: true, force: true })
      continue
    }
    if (!best || ahead(name, best)) {
      best = name
      stagedApp = bundle
      stagedFor = name
    }
  }
  if (best) log('mac update already staged from an earlier run', best)
  return best
}

/** Throw away anything staged. Used when a newer release supersedes it. */
export function clearStaged(): void {
  if (stagedApp) rmSync(dirname(stagedApp), { recursive: true, force: true })
  stagedApp = ''
  stagedFor = ''
}
