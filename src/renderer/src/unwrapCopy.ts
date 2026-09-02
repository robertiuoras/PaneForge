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

// The same list WITHOUT the indent rule: "this row is a bullet, a quote, a heading, a
// table row or a rule". Used to decide whether an indent is the author's layout, which a
// blanket `^\s{2,}` cannot answer because that is the very thing being questioned.
const MARKER_ROW = /^\s*([-*+>#]\s|\d+[.)]\s|```|~~~|\||[│┃┌┐└┘├┤┬┴┼─━╭╮╰╯])/;

// A row that reads as code rather than as a sentence. Braces, an assignment, an empty call
// or a backtick are all things prose does not carry. A bare semicolon is NOT on this list:
// it is ordinary punctuation in a sentence, and the drafted email this rule was written for
// has one in the middle of a wrapped line.
const CODEY = /[{}=`]|\(\)/;

// A table separator row is `|---|---|`, which has no space after the pipe, so the pipe
// gets its own rule above rather than being lumped in with the markers that do. The row
// BEFORE it needs saying too: a cell row is full width by design and would otherwise
// swallow whatever follows it.
const BLOCK_END = /\|\s*$/;

function isFull(line: string, width: number): boolean {
  return line.length >= width - SLACK;
}

const indentOf = (line: string): number => (line.match(/^ */) as RegExpMatchArray)[0].length;

/**
 * A run of rows with blank lines on either side - the unit every decision below is made
 * over. It has to be the paragraph rather than the whole selection: a drafted email is
 * three short paragraphs, and measuring "are most rows full" across all of them (plus the
 * greeting and the sign-off, which are two words each) says no when every paragraph on its
 * own says yes.
 */
function paragraphs(lines: string[]): number[][] {
  const out: number[][] = [];
  let run: number[] = [];
  lines.forEach((l, i) => {
    if (l.trim() === '') {
      if (run.length) out.push(run);
      run = [];
    } else run.push(i);
  });
  if (run.length) out.push(run);
  return out;
}

/**
 * Take off an indent that is the CLI's rendering rather than the author's.
 *
 * Claude Code draws a drafted message as a block with a two-space left margin, and when a
 * paragraph inside it is wrapped, some continuation rows carry that margin and some do not
 * - so the block arrives with a ragged left edge. `BLOCK_START` reads any indent as "this
 * row is its own block", and nothing in a paragraph like that ever joins.
 *
 * The tell is CONSISTENCY. A real indent - a code block, a nested list, a quoted excerpt -
 * is on EVERY row of its paragraph. An indent that is on some rows and not others was
 * never typed by anybody, so it comes off. Paragraphs holding a bullet, a table row or
 * anything that reads as code are left alone whatever their indents look like.
 */
function stripRenderedIndent(lines: string[]): string[] {
  const out = lines.slice();
  for (const para of paragraphs(lines)) {
    if (para.length < 2) continue;
    const rows = para.map((i) => lines[i]);
    if (rows.some((r) => MARKER_ROW.test(r) || CODEY.test(r))) continue;
    const indents = rows.map(indentOf);
    const ragged = indents.some((n) => n >= 2) && indents.some((n) => n === 0);
    if (!ragged) continue;
    for (const i of para) out[i] = lines[i].replace(/^ +/, '');
  }
  return out;
}

/**
 * One sentence carried across a break, for a paragraph too short for the "most rows are
 * full" reading to say anything: two or three rows is not a sample.
 *
 * Deliberately narrow. The first row has to end mid-sentence (a letter, a digit or a
 * comma - never a full stop, a colon, a bracket or a backtick), the second has to start
 * lowercase, and neither may read as code. The first row also has to be long enough to
 * have been wrapped at all: `Property Investors Alliance` above `piateam.com.au` is a
 * signature somebody typed on two lines, and it is shorter than any wrap.
 */
function sentenceContinues(prev: string, line: string): boolean {
  if (prev.trim().length < MIN_WIDTH) return false;
  if (!/[A-Za-z0-9,]$/.test(prev.trim())) return false;
  if (!/^[a-z]/.test(line.trim())) return false;
  if (CODEY.test(prev) || CODEY.test(line)) return false;
  if (MARKER_ROW.test(prev) || MARKER_ROW.test(line)) return false;
  return true;
}

export function unwrapForClipboard(text: string): string {
  if (!text || !text.includes('\n')) return text;
  // A fence anywhere means the selection carries code. Leave the whole thing alone rather
  // than trying to work out where the code stops.
  if (text.includes('```') || text.includes('~~~')) return text;

  const raw = text.split('\n').map((l) => l.replace(/\s+$/, ''));
  if (raw.filter((l) => l.trim() !== '').length < 2) return text;
  const lines = stripRenderedIndent(raw);

  // Which paragraphs read as wrapped prose, measured one paragraph at a time.
  const wrapped = new Map<number, number>();
  for (const para of paragraphs(lines)) {
    const rows = para.map((i) => lines[i]);
    if (rows.length < 2) continue;
    const width = Math.max(...rows.map((l) => l.length));
    if (width < MIN_WIDTH) continue;
    if (rows.filter((l) => isFull(l, width)).length / rows.length < MIN_FULL_SHARE) continue;
    for (const i of para) wrapped.set(i, width);
  }

  const out: string[] = [];
  const from: number[] = [];
  lines.forEach((line, i) => {
    const prev = out.length ? out[out.length - 1] : null;
    const width = wrapped.get(i);
    const openable =
      prev !== null &&
      prev.trim() !== '' &&
      line.trim() !== '' &&
      !BLOCK_END.test(prev) &&
      !BLOCK_START.test(line);
    const joinable =
      openable &&
      ((width !== undefined && wrapped.get(from[from.length - 1]) !== undefined && isFull(prev, width)) ||
        sentenceContinues(prev, line));
    if (joinable) out[out.length - 1] = `${prev} ${line.trim()}`;
    else {
      out.push(line);
      from.push(i);
    }
  });
  const joined = out.join('\n');
  return joined === raw.join('\n') ? text : joined;
}
