// What is TYPED into a pane's prompt box but not sent yet.
//
// A pane's bytes are a stream of repaints, so nothing on disk holds the composer: the
// log has the box drawn and redrawn a character at a time, and the app's own readings
// (`busy.ts`, `choices.ts`) all ask about the BOTTOM of the screen rather than about
// what a person is halfway through writing. So "read chat 1's prompt box back to me"
// had no answer at all - `pf` could type into a pane and could not see it, which is the
// one direction that matters when a draft is about to be lost.
//
// The rows come from a terminal (main replays the buffer through `@xterm/headless`), and
// the arithmetic here is the same `promptBox.ts` the click and delete paths already use -
// deliberately, because a second opinion about where the composer starts is how the two
// surfaces drift.
//
// Text in, text out, no terminal: `npm run test:composer`.

import { composerAt, frameAt, inputEnd, inputStart, leadingBlanks } from './promptBox'

export interface ComposerRead {
  /** what has been typed, newlines where the composer drew a second row */
  text: string
  /** how many rows of the box it filled */
  rows: number
  /** first row of the composer, as an index into the rows handed in */
  top: number
}

/**
 * Read the composer out of a screen.
 *
 * `cursorRow` is where the caret sits, as an index into `rows`. That is the anchor
 * `composerAt` walks out from, and it is the only reason this can tell a live prompt box
 * from a boxed answer further up the transcript.
 *
 * Answers `null` rather than a guess: a pane with no drawn composer (a plain shell), a
 * pane whose box is empty, and a pane mid-repaint all read as nothing typed. A caller
 * must not be able to mistake "I could not see it" for "the box is empty", so an empty
 * box answers a `ComposerRead` with an empty `text` and a refusal answers `null`.
 */
export function readComposer(
  rows: string[],
  cursorRow: number,
  opts: { codexCols?: number } = {}
): ComposerRead | null {
  if (cursorRow < 0 || cursorRow >= rows.length) return null
  const read = (r: number): string => rows[r] ?? ''
  const box = composerAt(read, cursorRow, opts)
  if (!box) return null
  // The first row carries the CLI's own marker, so the typed text starts past it. Every
  // row below is a continuation the CLI indents to line up under that column - dropping
  // exactly that indent, and never more, keeps a prompt that is itself indented intact.
  const indent = inputStart(read(box.top))
  const out: string[] = []
  for (let r = box.top; r <= box.bottom; r++) {
    const line = read(r)
    // A continuation row is cut at the composer's own indent and never past it, so a
    // prompt that is itself indented (`npm run build` under `run this:`) keeps its
    // shape. Two bounds keep that honest: the box's own left rule, which is never text,
    // and this row's own indent, which is where its text actually begins - a row
    // indented LESS than the first one must not have a character taken off it.
    const frame = frameAt(line)
    const base = frame < 0 ? 0 : frame + 1
    const lead = base + leadingBlanks(line.slice(base))
    const from = r === box.top ? indent : Math.min(Math.max(indent, base), lead)
    const to = inputEnd(line)
    out.push(to > from ? line.slice(from, to) : '')
  }
  // A composer drawn three rows tall with one row typed into is one line of text, not
  // three - the empty rows below are the box, not the draft.
  while (out.length > 1 && !out[out.length - 1].trim()) out.pop()
  return { text: out.join('\n'), rows: out.length, top: box.top }
}
