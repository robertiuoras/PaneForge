// Headless proof that the risky half of the app works on Windows: spawn `claude`
// in a real pty, capture its output, send a keystroke, exit cleanly.
// Run with `npm run smoke`. Nothing here touches Electron.

import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import pty from '@lydell/node-pty'

// Mirrors src/main/which.ts: ConPTY needs an absolute path, not a PATH lookup.
const resolve = (cmd) => {
  const exts = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    for (const ext of ['', ...exts]) {
      const p = join(dir, cmd + ext)
      if (dir && existsSync(p)) return p
    }
  }
  return cmd
}

const cwd = process.argv[2] ?? process.cwd()
const proc = pty.spawn(resolve('claude'), [], {
  name: 'xterm-256color',
  cols: 120,
  rows: 30,
  cwd,
  env: { ...process.env, TERM: 'xterm-256color' }
})

let out = ''
proc.onData((d) => {
  out += d
})

const done = (code) => {
  const clean = out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '')
  console.log('--- captured', out.length, 'chars ---')
  console.log(clean.split('\n').filter(Boolean).slice(0, 14).join('\n'))
  console.log('--- pty alive:', out.length > 0, '| pid:', proc.pid, '---')
  try {
    proc.kill()
  } catch {}
  process.exit(code)
}

setTimeout(() => {
  // Ctrl-C twice is how you leave the Claude Code TUI; proves input reaches the pty.
  proc.write('\x03')
  setTimeout(() => proc.write('\x03'), 300)
  setTimeout(() => done(out.length > 0 ? 0 : 1), 1500)
}, 6000)

proc.onExit(({ exitCode }) => done(out.length > 0 ? 0 : exitCode || 1))
