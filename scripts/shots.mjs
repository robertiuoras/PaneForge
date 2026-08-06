// Real screenshots of the real app, without a screen recorder.
//
//   npm run shots                     capture focus.png + grid.png
//   npm run shots -- --keep           skip the build, use what is in out/
//   npm run shots -- --out <dir>      write somewhere else
//   npm run shots -- --minimized      capture off-screen (see the caveat below)
//
// Why this exists: the marketing page at toolstash.xyz/paneforge draws its own
// preview in markup because there was no way to get a picture of the app that was
// not a manual screen grab. macOS will not hand a terminal the Screen Recording
// permission without a trip to System Settings, and a hand-taken grab goes stale
// the day the UI changes. Electron can photograph its own window through CDP with
// no OS permission at all, so this does that instead - and it is a command, so the
// pictures can be regenerated whenever the app looks different.
//
// It launches a SEPARATE copy on its own profile (`shots`), exactly like
// scripts/try.mjs: its own single-instance lock, its own config, its own taskbar
// button. The live app you are reading this in is never touched, and neither is
// your real profile - the capture copy gets a config written from scratch here, so
// it can never inherit or overwrite your window size, projects or panes.
//
// Panes are started with whichever agent CLIs are actually installed on this
// machine, in real folders, so what lands in the PNG is a real pty running a real
// agent. Nothing is prompted, so this costs no tokens: the panes show each CLI's
// own startup screen. Missing agents fall back to a plain shell running `git log`,
// which is still real output.
//
// The window is SHOWN by default. Chromium only composites frames for a window
// that is on screen, so a minimized copy can photograph as an empty grey rectangle.
// `--minimized` is there if you would rather risk that than have a window appear;
// the capture is checked for size either way and the script says so if it looks blank.
//
// LOOK AT THE PNGs BEFORE YOU PUBLISH THEM. They are photographs of your machine.
// The first run of this produced, entirely truthfully: your home folder in the path
// bar, your Claude statusline with its plan and usage percentages, a Codex line
// saying how much of the weekly limit was left, your MCP server names, and a Gemini
// "do you trust this folder?" box. All real, none of it something to put on a
// marketing page. Start the panes in folders each CLI has already been run in, give
// them a moment of real work to show, and read every line in the frame.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApps, waitTestAppsGone } from './test-app.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const keep = argv.includes('--keep')
const minimized = argv.includes('--minimized')
const PORT = Number(process.env.PF_SHOTS_PORT ?? 9436)
const PROFILE = 'shots'

function flag(name, fallback) {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

// Toolstash sits beside this repo and serves public/paneforge/{focus,grid}.png.
// The page falls back to its drawn preview when they are absent, so writing them
// is the whole handover - there is no other wiring to do.
const outDir = resolve(flag('--out', join(root, '..', 'toolstash', 'public', 'paneforge')))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ------------------------------------------------------------------ profile

/** Where Electron puts userData for `PANEFORGE_PROFILE=shots`, per src/main/profile.ts. */
function profileDir() {
  const base =
    process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support')
      : process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  return join(base, `claude-orchestrator-${PROFILE}`)
}

/**
 * Write the capture profile from scratch every run.
 *
 * Fixed window bounds matter more than they look: the page renders these at a
 * 16:10 aspect, and a capture taken at whatever size the last run left behind
 * gets letterboxed or cropped by the layout. Writing config.json before first
 * launch also stops `initProfile()` seeding this profile from the real one.
 */
function freshProfile() {
  const dir = profileDir()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* a leftover copy still holding a file - the config below is what matters */
  }
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify(
      {
        root: join(homedir(), 'Projects'),
        grid: false,
        restoreAfterRestart: 'never',
        notifyOnIdle: false,
        window: { width: 1600, height: 1000, x: 60, y: 60 }
      },
      null,
      2
    )
  )
}

// ------------------------------------------------------------------ CDP
// Same raw-WebSocket client the other probes use. Kept inline on purpose: every
// script in here owns its own so a change to one can never break the rest.

async function targets() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
    return await r.json()
  } catch {
    return []
  }
}

async function connect() {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const page = (await targets()).find(
      (t) => t.type === 'page' && /index\.html/.test(t.url) && !/shelf/.test(t.url)
    )
    if (page) return await open(page.webSocketDebuggerUrl)
    await sleep(400)
  }
  // A port left bound by a copy that has since died looks exactly like this.
  throw new Error(`No renderer on :${PORT} after 60s. Retry with PF_SHOTS_PORT=9437.`)
}

function open(url) {
  return new Promise((resolve_, reject) => {
    const ws = new WebSocket(url)
    let id = 0
    const waiting = new Map()
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      const p = waiting.get(msg.id)
      if (!p) return
      waiting.delete(msg.id)
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result)
    }
    ws.onerror = () => reject(new Error('CDP socket failed'))
    ws.onopen = () =>
      resolve_({
        send: (method, params = {}) =>
          new Promise((res, rej) => {
            const n = ++id
            waiting.set(n, { resolve: res, reject: rej })
            ws.send(JSON.stringify({ id: n, method, params }))
          }),
        close: () => ws.close()
      })
  })
}

async function evalIn(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', {
    expression: expr,
    awaitPromise: true,
    returnByValue: true
  })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed')
  return r.result.value
}

// ------------------------------------------------------------------ panes

/** Is this CLI actually on PATH? Only installed agents get a pane. */
function have(bin) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], {
    stdio: 'ignore'
  })
  return r.status === 0
}

/**
 * Four panes, best available agent first.
 *
 * Each pane is given something to DO, because the first version of this script
 * left them idle and photographed four boxes containing a splash screen and
 * nothing else - true, and useless as a picture of the app.
 *
 * What they are given is `/help`, and that is deliberate: it is a real command
 * typed into a real pty that fills the pane with the CLI's own output, and it is
 * answered locally, so a screenshot costs no tokens and reveals no conversation.
 * Shell panes get `git log` for the same reason.
 */
function plan() {
  const projects = resolve(flag('--projects', join(homedir(), 'Projects')))
  // Override with --dirs a,b,c,d when these are not the four you want in frame.
  const dirs = flag('--dirs', 'toolstash,PaneForge,assistant,taskdriver.ai').split(',')
  // Only CLIs that are signed in AND have already been trusted in these folders
  // belong in a picture. An agent seeing a folder for the first time photographs
  // as "do you trust the files in this folder?", and one that is signed out
  // photographs as a login URL with a live challenge token in it - which is not
  // something to commit to a public README. Override with --agents a,b,c,d once
  // you have run the others by hand at least once.
  const agents = flag('--agents', 'claude,codex,shell,shell').split(',')
  const bins = {
    claude: 'claude',
    codex: 'codex',
    gemini: 'gemini',
    qwen: 'qwen',
    cursor: 'cursor-agent'
  }
  // What a shell pane runs. Real commands, real output, nothing personal.
  const shellCmds = ['git log --oneline -12', 'git status -sb && git log --oneline -8']

  const out = []
  for (let i = 0; i < dirs.length && out.length < 4; i++) {
    const cwd = join(projects, dirs[i].trim())
    if (!existsSync(cwd)) {
      console.log(`   skipping ${dirs[i].trim()} - no such folder`)
      continue
    }
    const agent = (agents[out.length] ?? 'shell').trim()
    const shells = out.filter((s) => s.agent === 'shell').length
    out.push(
      agent !== 'shell' && have(bins[agent])
        ? // Long delay: the prompt is typed into the CLI, so it has to be up first.
          { cwd, agent, prompt: '/help', promptDelay: 6000 }
        : {
            cwd,
            agent: 'shell',
            prompt: shellCmds[shells % shellCmds.length],
            promptDelay: 900
          }
    )
  }
  return out
}

// ------------------------------------------------------------------ capture

async function shoot(cdp, file) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  if (!r?.data) throw new Error(`captureScreenshot returned nothing for ${file}`)
  writeFileSync(file, Buffer.from(r.data, 'base64'))
  const kb = Math.round(statSync(file).size / 1024)
  // A window Chromium never composited comes back as a flat rectangle, which PNG
  // squashes to a few KB. Worth saying out loud rather than shipping a grey box.
  console.log(`   ${file}  ${kb} KB${kb < 25 ? '  <- suspiciously small, looks blank' : ''}`)
  return kb
}

async function main() {
  if (!keep) {
    console.log('== Building')
    const b = spawnSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit', shell: true })
    if (b.status !== 0) process.exit(b.status ?? 1)
  }

  const electron = join(
    root,
    'node_modules',
    'electron',
    'dist',
    process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron.exe'
  )
  if (!existsSync(electron)) {
    console.error('No Electron in node_modules. Run `npm install` first.')
    process.exit(1)
  }

  closeTestApps(root)
  await waitTestAppsGone(root, 8000)
  freshProfile()
  mkdirSync(outDir, { recursive: true })

  const sessions = plan()
  if (!sessions.length) {
    console.error(`No projects found under ${join(homedir(), 'Projects')} - nothing to photograph.`)
    process.exit(1)
  }

  console.log(`== Launching the ${PROFILE} copy on :${PORT}${minimized ? ' (minimized)' : ''}`)
  const child = spawn(
    electron,
    ['.', minimized ? '--minimized' : '--show', `--remote-debugging-port=${PORT}`],
    { cwd: root, detached: true, stdio: 'ignore', env: { ...process.env, PANEFORGE_PROFILE: PROFILE } }
  )
  child.unref()

  let cdp
  try {
    cdp = await connect()
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')

    console.log(`== Starting ${sessions.length} panes: ${sessions.map((s) => s.agent).join(', ')}`)
    await evalIn(cdp, `window.api.startSessions(${JSON.stringify(sessions)})`)

    // Agent CLIs paint their startup screen over a couple of seconds. There is no
    // "ready" event to wait on that means "and it has drawn something", so this is
    // a wait. Long enough for a cold `claude`, short enough to not be annoying.
    // Long enough for a cold `claude`, plus its 6s prompt delay, plus the output
    // of /help to actually arrive and scroll the CLI's own startup warnings off
    // the top of the pane - which is where account and quota lines live.
    console.log('== Letting the agents paint (24s)')
    await sleep(24_000)

    console.log('== Capturing')
    await evalIn(cdp, `window.api.setConfig({ grid: false })`)
    await sleep(1200)
    await shoot(cdp, join(outDir, 'focus.png'))

    await evalIn(cdp, `window.api.setConfig({ grid: true })`)
    await sleep(1500)
    await shoot(cdp, join(outDir, 'grid.png'))
  } finally {
    try {
      cdp?.close()
    } catch {
      /* already gone */
    }
    closeTestApps(root)
  }

  console.log(`\nWrote focus.png and grid.png to ${outDir}`)
  console.log('Commit them in toolstash and /paneforge swaps its drawing for them.')
}

main().catch((e) => {
  console.error(`shots failed: ${e.message}`)
  closeTestApps(root)
  process.exit(1)
})
