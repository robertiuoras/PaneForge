// Which conversation a pane may claim, when three lanes of one repo share one folder.
//
// Measured on this desk 2026-08-26. `clients`, `clients-a` and `clients-b` are lane
// worktrees, and their Claude Code project folders are SYMLINKS to one directory - one
// project, one history. A pane opened at 12:50 in `clients-b` had its brand-new
// conversation adopted, within the minute, by the `clients-a` pane that had been running
// since 01:51. The desk snapshot then carried the wrong resume id: reopening would have
// put `piateam` inside a Klaviyo chat somebody else was mid-turn in, and the sidebar's
// two titles had already stopped matching what was on screen.
//
// Two holes, both here:
//   - the unclaimed branch of `transcriptFor` had no `opening()` veto at all, so a chat
//     somebody LAUNCHED was adoptable; `movedTo` had refused one since the day it was
//     written.
//   - `movedTo`'s rival check compared cwd STRINGS, so a rival in another lane of the
//     same project was invisible.
//
// The weight is in the negatives, and the last block is the control: a pane must still
// find its own conversation, or this "fix" is just a pane that never resumes anything.
//
//   node scripts/transcript-claim-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-transcript-claim-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const home = join(work, 'claude')
const projects = join(home, 'projects')
mkdirSync(projects, { recursive: true })

const CWD = '/Users/x/Projects/clients'
const slug = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-')
const trunk = join(projects, slug(CWD))
mkdirSync(trunk, { recursive: true })
// The shape this went wrong on: a lane's project folder is a symlink to the trunk's.
for (const lane of ['-a', '-b']) symlinkSync(trunk, join(projects, slug(CWD + lane)))

process.env.PF_CLAUDE_HOME = home

const outfile = join(work, 'transcripts.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/main/transcripts.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile
})
const { noteSession, forgetSession, resumeIdFor, projectDir } = createRequire(
  import.meta.url
)(outfile)

let n = 0
const ok = (what, cond) => {
  assert.ok(cond, what)
  n++
}

/**
 * A transcript as Claude Code writes one: the opening records, then a turn.
 *
 * `cwd` is what the real file states on every turn record, and the blocks below that
 * leave it out do so deliberately: those cases are about the CLOCK rules, and a stated
 * folder would answer them before a clock was ever read. The block that states one is
 * the shape every real transcript on disk actually has.
 */
function chat(id, how, { turns = 1, cwd = null } = {}) {
  const lines = [
    JSON.stringify({ type: 'mode', mode: 'normal', sessionId: id }),
    JSON.stringify({ type: 'permission-mode', permissionMode: 'default', sessionId: id })
  ]
  if (how) {
    lines.push(
      JSON.stringify({
        parentUuid: null,
        attachment: { type: 'hook_success', hookName: `SessionStart:${how}`, content: '' }
      })
    )
  }
  for (let i = 0; i < turns; i++) {
    lines.push(
      JSON.stringify({
        type: 'user',
        ...(cwd ? { cwd } : {}),
        message: { role: 'user', content: 'hello' }
      })
    )
  }
  writeFileSync(join(trunk, `${id}.jsonl`), lines.join('\n') + '\n')
  return id
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// The lane folders really are one folder as far as this file is concerned.
ok('a lane resolves to the trunk project folder', projectDir(CWD + '-a') === projectDir(CWD))
ok('...and so does the other one', projectDir(CWD + '-b') === projectDir(CWD))

// ------------------------------------------- a chat somebody launched is not adoptable
{
  const old = chat('old-lane-a-chat', 'startup')
  noteSession('pane-a', CWD + '-a', 'claude', old)
  await sleep(20)

  // A second pane opens in another lane hours later, and its CLI writes a new chat.
  noteSession('pane-b', CWD + '-b', 'claude')
  const fresh = chat('fresh-lane-b-chat', 'startup')

  ok('the older pane stays in its own conversation', resumeIdFor('pane-a') === old)
  ok('...and the new pane gets the new one', resumeIdFor('pane-b') === fresh)

  forgetSession('pane-a')
  forgetSession('pane-b')
}

// ---------------------------------- ...including for a pane holding no claim at all
{
  // The exact live shape: a restored pane whose claim was lost, sitting on nothing while
  // somebody launches a CLI in another lane of the same repo.
  noteSession('pane-a', CWD + '-a', 'claude')
  await sleep(20)
  noteSession('pane-b', CWD + '-b', 'claude')
  const fresh = chat('another-launched-chat', 'startup')

  ok('a claimless pane does NOT adopt a launched chat', resumeIdFor('pane-a') === undefined)
  ok('...which is still the pane that launched it', resumeIdFor('pane-b') === fresh)

  forgetSession('pane-a')
  forgetSession('pane-b')
}

// --------------------------- a chat with no hook record belongs to whoever just started
{
  // A CLI with no SessionStart hook says nothing about how it began, so the veto above
  // cannot fire. The other guard has to: a pane that started later than this one and is
  // still holding nothing is the pane that chat is being written for.
  noteSession('pane-a', CWD + '-a', 'claude')
  await sleep(20)
  noteSession('pane-b', CWD + '-b', 'claude')
  chat('silent-chat', null)
  ok('a silent newborn goes to the pane that started last', resumeIdFor('pane-a') === undefined)
  ok('...which takes it', resumeIdFor('pane-b') === 'silent-chat')
  forgetSession('pane-a')
  forgetSession('pane-b')
  rmSync(join(trunk, 'silent-chat.jsonl'))
}

// ------------------------------------------------- the rival check crosses lanes
{
  const mine = chat('cleared-pane-chat', 'startup')
  noteSession('pane-a', CWD + '-a', 'claude', mine)
  const theirs = chat('rival-pane-chat', 'startup')
  noteSession('pane-b', CWD + '-b', 'claude', theirs)
  ok('each lane keeps its own', resumeIdFor('pane-a') === mine)
  ok('...both ways round', resumeIdFor('pane-b') === theirs)

  // The rival clears: a new chat appears that is the RIVAL's continuation, not ours.
  await sleep(20)
  const rivalsNew = chat('rival-cleared-into', 'clear')
  ok('a lane-b clear is not taken by lane a', resumeIdFor('pane-a') === mine)

  forgetSession('pane-a')
  forgetSession('pane-b')
  rmSync(join(trunk, `${rivalsNew}.jsonl`))
}

// ------------------------------- a transcript states its own folder, and that is final
{
  // The live shape from 2026-08-26, where every clock rule pointed the wrong way: the
  // desk was written with `piateam` (lane a) and `pizzasrus` (the trunk) both holding
  // transcripts recorded in lane b, and the lane-b pane holding none. A `/clear` in
  // lane b is born after lane a went quiet and says `clear`, so it satisfies `movedTo`
  // on the clocks alone - and it names its folder in the file.
  const mine = chat('states-lane-a', 'startup', { cwd: CWD + '-a' })
  noteSession('pane-a', CWD + '-a', 'claude', mine)
  await sleep(20)
  const rivals = chat('states-lane-b', 'clear', { cwd: CWD + '-b' })

  ok('a chat naming another lane is refused', resumeIdFor('pane-a') === mine)

  // ...and the pane it belongs to takes it, or the rule above is a pane that never moves.
  noteSession('pane-b', CWD + '-b', 'claude')
  ok('...and the pane whose folder it names takes it', resumeIdFor('pane-b') === rivals)

  // The same for a claimless pane: the unclaimed branch has to refuse it too. Asserted
  // as "not that file" rather than "nothing at all" - earlier blocks left chats in this
  // folder that state no cwd, and those are the clock rules' business, not this one's.
  forgetSession('pane-b')
  noteSession('pane-c', CWD, 'claude')
  ok('a claimless trunk pane refuses a lane-b chat', resumeIdFor('pane-c') !== rivals)

  forgetSession('pane-a')
  forgetSession('pane-c')
  rmSync(join(trunk, `${mine}.jsonl`))
  rmSync(join(trunk, `${rivals}.jsonl`))
}

// ------------------------------------------------------------------ the control
{
  // None of the above may cost a pane its own conversation: a pane that clears must
  // still follow itself into the chat the clear started.
  const mine = chat('control-first-chat', 'startup')
  noteSession('pane-solo', CWD, 'claude', mine)
  ok('the pane holds its own chat', resumeIdFor('pane-solo') === mine)

  await sleep(20)
  const after = chat('control-cleared-into', 'clear')
  // A clear re-notes the pane with no resume id - it does not know the new id yet.
  noteSession('pane-solo', CWD, 'claude')
  ok('...and follows its own /clear into the new one', resumeIdFor('pane-solo') === after)
  forgetSession('pane-solo')
}

console.log(`ok  transcript-claim  ${n} checks`)
