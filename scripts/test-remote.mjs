// Parent-suite browser checks belong on Robert's PC, never on the hosting Mac.
import { spawnSync, execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, lstatSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const root = process.cwd()
const args = process.argv.slice(2)
// rbuild's verbatim transport joins arguments into a Windows shell command.
if (args.some(arg => !/^[a-zA-Z0-9_=-]+$/.test(arg))) {
  console.error('Invalid remote test selector.')
  process.exit(2)
}
const probe = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', 'Gamer@100.78.1.77', 'hostname'], { encoding: 'utf8', timeout: 12_000 })
if (probe.status !== 0 || probe.stdout.trim().toUpperCase() !== 'DESKTOP-CMSUCM1') {
  console.error('Tests deferred: designated PC unavailable or identity mismatch. No local browser fallback.')
  const detail = probe.error?.message || (probe.status !== 0
    ? (probe.stderr?.trim() || `SSH exited ${probe.status ?? probe.signal ?? 'without a status'}`)
    : `Expected DESKTOP-CMSUCM1; received ${JSON.stringify(probe.stdout.trim())}`)
  console.error(`PC transport: ${detail.slice(-1200)}`)
  process.exit(3)
}
const transport = join(homedir(), 'Projects', 'claude-memory', 'claude-config', 'rbuild.mjs')
if (!existsSync(transport)) {
  console.error('Tests deferred: established PC transport unavailable. No local browser fallback.')
  process.exit(3)
}
// Snapshot current working bytes, not git archive: pending fixes must be tested.
// Git's input list excludes ignored Rust targets, installers and node_modules.
// A unique remote directory prevents concurrent lane checks overwriting inputs.
const stage = mkdtempSync(join(tmpdir(), 'paneforge-suite-'))
let status = 1
try {
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\0').filter(Boolean)
  for (const file of new Set(files)) {
    const source = join(root, file)
    if (!existsSync(source) || !lstatSync(source).isFile()) continue
    const target = join(stage, file)
    mkdirSync(dirname(target), { recursive: true })
    cpSync(source, target)
  }
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  console.log(`PC suite snapshot: ${revision}, including current working-tree edits; ${stage}`)
  const result = spawnSync(process.execPath, [transport, '--repo', stage, '--', 'npm run typecheck && node scripts/test-all.mjs', ...args], {
    cwd: stage, stdio: 'inherit', env: { ...process.env, RBUILD_HOST: 'Gamer@100.78.1.77' },
  })
  status = result.status ?? 1
} finally {
  rmSync(stage, { recursive: true, force: true })
}
process.exit(status)
