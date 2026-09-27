// A pipe whose other end has gone costs one log line, never an uncaughtException.
//
// 2026-09-22 10:10:49 (pid 48416, v0.8.220): three `uncaughtException: Error: write EPIPE`
// in 8ms, each with one frame, `WriteWrap.onWriteComplete`. That frame is an asynchronous
// write that failed after the caller had moved on, on a stream with no `error` listener, so
// Node had nobody to hand it to. The two minutes before it were seven panes in a row whose
// typed prompts never landed ("6 returns were swallowed"), which is what a pane's input
// pipe looks like once the console behind it is gone.
//
// node-pty on Windows writes keystrokes to `_agent.inSocket`, a net.Socket on the console's
// input pipe, and listens for errors on the OUTPUT pipe only. Measured 2026-09-28 with the
// installed @lydell/node-pty: a write to that input socket after the console went away
// ends as `uncaughtException: write EAGAIN at WriteWrap.onWriteComplete` - the same frame.
// The output side has a listener, but it rethrows anything that is not EIO unless the
// terminal has a second listener of its own. Main's own stdout/stderr are the third pipe:
// a launcher that closed its end turns the next console line into the same throw.
//
// `crash.ts` kept the app up through all three, but each one was a fault notice and a line
// in the errors log that named no pane and no pipe. `npm run test:closedpipe` pins this.

/** Anything with Node's `on('error')`. */
interface Errant {
  on(event: 'error', listener: (err: Error) => void): unknown
}

/**
 * Give `stream` an error listener that reports each distinct error code once and keeps the
 * error from becoming an uncaughtException. A broken pipe does not heal, so the second
 * EPIPE on the same stream says nothing the first did not.
 */
export function tolerateClosedPipe(
  stream: Errant | null | undefined,
  report: (code: string) => void
): void {
  if (!stream || typeof stream.on !== 'function') return
  const said = new Set<string>()
  stream.on('error', (err) => {
    const code = String((err as NodeJS.ErrnoException)?.code || err?.message || err)
    if (said.has(code)) return
    said.add(code)
    try {
      report(code)
    } catch {
      /* the listener exists to stop a throw; it must not start one */
    }
  })
}

/**
 * Both of a pane terminal's pipes. `output` is node-pty's own read side (its rethrow needs
 * a second listener to stand down); `input` is the Windows keystroke socket, which has no
 * listener at all. Neither is in node-pty's typings, and on macOS/Linux there is no
 * `_agent`: `test:closedpipe` fails if a node-pty upgrade moves the input socket.
 */
export function guardPtyPipes(
  proc: unknown,
  report: (side: 'input' | 'output', code: string) => void
): void {
  const term = proc as { on?: Errant['on']; _agent?: { inSocket?: Errant } } | null
  if (!term) return
  if (typeof term.on === 'function') tolerateClosedPipe(term as Errant, (code) => report('output', code))
  tolerateClosedPipe(term._agent?.inSocket, (code) => report('input', code))
}
