// npm run test:promptpad
//
// Rail tags rebuilt from a Windows pane's transcript. Robert, 2026-09-23, on the PC's
// panes mirrored on the Mac after a restart: "the prompt tags are in the wrong place, not
// spread out".
//
// Windows' ConPTY paints every row padded with spaces to the full width. A pad that fills
// the last column leaves the terminal's pending wrap set, so whatever is written next
// lands on a row xterm flags `isWrapped` - and drawing an echo over that row later does
// not clear the flag. `seedPrompts` joined every wrapped row onto the row above,
// so over the PC's own s8 transcript at the mirror's real 130x55 grid:
//
//   - `❯ Continue the handoff…` sat under a padded blank row, was glued onto it and got
//     no tag at all;
//   - `❯ /model opus` swallowed the `⎿ Set model to…` line after its pad, so its label
//     was 197 characters of something else;
//   - the first ask, drawn twice, had one copy swallow its padded continuation and the
//     other not, so the one-tag-per-prompt rule saw two different prompts and drew two
//     tags in the top 1% of the rail.
//
// Rows 10, 16, 1574 of 1718 before; 16, 1574, 1577 after. The byte shapes below are
// copied from that transcript (text kept, the status line dropped), and are written into
// a real headless xterm at 130 columns, read by the shipped `promptRow`/`seedPrompts`.

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), `pf-promptpad-test-${process.pid}`)
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const outfile = join(work, 'promptecho.bundle.cjs')
buildSync({ absWorkingDir: root, entryPoints: ['src/shared/promptEcho.ts'], bundle: true, format: 'cjs', platform: 'node', outfile })
const req = createRequire(import.meta.url)
const { promptRow, seedPrompts } = req(outfile)
const { Terminal } = req('@xterm/headless')
rmSync(work, { recursive: true, force: true })

const COLS = 130
const GREY = '\x1b[38;2;153;153;153m'
const BOX = '\x1b[38;2;80;80;80m\x1b[48;2;55;55;55m'
/** ConPTY's row: the text, then spaces written out to the last column. */
const padded = (s) => s + ' '.repeat(COLS - [...s].length)

const ASK = 'Build what docs/superpowers/specs/2026-09-23-remote-rows-brief.md describes. Bring master in first (git fetch, then merge'
const ASK_TAIL = '  origin/master), read the brief, follow it exactly, and finish against its Done means.'
const CONTINUE = 'Continue the handoff: work its Next steps in order, and do not re-do finished items.'

let bytes = ''
bytes += '\r\n' + 'banner\r\n\r\n'
// First copy of the ask: the CLI broke the line itself, CRLF after the pad-free row.
bytes += `${BOX}❯ ${GREY}${ASK}\x1b[m\r\n${ASK_TAIL}\r\n\r\n`
bytes += '  ⎿  SessionStart:startup hook error\r\n\r\n'
// Second copy: padded to the edge with no CRLF, so the continuation lands wrapped.
bytes += `${BOX}❯ ${GREY}${padded(ASK)}\x1b[m${ASK_TAIL}\r\n`
for (let i = 0; i < 40; i++) bytes += `reply line ${i}\r\n`
bytes += '\r\n'
// `/model opus`, padded, and the next line written straight after the pad.
bytes += `${BOX}❯ \x1b[38;2;255;255;255m${padded('/model opus ')}\x1b[m${GREY}  ⎿  \x1b[mSet model to Opus 5.5 and saved as your default for new sessions\r\n`
// A full-width blank row, then the box's rule wraps onto the next row...
bytes += ' '.repeat(COLS) + '\x1b[38;2;136;136;136m' + '─'.repeat(COLS) + '\x1b[m'
// ...which the echo is then drawn over from column 1. The wrap flag stays.
bytes += `\r${BOX}❯ ${GREY}${padded(CONTINUE)}\x1b[m\r\n\r\n`
// A genuine soft wrap: a prompt longer than the row, no padding, no CRLF. Still one ask.
const LONG = 'a genuinely long prompt that runs past the edge of the terminal ' .repeat(3).trim()
bytes += `\r\n${BOX}❯ ${GREY}${LONG}\x1b[m\r\n\r\ndone\r\n`

const t = new Terminal({ cols: COLS, rows: 55, scrollback: 10_000, allowProposedApi: true })
await new Promise((r) => t.write(bytes, r))
const b = t.buffer.active
const rows = []
for (let i = 0; i < b.baseY + b.cursorY; i++) {
  const line = b.getLine(i)
  rows.push({ ...promptRow(line), wrapped: Boolean(line?.isWrapped) })
}
const row = (needle) => rows.findIndex((r) => r.text.startsWith(needle))
const want = {
  ask: rows.map((r, i) => (r.text.startsWith('❯ Build what') ? i : -1)).filter((i) => i >= 0),
  model: row('❯ /model opus'),
  cont: row('❯ Continue the handoff'),
  long: row('❯ a genuinely long')
}
assert.equal(want.ask.length, 2, 'fixture: the ask is drawn twice')
assert.ok(rows[want.cont].wrapped, 'fixture: the Continue echo sits on a row xterm flags wrapped, as on the PC')
assert.ok(rows[want.long + 1].wrapped, 'fixture: the long prompt really soft-wraps')

const seeded = seedPrompts(rows, 'claude')
console.log('promptpad:', seeded.map((s) => `${s.line}:${s.text.slice(0, 24)}(${s.text.length})`).join('  '))

assert.deepEqual(
  seeded.map((s) => s.line),
  [want.ask[1], want.model, want.cont, want.long],
  'one tag per prompt, each on the row its echo is drawn on'
)
const by = new Map(seeded.map((s) => [s.line, s.text]))
assert.equal(by.get(want.model).trim(), '/model opus', 'the pad does not glue the next line onto the label')
assert.equal(by.get(want.cont).trim(), CONTINUE, 'an echo under a padded blank row is read')
assert.equal(by.get(want.long), LONG, 'a real soft wrap is still one prompt')

console.log('promptpad: ok')
