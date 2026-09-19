/**
 * A pane's prompt box, read back without touching it.
 *
 * The bytes main holds are repaints, not a document, so the only thing that can say what
 * is in a composer is a terminal. One is built off-screen here, the pane's live buffer is
 * replayed into it at the width it was WRITTEN at, and `shared/composerRead.ts` reads the
 * rows out. Nothing is typed, nothing is submitted, and the pane never learns it happened -
 * which is the whole point: `pf` could write to a pane and could not see it.
 *
 * `@xterm/headless` rather than the renderer's xterm: this must answer while the window is
 * wedged, minimised or absent, and a headless terminal is already a dependency of this app
 * (`scroll-clear-test.mjs` measures the shipped buffer with it).
 */
import { Terminal } from '@xterm/headless'
import { readComposer, type ComposerRead } from '../shared/composerRead'

/** Deep enough to walk the dozen rows above the caret, shallow enough to stay cheap. */
const SCROLLBACK = 200

export async function composerOf(
  raw: string,
  cols: number,
  rows: number,
  agent?: string
): Promise<ComposerRead | null> {
  if (!raw) return null
  const term = new Terminal({
    cols: Math.max(20, cols),
    rows: Math.max(4, rows),
    scrollback: SCROLLBACK,
    allowProposedApi: true
  })
  try {
    await new Promise<void>((resolve) => term.write(raw, resolve))
    const buf = term.buffer.active
    const lines: string[] = []
    for (let i = 0; i < buf.length; i++) {
      // Trailing blanks stay ON: `inputEnd` is what decides where a row's text stops, and
      // it needs the row as the terminal holds it to tell an empty box from a full one.
      lines.push(buf.getLine(i)?.translateToString(false) ?? '')
    }
    const cursor = buf.baseY + buf.cursorY
    // Codex draws a borderless draft that only its own reading recognises; every other
    // CLI here draws a box or a rule, which the general walk finds.
    const codexCols = agent && /codex/i.test(agent) ? Math.max(20, cols) : undefined
    return readComposer(lines, cursor, { codexCols })
  } finally {
    term.dispose()
  }
}
