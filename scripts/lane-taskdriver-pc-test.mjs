// Synthetic Git fixtures exercise the Mac Taskdriver gate without a PC, network,
// production checkout, or real proof. The fake verifier exists only in tmpdir.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

if (process.platform !== 'darwin') {
  console.log('Taskdriver Mac gate fixture requires macOS')
  process.exit(0)
}

const scripts = resolve(import.meta.dirname)
const root = mkdtempSync(join(tmpdir(), 'pf-taskdriver-pc-'))
const projects = join(root, 'Projects')
const engineDir = join(projects, 'PaneForge', 'scripts')
const proofDir = join(projects, 'claude-memory', 'claude-config')
const proofFile = join(proofDir, 'taskdriver-pc-proof.mjs')
const approved = join(proofDir, 'approved.json')
const calls = join(proofDir, 'calls.jsonl')
let failures = 0

function ok(name, pass, detail = '') {
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${pass || !detail ? '' : ` - ${detail}`}`)
  if (!pass) failures++
}
function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}
function lane(repo, ...args) {
  const r = spawnSync(process.execPath, [join(engineDir, 'lane.mjs'), ...args, '--repo', repo], {
    encoding: 'utf8', timeout: 120_000
  })
  return { code: r.status ?? 1, out: r.stdout.trim(), err: r.stderr.trim() }
}
function allow(...trees) { writeFileSync(approved, JSON.stringify(trees)) }
function callTrees() {
  try { return readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) }
  catch { return [] }
}
function project(name) {
  const dir = join(projects, name, 'taskdriver.ai')
  const remote = join(projects, name, 'origin.git')
  mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '--bare', '-q', remote])
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'test')
  writeFileSync(join(dir, '.lanes.json'), '{"release":"merge"}\n')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: {
    typecheck: `node -e "require('fs').writeFileSync('${join(root, 'mac-ran')}', 'typecheck')"`,
    test: `node -e "require('fs').writeFileSync('${join(root, 'mac-ran')}', 'suite')"`
  } }))
  writeFileSync(join(dir, 'base.txt'), 'base\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'init')
  git(dir, 'remote', 'add', 'origin', remote)
  git(dir, 'push', '-q', '-u', 'origin', 'main')
  return { dir, remote }
}
function work(repo, session, file) {
  const claimed = JSON.parse(lane(repo, 'claim', '--session', session, '--cwd', repo).out)
  writeFileSync(join(claimed.dir, file), `${file}\n`)
  git(claimed.dir, 'add', '-A')
  git(claimed.dir, 'commit', '-qm', `feat: ${file}`)
  return claimed
}

try {
  mkdirSync(engineDir, { recursive: true })
  mkdirSync(proofDir, { recursive: true })
  // Keep the production entrypoint and imports intact apart from their location:
  // the copy makes its canonical Projects-relative verifier a disposable fake.
  const original = readFileSync(join(scripts, 'lane.mjs'), 'utf8')
  const relocated = original.replace(/from '(\.\/[^']+)'/g, (_, p) =>
    `from '${pathToFileURL(resolve(scripts, p)).href}'`)
  writeFileSync(join(engineDir, 'lane.mjs'), relocated)
  writeFileSync(proofFile, `import { spawnSync } from 'node:child_process'
import { readFileSync, appendFileSync } from 'node:fs'
const args = process.argv
const repo = args[args.indexOf('--repo') + 1]
const ref = args[args.indexOf('--ref') + 1]
const tree = spawnSync('git', ['rev-parse', ref + '^{tree}'], { cwd: repo, encoding: 'utf8' }).stdout.trim()
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({repo, ref, tree}) + '\\n')
if (!JSON.parse(readFileSync(${JSON.stringify(approved)}, 'utf8')).includes(tree)) {
  console.error('No PC proof for exact tree')
  process.exit(1)
}
`)
  allow()

  const missing = project('missing')
  lane(missing.dir, 'claim', '--session', 'hold-main', '--cwd', missing.dir)
  work(missing.dir, 'chat-a', 'feature.txt')
  const noProof = lane(missing.dir, 'ready', '--session', 'chat-a')
  ok('missing proof holds the lane', git(missing.remote, 'rev-parse', 'main') === git(missing.dir, 'rev-parse', 'main'), noProof.out)
  ok('missing proof is explained', /PC verification.*required/i.test(noProof.out + noProof.err), noProof.out)
  ok('Mac npm checks did not run', !existsSync(join(root, 'mac-ran')))
  allow(git(missing.dir, 'rev-parse', 'HEAD^{tree}'))
  lane(missing.dir, 'autoship', '--session', 'chat-a')
  ok('stale main proof cannot authorize the new merge tree',
    git(missing.remote, 'rev-parse', 'main') !== git(missing.dir, 'rev-parse', 'main') &&
    git(missing.remote, 'rev-parse', 'main') === git(missing.dir, 'rev-parse', 'HEAD^1'))

  const single = project('single')
  lane(single.dir, 'claim', '--session', 'hold-main', '--cwd', single.dir)
  const b = work(single.dir, 'chat-b', 'single.txt')
  allow(git(b.dir, 'rev-parse', 'HEAD^{tree}'))
  const passed = lane(single.dir, 'ready', '--session', 'chat-b')
  ok('verified lane can land when merged tree matches',
    git(single.remote, 'rev-parse', 'main') === git(single.dir, 'rev-parse', 'main'), passed.out)

  const combined = project('combined')
  lane(combined.dir, 'claim', '--session', 'hold-main', '--cwd', combined.dir)
  const c = work(combined.dir, 'chat-c', 'one.txt')
  const d = work(combined.dir, 'chat-d', 'two.txt')
  writeFileSync(join(d.dir, 'unfinished.txt'), 'waiting\n')
  const before = git(combined.remote, 'rev-parse', 'main')
  allow(git(c.dir, 'rev-parse', 'HEAD^{tree}'), git(d.dir, 'rev-parse', 'HEAD^{tree}'))
  lane(combined.dir, 'ready', '--session', 'chat-c')
  git(d.dir, 'add', '-A')
  git(d.dir, 'commit', '-qm', 'finish second lane')
  allow(git(c.dir, 'rev-parse', 'HEAD^{tree}'), git(d.dir, 'rev-parse', 'HEAD^{tree}'))
  const mismatch = lane(combined.dir, 'ready', '--session', 'chat-d')
  const mergedTree = git(combined.dir, 'rev-parse', 'HEAD^{tree}')
  ok('combined tree differs from either approved lane', !JSON.parse(readFileSync(approved)).includes(mergedTree))
  ok('combined unverified tree never pushes', git(combined.remote, 'rev-parse', 'main') === before, mismatch.out)
  ok('post-merge gate checked actual main tree', callTrees().some(c => c.repo === combined.dir && c.tree === mergedTree))
  ok('ready marks remain for retry', Object.keys(JSON.parse(readFileSync(join(combined.dir, '.git', 'paneforge-lanes.json'))).ready).length >= 2)
  ok('Mac npm checks still did not run', !existsSync(join(root, 'mac-ran')))
} finally {
  rmSync(root, { recursive: true, force: true })
}
if (failures) process.exit(1)
