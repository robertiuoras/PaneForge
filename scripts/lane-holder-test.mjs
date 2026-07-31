// Regression test for the ONE thing a lane knows about its holder: which folder that chat
// came from - scripts/lane.mjs `claim`.
//
// The bug this exists for: 2026-07-31. PaneForge's lane a read "a chat has it" on the strip
// with nothing anywhere saying whose chat, for half an hour, while that chat committed five
// times. It was a taskdriver chat: it never prompted from inside the checkout, so the prompt
// hook (which is what passes `--cwd`) never ran for it. It was refused by the guard, did what
// the refusal told it to do - `lane.mjs claim --session <id>` - and that command had no
// `--cwd` in it, so the hold recorded `cwd: null`.
//
// Null was then permanent. `claim` only ever wrote `cwd` on the claim that CREATED a hold;
// every later claim from the same session updated `seen` and nothing else. So the one hold
// that could not say where it came from was the one held from outside this window - which is
// exactly the hold the strip draws, because a lane held by a pane on screen is named by that
// pane already.
//
// Two halves, both pinned here:
//   1. a claim with no `--cwd` records the folder it was typed in, never null;
//   2. a hold that HAS null (claimed before this, or by anything that still omits it) is
//      filled in by the next claim that carries a folder - and a hold that already knows
//      where it came from is never rewritten by a later claim from somewhere else.
//
//   node scripts/lane-holder-test.mjs

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { installLane } from './lane-fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
// realpath: /var/folders vs /private/var/folders on macOS - see lane-sweep-test.
const root = join(realpathSync(tmpdir()), 'paneforge-lane-holder-test')
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })

let failed = 0
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`)
  if (!cond) {
    failed++
    if (detail) console.log(`      ${detail}`)
  }
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()

const repo = join(root, 'demo')
mkdirSync(join(repo, 'scripts'), { recursive: true })
writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'demo', version: '0.0.1' }, null, 2) + '\n')
writeFileSync(join(repo, 'app.js'), 'console.log(1)\n')
installLane(here, repo)
git(repo, 'init', '-q', '-b', 'master')
git(repo, 'config', 'user.email', 'test@example.com')
git(repo, 'config', 'user.name', 'test')
git(repo, 'add', '-A')
git(repo, 'commit', '-qm', 'first')
git(repo, 'tag', 'v0.0.1')

// The other project the offending chat was actually sitting in.
const elsewhere = join(root, 'taskdriver')
mkdirSync(elsewhere, { recursive: true })

const lane = (cwd, ...args) => {
  try {
    return {
      ok: true,
      out: execFileSync(process.execPath, [join(repo, 'scripts', 'lane.mjs'), ...args], {
        cwd,
        encoding: 'utf8',
        stdio: 'pipe'
      }).trim()
    }
  } catch (e) {
    return { ok: false, out: (e.stdout ?? '').toString().trim(), err: (e.stderr ?? '').toString().trim() }
  }
}
const statePath = join(repo, '.git', 'paneforge-lanes.json')
const state = () => JSON.parse(readFileSync(statePath, 'utf8'))
const write = (s) => writeFileSync(statePath, JSON.stringify(s, null, 2))
const holdOf = (session) => Object.values(state().lanes).find((c) => c.session === session)

// ---------------------------------------------------------------- typed by hand, no --cwd

const HAND = 'hand-typed-session'
const claimed = lane(elsewhere, 'claim', '--session', HAND)
ok('a claim with no --cwd is still accepted', claimed.ok, claimed.err)
const hand = holdOf(HAND)
ok('a claim with no --cwd records the folder it was typed in', hand?.cwd === elsewhere, JSON.stringify(hand))

// ---------------------------------------------------------------- the null already on disk

const OLD = 'hold-from-before'
{
  const s = state()
  // Exactly what was in PaneForge's own lane file: a hold with no folder behind it.
  s.lanes.b = { session: OLD, cwd: null, claimed: Date.now(), seen: Date.now() }
  write(s)
}
ok('the fixture starts from a hold with no folder', holdOf(OLD)?.cwd === null)

lane(repo, 'claim', '--session', OLD, '--cwd', elsewhere)
ok('a later claim fills in a folder the hold never had', holdOf(OLD)?.cwd === elsewhere, JSON.stringify(holdOf(OLD)))

// ---------------------------------------------------------------- and never rewrites one

const other = join(root, 'somewhere-else')
mkdirSync(other, { recursive: true })
lane(repo, 'claim', '--session', OLD, '--cwd', other)
ok(
  'a hold that already knows where it came from is left alone',
  holdOf(OLD)?.cwd === elsewhere,
  JSON.stringify(holdOf(OLD))
)

// The point of all of it: `status` can name the holder of every held lane.
const held = JSON.parse(lane(repo, 'status', '--json').out ?? '{}')
  .lanes.filter((l) => l.heldBy)
ok('every held lane can say where its chat came from', held.length > 0 && held.every((l) => l.from), JSON.stringify(held))

// ------------------------------------------------------- and what the strip then SAYS
//
// The other half of the same bug, and the half that cannot be read off a screen: the strip
// polls only while the window is on screen, so with a game running - when PaneForge opens no
// window at all - there is no DOM to check. src/renderer/src/laneWords.ts is the sentences on
// their own for exactly this reason.

const out = join(root, 'build')
execFileSync(
  process.execPath,
  [
    join(here, '..', 'node_modules', 'typescript', 'bin', 'tsc'),
    join('src', 'renderer', 'src', 'laneWords.ts'),
    '--outDir',
    out,
    '--rootDir',
    'src',
    '--module',
    'es2022',
    '--target',
    'es2022',
    '--moduleResolution',
    'bundler',
    '--skipLibCheck',
    // The project compiles strict. Without this flag the same files are compiled with
    // strictNullChecks OFF, where an unrelated shared type stops being assignable and
    // the test dies on a type error `npm run typecheck` does not have (three lane tests
    // were red on master for exactly this, saying nothing about lanes).
    '--strict'
  ],
  { cwd: join(here, '..'), stdio: 'pipe' }
)
writeFileSync(join(out, 'package.json'), '{"type":"module"}')
const { holderName, laneState, laneTip } = await import(pathToFileURL(join(out, 'renderer', 'src', 'laneWords.js')).href)

const NOW = 1_700_000_000_000
const entry = (over) => ({
  lane: 'a',
  dir: 'C:\\Users\\Gamer\\Desktop\\Projects\\PaneForge-a',
  branch: 'lane-a',
  from: null,
  session: null,
  ownerPane: null,
  held: true,
  seen: NOW,
  ready: false,
  conflicted: false,
  adoptable: false,
  resolver: null,
  ...over
})

// The lane this whole file is about, as it actually stood: held from another project.
const fromTaskdriver = entry({ from: 'C:\\Users\\Gamer\\Desktop\\Projects\\taskdriver', session: 'abc12345-dead-beef' })
ok(
  'a lane held from another project names that project',
  holderName(fromTaskdriver) === "taskdriver's chat",
  holderName(fromTaskdriver)
)
ok(
  'the strip line says who has it and since when',
  laneState(fromTaskdriver, false, NOW + 20 * 60_000) === "taskdriver's chat has it, quiet 20m",
  laneState(fromTaskdriver, false, NOW + 20 * 60_000)
)
ok(
  'a chat that spoke a moment ago reads as busy, still named',
  laneState(fromTaskdriver, false, NOW + 60_000) === "taskdriver's chat has it, busy now",
  laneState(fromTaskdriver, false, NOW + 60_000)
)

// A hold from before the fix, or from anything that still records no folder: the session id
// is not a name, but it is something to search for - which "a chat" was not.
const anonymous = entry({ session: '9082052c-2019-4856-b9af-37b2c5f9b762' })
ok(
  'a hold with no folder falls back to the chat id',
  laneState(anonymous, false, NOW + 60_000) === 'chat 9082052c has it, busy now',
  laneState(anonymous, false, NOW + 60_000)
)
ok('a hold with neither is still described', laneState(entry({}), false, NOW + 60_000) === 'a chat has it, busy now')

// The pane's own chip is the one place naming the holder is noise: it is telling itself.
ok('a pane is not told who it is', laneState(fromTaskdriver, true, NOW + 60_000) === 'busy now')

// A free lane says nothing about a holder, and a stuck one leads with the thing to act on.
ok('a free lane is still just free', laneState(entry({ held: false }), false, NOW) === 'free')
// Plain words on purpose: "conflicts with master" assumed the reader wrote the release
// script. The row says what it means and what ends it; git specifics live in the tooltip.
ok(
  'a conflict still leads with the conflict',
  laneState(entry({ conflicted: true, conflictSince: NOW }), false, NOW + 3 * 60_000).startsWith("won't merge - needs a decision"),
  laneState(entry({ conflicted: true, conflictSince: NOW }), false, NOW + 3 * 60_000)
)
ok(
  'finished work says it ships with the next update',
  laneState(entry({ ready: true }), false, NOW) === 'done - ships with the next update'
)

// The tooltip is where the whole path and the full id go, so the row can stay short.
const tip = laneTip(fromTaskdriver)
ok('the tooltip names the folder in full', tip.includes('Projects\\taskdriver'), tip)
ok('the tooltip carries the whole session id', tip.includes('abc12345-dead-beef'), tip)
ok('a free lane gets no holder tooltip', !laneTip(entry({ held: false })).includes('Held by'))

rmSync(root, { recursive: true, force: true })
console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
