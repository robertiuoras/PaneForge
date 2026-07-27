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
 * Send early once a pane has this much waiting. A burst this size is worth its
 * own message anyway, and it stops a firehose from holding a growing string
 * across the tick.
 */
const MAX_PENDING = 64 * 1024

export class DataPump {
  private pending = new Map<string, string>()
  private timer: ReturnType<typeof setTimeout> | null = null

  /**
   * @param sink what to actually send. Called once per pane per flush, with the
   * concatenated output for that pane.
   */
  constructor(private readonly sink: (id: string, data: string) => void) {}

  push(id: string, data: string): void {
    if (!data) return
    const next = (this.pending.get(id) ?? '') + data
    if (next.length >= MAX_PENDING) {
      this.pending.delete(id)
      this.sink(id, next)
      return
    }
    this.pending.set(id, next)
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null
        this.flush()
      }, FLUSH_MS)
      // A pending flush must never be the reason the process stays up.
      this.timer.unref?.()
    }
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
    for (const [id, data] of out) this.sink(id, data)
  }

  /** Send one pane's output now - used when that pane exits. */
  flushOne(id: string): void {
    const data = this.pending.get(id)
    if (data === undefined) return
    this.pending.delete(id)
    this.sink(id, data)
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
    for (const v of this.pending.values()) n += v.length
    return n
  }
}
