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
  // Everything that was waiting for the screen goes now, and is cleared first so a
  // callback that re-queues itself does not run twice.
  if (!state.active && deferred.size) {
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
  const running = await runningProcesses()
  const hit = watchlist().find((n) => running.has(n)) ?? null
  emit({ active: !!hit, game: hit, manual: false })
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
