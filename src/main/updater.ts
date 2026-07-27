// Background updates from GitHub Releases, with a Claude-desktop style prompt:
// the download happens quietly, and the only thing the user ever sees is
// "version X is ready - restart now?".
//
// The feed is the public releases of this repo, so no token ships in the app.
// In `npm run dev` there is no update metadata next to the binary, so the whole
// thing reports 'unsupported' instead of throwing on every launch.

import { appendFileSync, existsSync, statSync, truncateSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { UpdateState } from '../shared/types'
import { lastShip } from './laneBoard'

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
    // macOS refuses to swap in an unsigned update: Squirrel.Mac validates the code
    // signature, and this app ships unsigned. So on a Mac the app finds the new
    // version and hands you the release page instead of pretending it can self-update.
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
    u.on('checking-for-update', () => {
      if (probing) return
      set({ phase: 'checking', error: undefined })
    })
    u.on('update-available', (info: { version: string; releaseNotes?: string }) => {
      if (probing) return
      publishRetries = 0
      lastError = ''
      set({
        phase: process.platform === 'darwin' ? 'available' : 'downloading',
        version: info?.version,
        percent: 0,
        notes: notes(info?.releaseNotes),
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
    u.on('update-downloaded', (info: { version: string; releaseNotes?: string }) =>
      set({ phase: 'ready', version: info?.version, percent: 100, notes: notes(info?.releaseNotes) })
    )
    u.on('error', (e: Error) => {
      const message = e?.message ?? String(e)
      // A probe that fails changes nothing: the build already downloaded is still there
      // and still installable, and saying "update failed" over it would be a lie.
      if (probing) return log('probe error', message.slice(0, 160))
      // electron-updater fires this several times for one failed check (the feed, the
      // block map, the retry inside its own http executor). Eight identical events in
      // two seconds all reached the badge, and each one re-armed the retry, so a single
      // bad check turned into a loop. One failure is one failure.
      if (message === lastError && Date.now() - lastErrorAt < 5_000) return
      lastError = message
      lastErrorAt = Date.now()

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
    set({ phase: 'downloading', version: found, percent: 0 })
    await u.downloadUpdate()
  } catch (e) {
    log('supersede failed', (e as Error)?.message ?? String(e))
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

function notes(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw.replace(/<[^>]+>/g, '').trim().slice(0, 600)
  if (Array.isArray(raw)) {
    return raw
      .map((n: { note?: string }) => n?.note ?? '')
      .join('\n')
      .replace(/<[^>]+>/g, '')
      .trim()
      .slice(0, 600)
  }
  return undefined
}
