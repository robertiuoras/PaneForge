// detectLane(): the lane a folder ALREADY is, for a pane this app did not move itself.
//
// resolveLane only labels a pane it created a worktree for, so a chat started by hand in
// `taskdriver.ai-c` carried no lane id and its card printed the raw folder name, while a
// pane the app had moved said `assistant` + `lane a` for the same kind of folder.
// place.ts's projectOf may not guess a suffix - `service-a` is a real project name - so
// the label has to be PROVED here, by git, before it reaches a Session.
//
// The load-bearing half is the negatives: a standalone repo whose name ends in `-a`, and
// a plain folder beside a repo. Both are the shape a guess would get wrong.
//
// Real git in a temp folder, real lanes.ts, no stubs.

import { buildSync } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = resolve(import.meta.dirname, '..')
const work = realpathSync(mkdtempSync(join(tmpdir(), 'pf-lanedetect-')))
let failures = 0

function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` - ${detail}`}`)
  if (!ok) failures++
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr || r.stdout}`)
  return (r.stdout ?? '').trim()
}

async function loadLanes() {
  const out = join(work, 'lanes.bundle.mjs')
  buildSync({
    absWorkingDir: repoRoot,
    entryPoints: [join('src', 'main', 'lanes.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: out,
    external: ['electron']
  })
  return import(pathToFileURL(out).href)
}

const lanes = await loadLanes()

/** A repo with one commit, at `<work>/<name>`. */
function repoAt(name) {
  const repo = join(work, name)
  mkdirSync(repo, { recursive: true })
  writeFileSync(join(repo, 'app.js'), 'const a = 1\n')
  git(repo, ['init', '-b', 'main'])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'test'])
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'first'])
  return repo
}

// ------------------------------------------------- a real lane answers its letter

{
  const repo = repoAt('proj')
  for (const label of ['a', 'c']) {
    const lane = `${repo}-${label}`
    git(repo, ['worktree', 'add', '-b', `lane-${label}`, lane])
    check(`worktree -${label} is lane ${label}`, (await lanes.detectLane(lane)) === label)
  }
  // The older scheme is still on disk wherever a lane has not landed yet.
  const old = `${repo}-w2`
  git(repo, ['worktree', 'add', '-b', 'pf/w2', old])
  check('legacy -w2 worktree is lane w2', (await lanes.detectLane(old)) === 'w2')

  check('the repo itself is not a lane', (await lanes.detectLane(repo)) === undefined)
}

// ------------------------------------------------- the controls: a guess gets these wrong

{
  // A project genuinely called `service-a`, with a sibling `service` that is a real repo.
  // The NAME says lane; git says this folder is its own main checkout.
  repoAt('service')
  const own = repoAt('service-a')
  check('a standalone repo named -a is not a lane', (await lanes.detectLane(own)) === undefined)

  // A plain folder beside a repo: nothing to be a worktree of.
  const plain = join(work, 'proj-b')
  mkdirSync(plain, { recursive: true })
  check('a plain folder named -b is not a lane', (await lanes.detectLane(plain)) === undefined)

  // A worktree of a DIFFERENT repo that happens to sit at `<other>-a`.
  const other = repoAt('other')
  const foreign = join(work, 'proj-e')
  git(other, ['worktree', 'add', '-b', 'lane-e', foreign])
  check(
    "a worktree of somebody else's repo is not this project's lane",
    (await lanes.detectLane(foreign)) === undefined
  )
}

rmSync(work, { recursive: true, force: true })
console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
