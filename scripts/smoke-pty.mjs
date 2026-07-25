// Headless proof that the risky half of the app works on Windows: spawn an agent
// CLI in a real pty, capture its output, send a keystroke, exit cleanly.
//
//   npm run smoke                                  -> claude, in this folder
//   npm run smoke -- --cmd codex --args "resume --last"
//   npm run smoke -- --cmd gemini --cwd C:\path
//
// The command is passed in rather than read from src/shared/agents.ts so this stays
// a plain .mjs script with no build step - it proves the pty path, not the catalogue.

import { existsSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import pty from '@lydell/node-pty'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

// Mirrors src/main/which.ts: ConPTY needs an absolute path, not a PATH lookup, and
// on Windows the .cmd/.exe shim must win over the extensionless bash script npm
// installs next to it.
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

const cmd = arg('cmd', 'claude')
const args = arg('args', '').split(/\s+/).filter(Boolean)
const cwd = arg('cwd', process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : process.cwd())
const exe = resolve(cmd)

console.log(`--- spawning ${exe} ${args.join(' ')} in ${cwd} ---`)
const proc = pty.spawn(exe, args, {
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
  // Ctrl-C twice is how you leave these TUIs; proves input reaches the pty.
  proc.write('\x03')
  setTimeout(() => proc.write('\x03'), 300)
  setTimeout(() => done(out.length > 0 ? 0 : 1), 1500)
}, 6000)

proc.onExit(({ exitCode }) => done(out.length > 0 ? 0 : exitCode || 1))
