// Which antigravity conversation a pane may claim.
//
// Antigravity keeps ONE flat history.jsonl for the whole machine, so a row carries a
// folder and a moment and nothing else. `antigravityConversationFor` used to return the
// newest row whose workspace matched the pane's cwd - which is not identity. Measured
// 2026-09-01: `clients-b/tools/backdrop-gen.mjs` runs `agy` headlessly in
// `~/Projects/clients-b`, its rows are newer than the pane's, and the pane adopted its
// conversation `96d46b7a` (3 asks, none of them the pane's work). History showed the
// script's transcript, and a restore would have passed `--conversation` for it.
//
// The rule now: a pane adopts a conversation only when one of its `display` rows is a
// line the pane is KNOWN to have submitted. The weight below is in the refusals; the last
// block is the control - a pane must still find its own conversation.
//
//   node scripts/agy-conversation-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-agy-conversation-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(join(work, 'gemini', 'antigravity-cli'), { recursive: true })

process.env.PF_GEMINI_HOME = join(work, 'gemini')
process.env.PF_CLAUDE_HOME = join(work, 'claude')

const outfile = join(work, 'transcripts.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/main/transcripts.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile
})
const { noteSession, forgetSession, resumeIdFor, noteSubmittedPrompt } = createRequire(
  import.meta.url
)(outfile)

let n = 0
const ok = (what, cond, extra) => {
  assert.ok(cond, what + (extra === undefined ? '' : ` (${JSON.stringify(extra)})`))
  n++
}

const CWD = '/Users/x/Projects/clients-b'
const hFile = join(work, 'gemini', 'antigravity-cli', 'history.jsonl')
const rows = []
function say(display, conversationId, { workspace = CWD, at = Date.now() } = {}) {
  rows.push(JSON.stringify({ display, timestamp: at, workspace, conversationId }))
  writeFileSync(hFile, rows.join('\n') + '\n')
}

// ------------------------------------------------- a pane that typed nothing claims nothing
{
  noteSession('pane-1', CWD, 'antigravity')
  say('run the backdrop generator over every client', 'script-conv')
  ok('a pane with no typed line adopts nothing', resumeIdFor('pane-1') === undefined)
  forgetSession('pane-1')
}

// ------------------------------------------- the bug: a newer foreign row in the same folder
{
  noteSession('pane-2', CWD, 'antigravity')
  noteSubmittedPrompt('pane-2', 'set up the Cherry landing page copy')
  say('set up the Cherry landing page copy', 'pane-conv')
  // The script runs in the same folder a minute later, and its rows are the newest.
  say('generate a backdrop for pia', 'script-conv', { at: Date.now() + 60_000 })
  say('now do the other one', 'script-conv', { at: Date.now() + 61_000 })
  ok('the pane keeps its OWN conversation, not the newest', resumeIdFor('pane-2') === 'pane-conv')
  forgetSession('pane-2')
}

// ------------------------------------------------------------ another folder is never a match
{
  noteSession('pane-3', CWD, 'antigravity')
  noteSubmittedPrompt('pane-3', 'a line typed into pane three')
  say('a line typed into pane three', 'elsewhere-conv', { workspace: '/Users/x/Projects/other' })
  ok('a matching line in another folder is refused', resumeIdFor('pane-3') === undefined)
  forgetSession('pane-3')
}

// ------------------------------------------------------- a line too short to prove anything
{
  noteSession('pane-4', CWD, 'antigravity')
  noteSubmittedPrompt('pane-4', 'ok')
  say('ok', 'coincidence-conv')
  ok('a two-character agreement proves nothing', resumeIdFor('pane-4') === undefined)
  forgetSession('pane-4')
}

// --------------------------------------------------- a row written before the pane started
{
  const then = Date.now() - 10 * 60_000
  say('the same words, typed ten minutes ago', 'old-conv', { at: then })
  noteSession('pane-5', CWD, 'antigravity')
  noteSubmittedPrompt('pane-5', 'the same words, typed ten minutes ago')
  ok('a row older than the pane is refused', resumeIdFor('pane-5') === undefined)
  forgetSession('pane-5')
}

// ------------------------------------------------------- control: the pane finds its own
{
  noteSession('pane-6', CWD, 'antigravity')
  noteSubmittedPrompt('pane-6', 'Write the Cherry brief   and   check the numbers')
  // Whitespace and case are not identity, and a CLI may write a shortened line back.
  say('write the cherry brief and check the numbers', 'mine-conv')
  ok('the pane finds its own conversation', resumeIdFor('pane-6') === 'mine-conv')

  // ...and it sticks once claimed, even as the script keeps writing newer rows.
  say('something the script asked', 'script-conv', { at: Date.now() + 5000 })
  ok('...and keeps it while the script writes on', resumeIdFor('pane-6') === 'mine-conv')
  forgetSession('pane-6')
}

// ------------------------------------------------------ a prefix is enough, a stub is not
{
  noteSession('pane-7', CWD, 'antigravity')
  noteSubmittedPrompt('pane-7', 'refactor the invoice importer so it retries on a 429')
  say('refactor the invoice importer', 'prefix-conv')
  ok('a long prefix of a typed line counts', resumeIdFor('pane-7') === 'prefix-conv')
  forgetSession('pane-7')
}

console.log(`agy conversation: ${n} checks passed`)
