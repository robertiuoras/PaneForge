// Handing a job to the right project from outside the app.
//
//   npm run build
//   npm run try -- --keep --show --remote-debugging-port=9334
//   PF_PORT=9334 npm run test:routecli
//
// `--open <dir> --prompt <text>` is how something that is NOT PaneForge starts a session
// in the right place: a shell alias, or the Claude Code hook that notices a chat is in
// the wrong project and offers the command that moves it. `--route <text>` is the same
// thing with the folder worked out from the message.
//
// Two things here are easy to get wrong and both have been wrong already:
//
//   Chromium reorders argv. A second launch arrives at the running app as
//   `[exe, --open, --prompt, --allow-file-access-from-files, ., <dir>, <text>]` in its
//   OWN startup path - flags hoisted, values pushed to the end - so reading argv[i+1]
//   gives `--prompt` where the folder should be. The second-instance event delivers the
//   original order, which is the one that matters, and the parser must refuse the
//   reordered shape rather than open a folder called "--prompt".
//
//   The prompt is typed by the same queue the dialog uses, so the test asks for `/help`:
//   it is handled inside the CLI, prints locally and starts no turn.
//
// The pane it opens is killed at the end.

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const port = process.env.PF_PORT ?? '9334'
const profile = process.env.PANEFORGE_PROFILE ?? 'dev-b'

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && !(t.url ?? '').includes('shelf'))
if (!target)
  throw new Error(`no debuggable window on port ${port}. Start one with:
  npm run build && npm run try -- --keep --show --remote-debugging-port=${port}`)

const ws = new WebSocket(target.webSocketDebuggerUrl)
const pending = new Map()
let seq = 0
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  const p = pending.get(m.id)
  if (!p) return
  pending.delete(m.id)
  m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result)
})
const send = (method, params) => {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((res, rej) => pending.set(id, { res, rej }))
}
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails)
    throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails))
  return r.result.value
}

let failed = 0
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`)
  if (!cond) {
    failed++
    if (detail !== undefined) console.log(`      ${detail}`)
  }
}

const sessions = () => evaluate(`(async () => (await window.api.listSessions()).map(s => ({ id: s.id, cwd: s.cwd })))()`)

/** A second launch of the same profile, which the running app answers. */
function handoff(args) {
  const electron = join(repo, 'node_modules', 'electron', 'dist', 'electron.exe')
  const child = spawn(process.platform === 'win32' ? electron : electron.replace('.exe', ''), ['.', ...args], {
    cwd: repo,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, PANEFORGE_PROFILE: profile }
  })
  child.unref()
}

/** Poll rather than sleep once: the pane appears as soon as the pty spawns. */
async function waitForPane(cwd, ms = 12_000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const all = await sessions()
    const found = all.find((s) => s.cwd?.toLowerCase() === cwd.toLowerCase())
    if (found) return found
    await sleep(250)
  }
  return null
}

const before = await sessions()

// ---------------------------------------------------------------- --open <dir> --prompt

const dir = mkdtempSync(join(tmpdir(), 'pf-cli-'))
handoff(['--open', dir, '--prompt', '/help'])
const opened = await waitForPane(dir)
ok('--open starts a session in that folder', !!opened, JSON.stringify(await sessions()))

if (opened) {
  const typed = await evaluate(`(async () => {
    const s = (await window.api.listSessions()).find(s => s.id === ${JSON.stringify(opened.id)})
    return s ? { engaged: s.engaged, status: s.status } : null
  })()`)
  // `engaged` is set from the launch prompt, so it is the app's own record that a first
  // message arrived with the folder rather than the folder being opened bare.
  ok('and carries the prompt it was given', typed?.engaged === true, JSON.stringify(typed))
  await evaluate(`window.api.killSession(${JSON.stringify(opened.id)})`)
}
rmSync(dir, { recursive: true, force: true })

// ---------------------------------------------------------------- --route <text>

// No folder on the command line at all: the message names the project and the app works
// out where that is. The real projects root is what it looks in, so this asserts on a
// project that is certainly there - the one being tested.
await sleep(500)
handoff(['--route', 'fix the paneforge lane healer'])
const routed = await waitForPane(join(dirname(repo), 'PaneForge'))
ok('--route opens the project the message names', !!routed, JSON.stringify(await sessions()))
if (routed) await evaluate(`window.api.killSession(${JSON.stringify(routed.id)})`)

// A message naming nothing must open nothing at all. Silence is the whole contract here:
// a guess would put a random project on screen.
await sleep(500)
const quietBefore = (await sessions()).length
handoff(['--route', 'make the button a bit bigger please'])
await sleep(4000)
const quietAfter = await sessions()
ok('a message naming no project opens nothing', quietAfter.length === quietBefore, JSON.stringify(quietAfter))

// ---------------------------------------------------------------- leave nothing behind

await sleep(500)
const after = await sessions()
ok('every pane this test opened is closed again', after.length === before.length, JSON.stringify(after))

ws.close()
if (failed) {
  console.log(`\n${failed} failing check(s)`)
  process.exit(1)
}
console.log('\nall checks passed')
