// The two halves of the lane system have to agree on what a lane is called.
//
// There are two of them and there always were. The app's window (src/main/lanes.ts) makes
// a lane when a second pane opens a project someone is already in. The script
// (scripts/lane.mjs) hands lanes to chats, merges the finished ones back and cuts the
// release. They make and use the SAME folders - but until 2026-08-02 they named them
// differently: `<repo>-w2` on `pf/w2` from the app, `<repo>-a` on `lane-a` from the script.
//
// What that cost, in order of how much it hurt:
//
//   - A Projects folder held `Toolstash-a` next to `Toolstash-w2` with nothing to say what
//     the difference was, because there was not one. `w2` also skips `w1` (the project's
//     own folder is #1), so the numbering looked broken on top of being duplicated.
//   - The prompt hook asks the script for "the lane matching the folder I am sitting in".
//     From a pane the app had put in `Toolstash-w2` that asked for a lane called `w2`,
//     which the script would have made as `lane-w2` - a second branch and a second claim
//     on a worktree that already existed for another reason.
//
// So: one scheme. `<repo>-<letter>` on `lane-<letter>`, made by either half, understood by
// both. This test is what keeps that true - it does not check a string in one file, it
// makes a lane with the app and then hands the same repo to the script and requires them
// to land on the same folder and the same branch.
//
// The old shape is still READ (a lane on someone's disk with real commits in it must not
// go invisible because a convention changed), which the last section pins.
//
//   node scripts/lane-naming-test.mjs

import { buildSync } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { installLane } from './lane-fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
// realpath: macOS hands out /var/folders/... where git spells it /private/var/folders/...,
// and every path comparison below would compare the two.
const root = join(realpathSync(tmpdir()), 'paneforge-lane-naming-test')
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
const same = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase()

/** Bundle a main-process module and import it, the way the other lane tests do. */
function load(entry, name) {
  const out = join(root, `${name}.bundle.mjs`)
  buildSync({
    absWorkingDir: repoRoot,
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: out
  })
  return import(pathToFileURL(out).href)
}

const lanes = await load(join('src', 'main', 'lanes.ts'), 'lanes')
const laneWorkMod = await load(join('src', 'main', 'laneWork.ts'), 'laneWork')
const place = await load(join('src', 'shared', 'place.ts'), 'place')

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()

function fixture(name) {
  const repo = join(root, name)
  mkdirSync(join(repo, 'scripts'), { recursive: true })
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name, version: '0.0.1' }, null, 2) + '\n')
  writeFileSync(join(repo, 'app.js'), 'console.log(1)\n')
  installLane(here, repo)
  git(repo, 'init', '-q', '-b', 'master')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'test')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'first')
  git(repo, 'tag', 'v0.0.1')
  const lane = (...args) => {
    try {
      return {
        ok: true,
        out: execFileSync(process.execPath, [join(repo, 'scripts', 'lane.mjs'), ...args], {
          cwd: repo,
          encoding: 'utf8',
          stdio: 'pipe'
        }).trim()
      }
    } catch (e) {
      return { ok: false, out: (e.stdout ?? '').toString().trim(), err: (e.stderr ?? '').toString().trim() }
    }
  }
  return { repo, lane }
}

// ------------------------------------------------- the app and the script name it the same

{
  const f = fixture('agree')

  // The app moves a second pane out of the shared folder.
  const made = await lanes.resolveLane(f.repo, [f.repo])
  ok('the app puts the second session in <repo>-a', same(made.cwd, `${f.repo}-a`), made.cwd)
  ok('on branch lane-a', made.branch === 'lane-a', String(made.branch))
  ok('and calls the lane "a"', made.lane === 'a', String(made.lane))

  // Now the script is asked for the lane matching that folder - exactly what the prompt
  // hook does with `--prefer`, derived from the folder suffix a chat is sitting in.
  const got = JSON.parse(f.lane('claim', '--session', 'chat-1', '--prefer', 'a').out)
  ok('the script hands out the very same folder', same(got.dir, made.cwd), `${got.dir} vs ${made.cwd}`)
  ok('and the very same branch', got.branch === made.branch, `${got.branch} vs ${made.branch}`)
  ok(
    'so the lane the pane is in and the lane the chat holds are one lane',
    same(got.dir, `${f.repo}-a`) && got.lane === 'a',
    JSON.stringify(got)
  )

  // Nothing extra was created on the side - the failure this replaced would have left a
  // second branch (`lane-w2`) beside the app's `pf/w2`.
  const branches = git(f.repo, 'branch', '--format=%(refname:short)').split('\n').map((b) => b.trim())
  ok('and no second branch was invented for it', branches.sort().join(',') === 'lane-a,master', branches.join(','))
}

// ------------------------------------------------- the script knows every label the app makes

{
  const f = fixture('pool')
  const status = JSON.parse(f.lane('status').out)
  const pool = status.lanes.map((l) => l.lane)
  ok('the script starts from the project itself', pool[0] === 'main', pool.join(','))

  // Every lane the window can open has to be a lane the script can be handed. A pane in
  // `<repo>-e` whose chat asks for lane `e` must not be told there is no such lane.
  const appLabels = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
  const missing = appLabels.filter((l) => !pool.includes(l))
  ok('and knows every lane the app window can open', missing.length === 0, `missing: ${missing.join(',')}`)
  ok('folders and branches follow from the label', status.lanes.every((l) => (l.lane === 'main' ? l.branch === 'master' : l.dir.endsWith(`-${l.lane}`) && l.branch === `lane-${l.lane}`)), JSON.stringify(status.lanes.slice(0, 3)))
}

// ------------------------------------------------- lanes made under the old scheme still work

{
  const f = fixture('legacy')
  const old = `${f.repo}-w2`
  git(f.repo, 'worktree', 'add', '-q', '-b', 'pf/w2', old)
  git(old, 'config', 'user.email', 'test@example.com')
  git(old, 'config', 'user.name', 'test')
  writeFileSync(join(old, 'legacy.js'), 'export const legacy = 1\n')
  git(old, 'add', '-A')
  git(old, 'commit', '-qm', 'work done before the rename')

  const work = await laneWorkMod.laneWork(old)
  ok('an old <repo>-w2 lane is still recognised', Boolean(work), JSON.stringify(work))
  ok('with its label read as it is on disk', work?.lane === 'w2', String(work?.lane))
  ok('and its commit still counted', work?.ahead === 1, JSON.stringify(work))

  const merged = await laneWorkMod.mergeLaneBack(old)
  ok('and it still merges back into the project', merged?.ok === true, JSON.stringify(merged))
  ok('the work really landed', existsSync(join(f.repo, 'legacy.js')))

  // The app never makes another one: the next lane is a letter, beside the old folder.
  const next = await lanes.resolveLane(f.repo, [f.repo])
  ok('and the next lane made is a letter, not another w', same(next.cwd, `${f.repo}-a`), next.cwd)
}

// ------------------------------------------------- one word for it in the interface, too

{
  const a = place.describePlace({ cwd: 'C:/Projects/Toolstash-a', lane: 'a', branch: 'lane-a' })
  ok('a lane reads as "lane a"', a.role === 'lane a', a.role)
  ok('under its project name, not the folder name', a.project === 'Toolstash', a.project)
  ok('and the generated branch is not repeated on the chip', a.short === 'Toolstash · lane a', a.short)

  const legacy = place.describePlace({ cwd: 'C:/Projects/Toolstash-w2', lane: 'w2', branch: 'pf/w2' })
  ok('an old lane reads as the folder it is', legacy.role === 'lane w2', legacy.role)
  ok('and its branch is recognised as machinery too', legacy.short === 'Toolstash · lane w2', legacy.short)

  const main = place.describePlace({ cwd: 'C:/Projects/Toolstash', lane: 'main', branch: 'main' })
  ok('the project folder itself is the main checkout', main.role === 'main checkout', main.role)
  ok('and says only the project name', main.short === 'Toolstash', main.short)

  // The word "copy" is gone: it was the app's name for the same thing the script called a
  // lane, and having both is what this whole file exists to stop.
  ok('there is no second word for a lane', !JSON.stringify(a).includes('copy'), JSON.stringify(a))
}

// ------------------------------------------------- the two halves cannot silently drift

{
  // A label the app can produce must be spellable by the script's own rules. Pinned here
  // rather than trusted, because these two files cannot import each other: one is TypeScript
  // compiled into an Electron app, the other is a standalone .mjs run by hooks.
  const src = readFileSync(join(repoRoot, 'src', 'main', 'lanes.ts'), 'utf8')
  const appLabels = /const LANE_LABELS = \[([^\]]+)\]/.exec(src)?.[1]
  const parsed = (appLabels ?? '').split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean)
  ok('the app declares its lane labels in one place', parsed.length > 0, String(appLabels))

  const laneSrc = readFileSync(join(repoRoot, 'scripts', 'lane.mjs'), 'utf8')
  const poolSrc = /const DEFAULT_POOL = \[([^\]]+)\]/.exec(laneSrc)?.[1]
  const pool = (poolSrc ?? '').split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean)
  ok('the script declares its pool in one place', pool.length > 0, String(poolSrc))
  ok(
    'and the pool contains every label the app can make',
    parsed.every((l) => pool.includes(l)),
    `app: ${parsed.join(',')} | pool: ${pool.join(',')}`
  )
}

console.log(failed ? `\n${failed} lane-naming check(s) failed` : '\nall lane-naming checks passed')
process.exit(failed ? 1 : 0)
