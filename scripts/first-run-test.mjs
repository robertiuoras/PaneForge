// The Welcome screen's first-run card, over the rows the real checklist produces. Pins
// who sees the card (a fresh profile, never somebody with past sessions), which assistant
// "Start your first chat" opens, which one is badged recommended, where the first chat
// opens, that the Codex sign-in probe reads Codex's real auth.json shapes, and - by
// rendering the real component for each machine state - what a person actually reads.
//
//   node scripts/first-run-test.mjs

import { buildSync } from 'esbuild'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { strict as assert } from 'node:assert'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// Its own folder per run, so two lanes running this at once never delete each other's.
const work = mkdtempSync(join(tmpdir(), 'pf-first-run-test-'))

const bundle = (entry, name) => {
  const out = join(work, name)
  buildSync({ absWorkingDir: root, entryPoints: [entry], bundle: true, format: 'cjs', platform: 'node', outfile: out })
  return createRequire(import.meta.url)(out)
}
const { showFirstRun, agentStates, chatAgent, recommendedInstall, firstChatFolder, FIRST_FOLDER } = bundle(
  'src/shared/firstRun.ts',
  'firstRun.bundle.cjs'
)
const { setupRows } = bundle('src/shared/setupCheck.ts', 'setupCheck.bundle.cjs')
const { gatherSetupFacts } = bundle('src/main/setupCheck.ts', 'mainSetupCheck.bundle.cjs')

let checks = 0
const is = (actual, expected, what) => {
  assert.deepEqual(actual, expected, what)
  checks++
}

const facts = (over) => ({
  platform: 'darwin',
  claudeInstalled: false,
  gitInstalled: true,
  signedIn: false,
  codexInstalled: false,
  codexSignedIn: false,
  ...over
})
const states = (over) => agentStates(setupRows(facts(over)))

// --- who sees the card -------------------------------------------------------------
is(showFirstRun(undefined, 0), true, 'fresh profile: no flag, no past sessions -> card')
is(showFirstRun(true, 0), false, 'flag set (first chat opened) -> never again, even with history pruned')
is(showFirstRun(undefined, 412), false, 'profile from before the flag with past sessions -> no card')
is(showFirstRun(false, 3), false, 'past sessions win over an explicit false')

// --- state read off the real rows -----------------------------------------------------
is(
  states({}),
  [
    { id: 'claude', installed: false, signedIn: false },
    { id: 'codex', installed: false, signedIn: false }
  ],
  'clean machine: nothing installed, nothing signed in'
)
is(
  states({ claudeInstalled: true, signedIn: true, codexInstalled: true, codexSignedIn: true }),
  [
    { id: 'claude', installed: true, signedIn: true },
    { id: 'codex', installed: true, signedIn: true }
  ],
  'fully set up machine: both ready'
)
is(states({ codexInstalled: true })[1], { id: 'codex', installed: true, signedIn: false }, 'codex installed, not signed in')
// Windows adds a Git row; it must not be read as either assistant's state.
is(
  agentStates(setupRows(facts({ platform: 'win32', gitInstalled: false, claudeInstalled: true, signedIn: true }))),
  [
    { id: 'claude', installed: true, signedIn: true },
    { id: 'codex', installed: false, signedIn: false }
  ],
  'windows git row does not leak into assistant state'
)

// --- which assistant the Start button opens ------------------------------------------
is(chatAgent(states({}), 'claude'), null, 'nothing installed -> nothing to start')
is(chatAgent(states({ codexInstalled: true }), 'claude'), 'codex', 'only codex installed -> codex, whatever the default')
is(chatAgent(states({ claudeInstalled: true, codexInstalled: true }), 'codex'), 'codex', 'both installed, none signed in -> saved default')
is(chatAgent(states({ claudeInstalled: true, codexInstalled: true }), 'shell'), 'claude', 'both installed, default not one of them -> claude')
is(
  chatAgent(states({ claudeInstalled: true, codexInstalled: true, codexSignedIn: true }), 'claude'),
  'codex',
  'signed-in codex beats a claude that would open on a sign-in screen'
)
is(
  chatAgent(states({ claudeInstalled: true, signedIn: true, codexInstalled: true, codexSignedIn: true }), 'codex'),
  'codex',
  'both ready -> saved default'
)
// An API key with no Claude program is "signed in" but not installed - nothing to open.
is(chatAgent(states({ signedIn: true }), 'claude'), null, 'claude key but no claude -> nothing to start')

// --- recommended badge ----------------------------------------------------------------
is(recommendedInstall(states({})), 'claude', 'nothing installed -> claude recommended (no Node needed)')
is(recommendedInstall(states({ codexInstalled: true })), null, 'something installed -> no badge')

// --- where the first chat opens ----------------------------------------------------------
is(firstChatFolder('/Users/sam/Projects', true), { cwd: '/Users/sam/Projects' }, 'projects folder exists -> open there')
is(firstChatFolder('/Users/sam/Projects', false), { create: FIRST_FOLDER }, 'no projects folder yet -> a new one inside it')
is(FIRST_FOLDER.includes(' '), false, 'the made folder has no space in its name (tools choke on them)')

// --- the Codex sign-in probe, over auth.json shapes Codex 0.155 writes -----------------
// Keys copied from a real ~/.codex/auth.json on 2026-09-24 (values replaced).
const probe = (content) => {
  const dir = join(work, 'codex-home-' + checks)
  mkdirSync(dir, { recursive: true })
  if (content !== undefined) writeFileSync(join(dir, 'auth.json'), content)
  const before = process.env.CODEX_HOME
  process.env.CODEX_HOME = dir
  try {
    return gatherSetupFacts().codexSignedIn
  } finally {
    if (before === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = before
  }
}
const chatgpt = {
  auth_mode: 'chatgpt',
  OPENAI_API_KEY: null,
  tokens: { id_token: 'x.y.z', access_token: 'a.b.c', refresh_token: 'r', account_id: 'acc' },
  last_refresh: '2026-09-24T00:00:00Z'
}
is(probe(JSON.stringify(chatgpt, null, 2)), true, 'chatgpt sign-in (pretty-printed, key null) -> signed in')
is(probe(JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test', tokens: null })), true, 'api-key sign-in -> signed in')
is(probe(JSON.stringify({ OPENAI_API_KEY: null, tokens: null })), false, 'file present, both empty -> not signed in')
is(probe(undefined), false, 'no auth.json (after codex logout) -> not signed in')

// --- an install is seen the moment it finishes ------------------------------------------
// `which` keeps a "not found" for 60s, and the card looks for Claude as soon as it shows -
// so an install finishing inside that minute used to be reported as failed. Every install
// path calls `refreshPath()` before asking again; that has to drop the stale answer.
writeFileSync(join(work, 'pty-stub.cjs'), 'module.exports = {}')
const entry = join(work, 'install-entry.ts')
writeFileSync(
  entry,
  `export { refreshPath } from ${JSON.stringify(join(root, 'src/main/install'))}\n` +
    `export { which } from ${JSON.stringify(join(root, 'src/main/which'))}\n`
)
const installOut = join(work, 'install.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: [entry],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: installOut,
  // Neither the native terminal module nor Electron is touched by these two functions.
  alias: { '@lydell/node-pty': join(work, 'pty-stub.cjs'), electron: join(work, 'pty-stub.cjs') }
})
const { refreshPath, which } = createRequire(import.meta.url)(installOut)
{
  const bin = join(work, 'bin')
  mkdirSync(bin)
  const before = process.env.PATH
  process.env.PATH = bin + delimiter + before
  try {
    is(which('pf-first-run-fake'), 'pf-first-run-fake', 'fake program: not installed yet')
    const file = join(bin, process.platform === 'win32' ? 'pf-first-run-fake.cmd' : 'pf-first-run-fake')
    writeFileSync(file, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n')
    chmodSync(file, 0o755)
    refreshPath()
    is(which('pf-first-run-fake') !== 'pf-first-run-fake', true, 'installed seconds later: found after refreshPath, not the cached miss')
  } finally {
    process.env.PATH = before
  }
}

// --- what the card says, rendered from the real component -------------------------------
// `window.api` is read at module load by the card and the install console; nothing below
// calls it, because the view is rendered from plain values.
globalThis.window = { api: {} }
const cardOut = join(work, 'FirstRunCard.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/renderer/src/components/FirstRunCard.tsx'],
  outfile: cardOut,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'],
  alias: { '@shared': join(root, 'src/shared') }
})
const require = createRequire(import.meta.url)
const Module = require('node:module')
const card = new Module(cardOut)
card.filename = cardOut
card.paths = Module._nodeModulePaths(root) // React from this checkout, not the temp dir
card._compile(readFileSync(cardOut, 'utf8'), cardOut)
const { FirstRunView } = card.exports

const noop = () => {}
const view = (over, props = {}) =>
  renderToStaticMarkup(
    React.createElement(FirstRunView, {
      rows: setupRows(facts(over)),
      root: '/Users/sam/Projects',
      rootExists: true,
      preferred: 'claude',
      log: '',
      attempt: 0,
      busy: false,
      error: '',
      onInstall: noop,
      onInstalled: noop,
      onChange: noop,
      onStart: noop,
      ...props
    })
  )
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
const count = (html, needle) => html.split(needle).length - 1
const startButton = (html) => html.match(/<button class="primary fr-go"[^>]*>/)[0]

const clean = view({})
is(count(clean, '>Install<'), 2, 'clean mac: an Install button for each assistant')
is(text(clean).includes('Claude , the coding assistant from Anthropic'), true, 'claude is named for what it is')
is(text(clean).includes('Codex , the coding assistant from OpenAI'), true, 'codex is named for what it is')
is(text(clean).includes('Uses your Claude account - recommended'), true, 'claude carries the recommendation')
is(text(clean).includes('Uses your ChatGPT account - recommended'), false, 'codex does not')
is(startButton(clean).includes('disabled'), true, 'nothing installed: Start is disabled')
is(text(clean).includes('Install one of the assistants above first.'), true, 'and says what to do instead')
is(clean.includes('Git for Windows'), false, 'no Windows row on a Mac')

const win = view({ platform: 'win32', gitInstalled: false })
is(win.indexOf('Git for Windows') < win.indexOf('coding assistant from Anthropic'), true, 'windows: Git row comes first')
is(count(win, '>Install<'), 3, 'windows clean: Git, Claude, Codex installs')

const signIn = view({ claudeInstalled: true }, { rootExists: false })
is(count(signIn, '>Install<'), 1, 'claude installed: only codex still offers Install')
is(text(signIn).includes('Installed - signs in when its first chat opens'), true, 'installed-not-signed-in says how sign-in happens')
is(startButton(signIn).includes('disabled'), false, 'claude installed: Start is live')
is(
  text(signIn).includes('Opens Claude in a new folder, my-first-project. Claude asks you to sign in first, in your web browser.'),
  true,
  'no projects folder yet: says a new folder is made, and that sign-in comes first'
)
is(text(signIn).includes('/Users/sam/Projects - made for you when you start'), true, 'missing folder is named with what will happen')

const ready = view({ claudeInstalled: true, signedIn: true, codexInstalled: true, codexSignedIn: true })
is(count(ready, 'fr-row done'), 3, 'everything ready: three ticks (Claude, Codex, folder)')
is(count(ready, '>Install<'), 0, 'everything ready: nothing to install')
is(text(ready).includes('Opens Claude in Projects.'), true, 'ready: opens the saved default in the projects folder')
is(text(ready).includes('sign in'), false, 'ready: no sign-in talk')

const installing = view({}, { log: 'claude', attempt: 1, busy: true })
is(installing.includes('install-console'), true, 'an install shows the live console')
is(count(installing, 'disabled=""') >= 3, true, 'while installing, the other buttons wait')
is(text(installing).includes('Opening...'), false, 'an install is not labelled as opening a chat')

// New session's "no projects yet" state is `.empty.first-run`; a bare `.first-run` rule
// here once dressed it up as this card. The card owns its own class.
is(ready.startsWith('<div class="fr-card">'), true, 'card root is .fr-card')
is(/(^|[^.\w-])\.first-run\s*\{/m.test(readFileSync(join(root, 'src/renderer/src/styles.css'), 'utf8')), false, 'no bare .first-run rule')

// The words on screen never name the machinery (AGENTS.md "Every word on screen").
const JARGON = /\b(lanes?|worktrees?|checkouts?|CLI|PATH|terminal|repo|trunk|slot)\b/
for (const [name, html] of Object.entries({ clean, win, signIn, ready, installing })) {
  const hit = text(html).match(JARGON)
  is(hit?.[0] ?? null, null, `no jargon on screen (${name})`)
}

console.log(`first-run-test: ${checks} checks passed`)
