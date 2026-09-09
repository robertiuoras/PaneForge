// Regression test for "an untracked file in the main checkout does not hold every finished
// lane out of a release" - scripts/lane.mjs `mainBlockers`.
//
// Measured 2026-09-09: assistant's main held two `.claude/agent-memory/...` notes an agent
// had left, clients' main a `clients/simon-hubspot/` folder, neither touched by any lane -
// and every ready lane in both repos sat unmerged behind `main checkout is dirty, commit
// first` for a day. Git merges around an untracked file; the only untracked file that can
// stop a merge is one a lane brings under the same path, and that one still must.
//
//   node scripts/lane-untracked-test.mjs

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installLane } from './lane-fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(realpathSync(tmpdir()), 'paneforge-lane-untracked-test')
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

const origin = join(root, 'origin.git')
git(root, 'init', '-q', '--bare', '-b', 'master', origin)
const repo = join(root, 'demo')
mkdirSync(join(repo, 'scripts'), { recursive: true })
writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'demo', version: '0.0.1' }, null, 2) + '\n')
writeFileSync(join(repo, '.lanes.json'), JSON.stringify({ release: 'merge' }) + '\n')
writeFileSync(join(repo, 'app.js'), 'console.log(1)\n')
installLane(here, repo)
git(repo, 'init', '-q', '-b', 'master')
git(repo, 'config', 'user.email', 'test@example.com')
git(repo, 'config', 'user.name', 'test')
git(repo, 'add', '-A')
git(repo, 'commit', '-qm', 'first')
git(repo, 'remote', 'add', 'origin', origin)
git(repo, 'push', '-q', '-u', 'origin', 'master')

const lane = (cwd, ...args) => {
  try {
    return { ok: true, out: execFileSync(process.execPath, [join(repo, 'scripts', 'lane.mjs'), ...args], { cwd, encoding: 'utf8', stdio: 'pipe' }).trim() }
  } catch (e) {
    return { ok: false, out: (e.stdout ?? '').toString().trim(), err: (e.stderr ?? '').toString().trim() }
  }
}
const statePath = join(repo, '.git', 'paneforge-lanes.json')
const state = () => JSON.parse(readFileSync(statePath, 'utf8'))
const holderOf = (session) => Object.entries(state().lanes).find(([, c]) => c.session === session)?.[0]

// A chat in a letter lane finishes a feature. `--prefer a` so the lane is never `main`.
const SESS = 'chat-finished'
lane(repo, 'claim', '--session', SESS, '--prefer', 'a')
const LANE = holderOf(SESS)
ok('the claim landed in a letter lane', LANE && LANE !== 'main', JSON.stringify(state().lanes))
const laneFolder = join(root, `demo-${LANE}`)
writeFileSync(join(laneFolder, 'feature.js'), 'export const done = true\n')
git(laneFolder, 'add', '-A')
git(laneFolder, 'commit', '-qm', 'feat: the feature')

// Meanwhile an agent left a note in the main checkout that no lane knows about.
mkdirSync(join(repo, '.claude', 'agent-memory'), { recursive: true })
writeFileSync(join(repo, '.claude', 'agent-memory', 'note.md'), 'left behind\n')

const r1 = lane(repo, 'ready', '--session', SESS)
ok('ready with a stray untracked file in main still merges', /merged|released|shipped|went out/i.test(r1.out + r1.err) || git(repo, 'log', '--oneline', 'master').includes('the feature'), (r1.out + '\n' + r1.err).slice(0, 400))
ok('the feature is on master', git(repo, 'log', '--oneline', '-5', 'master').includes('the feature'), git(repo, 'log', '--oneline', '-5', 'master'))
ok('the stray file is still there, untouched', readFileSync(join(repo, '.claude', 'agent-memory', 'note.md'), 'utf8') === 'left behind\n')

// The one untracked file that must still block: a lane brings a file under the same path.
const SESS2 = 'chat-collides'
lane(repo, 'claim', '--session', SESS2, '--prefer', 'b')
const LANE2 = holderOf(SESS2)
ok('the second claim landed in a letter lane', LANE2 && LANE2 !== 'main', JSON.stringify(state().lanes))
const laneFolder2 = join(root, `demo-${LANE2}`)
writeFileSync(join(laneFolder2, 'notes.txt'), 'from the lane\n')
git(laneFolder2, 'add', '-A')
git(laneFolder2, 'commit', '-qm', 'feat: notes')
writeFileSync(join(repo, 'notes.txt'), 'somebody typed this in main\n')
const r2 = lane(repo, 'ready', '--session', SESS2)
ok('a colliding untracked file still refuses, by name', /dirty[\s\S]*notes\.txt/.test(r2.out + r2.err), (r2.out + '\n' + r2.err).slice(0, 400))
ok('and nothing was merged over it', !git(repo, 'log', '--oneline', '-5', 'master').includes('notes'), git(repo, 'log', '--oneline', '-5', 'master'))
ok('the typed file survives', readFileSync(join(repo, 'notes.txt'), 'utf8') === 'somebody typed this in main\n')

console.log(`\n${failed ? `${failed} FAILED` : 'all passed'}`)
process.exit(failed ? 1 : 0)
