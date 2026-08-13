// Regression test for the lane line every chat reads at the top of every prompt -
// scripts/lane-hook.mjs, the `--event=prompt` roster.
//
// The bug this exists for: 2026-08-13. The line listed only the OTHER chats and never
// showed the reader its own row, so three chats open in one repository each printed a
// different sentence about the same state - "lane main and lane a", "lane a", "no other
// chat" - every one of them true, no two of them comparable, and none of them containing
// the reader. Reported as "this one has lane b and lane a while first assistant has main
// checkout and lane a and 2nd assistant has nothing please fix its really confusing". The
// lanes themselves were healthy the whole time: one chat per lane, nothing dirty, no
// conflicts. The bug was the report, not the system.
//
// The invariant that makes a report like this checkable AT ALL is that two panes can be
// compared: same rows, same order, in every chat, with the reader's own row marked. Then
// two panes disagreeing is evidence of real drift instead of the normal case. That is what
// is pinned here - not the wording, which may change, but:
//
//   1. every held lane appears in every chat's table (nobody is missing from anyone);
//   2. the row set is IDENTICAL across chats once the "this is you" marker is removed;
//   3. exactly one row per chat is marked, and it is that chat's own lane;
//   4. an unheld lane is on nobody's table;
//   5. "started in X" appears only when a chat's folder is NOT the lane it holds, and
//      prints the whole path - `from` is a shell cwd and is often a SUBDIRECTORY of a
//      checkout (the PreToolUse guard claims with the folder of the file being written),
//      so the last path segment alone read "started in scripts", a folder that is no lane.
//
// The same assertions run a second time against Robert's installed copy of this hook
// (claude-config/paneforge-lane-hook.mjs) when that checkout is on the machine. That copy
// is the one his sessions actually execute; this one ships to everyone else. They are
// deliberately not identical - the installed copy has to FIND the engine, this one sits
// next to it - so a diff cannot police them, but the behaviour must not drift, and drifting
// silently is exactly how a fix stops being a fix. Absent checkout, that half is skipped.
//
//   node scripts/lane-roster-test.mjs

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installLane } from './lane-fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
// realpath: /var/folders vs /private/var/folders on macOS - see lane-sweep-test.
const root = join(realpathSync(tmpdir()), 'paneforge-lane-roster-test')
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })

let failed = 0
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`)
  if (!cond) {
    failed++
    if (detail) console.log(`      ${String(detail).split('\n').join('\n      ')}`)
  }
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()

// ------------------------------------------------------------------ the repository

const repo = join(root, 'demo')
mkdirSync(join(repo, 'scripts'), { recursive: true })
writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'demo', version: '0.0.1' }, null, 2) + '\n')
writeFileSync(join(repo, 'app.js'), 'console.log(1)\n')
// A throwaway with no remote does not get lanes - the hook would exit before printing a
// word, and every assertion below would pass vacuously against an empty string. The
// explicit yes is what a real project's remote stands for here.
writeFileSync(join(repo, '.lanes.json'), JSON.stringify({ lanes: true, release: 'merge' }, null, 2) + '\n')
installLane(here, repo)
// The hook is not imported by lane.mjs - it SPAWNS it - so the fixture's import walk does
// not find it. It has to sit beside the engine anyway: that sibling is how a hook shipped
// inside an installed PaneForge locates the engine at all.
copyFileSync(join(here, 'lane-hook.mjs'), join(repo, 'scripts', 'lane-hook.mjs'))
git(repo, 'init', '-q', '-b', 'master')
git(repo, 'config', 'user.email', 'test@example.com')
git(repo, 'config', 'user.name', 'test')
git(repo, 'add', '-A')
git(repo, 'commit', '-qm', 'first')
git(repo, 'tag', 'v0.0.1')

const ENGINE = join(repo, 'scripts', 'lane.mjs')
const REGISTRY = join(root, 'lane-repos.json')

// The verb comes first; `--repo` is a flag like any other.
const lane = (cmd, ...args) => {
  try {
    return execFileSync(process.execPath, [ENGINE, cmd, '--repo', repo, ...args], {
      cwd: repo,
      encoding: 'utf8',
      stdio: 'pipe'
    })
  } catch (e) {
    return `${e.stdout ?? ''}${e.stderr ?? ''}`
  }
}

// A chat is a VISITOR unless its transcript lives under a directory named after the repo
// it is prompting from (the hook's own rule). Give every test chat a real one so none of
// them is treated as a passer-by - that path is covered by visitor-park-test.
const slug = repo.replace(/[^A-Za-z0-9-]/g, '-')
const transcripts = join(root, 'projects', slug)
mkdirSync(transcripts, { recursive: true })

/**
 * Run the prompt hook exactly as Claude Code does: a JSON event on stdin, one chat.
 * `hookFile` is which COPY of the hook is under test.
 */
const prompt = (hookFile, session, cwd) => {
  const payload = JSON.stringify({
    session_id: session,
    cwd,
    transcript_path: join(transcripts, `${session}.jsonl`),
    prompt: 'hello'
  })
  try {
    return execFileSync(process.execPath, [hookFile, '--event=prompt'], {
      input: payload,
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, LANE_REGISTRY: REGISTRY, PANEFORGE_REPO: repo }
    })
  } catch (e) {
    return `${e.stdout ?? ''}${e.stderr ?? ''}`
  }
}

/** The roster block of one chat's output: every indented row under the table heading. */
const rowsOf = (out) =>
  out
    .split('\n')
    .filter((l) => /^ {2}\S/.test(l))
    .map((l) => l.replace(/\s+$/, ''))

/** A row with the "this is you" marker and the per-lane state stripped: lane + folder. */
const identityOf = (row) => row.replace(/ {2}(<- THIS CHAT|another chat:.*)$/, '').trimEnd()

// ------------------------------------------------------------------ the chats
//
// Three chats, one per checkout, which is the shape that produced three contradictory
// sentences. Claimed through the engine so each worktree exists before its chat prompts
// from inside it.

const SESSIONS = [
  { id: 'sess-main', prefer: 'main' },
  { id: 'sess-a', prefer: 'a' },
  { id: 'sess-b', prefer: 'b' }
]
const dirOf = {}
for (const s of SESSIONS) {
  const out = lane('claim', '--session', s.id, '--prefer', s.prefer, '--cwd', repo)
  let got
  try {
    got = JSON.parse(out)
  } catch {
    got = null
  }
  if (!got) {
    ok(`claim ${s.prefer}`, false, out)
    process.exit(1)
  }
  s.lane = got.lane
  dirOf[s.id] = got.dir
}

// A chat that prompts from its own checkout should say nothing about where it started.
// The folder a hold remembers is written ONCE, by the claim that created it, and a later
// claim only fills it in when it was missing - deliberately, so a chat that runs one
// command elsewhere does not rewrite its own origin. So the hold has to be dropped and
// remade to record a different folder; re-claiming on top of it is a no-op, which is a
// trap worth naming since it silently makes a fixture assert nothing.
for (const s of SESSIONS) {
  lane('release', '--session', s.id)
  lane('claim', '--session', s.id, '--prefer', s.lane, '--cwd', dirOf[s.id])
}

function checkCopy(label, hookFile) {
  const outputs = SESSIONS.map((s) => ({ s, out: prompt(hookFile, s.id, dirOf[s.id]) }))

  for (const { s, out } of outputs) {
    ok(`${label}: ${s.id} prints a roster`, rowsOf(out).length === SESSIONS.length, out)
  }

  // 1 + 2. The whole point: strip "this is you" and every chat is holding the same table.
  const identities = outputs.map(({ out }) => rowsOf(out).map(identityOf).join('\n'))
  // `every` over empty strings is vacuously true, so the non-empty half is part of the
  // assertion: a hook that printed nothing at all would otherwise "agree" with itself.
  ok(
    `${label}: every chat prints the SAME rows in the same order`,
    Boolean(identities[0]) && identities.every((i) => i === identities[0]),
    identities.map((i, n) => `--- ${SESSIONS[n].id}\n${i}`).join('\n')
  )
  // Every held lane, and its folder, is on that shared table.
  for (const s of SESSIONS) {
    ok(
      `${label}: lane ${s.lane} and its folder are on every chat's table`,
      identities[0].includes(dirOf[s.id]) && new RegExp(`^ {2}${s.lane}\\b`, 'm').test(identities[0]),
      identities[0]
    )
  }

  // 3. Exactly one marked row per chat, and it is that chat's own.
  for (const { s, out } of outputs) {
    const mine = rowsOf(out).filter((r) => r.includes('<- THIS CHAT'))
    ok(`${label}: ${s.id} has exactly one marked row`, mine.length === 1, out)
    ok(
      `${label}: ${s.id}'s marked row is lane ${s.lane}`,
      mine.length === 1 && mine[0].includes(dirOf[s.id]) && new RegExp(`^ {2}${s.lane}\\b`).test(mine[0]),
      mine[0]
    )
  }

  // 4. A lane nobody holds belongs on nobody's table.
  ok(
    `${label}: an unheld lane is on nobody's table`,
    !identities[0].includes(`${repo}-c`),
    identities[0]
  )

  // 5. "started in" is silent when the chat is where its lane is. Assert on the RAW rows:
  // the note lives in the state half of a row, which `identityOf` strips, so checking the
  // identities here would have passed no matter what the hook printed.
  const raw = rowsOf(outputs[0].out).join('\n')
  ok(`${label}: no "started in" noise when the folder IS the lane`, !raw.includes('started in'), raw)

  // ...and names the WHOLE path when a chat claimed from somewhere else. A subdirectory of
  // a checkout is the realistic case: the PreToolUse guard claims with the folder of the
  // file being edited, so the last segment alone printed "started in scripts".
  const sub = join(dirOf['sess-a'], 'scripts')
  lane('release', '--session', 'sess-a')
  lane('claim', '--session', 'sess-a', '--prefer', 'a', '--cwd', sub)
  const after = rowsOf(prompt(hookFile, 'sess-b', dirOf['sess-b'])).find((r) => /^ {2}a\b/.test(r)) ?? ''
  ok(`${label}: a chat sitting outside its lane is flagged`, after.includes('started in'), after)
  ok(`${label}: and the whole path is printed, not just its last segment`, after.includes(`started in ${sub}`), after)
  // Put it back so a second copy under test starts from the same state.
  lane('release', '--session', 'sess-a')
  lane('claim', '--session', 'sess-a', '--prefer', 'a', '--cwd', dirOf['sess-a'])
}

checkCopy('vendored', join(repo, 'scripts', 'lane-hook.mjs'))

// The installed copy Robert's own sessions run. Same behaviour required, different file.
const INSTALLED = join(homedir(), 'Projects', 'claude-memory', 'claude-config', 'paneforge-lane-hook.mjs')
if (existsSync(INSTALLED)) {
  // It resolves the engine by searching known checkouts rather than by sitting next to it,
  // so give it one: copied into the throwaway repo, PANEFORGE_REPO points there.
  const copy = join(repo, 'scripts', 'installed-lane-hook.mjs')
  copyFileSync(INSTALLED, copy)
  checkCopy('installed', copy)
} else {
  console.log('skip  installed copy (claude-memory not on this machine)')
}

rmSync(root, { recursive: true, force: true })
console.log(failed ? `\n${failed} failed` : '\nall ok')
process.exit(failed ? 1 : 0)
