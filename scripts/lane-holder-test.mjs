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

import { buildSync } from 'esbuild'
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
// esbuild rather than `tsc` on the one file, which is what this used to do.
//
// `tsc --rootDir src` emits an import specifier unchanged - `from '../../shared/place'`,
// with no extension - and Node's ESM loader refuses that, so the moment laneWords gained
// a RUNTIME import (rather than only `import type`, which is erased) the test died on a
// module-not-found naming a temp directory. Bundling has no specifiers left to resolve,
// and it is the same buildSync the other pure-module tests use.
buildSync({
  absWorkingDir: join(here, '..'),
  entryPoints: [join('src', 'renderer', 'src', 'laneWords.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: join(out, 'laneWords.mjs')
})
writeFileSync(join(out, 'package.json'), '{"type":"module"}')
const { deviceTip, holdWords, holderName, laneBusy, laneChipLabel, laneDoing, laneLabel, laneProject, laneState, laneTip } = await import(
  pathToFileURL(join(out, 'laneWords.mjs')).href
)

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

// A claim the OTHER machine published. There is no folder to name and its chat id belongs
// to a conversation this desk has never hosted, so eight characters of hex would be the
// least useful thing on the row. The desk IS the answer.
const otherDesk = entry({
  lane: 'main',
  branch: 'master',
  session: '4f0b2c19-77aa-4d1e-9c2e-0f7e5a3b1d84',
  peer: true,
  device: 'mac-nbn'
})
ok(
  'a lane held at the other desk is named by the desk',
  laneState(otherDesk, false, NOW + 4 * 60_000) === 'mac-nbn has it, busy now',
  laneState(otherDesk, false, NOW + 4 * 60_000)
)
ok(
  'and the tag beside it says nothing here can free it',
  deviceTip(otherDesk, 'desktop-cmsucm1').includes('another machine') &&
    deviceTip(otherDesk, 'desktop-cmsucm1').includes('typed in over there'),
  deviceTip(otherDesk, 'desktop-cmsucm1')
)
ok(
  'while this desk’s own lane is tagged without a warning',
  deviceTip(entry({ device: 'desktop-cmsucm1' }), 'desktop-cmsucm1') === 'On this machine (desktop-cmsucm1).',
  deviceTip(entry({ device: 'desktop-cmsucm1' }), 'desktop-cmsucm1')
)
ok('a record with no desk on it says nothing at all', deviceTip(entry({}), 'desktop-cmsucm1') === '')
// The tooltip may not borrow this machine's answers for a row about another one: `dir` is
// where OUR copy of that repo would live and `branch` is what OUR HEAD calls the trunk,
// and a published claim carries neither.
ok(
  'the tooltip for another desk does not print a local path as if it were theirs',
  !laneTip(otherDesk).includes(otherDesk.dir),
  laneTip(otherDesk)
)
ok(
  'and says plainly which machine the trunk is on',
  laneTip(otherDesk).includes('The trunk, on mac-nbn'),
  laneTip(otherDesk)
)

// The pane's own chip is the one place naming the holder is noise: it is telling itself.
ok('a pane is not told who it is', laneState(fromTaskdriver, true, NOW + 60_000) === 'busy now')

// The COLOUR of the same fact. It is a separate function from the sentence because a
// stylesheet cannot read a sentence, and the two disagreeing - a row saying "busy now" in
// the grey of a lane nobody has touched since yesterday - is the entire bug this answers.
ok('busy in words is busy in colour', laneBusy(fromTaskdriver, NOW + 60_000) === true)
ok('quiet twenty minutes is not busy', laneBusy(fromTaskdriver, NOW + 20 * 60_000) === false)
// Five minutes is the same threshold laneState prints from. Held either side of it, so a
// second copy of the number cannot drift from the first without this failing.
ok('the edge of the window is still busy', laneBusy(fromTaskdriver, NOW + 5 * 60_000 - 1) === true)
ok('a moment past it is not', laneBusy(fromTaskdriver, NOW + 5 * 60_000) === false)
// A lane nobody holds cannot be busy however recently it was seen - `seen` outlives the
// hold, so this is the case that would light up every free lane in the pool.
ok('a free lane is never busy', laneBusy(entry({ held: false }), NOW) === false)
// Ready and conflicted own the chip: both are states somebody has to act on, and a chat
// that has marked its lane done and kept typing must not read as work still in flight -
// that is exactly the release-gate failure `scripts/release-gate-test.mjs` pins.
ok('finished work is not in-flight work', laneBusy(entry({ ready: true }), NOW) === false)
ok('a conflict is not in-flight work', laneBusy(entry({ conflicted: true }), NOW) === false)

// A free lane says nothing about a holder, and a stuck one leads with the thing to act on.
ok(
  'a lane nobody holds says so in words, never the word "free"',
  laneState(entry({ held: false }), false, NOW) === 'nobody is using it',
  laneState(entry({ held: false }), false, NOW)
)
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

// ...and it only says that while nothing is holding it up. The strip drew that promise
// unchanged for hours over a release the gate had already refused, which is the report:
// "it says done - ships with next update, and it says releasing, and neither is true".
// The gate's reason is REPEATED here, never re-derived - see LaneBoard.hold.
const heldFor = (reason, at = NOW) => ({ reason, at })
ok(
  'a finished lane waiting on another chat says which',
  laneState(entry({ ready: true }), false, NOW, undefined, heldFor('waiting on chats still working: main (uncommitted edits, 4m ago)')) ===
    'done, waiting for the main copy',
  laneState(entry({ ready: true }), false, NOW, undefined, heldFor('waiting on chats still working: main (uncommitted edits, 4m ago)'))
)
ok(
  'one waiting on the clock says how long',
  laneState(entry({ ready: true }), false, NOW, undefined,
    heldFor('v0.8.138 went out 40m ago. The work is committed and still on its lane; it merges and goes out with the next release (about 80m). Do not ship it separately - run autoship again then.')) ===
    'done, releases batch - the next one is about 80m away'
)
ok(
  'and a red suite is named as a refusal rather than as a promise',
  laneState(entry({ ready: true }), false, NOW + 40 * 60_000, undefined,
    heldFor('master fails its own test suite, so it was not released - FAIL cardfit')) ===
    'done, held back 40m: master fails its own tests'
)
// The load-bearing negative: a reason nothing here recognises must still reach the screen.
// A hold this has never seen is exactly the one worth reading, and dropping it puts the
// old empty promise back for every future failure shape.
ok(
  'an unrecognised reason is printed, not swallowed',
  holdWords(heldFor('origin refused the push. Try again later.')) === 'origin refused the push',
  holdWords(heldFor('origin refused the push. Try again later.'))
)
ok('and no hold at all changes nothing', holdWords(null) === '' && holdWords(heldFor('   ')) === '')
ok(
  'a release that IS running is not a hold anybody can act on',
  holdWords(heldFor('another chat is mid-release')) === 'a release is running'
)

// The tooltip is where the whole path and the full id go, so the row can stay short.
const tip = laneTip(fromTaskdriver)
ok('the tooltip names the folder in full', tip.includes('Projects\\taskdriver'), tip)
ok('the tooltip carries the whole session id', tip.includes('abc12345-dead-beef'), tip)
ok('a free lane gets no holder tooltip', !laneTip(entry({ held: false })).includes('Held by'))

// ---------------------------------------------------------------------------------------
// Naming the lane, and naming the pane. Added 2026-08-01 after "lanes main master, I have
// no idea which project that is" - which was a fair description of what the strip printed.

// The row used to be `lane.branch`, so this row said `lane-a` and the one above it said
// `master`, for two different repositories.
ok(
  'a lane row names the project before the lane',
  laneLabel(entry({})) === 'PaneForge copy 2',
  laneLabel(entry({}))
)
ok(
  "the main lane is just the project's name - `main master` said neither",
  laneLabel(entry({ lane: 'main', dir: 'C:\\Users\\Gamer\\Desktop\\Projects\\PaneForge', branch: 'master' })) ===
    'PaneForge',
  laneLabel(entry({ lane: 'main', dir: 'C:\\Users\\Gamer\\Desktop\\Projects\\PaneForge', branch: 'master' }))
)
// Lanes stopped being a PaneForge-only thing, so the label cannot be a PaneForge-only word.
ok(
  'another repository names itself, not PaneForge',
  laneLabel(entry({ dir: 'C:\\Users\\Gamer\\Desktop\\Projects\\taskdriver-b', lane: 'b', branch: 'lane-b' })) ===
    'taskdriver copy 3'
)

// ---------------------------------------------------------------------------------------
// The same lane, on a card that has already named the project. Added 2026-08-07 after
// "why we have extra tag with project name": a taskdriver pane carried `taskdriver.ai`
// and then `taskdriver.ai · lane b`, two chips in a row, and they read as two facts.
const td = entry({ dir: 'C:\\Users\\Gamer\\Desktop\\Projects\\taskdriver-b', lane: 'b', branch: 'lane-b' })
ok(
  'a chip beside its own project drops the name and says only the lane',
  laneChipLabel(td, 'taskdriver') === 'copy 3',
  laneChipLabel(td, 'taskdriver')
)
// The one case the name exists for: a chat holding a lane of some other repository.
ok(
  'the project comes back when the lane is a copy of a DIFFERENT project',
  laneChipLabel(td, 'assistant') === 'taskdriver copy 3',
  laneChipLabel(td, 'assistant')
)
ok(
  'with no pane project given, the chip is the full label - the strip still needs it',
  laneChipLabel(td) === laneLabel(td)
)
// The main checkout has no lane letter, so `role` is the whole answer there.
ok(
  'the main lane on its own project says "main copy", never a bare project name twice',
  laneChipLabel(
    entry({ lane: 'main', dir: 'C:\\Users\\Gamer\\Desktop\\Projects\\PaneForge', branch: 'master' }),
    'PaneForge'
  ) === 'main copy'
)
ok('the project is spelled out on its own for the tooltip', laneProject(td) === 'taskdriver')

// A pane number is on the card, and on the keyboard. Eight characters of a session id are
// on neither, which is why they were never the answer to "who has it".
ok(
  'a holder that is a pane in this window is named by its Ctrl-N number',
  laneState(fromTaskdriver, false, NOW + 60_000, 3) === 'pane 3 has it, busy now',
  laneState(fromTaskdriver, false, NOW + 60_000, 3)
)
ok(
  'and the number beats the folder it started in',
  !laneState(fromTaskdriver, false, NOW + 60_000, 3).includes('taskdriver')
)
ok(
  'with no pane, the folder is still the fallback it always was',
  laneState(fromTaskdriver, false, NOW + 60_000).includes("taskdriver's chat")
)
ok('the tooltip uses the pane number too', laneTip(fromTaskdriver, 3).includes('Held by pane 3'))
// The lane is PaneForge's; only the CHAT holding it came from taskdriver. So the tooltip
// leads with the lane's own project and names the holder's folder further down - which is
// the distinction the whole strip exists to make, and the easy one to get backwards.
ok(
  'the tooltip leads with the project the LANE is in',
  laneTip(fromTaskdriver, 3).startsWith('PaneForge copy 2'),
  laneTip(fromTaskdriver, 3)
)
ok(
  "and still says where the holder's chat came from, lower down",
  laneTip(fromTaskdriver, 3).includes('Started in') && laneTip(fromTaskdriver, 3).includes('taskdriver')
)

// ---------------------------------------------------------------------------
// What a copy of the project is DOING, which is the question two counts never answered.
//
// "3 commits not in main · 2 uncommitted files" is how much, and the report was about what:
// "see other lanes and what they are working on ... a summary each lane what its doing".
// Both halves of the answer are free and already in the repository - the newest commit's
// subject, and the names of the files that are open right now. The load-bearing case is the
// LAST one: a lane with neither says nothing rather than inventing a sentence about work
// somebody else did.
const work = (over) => ({ subject: null, at: null, touching: [], dirty: 0, ...over })
ok(
  'a lane with uncommitted files says which',
  laneDoing(work({ touching: ['src/main/index.ts', 'src/renderer/src/App.tsx'], dirty: 2 }), NOW) ===
    'editing index.ts, App.tsx',
  laneDoing(work({ touching: ['src/main/index.ts', 'src/renderer/src/App.tsx'], dirty: 2 }), NOW)
)
ok(
  'and counts the ones it did not list',
  laneDoing(work({ touching: ['a.ts', 'b.ts', 'c.ts', 'd.ts'], dirty: 9 }), NOW).endsWith('+5 more'),
  laneDoing(work({ touching: ['a.ts', 'b.ts', 'c.ts', 'd.ts'], dirty: 9 }), NOW)
)
ok(
  'a quiet lane is named by its newest commit, with its age',
  laneDoing(work({ subject: 'fix(lanes): ship lane-peers.mjs', at: NOW - 3 * 3600_000 }), NOW) ===
    'last commit 3h ago: "fix(lanes): ship lane-peers.mjs"',
  laneDoing(work({ subject: 'fix(lanes): ship lane-peers.mjs', at: NOW - 3 * 3600_000 }), NOW)
)
ok('a lane with nothing in it says nothing', laneDoing(work(), NOW) === '', laneDoing(work(), NOW))
ok('and so does a lane that was never read', laneDoing(null, NOW) === '')

rmSync(root, { recursive: true, force: true })
console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
