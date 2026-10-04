// A tall composer may not push the working line out of the busy read.
//
// s15-mucz8c8j, 2026-09-22 18:03: 15 rows of unsent prompt sat in Claude Code's box, the
// spinner `✻ Frolicking… (4m 21s)` was 23 rows from the bottom, the 16-row read found
// nothing, and the card said "your move" for six minutes of a running turn. The fixture is
// that pane's own screen, replayed from its history log through @xterm/headless at 85x66.
//
//   node scripts/busy-window-test.mjs
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'pf-busy-window-'))
const out = join(work, 'b.cjs')
buildSync({
  absWorkingDir: root,
  stdin: { contents: "export { busyWindowStart } from './src/shared/busyWindow'\nexport { busyEvidence } from './src/shared/busy'", resolveDir: root },
  bundle: true, format: 'cjs', platform: 'node', outfile: out, logLevel: 'silent'
})
const { busyWindowStart, busyEvidence } = createRequire(out)(out)
rmSync(work, { recursive: true, force: true })

const fail = []
const ok = (c, n, d) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) { if (d !== undefined) console.log('     ', d); fail.push(n) } }

const rows = readFileSync(join(root, 'scripts/fixtures/busy-tall-composer-s15.txt'), 'utf8').split('\n')
const read = (i) => rows[i] ?? ''
let last = rows.length - 1
while (last > 0 && !read(last).trim()) last--
const text = (start) => rows.slice(start, last + 1).join('\n')

ok(busyEvidence(text(Math.max(0, last - 16 + 1))) === null, 'the old 16-row read really misses it (the fixture still shows the bug)')
ok(busyEvidence(text(busyWindowStart(read, last, 16)))?.reason === 'spin', 'the window reaches the working line above a tall composer',
  busyWindowStart(read, last, 16))

// A short composer keeps the old window: nothing above it is read that was not before.
const short = ['old answer (esc to interrupt · 3s)', ...Array(20).fill('text'), '─'.repeat(40), '❯ ', '─'.repeat(40), '  status']
const sl = short.length - 1
ok(busyWindowStart((i) => short[i] ?? '', sl, 16) === sl - 15, 'a short composer does not widen the read')
ok(busyEvidence(short.slice(busyWindowStart((i) => short[i] ?? '', sl, 16)).join('\n')) === null, 'so a stale footer far above stays unread')

// No composer on screen: unchanged.
ok(busyWindowStart((i) => `line ${i}`, 40, 16) === 25, 'no composer, bottom rows as before')

// A rule + `> ` pair only in scrollback, above the last `rows` rows and no rule inside them: bottom.
const quoted = ['out', '─'.repeat(40), '> quoted', ...Array(30).fill('text')]
ok(busyWindowStart((i) => quoted[i] ?? '', quoted.length - 1, 16) === quoted.length - 16, 'a quoted marker in scrollback does not widen the read')

console.log(fail.length ? `\n${fail.length} FAILED` : '\nall ok')
process.exit(fail.length ? 1 : 0)
