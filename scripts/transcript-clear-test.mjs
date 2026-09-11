// A pane that `/clear`s has to follow its own new conversation - on Windows too.
//
// Measured live 2026-09-11 on this desk. Pane `s1-mtwqtlwf` (assistant, on the PC)
// cleared at 22:42, and every handoff after that was refused with "Claude conversation
// has no resumable ID, so it was not handed off": `resumeIdFor` returned undefined for a
// pane that was sitting in a perfectly good conversation. The desk snapshot carried no
// resume id for it either, so reopening would have put it in whatever chat was newest,
// and the lane engine went on publishing the id of a chat that had stopped existing.
//
// Two independent defects, both of them here, and either one alone is enough to lose the
// conversation:
//
//   - `opening()` stopped scanning at the first `"type":"user"` record. Claude Code writes
//     the `/clear` command's OWN records - the local-command caveat, then the
//     `<command-name>/clear</command-name>` line - BEFORE the SessionStart attachment that
//     states how the conversation began. On the real file the marker sat on line 6 and the
//     scan stopped on line 3, so a cleared conversation read as `unknown`, and `movedTo`
//     wants the word `clear` before a settled pane may follow it.
//
//   - `heldElsewhere()` compared the transcript's stated folder to the pane's with `===`.
//     Claude Code writes the native path (`C:\Users\...`); PaneForge holds the pane's cwd
//     with forward slashes (`C:/Users/...`). Same folder, different strings, so the
//     same-folder exemption missed and the pane's own new chat read as a SIBLING LANE's -
//     the one thing that check exists to refuse. Windows only, which is why it survived.
//
// The last block is the control: the sibling-lane veto those two feed has to still fire,
// or this is not a fix, it is a deleted guard.
//
//   node scripts/transcript-clear-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-transcript-clear-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const home = join(work, 'claude')
const projects = join(home, 'projects')
mkdirSync(projects, { recursive: true })

// Held the way PaneForge holds a pane's cwd: forward slashes, on both platforms.
const CWD = 'C:/Users/x/Projects/assistant'
// ...and written the way Claude Code writes it into the transcript on Windows. The two
// spellings are the whole of the second defect, so the test states both explicitly
// rather than deriving one from `process.platform` and passing for free on the Mac.
const CWD_AS_WRITTEN = 'C:\\Users\\x\\Projects\\assistant'

const slug = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-')
const trunk = join(projects, slug(CWD))
mkdirSync(trunk, { recursive: true })

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
const { noteSession, forgetSession, resumeIdFor } = createRequire(import.meta.url)(outfile)

let n = 0
const ok = (what, cond) => {
  assert.ok(cond, what)
  n++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * A conversation started by `/clear`, in the record order Claude Code actually writes.
 *
 * The order is the point: caveat, command, system, and only THEN the hook attachment
 * saying `SessionStart:clear`. A helper that puts the marker first tests a file shape
 * that has not existed on this desk for months.
 */
function clearedChat(id, { cwd = CWD_AS_WRITTEN, dir = trunk } = {}) {
  const lines = [
    JSON.stringify({ type: 'mode', mode: 'normal', sessionId: id }),
    JSON.stringify({ type: 'file-history-snapshot', sessionId: id }),
    JSON.stringify({
      type: 'user',
      cwd,
      isMeta: true,
      message: { role: 'user', content: '<local-command-caveat>Caveat: local command</local-command-caveat>' }
    }),
    JSON.stringify({
      type: 'user',
      cwd,
      message: { role: 'user', content: '<command-name>/clear</command-name>\n<command-message>clear</command-message>' }
    }),
    JSON.stringify({ type: 'system', cwd, content: '' }),
    JSON.stringify({
      parentUuid: null,
      cwd,
      attachment: { type: 'hook_success', hookName: 'SessionStart:clear', content: '' }
    }),
    JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'continue from handoff' } })
  ]
  writeFileSync(join(dir, `${id}.jsonl`), lines.join('\n') + '\n')
  return id
}

/** A conversation somebody launched, for the blocks that need one to refuse. */
function launchedChat(id, { cwd = CWD_AS_WRITTEN, dir = trunk } = {}) {
  const lines = [
    JSON.stringify({ type: 'mode', mode: 'normal', sessionId: id }),
    JSON.stringify({
      parentUuid: null,
      cwd,
      attachment: { type: 'hook_success', hookName: 'SessionStart:startup', content: '' }
    }),
    JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'hello' } })
  ]
  writeFileSync(join(dir, `${id}.jsonl`), lines.join('\n') + '\n')
  return id
}

// ------------------------------------------- a settled pane follows its own /clear
{
  // The live shape: a pane handed here from the Mac, so it was settled on arrival, then
  // cleared. `movedTo` is the path that decides, and it wants the file's own word.
  const before = launchedChat('chat-before-the-clear')
  noteSession('pane', CWD, 'claude', before)
  ok('the pane starts in the conversation it arrived on', resumeIdFor('pane') === before)

  await sleep(20)
  const after = clearedChat('chat-after-the-clear')
  ok('a settled pane follows its own /clear', resumeIdFor('pane') === after)

  forgetSession('pane')
  rmSync(join(trunk, `${after}.jsonl`))
  rmSync(join(trunk, `${before}.jsonl`))
}

// ------------------------------- ...and so does one holding no claim at all
{
  // The other half: the `/clear` watcher re-notes the pane on submit, which drops its
  // claim, so the pane reaches the unclaimed branch instead. Same two defects, different
  // guard - `launchedElsewhere` there, `movedTo` above.
  noteSession('pane', CWD, 'claude')
  await sleep(20)
  const after = clearedChat('chat-claimed-from-nothing')
  ok('a re-noted pane claims the conversation its clear created', resumeIdFor('pane') === after)

  forgetSession('pane')
  rmSync(join(trunk, `${after}.jsonl`))
}

// ------------------------------------------------- the sibling-lane veto still fires
{
  // The control. A lane worktree's project folder is a SYMLINK to the trunk's, so one
  // folder holds both lanes' chats and `heldElsewhere` is the only thing that tells them
  // apart. Relaxing the same-folder exemption must not relax that.
  //
  // Windows refuses symlinkSync without Developer Mode or elevation, and the symlinked
  // shape IS this block, so skip out loud rather than assert something weaker.
  const LANE = CWD + '-a'
  let linked = true
  try {
    symlinkSync(trunk, join(projects, slug(LANE)))
  } catch (err) {
    if (err.code !== 'EPERM' && err.code !== 'EACCES') throw err
    linked = false
  }
  if (!linked) {
    console.log('skip  this machine cannot create symlinks - the sibling-lane veto needs the symlinked shape')
  } else {
    const mine = launchedChat('trunk-pane-chat')
    noteSession('pane', CWD, 'claude', mine)
    await sleep(20)
    // The LANE pane clears. Its new chat is newer than ours, says `clear`, and lands in
    // the folder we share - everything `movedTo` reads except the folder it names.
    clearedChat('lane-a-cleared-into', { cwd: LANE.replace(/\//g, '\\') })
    ok('a sibling lane\'s clear is still not adopted', resumeIdFor('pane') === mine)
    forgetSession('pane')
  }
}

console.log(`ok  ${n} checks`)
