// Capture the REAL Claude Code working footer, so the turn-clock regex in
// PaneForge's shared/busy.ts can be checked against what the CLI actually prints
// rather than against a fixture written from memory.
//
// Spawns `claude` in a pty, asks for something long enough to cross a minute, and
// records every distinct "spinner line" it draws.

import { existsSync, statSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import pty from '@lydell/node-pty'

const resolve = (cmd) => {
  const exts = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)
  const order = process.platform === 'win32' ? [...exts, ''] : ['', ...exts]
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    for (const ext of order) {
      const p = join(dir, cmd + ext)
      try {
        if (dir && existsSync(p) && statSync(p).isFile()) return p
      } catch {}
    }
  }
  return cmd
}

const exe = resolve('claude')
// A session spawned from inside another one inherits markers that turn the child
// into a headless child session - no spinner, no transcript, nothing to read.
const env = { ...process.env, TERM: 'xterm-256color' }
for (const k of Object.keys(env)) if (/^CLAUDE_CODE_(CHILD_SESSION|ENTRYPOINT|SSE_PORT)/.test(k)) delete env[k]
delete env.CLAUDECODE

const proc = pty.spawn(exe, ['--model', 'claude-haiku-4-5-20251001'], {
  name: 'xterm-256color',
  cols: 120,
  rows: 30,
  cwd: process.env.TEMP || process.cwd(),
  env
})

// Ink draws a run of blanks as "move the cursor right N", so stripping escapes
// without expanding that glues every word together and the footer's " · " -
// the separator the whole parser keys on - disappears.
const expand = (s) => s.replace(/\x1b\[(\d+)C/g, (_, n) => ' '.repeat(Math.min(Number(n), 200)))
const STRIP = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-B0-2]|\x1b[=>]|\r/g
const seen = new Map()
let raw = ''

proc.onData((d) => {
  raw += d
  for (const line of expand(d).replace(STRIP, '').split('\n')) {
    const s = line.trim()
    // The working line: a spinner glyph, a gerund, an ellipsis and a counter.
    if (!s.includes('…') && !/esc to (interrupt|cancel)/i.test(s)) continue
    // Key on the shape, not the digits, so 300 ticks collapse to a handful of forms.
    const shape = s.replace(/\d+/g, '#')
    if (!seen.has(shape)) seen.set(shape, s)
  }
})

const done = (why) => {
  const out = [...seen.values()]
  writeFileSync(
    join(process.env.TEMP || '.', 'claude-footer-capture.json'),
    JSON.stringify({ why, shapes: [...seen.keys()], samples: out, rawTail: raw.slice(-4000) }, null, 2)
  )
  console.log(`--- ${why}: ${out.length} distinct footer shapes ---`)
  for (const [shape, sample] of seen) console.log(`  ${JSON.stringify(sample)}\n    shape: ${JSON.stringify(shape)}`)
  try { proc.kill() } catch {}
  process.exit(0)
}

// Let the CLI paint its box before typing, or the prompt lands in a dead buffer.
setTimeout(() => {
  proc.write('Write a detailed 2500 word essay on the history of the abacus. Plain prose, no tools.')
  setTimeout(() => proc.write('\r'), 400)
}, 6000)

setTimeout(() => done('timeout'), 145_000)
