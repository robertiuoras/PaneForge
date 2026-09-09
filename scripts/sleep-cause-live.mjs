// Real automatic sleep in an isolated Electron profile. Build first. No agent CLI,
// installed app, user conversation, release or restart is involved.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync, watch } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { root, page, Link } from './ui-lab.mjs'

const name = `sleep-cause-proof-${process.pid}`
const dataRoot = process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support')
  : process.platform === 'win32' ? process.env.APPDATA : process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
assert(dataRoot, 'app data folder is known')
const profile = join(dataRoot, `claude-orchestrator-${name}`)
const evidence = join(tmpdir(), name)
const port = Number(process.env.PF_PORT ?? 9447)
mkdirSync(profile, { recursive: true })
mkdirSync(evidence, { recursive: true })
writeFileSync(join(profile, 'config.json'), JSON.stringify({ root: evidence,
  desktopShortcut: false, launchAtLogin: false, autoUpdate: false,
  discordPresence: false, autoLane: false, restoreAfterUpdate: false, phone: false,
  reclaim: { enabled: false }, autoHandoff: { enabled: false }, idleQuitMinutes: 0 }))
const env = { ...process.env, PANEFORGE_PROFILE: name, PANEFORGE_HEADLESS: '1', PANEFORGE_RESTORE: 'fresh' }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(createRequire(import.meta.url)('electron'), ['.', '--headless', `--profile=${name}`, `--remote-debugging-port=${port}`], {
  cwd: root, env, stdio: ['ignore', 'pipe', 'pipe']
})
let output = '', ws, timeout
child.stdout.on('data', chunk => { output += chunk })
const listening = new Promise((resolve, reject) => {
  child.stderr.on('data', chunk => { output += chunk; if (output.includes('DevTools listening on')) resolve() })
  child.once('error', reject)
  child.once('exit', (code, signal) => reject(Error(`test app exited: ${code}/${signal}`)))
  timeout = setTimeout(() => reject(Error('test app did not expose CDP')), 20_000)
})
try {
  await listening
  clearTimeout(timeout)
  const target = await page(port)
  assert(target.url.startsWith(pathToFileURL(root).href + '/'), 'CDP belongs to this checkout')
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }))
  const link = new Link(ws)
  const loaded = new Promise((resolve, reject) => {
    const onMessage = event => {
      const row = JSON.parse(event.data)
      if (row.method === 'Page.loadEventFired' || (row.method === 'Page.lifecycleEvent' && row.params.name === 'load')) {
        clearTimeout(timer); ws.removeEventListener('message', onMessage); resolve()
      }
    }
    const timer = setTimeout(() => { ws.removeEventListener('message', onMessage); reject(Error('renderer did not finish loading')) }, 15_000)
    ws.addEventListener('message', onMessage)
  })
  await link.send('Page.enable')
  await link.send('Page.setLifecycleEventsEnabled', { enabled: true })
  await loaded
  const started = await link.evaluate(`(async () => {
    const a = await window.api.startSession({ cwd: ${JSON.stringify(evidence)}, agent: 'shell', title: 'sleep proof A' });
    const b = await window.api.startSession({ cwd: ${JSON.stringify(evidence)}, agent: 'shell', title: 'sleep proof B' });
    const cfg = await window.api.getConfig();
    await window.api.setConfig({ ...cfg, reclaim: { ...cfg.reclaim, enabled: true, idleSleepMinutes: 0.001, idleCloseMinutes: 0 } });
    return [a.id, b.id];
  })()`)
  console.log(`Isolated shell panes ${started.join(', ')}; waiting for the real automatic sweep.`)
  const slept = await link.evaluate(`new Promise(async (resolve, reject) => {
    const ids = ${JSON.stringify(started)};
    const timer = setTimeout(() => { off(); reject(Error('automatic sleep did not happen within 75s')); }, 75000);
    const check = rows => { const s = rows.find(s => ids.includes(s.id) && s.asleep); if(s) { clearTimeout(timer); off(); resolve({id:s.id, reason:s.asleepReason}); } };
    const off = window.api.onSessions(check);
    check(await window.api.listSessions());
  })`)
  assert(['idle', 'pressure'].includes(slept.reason), `automatic sleep was ${slept.reason}`)
  const woke = await link.evaluate(`(async () => {
    const cfg = await window.api.getConfig(); await window.api.setConfig({...cfg, reclaim:{...cfg.reclaim, enabled:false}});
    const s = await window.api.wakeSession(${JSON.stringify(slept.id)});
    return { id:s.id, asleep:!!s.asleep, status:s.status };
  })()`)
  assert.equal(woke.asleep, false)
  // The renderer observes the spawn and first byte; the log writer is asynchronous.
  await link.evaluate(`new Promise(async resolve => {
    const id=${JSON.stringify(slept.id)};
    const done=rows=>{if(rows.some(s=>s.id===id && s.printed)){clearTimeout(timer);off();resolve(true)}};
    const timer=setTimeout(()=>{off();resolve(false)},10000);
    const off=window.api.onSessions(done);done(await window.api.listSessions());
  })`)
  // Wait for evidence to reach disk, not merely for a UI state to change. Log writes
  // intentionally run off the main thread and may still be queued at first paint.
  const rows = await new Promise((resolve, reject) => {
    const check = () => {
      const text = readFileSync(join(profile, 'reclaim.log'), 'utf8')
      const rows = text.slice(0, text.lastIndexOf('\n')).split('\n').filter(Boolean).map(JSON.parse)
      if (['sleep', 'wake', 'process-exit'].every(action => rows.some(row => row.action === action && row.pane === slept.id))) {
        clearTimeout(timer); watcher.close(); resolve(rows)
      }
    }
    const watcher = watch(profile, (_event, file) => { if (file === 'reclaim.log') check() })
    const timer = setTimeout(() => { watcher.close(); reject(Error('sleep/wake/exit logs did not reach disk within 10s')) }, 10_000)
    check()
  })
  const event = rows.find(row => row.action === 'sleep' && row.pane === slept.id)
  assert(event, 'completed automatic sleep is on disk')
  assert.equal(event.source, 'renderer-idle-sweep')
  assert.equal(event.reason, slept.reason)
  assert.equal(event.thresholdMs, 60)
  assert(event.idleMs >= event.thresholdMs)
  assert.equal(event.pid, child.pid)
  assert(event.version && event.seq > 0 && event.processPid)
  assert(rows.some(row => row.action === 'process-exit' && row.pane === slept.id), 'exit outcome is on disk')
  assert(rows.some(row => row.action === 'wake' && row.pane === slept.id), 'wake completion is on disk')
  const exited = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('isolated app failed to quit')), 10_000)
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }) })
  })
  // Finish the debugger evaluation before asking Electron to destroy its renderer.
  await link.evaluate(`setTimeout(() => { void window.api.quitIdle('sleep diagnostics runtime proof') }, 0); true`, { awaitPromise: false })
  const exit = await exited
  assert.equal(exit.code, 0)
  const terminalRows = readFileSync(join(profile, 'reclaim.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert(terminalRows.some(row => row.action === 'shutdown-request' && row.pane === slept.id && row.quitting), 'normal quit persisted the final pane lifecycle record')
  console.log('Normal quit persisted shutdown diagnostics and exited successfully.')
  writeFileSync(join(evidence, 'receipt.json'), JSON.stringify({ profile, pid: child.pid, slept, woke, event }, null, 2))
  console.log(JSON.stringify({ profile, pid: child.pid, slept, woke, event }))
} finally {
  clearTimeout(timeout)
  ws?.close()
  writeFileSync(join(evidence, 'app.log'), output)
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
}
