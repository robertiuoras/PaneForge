// What a pane is allowed to say about where it is.
//
// The bug this pins is not a crash, it is a sentence: "lanes main master" was on screen
// for weeks and the report was "I have no idea which project that is". Every string here
// is one somebody has to read at a glance while looking for the right window, which is
// exactly the kind of thing that is never re-checked once it looks plausible.
//
//   node scripts/place-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-place-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const out = join(work, 'place.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/place.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: out
})
const { describePlace, isTrunk, laneOfCheckout, paneRef, projectOf, samePlace } = createRequire(import.meta.url)(out)

let checks = 0
const is = (actual, expected, what) => {
  assert.equal(actual, expected, what)
  checks++
}
const ok = (cond, what) => {
  assert.ok(cond, what)
  checks++
}

const W = 'C:\\Users\\Gamer\\Desktop\\Projects'
const U = '/home/rob/Projects'

// ---------------------------------------------------------------------------
// The project name, which is the half that was missing entirely

is(projectOf(`${W}\\PaneForge`), 'PaneForge', 'a plain checkout is its folder')
is(projectOf(`${U}/PaneForge`), 'PaneForge', 'and separators do not matter')
is(projectOf(`${U}/PaneForge/`), 'PaneForge', 'nor does a trailing slash')
is(projectOf(`${W}\\PaneForge-w2`), 'PaneForge', 'the app-made lane suffix comes off unasked')
is(projectOf(`${W}\\PaneForge-w12`), 'PaneForge', 'including a two-digit one')
is(projectOf(`${W}\\PaneForge-a`, 'a'), 'PaneForge', 'a lane suffix comes off when the lane is known')
is(projectOf(`${W}\\PaneForge`, 'main'), 'PaneForge', 'the main lane has no suffix to remove')

// The rule that keeps this honest on somebody else's machine. `-a` is a legitimate
// ending, so it is only ever stripped when the caller already knows this folder is that
// lane - never guessed. A person whose repo is `service-a` must not see `service`.
is(projectOf(`${W}\\service-a`), 'service-a', 'a real project ending in -a is left alone')
is(projectOf(`${W}\\my-w`), 'my-w', '-w with no number is not a lane suffix')
is(projectOf(`${W}\\alpha-b`, 'a'), 'alpha-b', 'the wrong lane id does not strip the wrong suffix')

// Claude Code's own layout, so a pane a person opened in one reads as the project rather
// than as a generated slug nobody recognises.
is(
  projectOf(`${U}/PaneForge/.claude/worktrees/bright-running-fox`),
  'PaneForge',
  "Claude Code's worktree slug still names the project it belongs to"
)
is(
  projectOf(`${W}\\PaneForge\\.claude\\worktrees\\pr-1234`),
  'PaneForge',
  'and the PR form of the same layout'
)

// ---------------------------------------------------------------------------
// Trunk

for (const b of ['main', 'master', 'MAIN', ' trunk ', 'develop', 'default'])
  is(isTrunk(b), true, `"${b}" is a trunk name`)
for (const b of ['lane-a', 'feat/x', 'mastery', 'pf/w2', 'main-menu'])
  is(isTrunk(b), false, `"${b}" is somebody's work, not the trunk`)

// ---------------------------------------------------------------------------
// The chip. Project first, always; everything else only when it is not implied.

{
  const p = describePlace({ cwd: `${W}\\PaneForge`, branch: 'master', pane: 1 })
  is(p.short, 'PaneForge', 'the common case is the project name and nothing else')
  is(p.role, 'main checkout', 'and the role says which checkout this is')
  is(p.kind, 'main', '')
  is(p.onTrunk, true, '')
  ok(p.full.includes('master'), 'the branch is never hidden - it moves to the tooltip')
  ok(p.full.includes('the trunk'), 'which also answers what master IS')
  ok(p.full.includes('pane 1'), 'the tooltip names the switch key')
}

{
  const p = describePlace({ cwd: `${W}\\PaneForge`, branch: 'fix/rail-hitbox' })
  is(p.short, 'PaneForge · fix/rail-hitbox', 'a branch that is not the trunk earns its place')
  is(p.onTrunk, false, '')
}

{
  // A lane made before the app and scripts/lane.mjs agreed on one naming scheme. It is
  // still on disk wherever its work has not landed yet, so it still has to describe
  // itself - as the folder it actually is, never renamed in the UI to something no
  // folder is called.
  const p = describePlace({ cwd: `${W}\\PaneForge-w2`, branch: 'pf/w2', lane: 'w2', pane: 3 })
  is(p.short, 'PaneForge-w2', 'an old lane is named the way its FOLDER is named')
  is(p.slot, 'w2', '')
  is(p.role, 'copy w2', '')
  ok(!p.short.includes('#'), 'and never a bare # that could be read as a switch key')
  is(p.project, 'PaneForge', 'a lane is still the same project - that was the whole complaint')
  ok(!p.short.includes('pf/w2'), "a lane's own generated branch says nothing a person needs")
}

{
  const p = describePlace({ cwd: `${W}\\PaneForge-a`, branch: 'lane-a', lane: 'a' })
  is(p.short, 'PaneForge-a', 'a development lane is named the way its folder is')
  is(p.role, 'copy a', '')
  ok(!p.short.startsWith('lane'), 'never "lane a" on its own - that is the string being fixed')
  ok(!/ lane /.test(p.short), 'and never the word "lane" at all - the folder name is the fact')
}

{
  const p = describePlace({ cwd: `${W}\\taskdriver`, branch: 'main', lane: 'main' })
  is(p.short, 'taskdriver', "the main lane of another repo is just that repo's name")
  is(p.kind, 'main', 'lane "main" is the project folder itself, not a lane of it')
}

{
  const p = describePlace({ cwd: `${W}\\notes` })
  is(p.short, 'notes', 'a folder with no branch known still names itself')
  // It must not GUESS. This line used to read "not a git checkout", which was a claim
  // rather than a gap: the sidebar has no git poll of its own on purpose, so every card
  // in it asserted that its repository was not a repository. Measured in a real window on
  // a checkout with 19 uncommitted files.
  ok(!p.full.includes('not a git'), 'and does not claim to know it is not a repository')
  ok(!/\bon\b/.test(p.full.split('\n')[1] ?? ''), 'no branch line at all when there is no branch')
  ok(p.full.includes(`${W}\\notes`), 'the folder is still spelled out')
}

// The chip is read in a 282px sidebar beside a status dot, an agent logo and a clock.
for (const p of [
  describePlace({ cwd: `${W}\\PaneForge`, branch: 'master' }),
  describePlace({ cwd: `${W}\\PaneForge-w2`, lane: 'w2', branch: 'pf/w2' }),
  describePlace({ cwd: `${W}\\PaneForge-a`, lane: 'a', branch: 'lane-a' })
])
  ok(p.short.split(' · ').length <= 3, `"${p.short}" stays within three parts`)

// ---------------------------------------------------------------------------
// Same place, which is what a clash actually is

{
  const a = describePlace({ cwd: `${W}\\PaneForge`, branch: 'master' })
  const b = describePlace({ cwd: `${W}\\PaneForge`, branch: 'master' })
  const lane = describePlace({ cwd: `${W}\\PaneForge-a`, lane: 'a' })
  const other = describePlace({ cwd: `${W}\\taskdriver`, branch: 'main' })
  is(samePlace(a, b), true, 'two panes in one checkout are in the same place')
  is(samePlace(a, lane), false, 'a lane is a different place - that is what lanes are for')
  is(samePlace(a, other), false, 'different projects are different places')
}

// ---------------------------------------------------------------------------
// Naming a chat

is(paneRef(3), 'pane 3', 'a chat with a pane on screen is named by its switch key')
is(paneRef(undefined, 'abcdef1234'), 'chat abcdef', 'and by a short id only when it has no pane')
is(paneRef(undefined, null), 'another chat', 'and by nothing at all when it has neither')
is(paneRef(2, 'abcdef1234'), 'pane 2', 'the pane number always wins over the hex')

// ---------------------------------------------------------------------------
// The lane a checkout is in, read off its branch
//
// The load-bearing half is the negatives: a project whose NAME ends in a letter suffix
// must never be filed as a lane of something shorter.

is(laneOfCheckout(`${W}\\taskdriver.ai-c`, 'lane-c'), 'c', 'folder and branch agree - that is a lane')
is(laneOfCheckout(`${W}\\PaneForge-w2`, 'pf/w2'), 'w2', 'and the old worktree shape still reads')
is(laneOfCheckout('/home/r/service-a', 'lane-a'), 'a', 'a real name ending in -a IS a lane when the branch says so')
is(laneOfCheckout('/home/r/service-a', 'main'), undefined, 'the same folder on the trunk is a project called service-a')
is(laneOfCheckout('/home/r/service-a', 'feature/login'), undefined, 'a branch somebody made says nothing about lanes')
is(laneOfCheckout(`${W}\\PaneForge`, 'lane-a'), undefined, 'a branch with no matching folder suffix is not proof')
is(laneOfCheckout(`${W}\\PaneForge-b`, 'lane-a'), undefined, 'and the suffix must be the SAME lane')
is(laneOfCheckout(`${W}\\PaneForge-a`, undefined), undefined, 'no branch read yet, no answer')
is(laneOfCheckout(`${W}\\PaneForge-a`, 'LANE-A\n'), 'a', 'git output is trimmed and case-folded')
is(
  describePlace({ cwd: `${W}\\taskdriver.ai-c`, lane: laneOfCheckout(`${W}\\taskdriver.ai-c`, 'lane-c') }).project,
  'taskdriver.ai',
  'and the strip then names the project instead of the folder'
)

rmSync(work, { recursive: true, force: true })
console.log(`PASS place: ${checks} assertions`)
