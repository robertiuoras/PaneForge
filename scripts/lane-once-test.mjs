// The lane line is told to a chat once per change of WHO HOLDS WHICH CHECKOUT, and again after
// every SessionStart (startup, resume, clear, compact) - not on every prompt, and not when
// another chat merely edits or commits in the lane it already holds.
//
// Why (harness cost review 2026-10-09, row 5): the same ~900 B table re-entered a chat's
// context whenever another chat's progress word changed ("mid-edit" -> "1 commit" ->
// "finished"), 56 of 164 prints over the last 900 Mac prompts, and the old 30-minute
// re-print stood in for a compaction it could not see. SessionStart is the moment a chat
// really loses the line, so that hook (`--event=start`) is what makes the next prompt say it
// again. A chat whose SessionStart lane hook was never installed keeps the 30-minute re-print.
//
//   node scripts/lane-once-test.mjs

import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installLane } from './lane-fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(realpathSync(tmpdir()), 'paneforge-lane-once-test')
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })

let failed = 0
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`)
  if (!cond) {
    failed++
    if (detail !== undefined) console.log(`      ${String(detail).split('\n').join('\n      ')}`)
  }
}
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()

const repo = join(root, 'demo')
mkdirSync(join(repo, 'scripts'), { recursive: true })
writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'demo', version: '0.0.1' }, null, 2) + '\n')
writeFileSync(join(repo, 'app.js'), 'console.log(1)\n')
writeFileSync(join(repo, '.lanes.json'), JSON.stringify({ lanes: true, release: 'merge' }, null, 2) + '\n')
installLane(here, repo)
copyFileSync(join(here, 'lane-hook.mjs'), join(repo, 'scripts', 'lane-hook.mjs'))
git(repo, 'init', '-q', '-b', 'master')
git(repo, 'config', 'user.email', 'test@example.com')
git(repo, 'config', 'user.name', 'test')
git(repo, 'add', '-A')
git(repo, 'commit', '-qm', 'first')

const ENGINE = join(repo, 'scripts', 'lane.mjs')
const HOOK = join(repo, 'scripts', 'lane-hook.mjs')
const REGISTRY = join(root, 'lane-repos.json')
// ONE temp dir for the whole run: what the hook remembers between prompts lives there.
const TMP = join(root, 'hooktmp')
mkdirSync(TMP)
const env = { ...process.env, LANE_REGISTRY: REGISTRY, PANEFORGE_REPO: repo, TMPDIR: TMP, TEMP: TMP, TMP }

const lane = (cmd, ...args) => {
  try {
    return execFileSync(process.execPath, [ENGINE, cmd, '--repo', repo, ...args], { cwd: repo, encoding: 'utf8', stdio: 'pipe' })
  } catch (e) {
    return `${e.stdout ?? ''}${e.stderr ?? ''}`
  }
}
const slug = repo.replace(/[^A-Za-z0-9-]/g, '-')
const transcripts = join(root, 'projects', slug)
mkdirSync(transcripts, { recursive: true })
const hook = (event, session, cwd, extra = {}) => {
  const payload = JSON.stringify({ session_id: session, cwd, transcript_path: join(transcripts, `${session}.jsonl`), ...extra })
  try {
    return execFileSync(process.execPath, [HOOK, `--event=${event}`], { input: payload, cwd, encoding: 'utf8', stdio: 'pipe', env })
  } catch (e) {
    return `${e.stdout ?? ''}${e.stderr ?? ''}`
  }
}
/** Make everything the hook remembers `minutes` older: its own `at` stamps and the files' mtimes. */
const age = (minutes) => {
  const back = minutes * 60_000
  for (const f of readdirSync(TMP).filter((n) => n.startsWith('pf-lane-'))) {
    const p = join(TMP, f)
    try {
      const told = JSON.parse(readFileSync(p, 'utf8'))
      for (const r of Object.values(told.repos ?? {})) r.at -= back
      writeFileSync(p, JSON.stringify(told))
    } catch {
      /* not JSON: an older hook's own record */
    }
    const t = (Date.now() - back) / 1000
    utimesSync(p, t, t)
  }
}
const prompt = (session, cwd) => hook('prompt', session, cwd, { prompt: 'hello' })
const start = (session, cwd, source) => hook('start', session, cwd, { source, hook_event_name: 'SessionStart' })

const claim = (session, prefer, cwd = repo) => {
  const got = JSON.parse(lane('claim', '--session', session, '--prefer', prefer, '--cwd', cwd))
  return got.dir
}

// Chat ME works on master; chat B holds lane a. Both sessions began with a SessionStart, as
// every Claude Code session does once the hook is installed.
const ME = 'sess-me'
const mine = claim(ME, 'main')
const b = claim('sess-b', 'a')
start(ME, mine, 'startup')

const first = prompt(ME, mine)
ok('first prompt prints the lane table', /checkout in use right now/.test(first) && /<- THIS CHAT/.test(first), first)
ok('same table, next prompt: says nothing', prompt(ME, mine) === '', 'printed again')

// B edits and commits inside the lane it already holds: its progress word changes, nobody
// claimed or gave back anything.
writeFileSync(join(b, 'wip.txt'), 'half done\n')
const dirty = prompt(ME, mine)
ok('another chat starting to edit its own lane: says nothing', dirty === '', dirty)
git(b, 'add', '-A')
git(b, 'commit', '-qm', 'wip')
const committed = prompt(ME, mine)
ok('another chat committing in its own lane: says nothing', committed === '', committed)

// A real claim: chat C takes lane b. The table changed, so it is said again.
claim('sess-c', 'b')
const claimed = prompt(ME, mine)
ok('another chat claims a lane: table printed again', /checkout in use right now/.test(claimed) && claimed.split('\n').filter((l) => /^ {2}\S/.test(l)).length === 3, claimed)
ok('...and only once', prompt(ME, mine) === '', 'printed twice')

// And a release.
lane('release', '--session', 'sess-c')
const released = prompt(ME, mine)
ok('another chat gives its lane back: table printed again', /checkout in use right now/.test(released) && !/-b\s/.test(released), released)
ok('...and only once', prompt(ME, mine) === '', 'printed twice')

// Time alone is not a change once SessionStart is wired: age what the hook remembers by an hour.
age(60)
const later = prompt(ME, mine)
ok('an hour later, same table: says nothing', later === '', later)

// A compaction drops the line from the chat's context: SessionStart says so, the next prompt
// prints it again - once.
ok('SessionStart itself prints nothing', start(ME, mine, 'compact') === '', 'printed at start')
const afterCompact = prompt(ME, mine)
ok('first prompt after a compaction prints the table again', /checkout in use right now/.test(afterCompact), afterCompact)
ok('...and only once', prompt(ME, mine) === '', 'printed twice')

// Another chat's SessionStart is not this chat's.
start('sess-b', b, 'compact')
ok("another chat's SessionStart does not re-print here", prompt(ME, mine) === '', 'printed')

// A chat whose machine has no SessionStart lane hook yet keeps the old 30-minute re-print,
// so a compacted chat there still gets the line back.
const OLD = 'sess-no-start'
lane('release', '--session', ME)
const oldDir = claim(OLD, 'main')
ok('no SessionStart hook: first prompt prints', /checkout in use right now/.test(prompt(OLD, oldDir)))
ok('no SessionStart hook: next prompt quiet', prompt(OLD, oldDir) === '')
age(31)
ok('no SessionStart hook: re-printed after 30 minutes', /checkout in use right now/.test(prompt(OLD, oldDir)))

rmSync(root, { recursive: true, force: true })
if (failed) {
  console.log(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nall ok')
