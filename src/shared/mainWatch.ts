// The arithmetic for the process that watches the Electron main process.
//
// This deliberately counts the watchdog's own ticks rather than only elapsed wall time.
// A laptop sleep pauses both processes, and must not look like a frozen app after wake.

export const BEAT_MS = 2_000
export const HANG_MS = 75_000
const SLEEP_GAP_MS = BEAT_MS * 3

export interface MainWatchState {
  receivedBeat: boolean
  silentTicks: number
  lastTickAt: number
  acted: boolean
}

export type MainWatchAction = 'wait' | 'act'

export function fresh(): MainWatchState {
  return { receivedBeat: false, silentTicks: 0, lastTickAt: 0, acted: false }
}

/** Accepting a beat resets only the consecutive-miss reading. */
export function beat(state: MainWatchState): MainWatchState {
  return { ...state, receivedBeat: true, silentTicks: 0 }
}

/** One child timer tick. The returned state makes this decision testable without Electron. */
export function decide(state: MainWatchState, now: number, hangMs = HANG_MS): { action: MainWatchAction; state: MainWatchState } {
  if (state.acted) return { action: 'wait', state: { ...state, lastTickAt: now } }
  // One long gap is suspend or wake, not a missed heartbeat. Start a fresh count after it.
  if (state.lastTickAt && now - state.lastTickAt > SLEEP_GAP_MS) {
    return { action: 'wait', state: { ...state, silentTicks: 0, lastTickAt: now } }
  }
  const silentTicks = state.receivedBeat ? state.silentTicks + 1 : 0
  const next = { ...state, silentTicks, lastTickAt: now }
  if (!state.receivedBeat || silentTicks * BEAT_MS < hangMs) return { action: 'wait', state: next }
  return { action: 'act', state: { ...next, acted: true } }
}
