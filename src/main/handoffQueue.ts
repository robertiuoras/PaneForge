// Panes asked for mid-turn, moved the moment the turn ends.
//
// `sendHandoff` kills the pty once the far end has its replacement running, and a pty
// killed mid-turn loses the answer being written: the receiver resumes from the transcript
// file, which only holds turns the CLI has already flushed to disk. Refusing a busy pane
// would be honest and useless - the pane somebody wants moved is usually the one that is
// working. So a busy pane is HELD here and moved on its own, which is what makes "hand it
// off mid-turn" mean the move happens as soon as it can rather than the turn being lost.
//
// Three things this may not do, all of them learned elsewhere in this app:
//
//   - It may not kill anything to make progress. A pane that never goes quiet EXPIRES: the
//     entry is dropped and said out loud. An automatic action whose consequence is losing
//     an unfinished answer has to fail visibly rather than succeed destructively.
//   - It may not act on a stale reading. Every tick re-asks `list()` for the pane's state
//     rather than trusting what was true when it was queued.
//   - It may not leave a pane marked. `handingOff` is what stops `reclaim.ts` closing a
//     pane out from under a move in flight, so every exit from this file clears it -
//     including the expiry and the pane simply disappearing.

import { queueVerdict, type AutoHandoffConfig, type Queued } from '../shared/autoHandoff'
import type { HandoffItem } from '../shared/handoff'
import type { Session } from '../shared/types'

/** How often the queue looks. A turn ending is not worth a faster clock than this. */
export const TICK_MS = 5_000

export interface QueueDeps {
  list(): Session[]
  /** the pane is mid-turn or holding a question it drew on screen */
  busy(s: Session): boolean
  /** move it now - the same path the button takes, with the wait already spent */
  send(id: string, device: string, closeReceiverWhenDone: boolean): Promise<HandoffItem[]>
  /** paint the pane as on its way, so nothing else closes or moves it */
  mark(id: string, on: boolean): void
  deviceName(device: string): string
  config(): AutoHandoffConfig
  log(line: string): void
  now?(): number
}

export class HandoffQueue {
  private entries = new Map<string, Queued>()
  private timer: NodeJS.Timeout | null = null
  private running = new Set<string>()

  constructor(private deps: QueueDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  /** What is waiting, for the panel and for a test. */
  pending(): Queued[] {
    return [...this.entries.values()]
  }

  waitingFor(id: string): string | null {
    const q = this.entries.get(id)
    return q ? this.deps.deviceName(q.device) : null
  }

  add(id: string, device: string, closeReceiverWhenDone = false): void {
    // Re-queueing an id keeps its ORIGINAL wait: pressing the button again while a pane is
    // still working must not push its deadline out for ever.
    const had = this.entries.get(id)
    this.entries.set(id, { id, device, since: had?.since ?? this.now(), closeReceiverWhenDone })
    this.deps.mark(id, true)
    if (!had) this.deps.log(`handoff: ${id} queued for ${this.deps.deviceName(device)} - waiting for the turn to end`)
    this.arm()
  }

  /** A person changed their mind, or the pane was closed by hand. */
  drop(id: string): void {
    if (!this.entries.delete(id)) return
    this.deps.mark(id, false)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private arm(): void {
    if (this.timer || !this.entries.size) return
    this.timer = setInterval(() => this.tick(), TICK_MS)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  /** Exposed so a test drives the clock rather than waiting on one. */
  tick(): void {
    if (!this.entries.size) {
      this.stop()
      return
    }
    const cfg = this.deps.config()
    const now = this.now()
    const panes = new Map(this.deps.list().map((s) => [s.id, s]))
    for (const q of [...this.entries.values()]) {
      if (this.running.has(q.id)) continue
      const pane = panes.get(q.id)
      const state = pane
        ? {
            // The queue's own reading of busy is the one that decides, not fleetState:
            // `busy` covers a live question as well as a turn, and both must hold the move.
            state: (this.deps.busy(pane) ? 'working' : 'ready') as 'working' | 'ready',
            asking: false
          }
        : undefined
      const verdict = queueVerdict(q, pane ? state : undefined, cfg, now)
      if (verdict === 'wait') continue
      this.entries.delete(q.id)
      if (verdict === 'drop') {
        this.deps.mark(q.id, false)
        continue
      }
      if (verdict === 'expired') {
        this.deps.mark(q.id, false)
        this.deps.log(
          `handoff: ${q.id} gave up waiting after ${Math.round((now - q.since) / 60000)} min - still working, so it stays here`
        )
        continue
      }
      this.run(q)
    }
    if (!this.entries.size) this.stop()
  }

  private run(q: Queued): void {
    this.running.add(q.id)
    void this.deps
      .send(q.id, q.device, q.closeReceiverWhenDone === true)
      .then((items) => {
        const item = items[0]
        if (item?.ok) this.deps.log(`handoff: ${q.id} moved to ${this.deps.deviceName(q.device)} - its turn had ended`)
        else this.deps.log(`handoff: ${q.id} could not move - ${item?.error ?? 'refused over there'}`)
      })
      .catch((err: Error) => this.deps.log(`handoff: ${q.id} could not move - ${err.message}`))
      .finally(() => {
        this.running.delete(q.id)
        // Whatever happened, the pane is no longer on its way: a failed move must not
        // leave a pane that reclaim will never close and the queue will never retry.
        this.deps.mark(q.id, false)
      })
  }
}
