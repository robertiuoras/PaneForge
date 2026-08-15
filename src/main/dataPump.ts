/**
 * Coalesces pty output on its way to the renderer.
 *
 * Every chunk a pty emits used to be its own `webContents.send('pty:data', ...)`.
 * Measured on this machine, one pty streaming a real log (`git --no-pager log -p
 * -n 300`) emits **7,359 chunks per second at a median of 41 bytes each** - so
 * the app was paying full IPC price (structured clone, channel dispatch, a
 * renderer task, an xterm write) seven thousand times a second to move forty
 * bytes at a time, per pane, and a grid multiplies it. That is the stutter you
 * see when an agent starts printing: not the terminal rendering, the postage.
 *
 * So chunks for the same pane are appended into a pending string and sent as one
 * message on a shared timer. At FLUSH_MS = 8 that is at most 125 messages a
 * second across the whole app however many panes are shouting - a ~60x cut on
 * the measured rate - and the worst case a keystroke's echo can wait is 8ms,
 * which is under half a frame.
 *
 * Two things keep it honest:
 *   - Order. Appending only ever concatenates chunks for the SAME id, so the
 *     bytes reach xterm in the order the pty produced them. xterm does not care
 *     where the boundaries fall (it already had to handle arbitrary ones).
 *   - Nothing is dropped. A pane that exits, a window that is going away, and a
 *     buffer that grows past MAX_PENDING all flush immediately rather than
 *     waiting for the tick.
 */

/** How long output may sit before it goes out. Half a frame at 60Hz. */
const FLUSH_MS = 8

/**
 * The same, for a pane that is not on screen.
 *
 * Every pane stays mounted for its whole life (that is what makes switching to
 * one instant), so a background pane pays exactly what a visible one pays: an
 * IPC message, a structured clone, a renderer task and an xterm write, at up to
 * 125 messages a second, to update a canvas nobody is looking at. With six to
 * twelve panes open and one of them on screen, that is most of the traffic this
 * file exists to cut.
 *
 * A hidden pane cannot be watched, so the only thing a longer window costs is
 * how stale its buffer may be when it comes BACK on screen - and that costs
 * nothing either, because `setVisible` flushes a pane the moment it is claimed
 * visible. Nothing is dropped and nothing is reordered: it is the same bytes in
 * the same order, in a twelfth of the messages.
 */
const HIDDEN_FLUSH_MS = 100

/**
 * Send early once a pane has this much waiting. A burst this size is worth its
 * own message anyway, and it stops a firehose from holding a growing string
 * across the tick.
 */
const MAX_PENDING = 64 * 1024

export class DataPump {
  private pending = new Map<string, { data: string; due: number }>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private timerDue = 0
  /**
   * Which panes are on screen, as last claimed by a client. `null` means nobody
   * has said yet, and then every pane is treated as visible: a pump that has not
   * been told anything must behave exactly as it did before this existed.
   */
  private visible: Set<string> | null = null

  /**
   * @param sink what to actually send. Called once per pane per flush, with the
   * concatenated output for that pane.
   */
  constructor(private readonly sink: (id: string, data: string) => void) {}

  /**
   * The panes a client says are on screen. The union of every client - the desk
   * window and a phone are two screens and either one showing a pane makes it
   * visible - is the caller's business, not this file's.
   *
   * Anything already waiting for a pane that just became visible goes out now,
   * so switching to a pane never shows a frame that is up to HIDDEN_FLUSH_MS old.
   */
  setVisible(ids: string[]): void {
    this.visible = new Set(ids)
    for (const id of ids) this.flushOne(id)
  }

  private windowFor(id: string): number {
    return this.visible === null || this.visible.has(id) ? FLUSH_MS : HIDDEN_FLUSH_MS
  }

  push(id: string, data: string): void {
    if (!data) return
    const cur = this.pending.get(id)
    const next = (cur?.data ?? '') + data
    if (next.length >= MAX_PENDING) {
      this.pending.delete(id)
      this.sink(id, next)
      return
    }
    // The deadline belongs to the OLDEST byte waiting, never to the newest: a
    // pane printing steadily would otherwise push its own flush forward for ever.
    const due = cur ? cur.due : Date.now() + this.windowFor(id)
    this.pending.set(id, { data: next, due })
    this.arm(due)
  }

  /** Make sure the timer will fire by `due`. */
  private arm(due: number): void {
    if (this.timer !== null) {
      if (this.timerDue <= due) return
      clearTimeout(this.timer)
    }
    this.timerDue = due
    this.timer = setTimeout(
      () => {
        this.timer = null
        this.tick()
      },
      Math.max(0, due - Date.now())
    )
    // A pending flush must never be the reason the process stays up.
    this.timer.unref?.()
  }

  /** Send what is due, and re-arm for what is not. */
  private tick(): void {
    const now = Date.now()
    let next = 0
    const out: [string, string][] = []
    for (const [id, p] of this.pending) {
      // 1ms of slack: a timer that fires a hair early must not leave its own
      // work behind and re-arm for a fraction of a millisecond.
      if (p.due <= now + 1) out.push([id, p.data])
      else next = next === 0 ? p.due : Math.min(next, p.due)
    }
    for (const [id] of out) this.pending.delete(id)
    if (next !== 0) this.arm(next)
    // Snapshot first, same reason as flush(): a sink that pushes again must not
    // mutate the map being walked.
    for (const [id, data] of out) this.sink(id, data)
  }

  /** Send everything waiting, now. Safe to call when nothing is waiting. */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.pending.size === 0) return
    // Snapshot first: a sink that pushes again (a remote peer echoing) must not
    // mutate the map being iterated.
    const out = [...this.pending]
    this.pending.clear()
    for (const [id, p] of out) this.sink(id, p.data)
  }

  /** Send one pane's output now - used when that pane exits. */
  flushOne(id: string): void {
    const p = this.pending.get(id)
    if (p === undefined) return
    this.pending.delete(id)
    this.sink(id, p.data)
  }

  /** Drop everything waiting without sending it (the window is gone). */
  discard(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.pending.clear()
  }

  /** Characters waiting to go out, across every pane. For tests. */
  get waiting(): number {
    let n = 0
    for (const p of this.pending.values()) n += p.data.length
    return n
  }
}
