// Does the trash button's /clear actually reach the CLI as /clear?
//
// Not in the test suite: it launches a real Claude Code and takes a minute per case. It is
// here because the bug it caught cannot be caught any other way - the failure lived in what
// a TUI does with a key, which no unit test in this repo can see.
//
// The bug (2026-08-02): clearPane sent ONE Ctrl-U before typing /clear. Ctrl-U empties a
// one-line prompt box and leaves every earlier line of a shift+Enter draft exactly where
// it was, so "/clear" landed on the end of line one and the whole draft went to the model
// as a prompt. The pane kept its context and burned a turn.
//
//   node scripts/clear-wipe-probe.mjs
//
// PASS means the box was empty when /clear was typed. FAIL means the draft is still there,
// or Claude started answering it.

import { createRequire } from 'node:module'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(join(here, '..', 'package.json'))
const pty = require('@lydell/node-pty')

const CLAUDE = process.env.CLAUDE_BIN || 'claude'
const MARK = 'zqmarkerqz'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const strip = (s) =>
  s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')

/** The wipe App.tsx sends. Keep this identical to clearPane. */
const wipeFor = (lines) => '\x0b\x15\x7f'.repeat(Math.min(24, Math.max(4, lines + 2)))

async function run(label, draftLines, wipe) {
  const draft = draftLines.join('\x1b\r') // Alt+Enter: a newline in the box, not a submit
  const cwd = mkdtempSync(join(tmpdir(), 'pf-clear-'))
  const p = pty.spawn(CLAUDE, [], { name: 'xterm-256color', cols: 100, rows: 30, cwd, env: process.env })
  let buf = ''
  p.onData((d) => {
    buf += d
  })
  for (let i = 0; i < 60 && !/│\s*>/.test(strip(buf)); i++) await sleep(500)
  await sleep(1500)
  p.write(draft)
  await sleep(900)
  buf = ''
  // --- exactly what clearPane does ---
  p.write(wipe)
  await sleep(320)
  p.write('/clear')
  await sleep(360)
  p.write('\r')
  await sleep(3500)
  const flat = strip(buf).replace(/\s+/g, ' ')
  p.write('\x03')
  await sleep(150)
  p.kill()
  const residue = flat.includes(MARK)
  const answering = /(esc to interrupt|thinking with)/i.test(flat)
  return { label, ok: !residue && !answering, residue, answering, tail: flat.slice(-140) }
}

const three = [`${MARK} line one`, 'line two here', 'line three here']
const ten = [`${MARK} line one`, ...Array.from({ length: 9 }, (_, i) => `line ${i + 2} of the draft`)]

const plan = [
  ['one line, current wipe', [`${MARK} a single line`], wipeFor(1)],
  ['three lines, current wipe', three, wipeFor(3)],
  ['ten lines, current wipe', ten, wipeFor(10)],
  ['three lines, the OLD single ctrl-u (must fail)', three, '\x15']
]

let bad = 0
for (const [label, lines, wipe] of plan) {
  const r = await run(label, lines, wipe)
  const expectFail = label.includes('must fail')
  const good = expectFail ? !r.ok : r.ok
  if (!good) bad++
  console.log(`${good ? 'ok  ' : 'FAIL'}  ${label}  (residue=${r.residue} answering=${r.answering})`)
  if (!good) console.log(`      ${r.tail}`)
}
console.log(bad ? `\n${bad} failed` : '\nall good')
process.exit(bad ? 1 : 0)
