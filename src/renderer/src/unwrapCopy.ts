// Undo the terminal's line wrapping when text leaves a pane for the clipboard.
//
// The problem is not xterm's selection. An agent CLI draws its own paragraphs: it measures
// the pane, breaks the prose itself and writes REAL newlines, so what sits in the buffer is
// already hard-wrapped and `getSelection()` hands those newlines straight to the clipboard.
// Pasted into an email or a doc, every line ends where the pane happened to end, which is
// what "it does not keep the layout" means. Nothing downstream can undo it, because by then
// a wrap and a deliberate break look identical.
//
// So the join has to happen here, and it has to be conservative: a wrongly joined code block
// or table is worse than a ragged paragraph. Two things make it safe.
//
// 1. The wrap width is measured from the text itself rather than from the terminal. The CLI
//    wraps at ITS width, which is narrower than the pane, so the pane's `cols` is the wrong
//    ruler. The longest line in the selection is the right one.
// 2. A selection only counts as wrapped prose when most of its lines actually reach that
//    width. A paragraph does that by construction; code, tables and box drawing do not, so
//    they fall through untouched rather than relying on a per-line guess.
//
// Blank lines, list markers, indentation and fences all survive: they are the layout, and
// the only thing being removed is the break the terminal invented.

// How close to the longest line a line has to sit before it reads as "this line was full".
// A wrap lands a word short, and 12 columns is about the longest English word plus a space.
const SLACK = 12;

// Below this a "long" line is not evidence of anything - a narrow selection, a column of
// short values, a stack trace.
const MIN_WIDTH = 40;

// At least this share of the non-empty lines has to be full before the selection is treated
// as wrapped prose. Half is deliberately blunt: one full line in a code block is normal,
// half of them being full is not.
const MIN_FULL_SHARE = 0.5;

// A line that starts with any of these is its own block, so the line before it ended on
// purpose. Covers markdown lists, quotes, headings, tables, fences and box drawing.
const BLOCK_START = /^(\s{2,}|[-*+>#]\s|\d+[.)]\s|```|~~~|\||[│┃┌┐└┘├┤┬┴┼─━╭╮╰╯])/;

// A table separator row is `|---|---|`, which has no space after the pipe, so the pipe
// gets its own rule above rather than being lumped in with the markers that do. The row
// BEFORE it needs saying too: a cell row is full width by design and would otherwise
// swallow whatever follows it.
const BLOCK_END = /\|\s*$/;

function isFull(line: string, width: number): boolean {
  return line.length >= width - SLACK;
}

export function unwrapForClipboard(text: string): string {
  if (!text || !text.includes('\n')) return text;
  // A fence anywhere means the selection carries code. Leave the whole thing alone rather
  // than trying to work out where the code stops.
  if (text.includes('```') || text.includes('~~~')) return text;

  const lines = text.split('\n').map((l) => l.replace(/\s+$/, ''));
  const body = lines.filter((l) => l.trim() !== '');
  if (body.length < 2) return text;

  const width = Math.max(...body.map((l) => l.length));
  if (width < MIN_WIDTH) return text;

  const full = body.filter((l) => isFull(l, width)).length;
  if (full / body.length < MIN_FULL_SHARE) return text;

  const out: string[] = [];
  for (const line of lines) {
    const prev = out.length ? out[out.length - 1] : null;
    const joinable =
      prev !== null &&
      prev.trim() !== '' &&
      line.trim() !== '' &&
      isFull(prev, width) &&
      !BLOCK_END.test(prev) &&
      !BLOCK_START.test(line);
    if (joinable) out[out.length - 1] = `${prev} ${line.trim()}`;
    else out.push(line);
  }
  return out.join('\n');
}
