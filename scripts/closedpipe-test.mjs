// A pipe whose other end has gone costs one log line, never an uncaughtException.
//
// 2026-09-22: three `uncaughtException: Error: write EPIPE` at WriteWrap.onWriteComplete in
// the installed app. The real half below writes to a real Windows pane's keystroke socket
// after its console is gone - once without the guard (it must throw, or this test proves
// nothing) and once with it. See src/main/closedPipe.ts.

import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { guardPtyPipes, tolerateClosedPipe } from '../src/main/closedPipe.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let failed = 0
function ok(what, cond, extra) {
  console.log(`${cond ? 'ok' : 'FAIL'}  ${what}${cond || extra === undefined ? '' : ` - ${extra}`}`)
  if (!cond) failed++
}
const epipe = () => Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })

console.log('an error on a guarded stream is reported, once per kind, and never thrown')
{
  const bare = new EventEmitter()
  let threw = false
  try {
    bare.emit('error', epipe())
  } catch {
    threw = true
  }
  ok('control: an unguarded stream throws its error', threw)

  const s = new EventEmitter()
  const said = []
  tolerateClosedPipe(s, (code) => said.push(code))
  let thrown = null
  try {
    s.emit('error', epipe())
    s.emit('error', epipe())
    s.emit('error', Object.assign(new Error('write EAGAIN'), { code: 'EAGAIN' }))
  } catch (err) {
    thrown = err
  }
  ok('a guarded stream does not throw', thrown === null, String(thrown))
  ok('each kind is reported once', said.join(',') === 'EPIPE,EAGAIN', said.join(','))

  const loud = new EventEmitter()
  tolerateClosedPipe(loud, () => { throw new Error('report broke') })
  let escaped = false
  try {
    loud.emit('error', epipe())
  } catch {
    escaped = true
  }
  ok('a report that throws does not bring the throw back', !escaped)
  ok('nothing to guard is not an error', (() => { tolerateClosedPipe(null, () => {}); return true })())
}

console.log('the app guards every pipe it writes to')
{
  const src = (f) => readFileSync(join(root, 'src/main', f), 'utf8')
  ok('every pane terminal', /guardPtyPipes\(proc,/.test(src('sessions.ts')))
  ok('main\'s own stdout and stderr', /tolerateClosedPipe\(process\.stdout/.test(src('crash.ts')) &&
    /tolerateClosedPipe\(process\.stderr/.test(src('crash.ts')))
  ok('the Codex effort-level ask', /tolerateClosedPipe\(child\.stdin/.test(src('effortLevels.ts')))
}

if (process.platform === 'win32') {
  console.log('a real pane: keystrokes after its console is gone')
  const pty = createRequire(import.meta.url)(join(root, 'node_modules/@lydell/node-pty'))
  let uncaught = []
  process.on('uncaughtException', (err) => uncaught.push(err.code || err.message))

  // Kill the terminal, then write straight to its keystroke socket until the pipe says it
  // is gone. `IPty.write` is a no-op once node-pty has closed the terminal, so the socket is
  // written directly: that is the window a real pane hits when its console goes first.
  const afterConsoleGone = async (guard) => {
    const p = pty.spawn('cmd.exe', [], { cols: 80, rows: 24, cwd: root })
    const said = []
    if (guard) guardPtyPipes(p, (side, code) => said.push(`${side}:${code}`))
    const socket = p._agent?.inSocket
    await new Promise((r) => {
      p.onData(() => r())
      setTimeout(r, 3000)
    })
    p.kill()
    for (let i = 0; i < 30 && socket && !socket.destroyed; i++) {
      await new Promise((r) => setTimeout(r, 100))
      if (!socket.destroyed) socket.write('x')
    }
    await new Promise((r) => setTimeout(r, 300))
    return { said, hadSocket: Boolean(socket) }
  }

  const bare = await afterConsoleGone(false)
  ok('node-pty still keeps its keystroke socket where the guard looks', bare.hadSocket)
  const bareThrows = uncaught.length
  ok('control: unguarded, the dead pipe reaches uncaughtException', bareThrows > 0, `${bareThrows}`)
  uncaught = []
  const guarded = await afterConsoleGone(true)
  ok('guarded, nothing reaches uncaughtException', uncaught.length === 0, uncaught.join(','))
  ok('and the pane\'s input pipe is reported', guarded.said.some((s) => s.startsWith('input:')), guarded.said.join(','))
} else {
  console.log('(the real-pane half runs on Windows only: node-pty has no keystroke socket elsewhere)')
}

console.log(failed ? `\n${failed} failed` : '\nclosedpipe: all good')
process.exit(failed ? 1 : 0)
