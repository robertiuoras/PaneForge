// Background updates from GitHub Releases, with a Claude-desktop style prompt:
// the download happens quietly, and the only thing the user ever sees is
// "version X is ready - restart now?".
//
// The feed is the public releases of this repo, so no token ships in the app.
// In `npm run dev` there is no update metadata next to the binary, so the whole
// thing reports 'unsupported' instead of throwing on every launch.

import { execFile } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  readFileSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { get } from 'node:https'
import { join } from 'node:path'
import { app } from 'electron'
import type { UpdateState } from '../shared/types'
import { lastShip } from './laneBoard'
import {
  adoptStaged,
  canSwap,
  clearStaged,
  setMacUpdateLog,
  stageMacUpdate,
  swapAndRelaunch
} from './macUpdate'

type Emit = (s: UpdateState) => void

export const RELEASES_URL = 'https://github.com/robertiuoras/PaneForge/releases'

let state: UpdateState = { phase: 'idle', current: app.getVersion() }
let emit: Emit = () => undefined
let wired = false
let timer: NodeJS.Timeout | null = null
let retry: NodeJS.Timeout | null = null
/** The background poll is on. Kept separately: the timer is re-armed after every tick. */
let auto = false
/** A silent look at the feed while a build waits. Its events must not touch the badge. */
let probing = false

// electron-updater's own log line, kept next to the app's data. Without it an update
// failure is invisible after the fact: the message lives only in a renderer tooltip,
// and the next check overwrites it. One capped file makes the failure readable later.
const LOG = () => join(app.getPath('userData'), 'updater.log')

/**
 * The same file, for the rest of the update story.
 *
 * "It updated and never came back" could not be answered from here: the log ended at
 * `quitAndInstall` and the next line was the new process checking for updates, with
 * nothing in between saying whether a window was ever put on screen. The launch, the
 * reveal (or what deferred it) and the exit go in the one file the update already uses.
 */
export function updateLog(...parts: unknown[]): void {
  log(...parts)
}

/**
 * Milliseconds since this process started, for the boot lines.
 *
 * "It came back too slow" had no number anywhere: the log said when the installer was
 * handed over and when a window appeared, and the whole gap in between - process spawn,
 * main boot, renderer first paint - was one silence you could only guess at. Every boot
 * milestone carries this now, so a slow launch reads as a rising figure instead of as an
 * app that did not restart.
 */
export function bootMs(): number {
  return Math.round(process.uptime() * 1000)
}

function log(...parts: unknown[]): void {
  try {
    const file = LOG()
    // 256 KB is dozens of update cycles; past that the head is worthless anyway.
    if (existsSync(file) && statSync(file).size > 256_000) truncateSync(file, 0)
    appendFileSync(file, `${new Date().toISOString()} ${parts.map(String).join(' ')}\n`)
  } catch {
    // Logging must never be the thing that breaks an update.
  }
}

// Typed loosely on purpose: electron-updater is a runtime dependency of the
// packaged app, and requiring it eagerly would break `electron-vite dev`.
type Updater = {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowPrerelease: boolean
  logger: unknown
  checkForUpdates: () => Promise<unknown>
  downloadUpdate: () => Promise<unknown>
  quitAndInstall: (silent?: boolean, forceRunAfter?: boolean) => void
  setFeedURL: (options: unknown) => void
  on: (event: string, cb: (...args: any[]) => void) => void
}

let updater: Updater | null = null

function load(): Updater | null {
  if (updater) return updater
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('electron-updater') as { autoUpdater: Updater }
    updater = mod.autoUpdater
    return updater
  } catch {
    return null
  }
}

function set(patch: Partial<UpdateState>): void {
  const before = state.phase
  state = { ...state, ...patch, current: app.getVersion() }
  if (state.phase !== before || patch.error) {
    log('state', state.phase, state.version ?? '', state.error ?? '')
  }
  emit(state)
}

/** A check or a download is already running - starting a second one is what breaks it. */
function busy(): boolean {
  return state.phase === 'checking' || state.phase === 'downloading'
}

// --- did the last install actually happen? ---------------------------------
//
// 2026-08-01: "Restart now" ran the installer and the relaunch was still the old
// version - the NSIS install failed silently (mid-game, the installer exe took 8s to
// even start under the AV scan and gave up on the still-running app) and the only
// visible result was the same toast asking for the same restart. Clicking it again
// worked. So the click is finished for the user instead: a marker written before every
// quitAndInstall is how the next launch tells "updated" from "came back unchanged",
// and an unchanged relaunch installs the already-downloaded build again by itself,
// once. Two failed attempts stop the loop - the toast is back anyway, and a third try
// is the user's call.
const ATTEMPT = () => join(app.getPath('userData'), 'install-attempt.json')

type Attempt = { version: string; tries: number }

function readAttempt(): Attempt | null {
  try {
    const raw = JSON.parse(readFileSync(ATTEMPT(), 'utf8')) as Partial<Attempt>
    return typeof raw.version === 'string' && typeof raw.tries === 'number'
      ? { version: raw.version, tries: raw.tries }
      : null
  } catch {
    return null
  }
}

function recordInstallAttempt(version: string): void {
  const prior = readAttempt()
  const tries = (prior?.version === version ? prior.tries : 0) + 1
  try {
    writeFileSync(ATTEMPT(), JSON.stringify({ version, tries }), 'utf8')
  } catch {
    /* best-effort: without the marker the worst case is the old behaviour */
  }
  log('install', `attempt ${tries} for v${version}`)
}

let retryVersion: string | null = null

/** At launch: consume the marker, decide whether the last install needs finishing. */
function checkLastAttempt(): void {
  const a = readAttempt()
  if (!a) return
  try {
    unlinkSync(ATTEMPT())
  } catch {
    /* unreadable marker is as good as none */
  }
  if (!newer(a.version, app.getVersion())) return // it applied - nothing to do
  if (a.tries >= 2) {
    log('install', `v${a.version} still not applied after ${a.tries} attempts - leaving the restart to the user`)
    return
  }
  // Put the count back so the retry's own recordInstallAttempt makes this attempt 2.
  try {
    writeFileSync(ATTEMPT(), JSON.stringify(a), 'utf8')
  } catch {
    /* same best-effort as above */
  }
  retryVersion = a.version
  log('install', `v${a.version} did not apply (still v${app.getVersion()}) - retrying when it is ready again`)
}

/** True exactly once, when `version` is the build a failed install should retry. */
export function consumeInstallRetry(version: string | undefined): boolean {
  if (!retryVersion || retryVersion !== version) return false
  retryVersion = null
  return true
}

// One failed check reaches this module as a burst of identical errors; these two
// collapse the burst into a single reported failure.
let lastError = ''
let lastErrorAt = 0
// How many times in a row the feed has 404'd while a release finishes uploading.
let publishRetries = 0

/**
 * A release whose assets have not finished uploading yet.
 *
 * GitHub publishes the tag the moment the release is created and the 80 MB installer
 * plus its latest.yml land seconds to minutes later. electron-updater asks for the
 * metadata in that gap, gets a 404, and reports it exactly like a broken update - which
 * is what put "check failed" in the corner of the app every single time a new version
 * went out, at the one moment the user was most likely to click it.
 */
function isPublishing(message: string): boolean {
  return /latest(-mac|-linux)?\.yml/i.test(message) && /404/.test(message)
}

/**
 * The mac half of the feed is optional, so a missing one must not read as a failure.
 *
 * A Mac can never install one of these updates anyway - the app is unsigned and
 * Squirrel.Mac refuses it - so all the feed is ever used for on darwin is "there is a
 * newer version, here is the page". `latest-mac.yml` only exists when a release was cut
 * by the CI matrix; every release cut straight from the Windows machine (which is most
 * of them: electron-builder creates the tag through the API, so no tag push event ever
 * reaches Actions) has Windows assets only. electron-updater 404s on those forever and
 * the corner of the app has read "update failed" ever since, while the app was in fact
 * up to date.
 *
 * So on darwin a failed feed read falls back to the plain public releases API, which
 * needs no assets at all - only the tag name. Error is reported only if that fails too.
 */
const API_LATEST = 'https://api.github.com/repos/robertiuoras/PaneForge/releases/latest'

/**
 * A new version, on a Mac. Either this app can swap itself or you get the page.
 *
 * Squirrel.Mac is what cannot install an unsigned build; a folder move can, so
 * `macUpdate.ts` does the download and the swap and this app updates itself on a Mac like
 * it does on Windows - quietly, on the next restart. Everything that made that impossible
 * is still true when `canSwap()` is false (an Intel Mac with no matching asset, a copy
 * still running from the read-only .dmg, a dev build), and then the badge does what it did
 * before: names the version and opens the release page.
 */
/**
 * The outer stop on staging a mac build, in case something in there hangs anyway.
 *
 * `macUpdate.ts` now settles every download path by itself, and this is the belt to that
 * pair of braces: the failure being ruled out is not a slow download, it is a promise that
 * never settles at all. One of those costs far more than the build it loses - `macStaging`
 * stays set so no later check re-offers the version, and `busy()` sees `downloading` and
 * refuses every check after it, so the app stops updating for good with nothing written
 * anywhere. That is what happened to v0.4.62 here on 2026-08-06. Anything reaching this
 * timer is a bug, and it goes down the ordinary failure path: the badge offers the release
 * page, and the next poll is free to try again.
 *
 * Generous on purpose - a real 95 MB zip on a bad connection must never trip it.
 */
const STAGE_DEADLINE_MS = 30 * 60_000

function deadline(version: string): Promise<never> {
  return new Promise<never>((_, reject) => {
    const t = setTimeout(
      () => reject(new Error(`staging ${version} was still not finished after 30 minutes - giving up on it`)),
      STAGE_DEADLINE_MS
    )
    t.unref?.()
  })
}

function offerMac(version: string): void {
  const url = `${RELEASES_URL}/tag/v${version}`
  if (!canSwap()) {
    log('mac cannot self-swap - handing over the release page', version)
    set({ phase: 'available', version, percent: undefined, error: undefined, url })
    return
  }
  if (macStaging === version) return
  macStaging = version
  set({ phase: 'downloading', version, percent: 0, error: undefined, url })
  void Promise.race([
    stageMacUpdate(version, (p) => {
      if (state.version === version && state.phase === 'downloading') set({ percent: p })
    }),
    deadline(version)
  ])
    .then(() => {
      macStaging = ''
      set({ phase: 'ready', version, percent: 100, error: undefined, url })
    })
    .catch((e: Error) => {
      macStaging = ''
      const message = e?.message ?? String(e)
      log('mac self-update failed', message.slice(0, 200))
      // The page still works, and it is what this app did for every release before now.
      // A failed download must not leave the one machine that needs it with nothing.
      set({ phase: 'available', version, percent: undefined, error: undefined, url })
    })
}

/** The version being downloaded for a Mac right now, so two checks cannot both fetch it. */
let macStaging = ''

function publicLatestMacRelease(): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = get(
      API_LATEST,
      {
        headers: {
          'user-agent': `PaneForge/${app.getVersion()}`,
          accept: 'application/vnd.github+json'
        },
        timeout: 15_000
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume()
          return reject(new Error(`releases API ${res.statusCode}`))
        }
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c) => {
          body += c
        })
        res.on('end', () => {
          try {
            const tag = String(JSON.parse(body)?.tag_name ?? '')
            const version = tag.replace(/^v/, '')
            if (!version) return reject(new Error('no tag_name in the releases API response'))
            resolve(version)
          } catch (e) {
            reject(e)
          }
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('releases API timed out')))
    req.on('error', reject)
  })
}

function ghLatestMacRelease(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'gh',
      ['api', 'repos/robertiuoras/PaneForge/releases/latest', '--jq', '.tag_name'],
      { windowsHide: true, timeout: 15_000 },
      (err, out) => {
        const version = err ? '' : out.trim().replace(/^v/, '')
        if (version) resolve(version)
        else reject(err ?? new Error('no tag_name from the authenticated releases API'))
      }
    )
  })
}

async function latestMacRelease(): Promise<string> {
  try {
    return await publicLatestMacRelease()
  } catch (publicError) {
    try {
      return await ghLatestMacRelease()
    } catch {
      throw publicError
    }
  }
}

function macFallback(message: string): void {
  void latestMacRelease()
    .then((version) => {
      if (newer(version, have())) {
        log('mac fallback', `${have()} -> ${version} (feed has no mac metadata)`)
        offerMac(version)
      } else {
        set({ phase: 'none', version: undefined, percent: undefined, error: undefined })
      }
    })
    .catch((e: Error) => {
      log('mac fallback failed', (e?.message ?? String(e)).slice(0, 160))
      set({ phase: 'error', error: message, percent: undefined })
      schedule(3 * 60_000)
    })
}

// GitHub hid this whole account from anonymous requests on 2026-07-28 (anti-abuse
// flag): profile, repo and releases all 404 unless the request is authenticated, so
// the updater went blind while the releases themselves were fine. The way through is
// the gh CLI already logged in on this machine: borrow its token and move the feed to
// the authenticated API. Only tried after a 404, so a healthy account keeps the
// anonymous path, and the token is validated against the releases endpoint first -
// an expired token must not replace a path that might have worked.
let feedTokened = false
let borrowing = false
let borrowReady: (() => void) | null = null

function borrowGhToken(u: Updater, onReady?: () => void): void {
  if (feedTokened) return onReady?.()
  if (onReady && !borrowReady) borrowReady = onReady
  if (borrowing) return
  borrowing = true
  execFile('gh', ['auth', 'token'], { windowsHide: true, timeout: 10_000 }, (err, out) => {
    const token = err ? '' : out.trim()
    if (!token) {
      borrowing = false
      borrowReady = null
      return
    }
    execFile(
      'gh',
      ['api', 'repos/robertiuoras/PaneForge/releases/latest', '--jq', '.tag_name'],
      { windowsHide: true, timeout: 15_000 },
      (err2, out2) => {
        borrowing = false
        if (err2 || !out2.trim().startsWith('v')) {
          borrowReady = null
          return
        }
        u.setFeedURL({ provider: 'github', owner: 'robertiuoras', repo: 'PaneForge', private: true, token })
        feedTokened = true
        log('feed', 'account hidden from anonymous requests - using the gh CLI token')
        const ready = borrowReady
        borrowReady = null
        // Authentication can finish from an immediate test stub before the rejected
        // probe has unwound its `probing` guard. Retry on the next timer turn so the
        // ready-state poll cannot be discarded as still in flight.
        if (ready) setTimeout(ready, 0)
        else schedule(5_000)
      }
    )
  })
}

/** Single owner of the "try again later" timer, so retries cannot stack up. */
function schedule(ms: number): void {
  if (retry) clearTimeout(retry)
  retry = setTimeout(() => void checkForUpdates(), ms)
  retry.unref?.()
}

// --- how often to look ------------------------------------------------------
//
// The app is released several times a day from the machine it runs on, so "check every
// half hour" is the difference between running today's build and yesterday's. Two things
// made that worse than the interval suggests, and both are handled below.

/** Nothing is known to be coming: the ordinary background poll. */
const IDLE_EVERY = 10 * 60_000
/**
 * A release has gone out but its installer is still uploading.
 *
 * Measured on v0.3.30: the tag was created at 12:49:39Z and `latest.yml` finished
 * uploading at 12:53:38Z - four minutes in which the feed still answers with the OLD
 * version. That is not a 404, so the publishing retry below never sees it; the check
 * simply reports "up to date" and the next one is half an hour away. Restarting the app
 * only re-rolls the same 8-second check, which is why catching a fresh release used to
 * take several restarts.
 */
const CHASE_EVERY = 60_000
/** A release that never reached the feed stops being chased; the idle poll takes over. */
const CHASE_WINDOW = 30 * 60_000

/** Compare two dotted versions. True when `a` is strictly newer than `b`. */
function newer(a: string, b: string): boolean {
  const pa = a.split(/[.-]/)
  const pb = b.split(/[.-]/)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number(pa[i] ?? 0)
    const y = Number(pb[i] ?? 0)
    if (Number.isNaN(x) || Number.isNaN(y)) return a > b
    if (x !== y) return x > y
  }
  return false
}

/** The newest build already on this machine: installed, or downloaded and waiting. */
function have(): string {
  const held = state.phase === 'ready' || state.phase === 'downloading' ? state.version : undefined
  const current = app.getVersion()
  return held && newer(held, current) ? held : current
}

/**
 * A release this machine cut itself that has not arrived on the feed yet.
 *
 * `scripts/lane.mjs` records every release it cuts in the lane state file, so the app
 * knows a new version exists minutes before GitHub can serve it. On any machine without
 * a PaneForge checkout there is no such file and this is always false - the poll is
 * simply the idle one.
 */
function chasing(): boolean {
  const ship = lastShip()
  if (!ship) return false
  if (Date.now() - ship.at > CHASE_WINDOW) return false
  return newer(ship.version, have())
}

/** How long until the next look. Exported so `npm run test:updater` can assert it. */
export function pollDelay(): number {
  return chasing() ? CHASE_EVERY : IDLE_EVERY
}

export function getUpdateState(): UpdateState {
  return state
}

export function initUpdater(onChange: Emit, enabled: boolean): void {
  emit = onChange
  if (!app.isPackaged) {
    set({ phase: 'unsupported', error: 'Updates only run in the packaged app.' })
    return
  }
  const u = load()
  if (!u) {
    set({ phase: 'unsupported', error: 'electron-updater is not bundled in this build.' })
    return
  }
  // `electron-builder --dir` produces a runnable app with no app-update.yml, and
  // electron-updater's only reaction to that is an ENOENT it surfaces as a scary
  // error in Settings. A locally built folder simply has no feed to poll.
  if (!existsSync(join(process.resourcesPath, 'app-update.yml'))) {
    set({ phase: 'unsupported', error: 'Local build - no update feed. Installed builds update themselves.' })
    return
  }
  if (!wired) {
    wired = true
    checkLastAttempt()
    setMacUpdateLog(log)
    // macOS refuses to swap in an unsigned update THROUGH SQUIRREL: it validates the code
    // signature, and this app ships unsigned. So electron-updater never downloads on a
    // Mac - `macUpdate.ts` fetches the release zip and swaps the bundle on exit instead.
    u.autoDownload = process.platform !== 'darwin'
    // A downloaded update installs itself when the app exits. The panes are already
    // gone by then, so nothing is swapped out from under a running agent - and a fix
    // reaches you at your next start without a prompt interrupting a session. The
    // prompt still exists for updating right now; this is only the fallback for
    // ignoring it. On a Mac the install is refused anyway (see autoDownload above).
    u.autoInstallOnAppQuit = true
    u.logger = {
      info: (m: unknown) => log('info', m),
      warn: (m: unknown) => log('warn', m),
      error: (m: unknown) => log('error', m),
      debug: () => undefined
    }
    // A Mac that quit with "later" already has the new bundle expanded on disk. Picking it
    // back up is the difference between one 120 MB download and one per restart.
    if (process.platform === 'darwin') {
      const found = adoptStaged()
      if (found && newer(found, app.getVersion())) {
        set({
          phase: 'ready',
          version: found,
          percent: 100,
          url: `${RELEASES_URL}/tag/v${found}`
        })
      } else if (found) clearStaged()
    }
    u.on('checking-for-update', () => {
      if (probing) return
      set({ phase: 'checking', error: undefined })
    })
    u.on('update-available', (info: { version: string }) => {
      if (probing) return
      publishRetries = 0
      lastError = ''
      // electron-updater is not downloading this one on a Mac (autoDownload is off there),
      // so the mac path takes the version and fetches the zip itself.
      if (process.platform === 'darwin') return offerMac(String(info?.version ?? ''))
      set({
        phase: 'downloading',
        version: info?.version,
        percent: 0,
        url: `${RELEASES_URL}/tag/v${info?.version ?? ''}`
      })
    })
    u.on('update-not-available', () => {
      if (probing) return
      publishRetries = 0
      lastError = ''
      set({ phase: 'none', version: undefined, percent: undefined, error: undefined })
    })
    u.on('download-progress', (p: { percent: number }) =>
      set({ phase: 'downloading', percent: Math.round(p?.percent ?? 0) })
    )
    u.on('update-downloaded', (info: { version: string }) =>
      set({ phase: 'ready', version: info?.version, percent: 100 })
    )
    u.on('error', (e: Error) => {
      const message = e?.message ?? String(e)
      // A probe that fails changes nothing: the build already downloaded is still there
      // and still installable, and saying "update failed" over it would be a lie.
      if (probing) {
        log('probe error', message.slice(0, 160))
        if (/404/.test(message)) borrowGhToken(u, () => void pollOnce())
        return
      }
      // electron-updater fires this several times for one failed check (the feed, the
      // block map, the retry inside its own http executor). Eight identical events in
      // two seconds all reached the badge, and each one re-armed the retry, so a single
      // bad check turned into a loop. One failure is one failure.
      if (message === lastError && Date.now() - lastErrorAt < 5_000) return
      lastError = message
      lastErrorAt = Date.now()

      // Any 404 might be the shadow-hidden account rather than a mid-upload release;
      // borrowing costs one local gh call and applies only if the token proves it can
      // see the releases the anonymous path cannot.
      if (/404/.test(message)) borrowGhToken(u)

      // A Mac never downloads from the feed (autoDownload is off above), so the only
      // thing a failed feed read costs here is the version number - and the releases API
      // still has that even when the release carries no mac assets. Retrying a
      // `latest-mac.yml` 404 that will never resolve is what put a permanent
      // "update failed" in the corner of this app on macOS. Only the feed read is
      // rerouted: a checksum or a download failure still says so.
      if (process.platform === 'darwin' && /\.yml|404/i.test(message)) return macFallback(message)

      if (isPublishing(message)) {
        // The release tag is on GitHub but its assets are still uploading, so
        // latest.yml 404s for the first minute or two after a release goes out. That is
        // the single most common thing this app has ever shown as "check failed", and
        // it is not a failure at all: there is simply nothing installable yet. Say
        // nothing alarming and look again shortly, because there WILL be an update.
        publishRetries++
        set({ phase: 'none', version: undefined, percent: undefined, error: undefined })
        log('publishing', `assets not up yet (try ${publishRetries})`, message.slice(0, 120))
        if (publishRetries <= 12) return schedule(45_000)
        publishRetries = 0
      }

      set({ phase: 'error', error: message, percent: undefined })
      // An 80 MB download dies for boring reasons - a dropped wifi packet, a locked
      // temp file. Left alone the badge reads "update failed" until it is clicked,
      // which looks like the update system is dead. Try again quietly.
      schedule(3 * 60_000)
    })
  }
  setAutoCheck(enabled)
}

/** Turn the background poll on or off; a manual check still works either way. */
export function setAutoCheck(enabled: boolean): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  auto = enabled && app.isPackaged
  if (!auto) return
  // A few seconds after launch, then on its own clock: the app is released several times
  // a day, so a slow poll means running yesterday's build all morning.
  arm(8_000)
}

/** One self-rescheduling timer, so the gap can change with what is going on. */
function arm(ms: number): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => void pollOnce(), ms)
  timer.unref?.()
}

/** One turn of the background poll. Exported so the test can drive it without timers. */
export async function pollOnce(): Promise<void> {
  try {
    // A build already downloaded used to end the story: no further check ever ran, so a
    // newer release that went out in the meantime was only found AFTER restarting into
    // the stale one - one version per restart, which is what "I have to restart it
    // several times" was. Keep looking, and swap the pending build for a newer one.
    if (state.phase === 'ready') await supersede()
    else await checkForUpdates()
  } finally {
    if (auto) arm(pollDelay())
  }
}

/**
 * While a build waits to install, is there an even newer one?
 *
 * Probed with autoDownload off so that asking cannot start a redundant 80 MB download of
 * the build already sitting in the pending folder - the exact failure the guard in
 * checkForUpdates() exists to prevent. Only a strictly newer version is fetched, and the
 * events fired by the probe are ignored (`probing`) so the badge does not flicker
 * through "checking" every minute while a build is ready to go.
 */
async function supersede(): Promise<void> {
  const u = load()
  const pending = state.version
  if (!u || probing || state.phase !== 'ready' || !pending) return
  const restore = u.autoDownload
  probing = true
  try {
    u.autoDownload = false
    const result = (await u.checkForUpdates()) as { updateInfo?: { version?: string } } | null
    const found = result?.updateInfo?.version
    if (!found || !newer(found, pending)) return
    log('supersede', `${pending} -> ${found}`)
    probing = false
    u.autoDownload = restore
    if (process.platform === 'darwin') {
      return offerMac(found)
    }
    set({ phase: 'downloading', version: found, percent: 0 })
    await u.downloadUpdate()
  } catch (e) {
    const message = (e as Error)?.message ?? String(e)
    if (process.platform === 'darwin' && /\.yml|404/i.test(message)) {
      try {
        const found = await latestMacRelease()
        if (!newer(found, pending)) return
        log('supersede fallback', `${pending} -> ${found} (feed has no mac metadata)`)
        probing = false
        u.autoDownload = restore
        return offerMac(found)
      } catch (fallbackError) {
        log('probe error', (fallbackError as Error)?.message ?? String(fallbackError))
        return
      }
    }
    log('supersede failed', message)
  } finally {
    probing = false
    u.autoDownload = restore
  }
}

export async function checkForUpdates(): Promise<UpdateState> {
  const u = load()
  if (!app.isPackaged || !u) return state
  // The bug this guards: with autoDownload on, every check that finds a new version
  // starts a download. A second check fired while the first 80 MB is still in flight
  // starts a SECOND download into the same temp file, and the pair kill each other
  // ("checksum mismatch" / EPERM), so the badge reads "check failed" while the app
  // was in fact updating fine. Clicking the badge again only made it worse. So while
  // a check or download is running, or a build is already downloaded and waiting for
  // a restart, say so instead of starting over.
  if (busy() || state.phase === 'ready') return state
  if (retry) {
    clearTimeout(retry)
    retry = null
  }
  try {
    set({ phase: 'checking', error: undefined })
    await u.checkForUpdates()
  } catch (e) {
    set({ phase: 'error', error: (e as Error)?.message ?? String(e) })
  }
  return state
}

/** True once the installer has actually been launched, so the caller may exit. */
export function installUpdate(): boolean {
  const u = load()
  if (!u || state.phase !== 'ready') return false
  // Written before the installer runs: the next launch compares its own version
  // against this to notice an install that silently did nothing (see checkLastAttempt).
  if (state.version) recordInstallAttempt(state.version)
  // A Mac has no installer to run: the new bundle is already expanded next to the app's
  // data and a detached shell script moves it into place as soon as this process is gone.
  // Same contract as below - true means "something is running that needs this exe to exit".
  if (process.platform === 'darwin') return swapAndRelaunch()
  // Silent: the NSIS installer runs with no window at all, so an update looks like the
  // app blinking rather than a setup wizard taking over the screen. forceRunAfter
  // brings PaneForge straight back up. Both flags matter - a non-silent install shows
  // the progress dialog, and without forceRunAfter a silent one just leaves you with
  // no app. (The build is oneClick NSIS, which needs no answers from the user.)
  // The installer child is spawned synchronously inside this call (detached and unref'd),
  // so it survives - and wants - this process going away the moment we return.
  u.quitAndInstall(true, true)
  return true
}
