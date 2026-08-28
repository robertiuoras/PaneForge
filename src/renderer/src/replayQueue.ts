/**
 * One pane replays its old screen at a time, and the pane being LOOKED AT goes first.
 *
 * A restored desk mounts every pane in one tick and each of them writes up to
 * `BUFFER_LIMIT` (400 kB) of the previous process's raw output into its own xterm. That
 * parse is 45-147 ms per pane on the UI thread (measured 2026-08-27, see
 * `shared/capacity.ts`), it is not interruptible, and eight of them started together
 * saturate the thread for the whole restore - which is "after a restart everything is
 * super laggy": the window is up, the panes are drawn, and nothing answers a keypress
 * because eight terminals are parsing at once behind them.
 *
 * Nothing here makes the parse cheaper. What it changes is the ORDER and the gaps: the
 * active pane's replay runs first and alone, so the pane somebody is actually reading is
 * finished and typeable while the other seven are still queued, and the thread is handed
 * back between panes so a keystroke lands in the gap rather than behind 400 kB.
 *
 * A pane that goes away before its turn cancels itself; a pane that becomes active while
 * it is waiting jumps the rest of the queue, because `priority` is asked at the moment
 * the next job is picked and never stored.
 */

/** How long the thread is handed back between two panes' replays. */
export const YIELD_MS = 16

export interface ReplayJob {
  id: string
  /**
   * Lower runs sooner, asked fresh each time a job is picked: 0 the pane with the
   * keyboard, 1 a pane on screen, 2 everything else.
   */
  priority: () => number
  /** Resolves when the bytes have been PARSED, not when `write` returned. */
  run: () => Promise<void>
}

const waiting: ReplayJob[] = []
let running = false

/** Queue a pane's replay. Safe to call from a mount effect; it never throws. */
export function queueReplay(job: ReplayJob): void {
  waiting.push(job)
  void pump()
}

/** A pane unmounting takes its replay out of the queue if it has not started. */
export function dropReplay(id: string): void {
  const i = waiting.findIndex((j) => j.id === id)
  if (i >= 0) waiting.splice(i, 1)
}

/** How many replays are still waiting. For the probe in `test:replayqueue`. */
export function replaysWaiting(): number {
  return waiting.length
}

async function pump(): Promise<void> {
  if (running) return
  running = true
  try {
    while (waiting.length) {
      let best = 0
      for (let i = 1; i < waiting.length; i++) {
        if (waiting[i].priority() < waiting[best].priority()) best = i
      }
      const [job] = waiting.splice(best, 1)
      try {
        await job.run()
      } catch {
        /* a pane that went away mid-replay must not stop the queue */
      }
      // Hand the thread back before the next 400 kB. A keystroke, a resize and React's
      // own work all land in this gap; without it the queue is one long task again.
      if (waiting.length) await new Promise((r) => setTimeout(r, YIELD_MS))
    }
  } finally {
    running = false
  }
}
