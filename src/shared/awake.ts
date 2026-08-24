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

/** The three fields of a pane this reads. Loose so a test can build one. */
export interface AwakePane {
  /** epoch ms the current turn started, absent when nothing is running */
  runSince?: number
  status: string
  /** the pane is sitting on a question it drew on screen */
  asking?: boolean
}

export interface AwakeInput {
  panes: readonly AwakePane[]
  /** the setting. Off means this feature does nothing at all. */
  enabled: boolean
  now: number
  /** epoch ms the current busy stretch began; null when the desk was last quiet */
  busySince: number | null
  /** how long one unbroken busy stretch may hold the display. Default 3h. */
  maxHoldMs?: number
}

export interface AwakeVerdict {
  hold: boolean
  /** Why, in the words that go in the log line - both ways round. */
  reason: string
  /** How many panes counted as working. 0 whenever a refusal fired first. */
  busy: number
}

export const DEFAULT_MAX_HOLD_MS = 3 * 60 * 60_000

/** A pane with an agent mid-turn, or one holding a question nobody has answered. */
export function awakeBusy(panes: readonly AwakePane[]): number {
  return panes.filter((p) => (p.runSince || p.asking) && p.status !== 'exited').length
}

export function awakeVerdict(input: AwakeInput): AwakeVerdict {
  if (!input.enabled) return { hold: false, reason: 'off', busy: 0 }
  const busy = awakeBusy(input.panes)
  if (!busy) return { hold: false, reason: 'nothing running', busy: 0 }
  const cap = input.maxHoldMs ?? DEFAULT_MAX_HOLD_MS
  if (input.busySince !== null && input.now - input.busySince > cap) {
    const hours = Math.round((input.now - input.busySince) / 360_000) / 10
    return { hold: false, reason: `busy ${hours}h without a break - past the cap`, busy }
  }
  return { hold: true, reason: `${busy} pane${busy === 1 ? '' : 's'} working`, busy }
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
      maxHoldMs: this.deps.maxHoldMs
    })
    if (verdict.hold && this.id === null) {
      this.id = this.deps.start()
      this.say(`display held awake - ${verdict.reason}`)
    } else if (!verdict.hold && this.id !== null) {
      this.deps.stop(this.id)
      this.id = null
      this.say(`display released - ${verdict.reason}`)
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
    this.say('display released - shutting down')
  }

  private say(line: string): void {
    if (line === this.lastReason) return
    this.lastReason = line
    this.deps.log?.(line)
  }
}
