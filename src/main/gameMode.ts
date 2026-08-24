// Do not disturb while a game is on screen.
//
// Measured on this machine with CS2 in fullscreen: a foreground probe sampling every
// 200ms sat on "Counter-Strike 2" for 20s untouched, and dropped to the desktop 5.3s
// after `npm run try` launched a second PaneForge - a launch that never calls show(),
// only showInactive() and minimize(). That is the whole problem: on Windows an
// exclusive-fullscreen game loses the screen when *any* window appears, floats above
// it, or flashes its taskbar button. Politely declining the keyboard is not enough,
// because the game was never fighting for the keyboard - it was holding the display.
//
// So while a game is running the app makes itself invisible rather than merely quiet:
// no new windows, no always-on-top overlay, no taskbar flash, no toast, no update
// restart. Everything that was going to interrupt is deferred and happens the moment
// the game exits.
//
// Detection is a process-name watchlist read with `tasklist`, not a fullscreen-window
// query: that needs a P/Invoke, and shelling out to PowerShell to compile one costs
// most of a second per poll on a machine that is by definition busy. tasklist is a
// ~20ms C binary, polled on a slow timer, and the list is editable in Settings.

import { spawn } from 'node:child_process'
import type { Config, GameModeConfig } from '../shared/types'

/** What the rest of the app asks about. `game` is the process that was matched. */
export type GameState = {
  /** true when interruptions must be held back - a game is up, or DND is forced on */
  active: boolean
  /** the matched process name, or null when `active` is only the manual switch */
  game: string | null
  /** the manual "do not disturb" switch, independent of what is running */
  manual: boolean
}

// Steam/Epic top sellers that go exclusive fullscreen by default, plus the launchers'
// own overlay processes are deliberately absent: Steam being open is not playing.
export const DEFAULT_GAMES = [
  'cs2.exe',
  'csgo.exe',
  'dota2.exe',
  'valorant.exe',
  'valorant-win64-shipping.exe',
  'fortniteclient-win64-shipping.exe',
  'r5apex.exe',
  'rustclient.exe',
  'gta5.exe',
  'rdr2.exe',
  'eldenring.exe',
  'overwatch.exe',
  'leagueoflegends.exe',
  'destiny2.exe',
  'palworld-win64-shipping.exe',
  'javaw.exe'
]

/** Nothing is running: the state the app starts in and falls back to on any error. */
const CLEAR: GameState = { active: false, game: null, manual: false }

/**
 * Is PaneForge itself the window on screen right now? Injected by main so this module
 * does not need BrowserWindow (and so the headless test can drive it).
 *
 * A game that is RUNNING is not a game that is ON SCREEN. Measured on this machine:
 * cs2.exe sat in the background with 2h19m of CPU while the user was typing into
 * PaneForge, and the process watchlist alone read that as "do not disturb" all day. So
 * everything the feature holds back was held back indefinitely - the update restart that
 * had already been clicked, the window reveal, the toast - and the sidebar simply said
 * "quiet" with no way out. That is the one cause behind both "why does it show quiet"
 * and "installing from the update popup does nothing".
 *
 * Our own window having focus settles it with no P/Invoke and no extra poll: an
 * exclusive-fullscreen game does not hold the display while a different app owns the
 * keyboard. If the user is typing in here, there is nothing left to protect.
 */
let focusProbe: (() => boolean) | null = null

/** Main hands over "is my window the focused one". Safe to clear with null. */
export function setFocusProbe(fn: (() => boolean) | null): void {
  focusProbe = fn
}

/**
 * Is somebody demonstrably AT this window right now?
 *
 * Exported because `autoAnswer` needs the same reading for a different reason: its wait is
 * the window in which a person who disagrees reaches the pane, which is only meaningful
 * while that person is not already here. One probe rather than a second one wired
 * separately - two answers to "is this window focused" is how they end up disagreeing.
 */
export function deskFocused(): boolean {
  return weAreOnScreen()
}

/** Never allowed to be the reason DND turns ON - only ever the reason it turns off. */
function weAreOnScreen(): boolean {
  if (!focusProbe) return false
  try {
    return focusProbe()
  } catch {
    // A window on its way out must not decide this.
    return false
  }
}

let state: GameState = CLEAR
let cfg: GameModeConfig | null = null
let timer: NodeJS.Timeout | null = null
let listeners: ((s: GameState) => void)[] = []
let polling = false

// Work that was due while a game was on: an update restart, a window that wanted to
// appear. Keyed so a poll every 15s cannot queue the same restart forty times.
const deferred = new Map<string, () => void>()

export function gameState(): GameState {
  return state
}

export function isGameActive(): boolean {
  return state.active
}

/** Called on every transition, with the new state. Used to hide/show the overlay. */
export function onGameState(fn: (s: GameState) => void): void {
  listeners.push(fn)
}

/**
 * Run `fn` now if the screen is free, or the moment the game exits if it is not.
 * `key` collapses repeats - the same deferred restart queued twice is still one
 * restart. Returns true when it ran immediately.
 */
export function whenClear(key: string, fn: () => void): boolean {
  if (!state.active) {
    fn()
    return true
  }
  deferred.set(key, fn)
  return false
}

/** Drop a queued item without running it (the update was superseded, the window closed). */
export function cancelDeferred(key: string): void {
  deferred.delete(key)
}

export function deferredCount(): number {
  return deferred.size
}

function emit(next: GameState): void {
  const changed =
    next.active !== state.active || next.game !== state.game || next.manual !== state.manual
  state = next
  if (!changed) return
  for (const fn of listeners) {
    try {
      fn(state)
    } catch {
      /* a listener that throws must not stop the others or wedge the poller */
    }
  }
  // Everything that was waiting for the screen goes now.
  if (!state.active) releaseDeferred()
}

/**
 * Run and clear everything that was waiting for the screen.
 *
 * Cleared before anything runs, so a callback that re-queues itself does not run twice.
 * Separate from `emit` because the queue can come due without the state changing: a game
 * that is running but is not the window you are looking at still holds nothing back.
 */
function releaseDeferred(): void {
  if (!deferred.size) return
  const due = [...deferred.values()]
  deferred.clear()
  for (const fn of due) {
    try {
      fn()
    } catch {
      /* one failed deferred action must not swallow the rest */
    }
  }
}

/**
 * Image names of every running process, lowercased. `tasklist /NH /FO CSV` is one
 * quoted field per column, and the first is the name - no CSV parser needed for a
 * field that cannot contain a comma.
 */
function runningProcesses(): Promise<Set<string>> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(new Set())
    let out = ''
    let done = false
    const finish = (s: Set<string>): void => {
      if (done) return
      done = true
      resolve(s)
    }
    try {
      const p = spawn('tasklist', ['/NH', '/FO', 'CSV'], { windowsHide: true })
      // A tasklist that hangs (it can, on a machine under load) must not leave the
      // poller stuck forever with no state and no next poll.
      const kill = setTimeout(() => {
        try {
          p.kill()
        } catch {
          /* already gone */
        }
        finish(new Set())
      }, 5000)
      p.stdout.on('data', (d) => (out += d))
      p.on('error', () => {
        clearTimeout(kill)
        finish(new Set())
      })
      p.on('close', () => {
        clearTimeout(kill)
        const names = new Set<string>()
        for (const line of out.split('\n')) {
          const m = /^"([^"]+)"/.exec(line.trim())
          if (m) names.add(m[1].toLowerCase())
        }
        finish(names)
      })
    } catch {
      finish(new Set())
    }
  })
}

function watchlist(): string[] {
  const list = cfg?.processes?.length ? cfg.processes : DEFAULT_GAMES
  return list.map((n) => n.trim().toLowerCase()).filter(Boolean)
}

/**
 * The image name of whatever owns the foreground window right now, or null.
 *
 * This is the answer `weAreOnScreen()` cannot give during a launch, and the gap between
 * the two is the whole "PaneForge did not come back after the update" bug. The focus
 * probe asks whether OUR window is visible and focused - but at reveal time the window
 * has deliberately never been shown, so it is false by construction. A game left running
 * in the background therefore held the reveal back, the reveal was the only thing that
 * could have made the probe true, and nothing but the game exiting could break the ring.
 * Measured: a restart with cs2.exe idling behind the desktop produced a running app with
 * no window and no taskbar button - indistinguishable from an update that never restarted.
 *
 * Asking Windows costs a PowerShell that compiles a P/Invoke, which is why the 15s poller
 * still uses `tasklist` and this is reserved for the moments something is actually being
 * held back. Anything that goes wrong answers null, and null never holds a window back.
 */
function foregroundProcess(): Promise<string | null> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null)
    let out = ''
    let done = false
    const finish = (v: string | null): void => {
      if (done) return
      done = true
      resolve(v)
    }
    const script = [
      "Add-Type -Namespace PF -Name Fg -MemberDefinition '[DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern int GetWindowThreadProcessId(IntPtr h, out int p);'",
      '$h=[PF.Fg]::GetForegroundWindow()',
      '$p=0',
      '[void][PF.Fg]::GetWindowThreadProcessId($h,[ref]$p)',
      '$pr=Get-Process -Id $p -ErrorAction SilentlyContinue',
      'if ($pr) { Write-Output "$($pr.ProcessName).exe" }'
    ].join('; ')
    try {
      const p = spawn(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { windowsHide: true }
      )
      const kill = setTimeout(() => {
        try {
          p.kill()
        } catch {
          /* already gone */
        }
        finish(null)
      }, 4000)
      p.stdout.on('data', (d) => (out += d))
      p.on('error', () => {
        clearTimeout(kill)
        finish(null)
      })
      p.on('close', () => {
        clearTimeout(kill)
        const name = out.trim().split('\n')[0]?.trim().toLowerCase()
        finish(name || null)
      })
    } catch {
      finish(null)
    }
  })
}

/**
 * Is a game the window on screen right now - not merely a process that exists?
 *
 * The one question worth a P/Invoke, asked only where the answer decides whether the app
 * is allowed to have a window at all. False on anything unexpected: a check that failed
 * must never be the reason PaneForge stays invisible.
 */
export async function gameIsForeground(): Promise<boolean> {
  const front = await (frontProbe ?? foregroundProcess)()
  if (!front) return false
  return watchlist().includes(front.toLowerCase())
}

/**
 * Swap the foreground query out. Only the headless test uses this: it stubs
 * `child_process` wholesale for `tasklist`, so without a seam the PowerShell above would
 * be handed a process listing and "what is on screen" would be whatever the CSV happened
 * to start with.
 */
let frontProbe: (() => Promise<string | null>) | null = null
export function setForegroundProbe(fn: (() => Promise<string | null>) | null): void {
  frontProbe = fn
}

/**
 * One detection pass. Exported so the moments that matter most - about to restart for
 * an update, about to open a window - can ask right now instead of trusting a reading
 * that could be 15 seconds old.
 */
export async function checkNow(): Promise<GameState> {
  const manual = !!cfg?.manual
  // Forced on: no reason to spend a process listing to find out what we already know.
  if (manual) {
    emit({ active: true, game: state.game, manual: true })
    return state
  }
  if (!cfg?.enabled) {
    emit(CLEAR)
    return state
  }
  // The person is here. Whatever is running behind this window is not on the screen, so
  // nothing needs holding back - and anything that was held goes now (see emit()).
  // Checked before the process listing on purpose: it also saves the tasklist spawn for
  // the whole time the app is the thing being used.
  if (weAreOnScreen()) {
    emit(CLEAR)
    return state
  }
  const running = await runningProcesses()
  const hit = watchlist().find((n) => running.has(n)) ?? null
  emit({ active: !!hit, game: hit, manual: false })
  // Work already waiting is judged against the SCREEN rather than the process list, and
  // only while there is work waiting - which is what keeps the P/Invoke off the ordinary
  // poll. Without it the queue drained only when the game process exited: alt-tabbing out
  // of a game you had left running was not enough, so an update restart and a window
  // reveal could sit there for hours with the desktop plainly in view. The state itself
  // is left alone on purpose - a game IS still running, and the next interruption can go
  // on being held until the user's own focus settles it.
  if (hit && deferred.size && !(await gameIsForeground())) releaseDeferred()
  return state
}

// Idle is the common case and wants to notice a game starting reasonably soon. Once a
// game is up the only open question is when it ends, and that answer keeps: poll half
// as often, so the busiest moment on the machine is also the quietest one here.
const POLL_IDLE_MS = 15_000
const POLL_ACTIVE_MS = 30_000

function schedule(): void {
  if (timer) clearTimeout(timer)
  const ms = state.active ? POLL_ACTIVE_MS : POLL_IDLE_MS
  timer = setTimeout(tick, ms)
  // Never the reason the process stays alive at quit.
  timer.unref?.()
}

async function tick(): Promise<void> {
  if (polling) return schedule()
  polling = true
  try {
    await checkNow()
  } finally {
    polling = false
    schedule()
  }
}

/** Start watching. Safe to call again - later calls only re-read the config. */
export function startGameWatch(config: Config): void {
  cfg = config.gameMode
  if (!timer) void tick()
  else void checkNow().then(schedule)
}

/** Config changed in Settings: adopt it and re-evaluate without waiting for the timer. */
export function refreshGameWatch(config: Config): void {
  cfg = config.gameMode
  if (!cfg.enabled && !cfg.manual) {
    // Turning the feature off releases whatever it was holding back, or the queued
    // update would sit there until the next game started and ended.
    emit(CLEAR)
    if (timer) clearTimeout(timer)
    timer = null
    return
  }
  if (!timer) void tick()
  else void checkNow().then(schedule)
}

export function stopGameWatch(): void {
  if (timer) clearTimeout(timer)
  timer = null
  listeners = []
  deferred.clear()
  state = CLEAR
}
