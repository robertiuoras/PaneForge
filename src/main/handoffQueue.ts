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
  /**
   * Paint the pane as on its way, so nothing else closes or moves it.
   *
   * `queuedAt` says it is WAITING rather than moving, which is a different sentence on the
   * card - and it is dropped the moment the move really starts.
   */
  mark(id: string, on: boolean, queuedAt?: number): void
  deviceName(device: string): string
  config(): AutoHandoffConfig
  log(line: string): void
  /**
   * Say it to the PERSON, not just the log. A queued move finishes minutes after the
   * button was pressed - the dialog that flashed "it goes as soon as the turn ends" is
   * long closed, and the phone never had one - so `log()` alone meant a pane vanished
   * from the desk with no reason on screen. That reads as a frozen session, not a move.
   */
  notify?(line: string): void
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
    const since = had?.since ?? this.now()
    this.entries.set(id, { id, device, since, closeReceiverWhenDone })
    this.deps.mark(id, true, since)
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
        const mins = Math.round((now - q.since) / 60000)
        this.deps.log(`handoff: ${q.id} gave up waiting after ${mins} min - still working, so it stays here`)
        this.deps.notify?.(
          `${this.paneName(q.id, panes)} did not move to ${this.deps.deviceName(q.device)} - still working after ${mins} min, so it stays here`
        )
        continue
      }
      this.run(q)
    }
    if (!this.entries.size) this.stop()
  }

  /** The pane's title if it is still listed, else its id - a message needs a name. */
  private paneName(id: string, panes?: Map<string, Session>): string {
    const found = (panes ?? new Map(this.deps.list().map((s) => [s.id, s]))).get(id)
    return found?.title || id
  }

  private run(q: Queued): void {
    this.running.add(q.id)
    // Read the title BEFORE the move: a successful handoff kills the pane, so by the
    // time the promise resolves there is nothing left to name it with.
    const name = this.paneName(q.id)
    const where = this.deps.deviceName(q.device)
    void this.deps
      .send(q.id, q.device, q.closeReceiverWhenDone === true)
      .then((items) => {
        const item = items[0]
        if (item?.ok) {
          this.deps.log(`handoff: ${q.id} moved to ${where} - its turn had ended`)
          this.deps.notify?.(`Moved ${name} to ${where} - its turn had ended`)
        } else {
          const why = item?.error ?? 'refused over there'
          this.deps.log(`handoff: ${q.id} could not move - ${why}`)
          this.deps.notify?.(`${name} could not move to ${where} - ${why}`)
        }
      })
      .catch((err: Error) => {
        this.deps.log(`handoff: ${q.id} could not move - ${err.message}`)
        this.deps.notify?.(`${name} could not move to ${where} - ${err.message}`)
      })
      .finally(() => {
        this.running.delete(q.id)
        // Whatever happened, the pane is no longer on its way: a failed move must not
        // leave a pane that reclaim will never close and the queue will never retry.
        this.deps.mark(q.id, false)
      })
  }
}
