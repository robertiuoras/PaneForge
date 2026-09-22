// A pane whose conversation the claim rules could not infer is asked about by pid.
//
// 2026-09-23: 17 of 21 sleep refusals were `conversation-unverified` with no transcript
// at all, at memory pressure 2, while Claude Code's own `~/.claude/sessions/<pid>.json`
// named each pane's conversation. `claimFromCli` reads that file; these checks pin when
// it may be believed.
//
//   node scripts/transcript-cli-claim-test.mjs

import { buildSync } from 'esbuild'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-transcript-cli-claim-test')
rmSync(work, { recursive: true, force: true })
const home = join(work, 'claude')
const CWD = join(work, 'repo')
const OTHER = join(work, 'elsewhere')
for (const d of [CWD, OTHER, join(home, 'sessions')]) mkdirSync(d, { recursive: true })
const project = join(home, 'projects', CWD.replace(/[^A-Za-z0-9]/g, '-'))
mkdirSync(project, { recursive: true })
const SID = '2df0c87c-146a-4829-b1e2-5ede2ea5f3c6'
writeFileSync(join(project, `${SID}.jsonl`), '{"type":"user"}\n{"type":"assistant"}\n')
const row = (pid, extra = {}) =>
  writeFileSync(join(home, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId: SID, cwd: CWD, ...extra }))
row(101)
row(102, { cwd: OTHER })
row(103, { sessionId: 'aaaaaaaa-0000-0000-0000-000000000000' })
row(104, { pid: 999 })
writeFileSync(join(home, 'sessions', '105.json'), '{ not json')

process.env.PF_CLAUDE_HOME = home
const outfile = join(work, 'transcripts.bundle.cjs')
buildSync({ absWorkingDir: root, entryPoints: ['src/main/transcripts.ts'], bundle: true, format: 'cjs', platform: 'node', outfile })
const t = createRequire(import.meta.url)(outfile)

let failed = 0
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`)
  if (!cond) {
    failed++
    if (detail !== undefined) console.log('      ' + String(detail))
  }
}

t.noteSession('p1', CWD, 'claude')
ok('with nothing inferred, the pane has no conversation', t.resumeIdFor('p1') === undefined, t.resumeIdFor('p1'))
ok('the CLI\'s own row claims it', t.claimFromCli('p1', 101) === true)
ok('...and it is the conversation the row names', t.resumeIdFor('p1') === SID, t.resumeIdFor('p1'))

for (const [name, pid] of [['a row for another folder', 102], ['a row whose transcript is not on disk', 103],
  ['a row that is for a different pid', 104], ['a row that is not JSON', 105], ['no row at all', 106]]) {
  t.noteSession('p' + pid, CWD, 'claude')
  ok(`${name} claims nothing`, t.claimFromCli('p' + pid, pid) === false && t.resumeIdFor('p' + pid) === undefined)
}
t.noteSession('cx', CWD, 'codex')
ok('a Codex pane is not a Claude row', t.claimFromCli('cx', 101) === false)
t.noteSession('np', CWD, 'claude')
ok('a pane with no process is not asked', t.claimFromCli('np', undefined) === false)

rmSync(work, { recursive: true, force: true })
console.log(failed ? `\n${failed} failed` : '\nall cli-claim checks passed')
process.exit(failed ? 1 : 0)
