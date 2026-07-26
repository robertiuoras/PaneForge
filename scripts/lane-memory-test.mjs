// Prove a lane gets the two things a bare worktree does not - its own dev server
// port, and the original folder's Claude Code memory - without launching an agent:
//
//   npm run test:lanes:memory
//
// The seeding side of a lane (.env files, local settings, dependencies) is
// covered by lane-test.mjs; this file is only about port and memory.
//
// Lanes are the one feature that touches things outside the app - a git worktree,
// the user's .env files, Claude Code's own config folder - so "it typechecked" is
// worth very little here. This builds a throwaway git repo, points HOME at a
// throwaway folder, runs the real resolveLane(), and checks the lane came out
// with its own port, a junction to the original folder's Claude memory, and the
// original folder's project settings.
//
// lanes.ts imports nothing but node builtins, so it is compiled on its own into a
// temp folder and imported directly - no Electron, no app, ~2s.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = resolve(import.meta.dirname, '..')
const work = mkdtempSync(join(tmpdir(), 'pf-lane-'))
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

/** Compile lanes.ts on its own and import it as a module. */
async function loadLanes() {
  const out = join(work, 'build')
  // The tsc entry script, not the npx shim: node 24 refuses to spawn a .cmd.
  execFileSync(
    process.execPath,
    [
      join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      join('src', 'main', 'lanes.ts'),
      '--outDir',
      out,
      '--module',
      'es2022',
      '--target',
      'es2022',
      '--moduleResolution',
      'bundler',
      '--skipLibCheck'
    ],
    { cwd: repoRoot, stdio: 'pipe' }
  )
  writeFileSync(join(out, 'package.json'), '{"type":"module"}')
  return import(pathToFileURL(join(out, 'lanes.js')).href)
}

const lanes = await loadLanes()

// ---- a repo that states its dev port, so the lane's port can be checked ----
const repo = join(work, 'demo')
mkdirSync(repo, { recursive: true })
writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { dev: 'vite --port 5100' } }))
writeFileSync(join(repo, '.env'), 'SECRET=from-original\n')
writeFileSync(join(repo, 'README.md'), '# demo\n')
git(repo, ['init', '-b', 'main'])
git(repo, ['config', 'user.email', 'test@example.com'])
git(repo, ['config', 'user.name', 'test'])
git(repo, ['add', '-A'])
git(repo, ['commit', '-m', 'init'])

// ---- a throwaway HOME with a Claude Code layout already in it ----
const home = join(work, 'home')
const projects = join(home, '.claude', 'projects')
const key = (p) => resolve(p).replace(/[\\/:]/g, '-')
mkdirSync(join(projects, key(repo)), { recursive: true })
writeFileSync(join(projects, key(repo), 'transcript.jsonl'), '{"marker":"original"}\n')
writeFileSync(
  join(home, '.claude.json'),
  JSON.stringify({
    projects: {
      [resolve(repo)]: {
        allowedTools: ['Bash(git status)'],
        hasTrustDialogAccepted: true,
        history: [{ display: 'earlier prompt' }],
        lastCost: 1.23
      }
    }
  })
)
process.env.USERPROFILE = home
process.env.HOME = home
delete process.env.CLAUDE_CONFIG_DIR

// ---- the thing under test: a second session in a folder already in use ----
const lane = lanes.resolveLane(repo, [repo])

check('lane moved to its own folder', lane.cwd === `${repo}-w2`, lane.cwd)
check('lane is on its own branch', lane.branch === 'pf/w2', String(lane.branch))
check('gitignored .env came along', existsSync(join(lane.cwd, '.env')))
check('port is one past the project’s own', lane.port === 5101, String(lane.port))
check('PORT is in the launch env', lane.env?.PORT === '5101', JSON.stringify(lane.env))
check('lane label is in the launch env', lane.env?.PF_LANE === 'w2')
check('memory sharing reported', lane.sharedMemory === true, String(lane.sharedMemory))

const laneDir = join(projects, key(lane.cwd))
check('lane project folder is a link', existsSync(laneDir) && lstatSync(laneDir).isSymbolicLink())
check(
  'lane sees the original transcripts',
  existsSync(join(laneDir, 'transcript.jsonl')) &&
    readFileSync(join(laneDir, 'transcript.jsonl'), 'utf8').includes('original')
)

// A file written on the lane side must land in the original folder, not a copy:
// that is what makes /resume and project memory one shared thing.
writeFileSync(join(laneDir, 'from-lane.jsonl'), '{}\n')
check(
  'writes through the link reach the original',
  existsSync(join(projects, key(repo), 'from-lane.jsonl'))
)

const seeded = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).projects
const entry = seeded[resolve(lane.cwd)]
check('lane path was seeded into .claude.json', Boolean(entry))
check('trust carried over', entry?.hasTrustDialogAccepted === true)
check('allowed tools carried over', entry?.allowedTools?.[0] === 'Bash(git status)')
check('prompt history carried over', entry?.history?.length === 1)
check('per-run metrics were not copied', entry && !('lastCost' in entry))
check('forward-slash form seeded too', Boolean(seeded[resolve(lane.cwd).replace(/\\/g, '/')]))
check('original entry untouched', seeded[resolve(repo)]?.lastCost === 1.23)

// A third session gets a third folder and a third port, not the same one twice.
const third = lanes.resolveLane(repo, [repo, lane.cwd])
check('third session gets its own lane', third.cwd === `${repo}-w3`, third.cwd)
check('third session gets its own port', third.port === 5102, String(third.port))

// Restored panes: the lane is already the cwd, and it must still get its port.
const again = lanes.laneExtras(lane.cwd, 'w2')
check('restored lane keeps the same port', again.port === 5101, String(again.port))

// A folder nobody else is in is left exactly as it was.
const untouched = lanes.resolveLane(repo, [])
check('unclashed launch is not moved', untouched.cwd === repo && !untouched.lane)
check('unclashed launch gets no port', untouched.port === undefined)

// ---- cleanup: worktrees hold locks, so remove them through git ----
try {
  for (const dir of [lane.cwd, third.cwd]) spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd: repo })
} catch {
  /* best effort */
}
try {
  rmSync(work, { recursive: true, force: true, maxRetries: 3 })
} catch {
  console.log(`note: temp folder left behind at ${work}`)
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall lane checks passed')
process.exit(failures ? 1 : 0)
