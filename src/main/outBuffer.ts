/**
 * The retained tail of one pty's output.
 *
 * This used to be a plain string kept trimmed on every chunk:
 *
 *     live.buffer = (live.buffer + data).slice(-BUFFER_LIMIT)
 *
 * which is two copies of the whole 400 KB cap for every chunk the pty emits - and a
 * chatty agent emits them in the hundreds per second, across every open pane at once.
 * That is hundreds of megabytes a second of string churn in the main process, all of it
 * immediately garbage, to keep a buffer that is only ever READ when a pane mounts or a
 * remote peer asks for it. It measured as the main process holding several percent of a
 * core for as long as the app was open, doing nothing anyone asked for.
 *
 * So chunks are kept as chunks. Appending is O(chunk): push, add to the running length,
 * and drop whole chunks off the front once what is left in front of them already covers
 * the cap. The join happens on read, where one copy is what the caller wanted anyway.
 *
 * `limit` is a floor on what is retained, not a ceiling: the tail can carry up to one
 * extra chunk beyond it, and read() trims to exactly the cap.
 */
export class OutBuffer {
  private parts: string[] = []
  private len = 0

  constructor(private readonly limit: number) {}

  push(data: string): void {
    if (!data) return
    this.parts.push(data)
    this.len += data.length
    // Drop from the front while the rest still covers the cap on its own.
    while (this.parts.length > 1 && this.len - this.parts[0].length >= this.limit) {
      this.len -= this.parts.shift()!.length
    }
  }

  /** Replace the whole tail (a restart writes a reset sequence and starts over). */
  set(data: string): void {
    this.parts = data ? [data] : []
    this.len = data.length
  }

  clear(): void {
    this.set('')
  }

  get length(): number {
    return this.len
  }

  /**
   * The tail as one string, capped. Compacted in place: a pane that mounts, drops and
   * mounts again does not re-join the same chunks each time.
   */
  read(): string {
    if (this.parts.length === 0) return ''
    if (this.parts.length > 1 || this.len > this.limit) {
      const joined = this.parts.join('')
      const out = joined.length > this.limit ? joined.slice(-this.limit) : joined
      this.parts = [out]
      this.len = out.length
    }
    return this.parts[0]
  }
}
