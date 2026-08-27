// Whether the display may go to sleep while this app has work running.
//
// Why it exists (2026-08-23, Robert's words): "dont sleep if sessions running in
// paneforge because right now its sleep/screen off to quickly". On battery this Mac
// had `displaysleep 1` - one minute - so an agent working for ten minutes did it
// behind a black screen, and a question it drew was never seen.
//
// The decision is separate from `powerSaveBlocker` on purpose: holding a machine
// awake is a battery cost, so every refusal here is worth a test, and none of them
// can be exercised through Electron.
//
// The cap is the load-bearing one. A pane whose agent WEDGED keeps `runSince` set
// for as long as the app is open, and without a cap "an agent is working" would keep
// the screen lit all night on a laptop nobody is at. The cap is on the BUSY STRETCH,
// not on the hold: it resets only when the desk actually goes quiet, so a wedged pane
// cannot re-arm it by ticking.

/** The fields of a pane this reads. Loose so a test can build one. */
export interface AwakePane {
  /** epoch ms the current turn started, absent when nothing is running */
  runSince?: number
  status: string
  /** the pane is sitting on a question it drew on screen */
  asking?: boolean
  /** foreground command running in a shell pane */
  job?: string
  /** background shell / monitor / watcher tasks under the pane */
  backJobsCount?: number
  /** dev server processes running for this pane / project */
  devServersCount?: number
  /** epoch ms of the most recent output or logs */
  lastOutput?: number
  /** epoch ms of the most recent keyboard input */
  lastKeyboard?: number
}

export interface AwakeInput {
  panes: readonly AwakePane[]
  /** the setting. Off means this feature does nothing at all. */
  enabled: boolean
  now: number
  /** epoch ms the current busy stretch began; null when the desk was last quiet */
  busySince: number | null
  /** how long one unbroken busy stretch may hold the system. Default 3h. */
  maxHoldMs?: number
  /**
   * Nobody can SEE this machine's screen: the lid is shut and the builtin panel is the
   * only display there is.
   *
   * The system hold and the screen hold are separate decisions and this is the one input
   * that only the screen hold cares about. `pmset -a disablesleep 1` - which the lid
   * guard sets so a working pane survives a lid-close - makes the kernel ignore the lid
   * OUTRIGHT, backlight included, so a shut MacBook runs its OLED at full brightness for
   * the whole session with nobody looking at it. Holding the MACHINE awake never
   * justified lighting the PANEL.
   *
   * It is deliberately narrower than "the lid is shut": clamshell driving an external
   * monitor also reports the lid shut, and blanking THAT is a desk going black mid-use.
   * A reading that failed counts as false, so the fallback is the behaviour this app
   * always had, never a dark screen somebody is reading.
   */
  screenUnseen?: boolean
}

export interface AwakeVerdict {
  hold: boolean
  /** Whether the SCREEN must stay lit. Narrower than `hold` on purpose - see awakeDisplayBusy. */
  holdDisplay: boolean
  /** Why, in the words that go in the log line - both ways round. */
  reason: string
  /** How many panes counted as working. 0 whenever a refusal fired first. */
  busy: number
}

export const DEFAULT_MAX_HOLD_MS = 3 * 60 * 60_000
/** Keep awake for 5 minutes after recent logs or output so reading logs does not turn off the screen */
export const RECENT_LOGS_HOLD_MS = 5 * 60_000
/**
 * How long after the last KEYPRESS the screen stays lit (2026-08-27, Robert's words:
 * "screen not turning off after like 5mins of inactivity ... but laptop still should run
 * in background"). Work running is a reason to keep the MACHINE awake; it is not a reason
 * to keep the SCREEN lit at an empty desk, which is what was draining the battery.
 */
export const RECENT_KEYBOARD_HOLD_MS = 5 * 60_000

/** A pane with an agent mid-turn, one holding a question, a shell running a command, recent log output, or a background job/monitor. */
export function awakeBusy(panes: readonly AwakePane[], now?: number): number {
  const currentNow = now ?? Date.now()
  return panes.filter((p) => {
    if (p.status === 'exited') return false
    if (p.runSince || p.asking) return true
    if (p.status === 'working' || p.status === 'starting') return true
    if (p.job) return true
    if ((p.backJobsCount ?? 0) > 0) return true
    if ((p.devServersCount ?? 0) > 0) return true
    if (p.lastOutput && currentNow - p.lastOutput < RECENT_LOGS_HOLD_MS) return true
    if (p.lastKeyboard && currentNow - p.lastKeyboard < RECENT_LOGS_HOLD_MS) return true
    return false
  }).length
}

/**
 * Panes that justify keeping the SCREEN on: one sitting on a question he has to answer,
 * or one he typed into in the last few minutes. Agent turns, shell jobs, dev servers and
 * log output all keep the SYSTEM awake (awakeBusy) but deliberately do not count here.
 */
export function awakeDisplayBusy(panes: readonly AwakePane[], now?: number): number {
  const currentNow = now ?? Date.now()
  return panes.filter((p) => {
    if (p.status === 'exited') return false
    if (p.asking) return true
    if (p.lastKeyboard && currentNow - p.lastKeyboard < RECENT_KEYBOARD_HOLD_MS) return true
    return false
  }).length
}

export function awakeVerdict(input: AwakeInput): AwakeVerdict {
  if (!input.enabled) return { hold: false, holdDisplay: false, reason: 'off', busy: 0 }
  const busy = awakeBusy(input.panes, input.now)
  if (!busy) return { hold: false, holdDisplay: false, reason: 'nothing running', busy: 0 }
  const cap = input.maxHoldMs ?? DEFAULT_MAX_HOLD_MS
  if (input.busySince !== null && input.now - input.busySince > cap) {
    const hours = Math.round((input.now - input.busySince) / 360_000) / 10
    return {
      hold: false,
      holdDisplay: false,
      reason: `busy ${hours}h without a break - past the cap`,
      busy
    }
  }
  const displayBusy = awakeDisplayBusy(input.panes, input.now)
  if (input.screenUnseen) {
    return {
      hold: true,
      holdDisplay: false,
      reason: `${busy} pane${busy === 1 ? '' : 's'} working, lid shut so the screen may sleep`,
      busy
    }
  }
  return {
    hold: true,
    holdDisplay: displayBusy > 0,
    reason: displayBusy
      ? `${busy} pane${busy === 1 ? '' : 's'} working, ${displayBusy} needing the screen`
      : `${busy} pane${busy === 1 ? '' : 's'} working, screen free to sleep`,
    busy
  }
}

/**
 * The stretch clock. Kept here rather than in main so the cap is testable: it is the
 * only part of this feature that has to remember anything between ticks.
 *
 * `busySince` moves ONLY on the 0 -> n edge. A tick that finds work already running
 * leaves it alone, which is what makes the cap measure the stretch instead of the tick.
 */
export function nextBusySince(prev: number | null, busy: number, now: number): number | null {
  if (!busy) return null
  return prev === null ? now : prev
}

/**
 * The thing that holds the display awake, with the power API injected.
 *
 * Injected because `powerSaveBlocker` only exists inside a running Electron app, and a
 * feature that can only be exercised in production is a feature that ships untested -
 * the cap especially, which by definition takes hours to reach.
 */
export interface AwakeDeps {
  panes(): readonly AwakePane[]
  enabled(): boolean
  /** start a display-sleep blocker, returns its id */
  start(): number
  stop(id: number): void
  now(): number
  maxHoldMs?: number
  /** Nobody can see the screen - see `AwakeInput.screenUnseen`. Absent counts as false. */
  screenUnseen?(): boolean
  log?(line: string): void
}

export class AwakeKeeper {
  private id: number | null = null
  private busySince: number | null = null
  private lastReason = ''

  constructor(private deps: AwakeDeps) {}

  /** Look at the desk now and hold or release. Safe to call as often as you like. */
  tick(): AwakeVerdict {
    const now = this.deps.now()
    const panes = this.deps.panes()
    const busy = awakeBusy(panes)
    this.busySince = nextBusySince(this.busySince, busy, now)
    const verdict = awakeVerdict({
      panes,
      enabled: this.deps.enabled(),
      now,
      busySince: this.busySince,
      maxHoldMs: this.deps.maxHoldMs,
      screenUnseen: this.deps.screenUnseen?.() ?? false
    })
    if (verdict.hold && this.id === null) {
      this.id = this.deps.start()
      this.say(`system held awake - ${verdict.reason}`)
    } else if (!verdict.hold && this.id !== null) {
      this.deps.stop(this.id)
      this.id = null
      this.say(`system sleep released - ${verdict.reason}`)
    }
    return verdict
  }

  /** Held right now? */
  holding(): boolean {
    return this.id !== null
  }

  /** Let go, whatever the desk looks like. For app shutdown. */
  release(): void {
    if (this.id === null) return
    this.deps.stop(this.id)
    this.id = null
    this.say('system sleep released - shutting down')
  }

  private say(line: string): void {
    if (line === this.lastReason) return
    this.lastReason = line
    this.deps.log?.(line)
  }
}
