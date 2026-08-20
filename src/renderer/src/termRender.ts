/**
 * Raw terminal bytes, back into the lines a person saw.
 *
 * A pane's transcript is a stream of REPAINTS, not a document: an agent's "thinking" line
 * is drawn many times a second and a boxed composer is redrawn character by character.
 * Stripping the escape sequences out of that (`stripAnsi`) puts every one of those frames
 * on its own line - the "it spams the thinking info" complaint, written down. A terminal
 * is the thing that turns repaints back into lines, so the bytes go through a real xterm
 * off-screen and its BUFFER is what is read out.
 *
 * One copy, used by the phone's text sheet and by History's transcript view: two of these
 * would drift in exactly the way nobody notices - two surfaces disagreeing about what a
 * session said.
 */

import { Terminal } from '@xterm/xterm'

/**
 * Replay `raw` through a terminal nobody can see and read the lines back out.
 *
 * `cols` is the width the output was WRITTEN at: the CLI hard-wrapped its own output
 * there, so rendering at any other one re-flows box drawing into soup. `rows` is small on
 * purpose - only the scrollback is being read, and the screen is the last few lines of it.
 */
export async function renderLines(raw: string, cols: number): Promise<string[]> {
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;left:-10000px;top:0;width:800px;height:400px'
  document.body.appendChild(host)
  const t = new Terminal({
    cols: Math.max(20, cols),
    rows: 24,
    // Deep enough for 8 MB of an agent's output; the terminal is thrown away immediately.
    scrollback: 400_000,
    allowProposedApi: true
  })
  try {
    t.open(host)
    await new Promise<void>((resolve) => t.write(raw, resolve))
    const buf = t.buffer.active
    const lines: string[] = []
    for (let i = 0; i < buf.length; i++) {
      // `true` keeps trailing whitespace off, which is most of a terminal line.
      lines.push(buf.getLine(i)?.translateToString(true) ?? '')
    }
    // A terminal's buffer is `rows` tall even when nothing was printed into it, so the
    // tail is usually blank rows. They are noise in a document.
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
    return lines
  } finally {
    t.dispose()
    host.remove()
  }
}
