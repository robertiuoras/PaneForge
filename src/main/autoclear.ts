// The countdown in flight, and the keystrokes at the end of it. Every judgement is in
// shared/autoclear.ts; this file is the clock, the pty and the broadcast.
//
// Deliberately dependency-injected and importing nothing from Electron: the test drives a
// real countdown against fake panes, including the four refusals - which is the half that
// matters, because each one exists to stop an automatic /clear landing on live work.
import {
  acceptClear,
  clearChunks,
  clearTick,
  CLEAR_CHUNK_GAP_MS,
  type ClearAsk,
  type ClearPane,
  type ClearRequest
} from '../shared/autoclear'

/** How often a countdown re-reads the desk. The card counts down on its own clock. */
export const CLEAR_TICK_MS = 1_000

export interface ClearDeps {
  /** every pane on this desk, now */
  panes(): readonly (ClearPane & { title?: string })[]
  /** bytes into a pane's pty - the same path a keystroke takes */
  write(id: string, data: string): void
  /** tell the window what is pending, every time it changes */
  changed(pending: ClearAsk[]): void
  now(): number
  log?(line: string): void
  /** injected so a test does not wait in real seconds */
  after?(fn: () => void, ms: number): void
}

export type ClearAnswer = 'cancel' | 'now'

export class ClearCountdown {
  private asks = new Map<string, ClearAsk>()
  private firing = new Set<string>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private deps: ClearDeps) {}

  /** A hook asking for a pane to be cleared. Answers with the countdown, or with why not. */
  request(req: ClearRequest): { ok: true; ask: ClearAsk } | { ok: false; reason: string } {
    const pane = this.deps.panes().find((p) => p.id === req.paneId)
    const verdict = acceptClear(req, pane, this.deps.now(), pane?.title ?? '')
    if (!verdict.ok) {
      this.deps.log?.(`clear refused for ${req.paneId}: ${verdict.reason}`)
      return verdict
    }
    // A second ask for the same pane REPLACES the first rather than stacking: the hook
    // fires once per Stop, and two cards for one pane would each type their own /clear.
    this.asks.set(verdict.ask.paneId, verdict.ask)
    this.deps.log?.(
      `clear countdown for ${verdict.ask.paneId} (${verdict.ask.steps.length} step(s), ` +
        `${Math.round((verdict.ask.dueAt - verdict.ask.askedAt) / 1000)}s)`
    )
    this.announce()
    this.arm()
    return verdict
  }

  /** The buttons on the card. `now` skips the rest of the countdown. */
  answer(paneId: string, action: ClearAnswer): boolean {
    const ask = this.asks.get(paneId)
    if (!ask) return false
    if (action === 'cancel') {
      this.asks.delete(paneId)
      this.deps.log?.(`clear cancelled for ${paneId}`)
      this.announce()
      return true
    }
    this.fire(ask)
    return true
  }

  pending(): ClearAsk[] {
    return [...this.asks.values()]
  }

  /** Re-read the desk. Nothing here trusts what was true when the ask arrived. */
  tick(): void {
    if (!this.asks.size) return
    const panes = this.deps.panes()
    const now = this.deps.now()
    let changed = false
    for (const ask of [...this.asks.values()]) {
      if (this.firing.has(ask.paneId)) continue
      const verdict = clearTick(ask, panes.find((p) => p.id === ask.paneId), now)
      if (verdict.act === 'wait') continue
      if (verdict.act === 'drop') {
        this.asks.delete(ask.paneId)
        this.deps.log?.(`clear dropped for ${ask.paneId}: ${verdict.reason}`)
        changed = true
        continue
      }
      this.fire(ask)
      changed = true
    }
    if (changed) this.announce()
    if (!this.asks.size) this.disarm()
  }

  stop(): void {
    this.disarm()
    this.asks.clear()
    this.firing.clear()
  }

  /**
   * Type it. The chunks are separate writes `CLEAR_CHUNK_GAP_MS` apart because the CLI
   * has to finish clearing before the prompt arrives, and because a long single write is
   * read as a paste - see shared/autoclear.ts.
   */
  private fire(ask: ClearAsk): void {
    if (this.firing.has(ask.paneId)) return
    this.firing.add(ask.paneId)
    this.asks.delete(ask.paneId)
    this.announce()
    const chunks = clearChunks(ask.prompt)
    const after = this.deps.after ?? ((fn: () => void, ms: number) => void setTimeout(fn, ms))
    chunks.forEach((chunk, i) => {
      const send = (): void => {
        this.deps.write(ask.paneId, chunk)
        if (i === chunks.length - 1) this.firing.delete(ask.paneId)
      }
      if (i === 0) send()
      else after(send, CLEAR_CHUNK_GAP_MS * i)
    })
    this.deps.log?.(`clear typed into ${ask.paneId}`)
  }

  private announce(): void {
    this.deps.changed(this.pending())
  }

  private arm(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), CLEAR_TICK_MS)
    this.timer.unref?.()
  }

  private disarm(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }
}
