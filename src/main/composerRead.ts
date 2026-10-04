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
    const reading = readComposer(lines, cursor, { codexCols })
    // Codex 0.159 paints its empty hint in dim cells, with the caret before it. Text
    // alone is insufficient: a person can type these exact words and park at the start.
    if (codexCols && reading?.rows === 1 && reading.text === 'Ask Codex to do anything' &&
      cursor === reading.top && buf.cursorX === 2 &&
      Array.from(reading.text).every((_, n) => Boolean(buf.getLine(reading.top)?.getCell(n + 2)?.isDim()))) {
      return { ...reading, text: '' }
    }
    // Claude Code 2.1.288 does the same with its own hint (`Try "write a test for <filepath>"`),
    // dim, right after the `❯` and with the caret before it - painted first with cursor-forward
    // between the words, then repainted with plain spaces (s54-musnckna, PC, 2026-10-03). Read
    // as typed text, an empty box never cleared the app's own unsent-draft flag. Every letter
    // dim and the caret at the start, or it is a draft: a person's typing is never dim.
    if (!codexCols && reading?.rows === 1 && reading.text && cursor === reading.top &&
      claudeHint(buf.getLine(reading.top), buf.cursorX)) {
      return { ...reading, text: '' }
    }
    return reading
  } finally {
    term.dispose()
  }
}

type HeadlessLine = NonNullable<ReturnType<Terminal['buffer']['active']['getLine']>>

/** A `❯` row whose every letter after the marker is dim, with the caret on the first of them. */
function claudeHint(line: HeadlessLine | undefined, caretX: number): boolean {
  if (!line) return false
  let marker = -1
  for (let x = 0; x < Math.min(line.length, 4); x++) {
    if (line.getCell(x)?.getChars() === '❯') {
      marker = x
      break
    }
  }
  if (marker < 0) return false
  let first = -1
  for (let x = marker + 1; x < line.length; x++) {
    const cell = line.getCell(x)
    const ch = cell?.getChars() ?? ''
    if (!ch.trim() || ch === ' ') continue
    if (!cell?.isDim()) return false
    if (first < 0) first = x
  }
  return first >= 0 && caretX === first
}

/**
 * The rows on the pane's screen right now, trailing blanks trimmed: what a person looking at
 * it sees, not everything it printed. A line a CLI drew and then wrote over is still in the
 * raw bytes, so only a replay can say it is gone.
 */
export async function screenOf(raw: string, cols: number, rows: number): Promise<string[]> {
  if (!raw) return []
  const term = new Terminal({ cols: Math.max(20, cols), rows: Math.max(4, rows), scrollback: 0, allowProposedApi: true })
  try {
    await new Promise<void>((resolve) => term.write(raw, resolve))
    const buf = term.buffer.active
    const out: string[] = []
    for (let i = 0; i < term.rows; i++) out.push(buf.getLine(buf.baseY + i)?.translateToString(true) ?? '')
    return out
  } finally {
    term.dispose()
  }
}
