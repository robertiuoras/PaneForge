// The first-run welcome, over the rows the real checklist produces. Pins who sees it (a
// fresh profile, never somebody with past sessions), which assistant is picked to begin
// with, what its one button does next (install, sign in, start), the sign-in line each CLI
// is run with, where the first chat opens, that the sign-in probes read the CLIs' real file
// shapes (and the account each is signed in with), and - by rendering the real component
// for each machine state - what a person actually reads.
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
const {
  showFirstRun,
  agentStates,
  chatAgent,
  recommendedInstall,
  firstChatFolder,
  FIRST_FOLDER,
  nextStep,
  signInCommand,
  signInRow,
  signInAgent,
  signInLink,
  wantsCode
} = bundle('src/shared/firstRun.ts', 'firstRun.bundle.cjs')
const { setupRows } = bundle('src/shared/setupCheck.ts', 'setupCheck.bundle.cjs')
const { gatherSetupFacts, signedInAccounts } = bundle('src/main/setupCheck.ts', 'mainSetupCheck.bundle.cjs')

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

// --- the one button: the next thing the picked assistant is missing --------------------
is(nextStep({ id: 'claude', installed: false, signedIn: false }), 'install', 'not installed -> install')
is(nextStep({ id: 'claude', installed: false, signedIn: true }), 'install', 'a key but no program -> still install')
is(nextStep({ id: 'codex', installed: true, signedIn: false }), 'signin', 'installed, signed out -> sign in')
is(nextStep({ id: 'codex', installed: true, signedIn: true }), 'start', 'ready -> start')

// --- the sign-in each CLI is run with ------------------------------------------------------
// Flags read off the installed CLIs' --help on 2026-10-07: `claude auth login --claudeai`
// (Claude subscription, the default) and `codex login` (ChatGPT, browser + localhost callback).
is(signInCommand('claude', '/Users/sam/.local/bin/claude', 'darwin'), "'/Users/sam/.local/bin/claude' auth login --claudeai", 'mac claude')
is(signInCommand('codex', '/opt/homebrew/bin/codex', 'darwin'), "'/opt/homebrew/bin/codex' login", 'mac codex')
is(signInCommand('claude', "/Users/o'neil/bin/claude", 'linux'), "'/Users/o'\\''neil/bin/claude' auth login --claudeai", 'a quote in the path stays quoted (bash)')
is(
  signInCommand('codex', "C:\\Users\\o'neil\\AppData\\Roaming\\npm\\codex.cmd", 'win32'),
  "& 'C:\\Users\\o''neil\\AppData\\Roaming\\npm\\codex.cmd' login",
  'windows: PowerShell call operator, quote doubled'
)
is(
  signInCommand('claude', 'C:\\Users\\Sam\u2019s PC\\.local\\bin\\claude.exe', 'win32'),
  "& 'C:\\Users\\Sam\u2019\u2019s PC\\.local\\bin\\claude.exe' auth login --claudeai",
  'windows: a curly quote (PowerShell reads it as a quote) is doubled too'
)
is([signInRow('claude'), signInRow('codex')], ['signin', 'codex-signin'], 'a sign-in streams under its own setup row')
is([signInAgent('signin'), signInAgent('codex-signin'), signInAgent('claude'), signInAgent('git')], ['claude', 'codex', null, null], 'and the row maps back')
is(
  signInLink('Opening browser...\nIf the browser did not open, visit: https://claude.ai/oauth/authorize?code=true&client_id=abc\n'),
  'https://claude.ai/oauth/authorize?code=true&client_id=abc',
  'the sign-in page address is read off the output'
)
is(signInLink('Starting local login server on http://localhost:1455.\n'), '', 'a localhost callback is never offered')
is(signInLink('see https://evil.example.com/claude.ai'), '', 'nor any host that is not the assistant\'s own')
is(signInLink('https://auth.openai.com/oauth/authorize?x=1'), 'https://auth.openai.com/oauth/authorize?x=1', 'codex sign-in host')
is(wantsCode('Paste code here if prompted > '), true, 'claude waiting for the copied code')
is(wantsCode('Opening browser to sign in...'), false, 'not before it asks')

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

// --- the account each assistant is signed in with -----------------------------------------
// `.claude.json` from CLAUDE_CONFIG_DIR, keys in the order the CLI writes them (2026-10-07,
// values replaced) - including the nested object the slice must not stop short of.
const accounts = (claudeText, codexAuth) => {
  const dir = join(work, 'accounts-' + checks)
  mkdirSync(join(dir, 'codex'), { recursive: true })
  if (claudeText !== undefined) writeFileSync(join(dir, '.claude.json'), claudeText)
  if (codexAuth !== undefined) writeFileSync(join(dir, 'codex', 'auth.json'), codexAuth)
  const before = { c: process.env.CLAUDE_CONFIG_DIR, x: process.env.CODEX_HOME }
  process.env.CLAUDE_CONFIG_DIR = dir
  process.env.CODEX_HOME = join(dir, 'codex')
  try {
    return signedInAccounts()
  } finally {
    for (const [k, v] of [['CLAUDE_CONFIG_DIR', before.c], ['CODEX_HOME', before.x]]) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}
const claudeFile = JSON.stringify(
  {
    numStartups: 3,
    oauthAccount: {
      accountUuid: 'u',
      emailAddress: 'sam@example.com',
      organizationUuid: 'o',
      ccOnboardingFlags: { a: true },
      organizationName: 'Sam'
    },
    projects: { '/x': { emailAddress: 'not-this@example.com' } }
  },
  null,
  2
)
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = (claims) => `${b64({ alg: 'RS256' })}.${b64(claims)}.sig`
const codexFile = JSON.stringify({ ...chatgpt, tokens: { ...chatgpt.tokens, id_token: jwt({ email: 'sam@chatgpt.test', 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' } }) } })
is(accounts(claudeFile, codexFile), { claude: 'sam@example.com', codex: 'sam@chatgpt.test' }, 'both signed in: both emails')
is(accounts(undefined, undefined), { claude: '', codex: '' }, 'neither file: no names (never the home folder\'s file)')
is(accounts('{"numStartups":1}', JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test', tokens: null })), { claude: '', codex: '' }, 'signed out claude, api-key codex: no names')
is(accounts(claudeFile, '{not json'), { claude: 'sam@example.com', codex: '' }, 'a broken codex file costs only its own name')

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
      accounts: { claude: '', codex: '' },
      pick: null,
      root: '/Users/sam/Projects',
      rootExists: true,
      preferred: 'claude',
      log: '',
      attempt: 0,
      busy: false,
      error: '',
      onPick: noop,
      onRun: noop,
      onFinished: noop,
      onChange: noop,
      onStart: noop,
      ...props
    })
  )
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
const count = (html, needle) => html.split(needle).length - 1
const goButton = (html) => html.match(/<button class="primary fr-go"[^>]*>([^<]*)</)
const goLabel = (html) => goButton(html)[1]
const picked = (html) => text(html.match(/<button class="fr-chip on"[\s\S]*?<\/button>/)[0]).trim()

const clean = view({})
is(text(clean).includes('Welcome to PaneForge'), true, 'says where you are')
is(count(clean, 'class="fr-num"'), 3, 'three numbered steps')
is(count(clean, '<button class="primary'), 1, 'one main button')
is(goLabel(clean), 'Install Claude', 'clean mac: the one button installs Claude')
is(picked(clean).startsWith('Claude by Anthropic'), true, 'and Claude is the one picked')
is(text(clean).includes('Not installed yet'), true, 'each chip says it is not installed')
is(text(clean).includes('Downloads Claude from Anthropic'), true, 'the button says what it will do')
is(clean.includes('Git for Windows'), false, 'no Windows line on a Mac')
is(/<select|<details/.test(clean), false, 'no dropdowns: chips and status lines')

const codexPicked = view({}, { pick: 'codex' })
is(goLabel(codexPicked), 'Install Codex', 'picking Codex makes the button about Codex')
is(text(codexPicked).includes('Downloads Codex from OpenAI'), true, 'and its note too')

const win = view({ platform: 'win32', gitInstalled: false })
is(text(win).includes('Claude needs Git for Windows'), true, 'windows: says Claude needs Git')
is(count(win, '>Install Git<'), 1, 'with its own button')
is(view({ platform: 'win32', gitInstalled: false }, { pick: 'codex' }).includes('Git for Windows'), false, 'not shown for Codex')

const signIn = view({ claudeInstalled: true }, { rootExists: false })
is(goLabel(signIn), 'Sign in to Claude', 'installed, signed out: the button signs in')
is(text(signIn).includes('Not signed in yet'), true, 'and the chip says so')
is(text(signIn).includes('sign in with your Claude account'), true, 'names the account it wants')
is(text(signIn).includes('Made for you when you start.'), true, 'missing folder says it will be made')
const codexSignIn = view({ codexInstalled: true }, { pick: 'codex' })
is(text(codexSignIn).includes('sign in with your ChatGPT account'), true, 'codex wants a ChatGPT account')

const signingIn = view({ claudeInstalled: true }, { log: 'signin', attempt: 1 })
is(signingIn.includes('install-console'), true, 'a sign-in shows its console')
is(text(signingIn).includes('Signing in... finish in your web browser'), true, 'labelled as a sign-in, not an install')
is(goLabel(signingIn), 'Start the sign-in again', 'a stuck sign-in can be started over')
is(goButton(signingIn)[0].includes('disabled'), false, 'so that button stays live')

const ready = view(
  { claudeInstalled: true, signedIn: true, codexInstalled: true, codexSignedIn: true },
  { accounts: { claude: 'sam@example.com', codex: '' } }
)
is(goLabel(ready), 'Start chatting with Claude', 'everything ready: the button starts the chat')
is(text(ready).includes('Signed in as sam@example.com'), true, 'claude shows the account it found')
is(count(ready, 'fr-chip-status ok'), 2, 'both chips read as ready')
is(text(ready).includes(' Ready '), true, 'an account with no name reads Ready')
is(text(ready).includes('Opens Claude in Projects.'), true, 'opens in the projects folder')
is(text(ready).includes('press Enter to say yes'), true, 'says how to answer Claude\'s first question')
is(text(ready).includes('/Users/sam/Projects'), true, 'shows the projects folder')
const readyCodex = view({ claudeInstalled: true, signedIn: true, codexInstalled: true, codexSignedIn: true }, { preferred: 'codex' })
is(goLabel(readyCodex), 'Start chatting with Codex', 'both ready: the saved default is picked')
is(text(readyCodex).includes('press Enter'), false, 'codex folders are already trusted: no question to warn about')
is(goLabel(view({ codexInstalled: true, codexSignedIn: true }, { preferred: 'claude' })), 'Start chatting with Codex', 'only codex ready: codex is picked')

const installing = view({}, { log: 'claude', attempt: 1, busy: true })
is(installing.includes('install-console'), true, 'an install shows the live console')
is(text(installing).includes('Installing...'), true, 'labelled as an install')
is(goLabel(installing), 'Installing Claude...', 'the button says it is working')
is(count(installing, 'disabled=""') >= 4, true, 'while installing, every button waits')

// New session's "no projects yet" state is `.empty.first-run`; a bare `.first-run` rule
// here once dressed it up as this card. The card owns its own class.
is(ready.startsWith('<div class="fr-card">'), true, 'card root is .fr-card')
is(/(^|[^.\w-])\.first-run\s*\{/m.test(readFileSync(join(root, 'src/renderer/src/styles.css'), 'utf8')), false, 'no bare .first-run rule')

// The words on screen never name the machinery (AGENTS.md "Every word on screen").
const JARGON = /\b(lanes?|worktrees?|checkouts?|CLI|PATH|terminal|repo|trunk|slot)\b/
for (const [name, html] of Object.entries({ clean, codexPicked, win, signIn, codexSignIn, signingIn, ready, readyCodex, installing })) {
  const hit = text(html).match(JARGON)
  is(hit?.[0] ?? null, null, `no jargon on screen (${name})`)
}

console.log(`first-run-test: ${checks} checks passed`)
