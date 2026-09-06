// Proof, in a real window, that a Codex pane picks its own reasoning effort.
//
// Everything else about this feature is arithmetic and is pinned by `effort-test.mjs`.
// The one thing a test cannot say is whether the keys actually land in Codex's TUI, so
// this opens a REAL Codex pane in a headless dev copy, submits three prompts through the
// app's own write path, and then reads the conversation's own log - never the screen.
//
//   node scripts/effort-demo.mjs [--keep] [--port 9333]
//
// It costs three short Codex turns. It stops the moment a pane prints anything about a
// usage or rate limit, and never retries.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const port = args.includes('--port') ? args[args.indexOf('--port') + 1] : '9333'
const CWD = process.env.PF_EFFORT_DEMO_CWD || join(root, 'tmp', 'effort-proof')
const MODEL = process.env.PF_EFFORT_DEMO_MODEL || 'gpt-6-astra'

const say = (...a) => console.log(...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function evaluate(expression) {
  const out = execFileSync('node', [join(root, 'scripts/ui-lab.mjs'), 'eval', expression, '--port', port], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  })
  const text = out.trim()
  if (text.startsWith('SKIP:')) throw new Error(text)
  return JSON.parse(text)
}

/** The dev copy's own data folder, found by the log this feature writes into it. */
function effortLog() {
  const support = join(homedir(), 'Library/Application Support')
  let best = null
  for (const name of readdirSync(support)) {
    const file = join(support, name, 'effort.log')
    if (!existsSync(file)) continue
    const at = statSync(file).mtimeMs
    if (!best || at > best.at) best = { file, at }
  }
  return best?.file
}

/** The newest rollout Codex wrote for the demo folder, and its per-turn efforts. */
function rolloutTurns() {
  const base = join(homedir(), '.codex/sessions')
  const files = []
  const walk = (dir) => {
    let rows = []
    try {
      rows = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const row of rows) {
      const path = join(dir, row.name)
      if (row.isDirectory()) walk(path)
      else if (row.name.endsWith('.jsonl')) files.push({ path, at: statSync(path).mtimeMs })
    }
  }
  walk(base)
  files.sort((a, b) => b.at - a.at)
  for (const file of files.slice(0, 8)) {
    const text = readFileSync(file.path, 'utf8')
    if (!text.includes(CWD)) continue
    const turns = text
      .split('\n')
      .filter((l) => l.includes('"turn_context"'))
      .map((l) => {
        try {
          return JSON.parse(l).payload
        } catch {
          return null
        }
      })
      .filter(Boolean)
      .map((p) => ({ effort: p.effort, model: p.model }))
    if (turns.length) return { file: file.path, turns }
  }
  return { file: null, turns: [] }
}

async function waitFor(what, expr, ms = 120_000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const value = evaluate(expr)
    if (value) return value
    await sleep(1000)
  }
  throw new Error(`gave up waiting for ${what}`)
}

// A REFUSAL, not the heads-up banner Codex prints while it is still perfectly willing to
// answer ("you have less than 5% of your weekly limit left"): the first run of this demo
// stopped on that banner before a single turn had been asked for.
const LIMIT = /(rate limit reached|usage limit reached|you'?ve hit your|out of (credits|quota)|too many requests|429)/i

async function submit(id, prompt, label) {
  const started = Date.now()
  // `sendPrompt` is the app's own queued path: it types the line, waits for an idle
  // composer and presses return itself, retrying if the CLI ate it. That return is an
  // `app` write, which is exactly the case the intercept has to cover too.
  evaluate(`(() => { window.api.sendPrompt(${JSON.stringify(id)}, ${JSON.stringify(prompt)}); return true })()`)
  // The busy footer answers first; then the pane goes quiet again.
  await sleep(8000)
  await waitFor(
    `${label} to finish`,
    `(async () => { const s = (await window.api.listSessions()).find((x) => x.id === ${JSON.stringify(id)}); return s && s.status !== 'working' && s.status !== 'starting' })()`,
    180_000
  )
  const screen = evaluate(
    `(() => { const t = window.__pf[${JSON.stringify(id)}]?.term; if (!t) return ''; const b = t.buffer.active; let out = []; for (let i = Math.max(0, b.length - 40); i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? ''); return out.join('\\n') })()`
  )
  if (LIMIT.test(String(screen))) {
    say(`\nSTOPPED: the pane printed a limit line during "${label}". Nothing retried.`)
    say(String(screen).slice(-600))
    return { stopped: true }
  }
  const reading = evaluate(
    `(async () => { const s = (await window.api.listSessions()).find((x) => x.id === ${JSON.stringify(id)}); return s ? s.effort : null })()`
  )
  say(`  ${label}: ${Math.round((Date.now() - started) / 1000)}s, card says ${JSON.stringify(reading)}`)
  return { stopped: false }
}

const main = async () => {
  execFileSync('mkdir', ['-p', CWD])
  if (!args.includes('--keep')) {
    say('building...')
    execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' })
  }
  say('opening a headless dev copy...')
  spawnSync('npm', ['run', 'try', '--', '--headless', `--remote-debugging-port=${port}`, '--keep'], {
    cwd: root,
    stdio: 'inherit'
  })
  await waitFor('the window', '(() => Boolean(window.api))()', 90_000)

  say(`opening a Codex pane in ${CWD}`)
  const id = evaluate(
    `(async () => { const s = await window.api.startSession({ cwd: ${JSON.stringify(CWD)}, agent: 'codex', model: ${JSON.stringify(MODEL)}, effort: { mode: 'auto' }, where: 'local' }); return s && s.id })()`
  )
  if (!id) throw new Error('no pane')
  say(`pane ${id}`)
  await waitFor(
    'Codex to be ready',
    `(async () => { const s = (await window.api.listSessions()).find((x) => x.id === ${JSON.stringify(id)}); return Boolean(s && s.printed) })()`,
    120_000
  )
  // Codex prints its banner, its limit heads-up and then its composer. A return pressed
  // into any of that is eaten, so the first prompt waits for the pane to go properly quiet.
  await sleep(15000)

  const one = await submit(id, 'List the files in this folder. Reply with exactly the word OK.', 'turn 1 (expects Low)')
  if (!one.stopped) {
    const two = await submit(
      id,
      'Why does this intermittent crash still happen after two fixes? Reply with exactly the word OK.',
      'turn 2 (expects High)'
    )
    if (!two.stopped) {
      evaluate(
        `(async () => { await window.api.setEffort(${JSON.stringify(id)}, { mode: 'manual', level: 'medium' }); return true })()`
      )
      await submit(id, 'Implement the change we discussed. Reply with exactly the word OK.', 'turn 3 (set to Medium by hand)')
    }
  }

  const log = effortLog()
  if (log) {
    say('\n--- effort.log ---')
    say(readFileSync(log, 'utf8').trim().split('\n').slice(-20).join('\n'))
  } else {
    say('\nno effort.log found')
  }
  const rollout = rolloutTurns()
  say('\n--- what the conversation itself recorded ---')
  say(rollout.file ?? 'no rollout found')
  say(JSON.stringify(rollout.turns))

  spawnSync('npm', ['run', 'try', '--', '--close'], { cwd: root, stdio: 'inherit' })
}

main().catch((err) => {
  console.error(String(err?.stack || err))
  spawnSync('npm', ['run', 'try', '--', '--close'], { cwd: root, stdio: 'inherit' })
  process.exit(1)
})
