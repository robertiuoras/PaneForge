// Show, in the test window, what this build actually changed.
//
//   npm run demo                 # rebuild, relaunch the copy, drive it, print evidence
//   npm run demo -- --keep       # same, against the copy already open
//
// Why this exists: "I changed X" and a passing suite are not something Robert can look
// at. This drives the real window through each change with a pause on every step, so the
// screen shows the feature working while the terminal says what the screen is doing and
// which build it is - the two together are the receipt.
//
// Every step is a QUESTION asked of the live window (`scripts/probe.mjs`'s transport),
// never a screenshot: a screenshot cannot say whether the row that appeared is the row
// that was supposed to appear.
//
// A step that cannot be shown says so and the run continues. A demo that stops at the
// first missing button teaches nothing about the other four.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const args = process.argv.slice(2)
const keep = args.includes('--keep')
const port = process.env.PF_PORT ?? '9333'
/** How long each step stays on screen before the next one replaces it. */
const BEAT_MS = Number(process.env.PF_DEMO_BEAT ?? 3500)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Run one expression in the window and give back its answer. */
async function ask(expr) {
  const r = spawnSync(process.execPath, [join(here, 'probe.mjs'), '--port', port, expr], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  })
  const out = (r.stdout ?? '').trim()
  // probe prints the expression back before the JSON, so take the last JSON value.
  const at = out.lastIndexOf('\n{')
  const json = at === -1 ? out.slice(out.indexOf('{')) : out.slice(at + 1)
  try {
    return JSON.parse(json)
  } catch {
    return { err: (r.stderr || out || 'no answer').split('\n').slice(-3).join(' ') }
  }
}

function say(step, what) {
  console.log(`\n${step}  ${what}`)
}

// ---------------------------------------------------------------- which build is this

const sha = execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
const subject = execFileSync('git', ['-C', root, 'log', '-1', '--format=%s'], { encoding: 'utf8' }).trim()

if (!keep) {
  console.log('== building')
  const b = spawnSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' })
  if (b.status !== 0) process.exit(b.status ?? 1)
  spawnSync('npm', ['run', 'try', '--', '--close'], { cwd: root, encoding: 'utf8' })
  spawnSync('npm', ['run', 'try', '--', '--keep', '--show', `--remote-debugging-port=${port}`], {
    cwd: root,
    encoding: 'utf8'
  })
  await sleep(4000)
}

const built = existsSync(join(root, 'out/renderer/index.html'))
  ? statSync(join(root, 'out/renderer/index.html')).mtime.toLocaleTimeString()
  : 'missing'
console.log(`\n== the copy on screen is ${sha} "${subject}"`)
console.log(`   renderer built at ${built}`)

// The window has to be reachable before any of this means anything.
const alive = await ask('({ ok: !!document.querySelector(".app, #root, body") })')
if (alive.err) {
  console.error(`the test copy is not answering on :${port} - ${alive.err}`)
  process.exit(1)
}


// Every step opens the dialog it needs and CHECKS it is in that one. The first run of
// this demo typed a History query into the New session box, waited, and reported "0 rows"
// as if the feature were broken - a step that does not name the screen it is on can fail
// truthfully about the wrong thing.
const DIALOG = `
  const head = () => (document.querySelector('.dialog-head strong')?.textContent || '').trim()
  // Every dialog in this app closes on a mousedown OUTSIDE it (the .overlay's own
  // handler), and that is the only close they all share - the buttons differ, and a demo
  // that hunted for a Cancel left New session open on screen while it typed History
  // queries into it, then reported the feature broken. Dialogs stack, so close until none.
  const closeDialog = async () => {
    for (let i = 0; i < 4; i++) {
      const overlay = document.querySelector('.overlay')
      if (!overlay) break
      overlay.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      await new Promise(r => setTimeout(r, 350))
    }
  }
  // History has no button - it is Ctrl+H or the command palette (App.tsx 'history'), so a
  // demo that only looks for buttons reports "History did not open" and blames the
  // feature. A key is a legal way to open a dialog, so this takes one.
  const openDialog = async (name, match, key) => {
    if (head() === name) return true
    await closeDialog()
    const btn = [...document.querySelectorAll('button')].find(b => match.test((b.title || '') + ' ' + (b.textContent || '')))
    if (btn) btn.click()
    else if (key) window.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true }))
    await new Promise(r => setTimeout(r, 900))
    return head() === name
  }
  const setValue = (el, t) => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, t)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
`

const results = []

// ---------------------------------------------------------------- 1. history by name

say('[1/4]', 'History finds a session by its NAME (used to search transcripts only)')
const hist = await ask(`(async () => {
  ${DIALOG}
  if (!(await openDialog('History', /search past sessions/i, 'h'))) return { err: 'History did not open' }
  const box = document.querySelector('.dialog .search')
  const saved = document.querySelectorAll('.hist-item').length
  // A name off the first row, so the demo searches for a session that is really there.
  const name = (document.querySelector('.hist-item strong')?.textContent || '').trim()
  const t0 = performance.now()
  setValue(box, name)
  await new Promise(r => setTimeout(r, 2500))
  const rows = [...document.querySelectorAll('.hist-item')]
  return {
    on: head(),
    saved,
    searchedFor: name,
    rows: rows.length,
    firstRow: (rows[0]?.querySelector('strong')?.textContent || '').trim(),
    hasOpenAgain: rows.some(r => [...r.querySelectorAll('button')].some(b => /open again|folder is gone/i.test(b.textContent || ''))),
    ms: Math.round(performance.now() - t0)
  }
})()`)
results.push(['History by name', hist])
console.log(`      ${JSON.stringify(hist)}`)
await sleep(BEAT_MS)

// ---------------------------------------------------------------- 2. history by text

say('[2/4]', 'and still finds a word a pane PRINTED - now off a prefiltered read')
const text = await ask(`(async () => {
  ${DIALOG}
  if (!(await openDialog('History', /search past sessions/i, 'h'))) return { err: 'History did not open' }
  const box = document.querySelector('.dialog .search')
  const t0 = performance.now()
  setValue(box, 'typecheck')
  await new Promise(r => setTimeout(r, 3000))
  return {
    on: head(),
    searchedFor: 'typecheck',
    rows: document.querySelectorAll('.hist-item').length,
    matchedLines: document.querySelectorAll('.hist-line').length,
    ms: Math.round(performance.now() - t0)
  }
})()`)
results.push(['History by transcript', text])
console.log(`      ${JSON.stringify(text)}`)
await sleep(BEAT_MS)

// ---------------------------------------------------------------- 3. create a project

say('[3/4]', 'New session: a name nothing matches is offered as a project')
const make = await ask(`(async () => {
  ${DIALOG}
  if (!(await openDialog('New session', /new session/i))) return { err: 'New session did not open' }
  const box = document.querySelector('.dialog .search')
  const type = async (t) => { setValue(box, t); await new Promise(r => setTimeout(r, 700)) }
  await type('paneforge')
  const forExisting = !document.querySelector('.proj-new')
  // A name that is really not there, worked out from the WHOLE list rather than
  // hard-coded: Car exists on this machine now, and offering to create a folder that is
  // already there shows the opposite of the feature.
  await type('')
  const have = new Set([...document.querySelectorAll('.proj-name')].map(e => (e.textContent||'').trim().toLowerCase()))
  let name = 'Car'
  for (let i = 2; have.has(name.toLowerCase()); i++) name = 'Car' + i
  await type(name)
  return {
    on: head(),
    existingNameOffersNothing: forExisting,
    typed: name,
    offer: (document.querySelector('.proj-new')?.textContent || '').trim()
  }
})()`)
results.push(['Create a project', make])
console.log(`      ${JSON.stringify(make)}`)
await sleep(BEAT_MS)

// ---------------------------------------------------------------- 4. pane titles

say('[4/4]', 'a repo pane keeps its own name; only a clients/ pane takes a subject')
const titles = await ask(`(async () => {
  ${DIALOG}
  await closeDialog()
  // A real pane in a real repo folder, so the card on screen is the evidence: a shell
  // pane, because this is about what the card SAYS and a shell costs nobody any tokens.
  const root = (await window.api.getConfig()).root
  const before = (await window.api.listSessions()).length
  await window.api.startSessions([{ cwd: root + '/Car', agent: 'shell' }])
  await new Promise(r => setTimeout(r, 3000))
  const sessions = await window.api.listSessions()
  // Leave the desk as it was found: the demo's own panes are closed again, so running it
  // twice does not stack Car panes nobody opened.
  const mine = sessions.slice(before)
  return {
    started: sessions.length - before,
    closedAfter: mine.length,
    cards: [...document.querySelectorAll('.row-name')].map(e => (e.textContent||'').trim()).slice(-4),
    sessions: sessions.map(s => ({ title: s.title, cwd: s.cwd })).slice(-3),
    closed: await (async () => {
      await new Promise(r => setTimeout(r, 2500))
      for (const s of mine) await window.api.killSession(s.id)
      return mine.length
    })()
  }
})()`)
results.push(['Pane titles', titles])
console.log(`      ${JSON.stringify(titles)}`)

// The rule itself, off the shipped file rather than off a memory of it.
const rule = spawnSync(process.execPath, [join(here, 'title-demo.mjs')], { encoding: 'utf8' })
if (rule.stdout) process.stdout.write(rule.stdout)

// ---------------------------------------------------------------- receipt

console.log(`\n== ${sha} - what the window just showed`)
for (const [what, r] of results) {
  console.log(`   ${r.err ? 'COULD NOT SHOW' : 'shown'}  ${what}${r.err ? ` (${r.err})` : ''}`)
}
console.log('\n   the window is still open: npm run try -- --close when you are done')
