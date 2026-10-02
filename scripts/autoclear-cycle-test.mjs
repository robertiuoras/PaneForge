// Twenty finish -> clear -> resume cycles through the shipped auto-clear hook
// (scripts/autoclear-hook.mjs), as Claude Code runs it, in a sandbox HOME (wr-03, 2026-10-02:
// "u shouldve cloesd it yourself thats the whole point").
//
// Each cycle is one chat's life over the context line:
//   1. it finishes a turn with no handoff        -> blocked once, told the exact path
//   2. it writes a handoff (every 4th one in a shape the parser cannot read)
//        bad shape                                -> blocked once, told how to fix it, then fixed
//   3. the continuation Stop                     -> one clear request the app's readAsk accepts,
//                                                   carrying the open steps
//   4. the app clears; SessionStart(source=clear) -> the fresh session gets the handoff
//   5. the resumed session's first Stop          -> NO second clear off the file it came from
//   6. it finishes the work, handoff says None   -> no request: nothing left, the chat is done
// Every cycle must hold every step; the run passes only at 20/20.
//
// Run: node scripts/autoclear-cycle-test.mjs

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildSync } from 'esbuild'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const HOOK = join(REPO, 'scripts', 'autoclear-hook.mjs')
const CYCLES = 20
const work = mkdtempSync(join(tmpdir(), 'autoclear-cycle-'))
const out = join(work, 'autoclear.mjs')
buildSync({ entryPoints: [join(REPO, 'src', 'shared', 'autoclear.ts')], bundle: true, format: 'esm', platform: 'node', outfile: out })
const { readAsk } = await import(pathToFileURL(out).href)
const hook = await import(pathToFileURL(HOOK).href)

const home = join(work, 'home')
const claudeHome = join(home, '.claude')
const userData = join(work, 'user data')
const cwd = join(work, 'proj')
mkdirSync(cwd, { recursive: true })
const PANE = 's9-cycle01'
const handoff = hook.handoffCandidates(cwd, PANE, claudeHome, () => false)[0]
mkdirSync(dirname(handoff), { recursive: true })
const reqDir = join(userData, 'autoclear-requests')
const requests = () => (existsSync(reqDir) ? readdirSync(reqDir).filter((f) => f.endsWith('.json')) : [])
const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, PF_CLAUDE_HOME: claudeHome, PF_PANE: PANE }

function transcript(name, tokens) {
  const f = join(work, `${name}.jsonl`)
  const rows = [
    { type: 'user', message: { content: 'go' } },
    { type: 'assistant', message: { usage: { input_tokens: 100, cache_read_input_tokens: tokens - 300, cache_creation_input_tokens: 200 } } }
  ]
  writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  return f
}
function run(event, input) {
  const r = spawnSync(process.execPath, [HOOK, `--event=${event}`, `--user-data=${userData}`], {
    input: JSON.stringify({ cwd, ...input }),
    encoding: 'utf8',
    timeout: 20_000,
    env
  })
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' }
}
/** Distinct mtimes: the hook keys "already asked" and "consumed" on them. */
let clock = Date.now() / 1000 - 600
function write(text) {
  writeFileSync(handoff, text)
  clock += 2
  utimesSync(handoff, clock, clock)
}

let passed = 0
const failures = []
for (let i = 1; i <= CYCLES; i++) {
  const bad = []
  const check = (what, ok, detail) => {
    if (!ok) bad.push(`${what}: ${detail}`)
  }
  rmSync(handoff, { force: true })
  for (const f of requests()) rmSync(join(reqDir, f), { force: true })
  const sid = `cycle-${i}`
  const fat = transcript(`t${i}`, 220_000 + i * 1000)

  const first = run('stop', { session_id: sid, transcript_path: fat })
  check('1 no handoff blocks', first.code === 2 && first.err.includes(handoff), JSON.stringify(first))

  const steps = [`build part ${i}`, `test part ${i}`]
  if (i % 4 === 0) {
    write(`## State\nhalf of part ${i}\n## Next steps\nBuild part ${i} and then test it.\n`)
    const shape = run('stop', { session_id: sid, transcript_path: fat, stop_hook_active: true })
    check('2 bad shape blocks with the fix', shape.code === 2 && /no list under it/.test(shape.err) && requests().length === 0, JSON.stringify(shape))
  }
  write(`## State\nhalf of part ${i}\n## Next steps\n1. ${steps[0]}\n2. ${steps[1]}\n`)
  const ask = run('stop', { session_id: sid, transcript_path: fat, stop_hook_active: true })
  const files = requests()
  const req = files.length === 1 ? readAsk(JSON.parse(readFileSync(join(reqDir, files[0]), 'utf8'))) : null
  check('3 one clear request', ask.code === 0 && files.length === 1, JSON.stringify({ ask, files }))
  check('3 readAsk accepts it with the steps', !!req && JSON.stringify(req.steps) === JSON.stringify(steps), JSON.stringify(req))
  for (const f of files) rmSync(join(reqDir, f), { force: true }) // the app took it and cleared

  const fresh = `${sid}-resumed`
  const start = run('start', { session_id: fresh, source: 'clear' })
  let ctx = ''
  try {
    ctx = JSON.parse(start.out).hookSpecificOutput.additionalContext
  } catch {
    /* judged below */
  }
  check('4 resumed session gets the handoff', start.code === 0 && ctx.includes(`1. ${steps[0]}`), start.out.slice(0, 200))

  const resumedStop = run('stop', { session_id: fresh, transcript_path: transcript(`r${i}`, 60_000 + 200_000) })
  check('5 no second clear off the file it came from', requests().length === 0, JSON.stringify(resumedStop))

  write(`## State\npart ${i} done and verified\n## Next steps\nNone\n`)
  const done = run('stop', { session_id: fresh, transcript_path: transcript(`d${i}`, 270_000), stop_hook_active: true })
  check('6 None: no request, chat done', done.code === 0 && requests().length === 0 && !done.err, JSON.stringify(done))

  if (bad.length) failures.push(`cycle ${i}\n      ${bad.join('\n      ')}`)
  else passed++
}

rmSync(work, { recursive: true, force: true })
for (const f of failures) console.error(`FAIL  ${f}`)
console.log(`${passed === CYCLES ? 'ok   ' : 'FAIL '} ${passed}/${CYCLES} finish -> clear -> resume cycles held every step`)
process.exit(passed === CYCLES ? 0 : 1)
