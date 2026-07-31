/**
 * What a split is allowed to believe, and what it must refuse.
 *
 * Model-free and network-free: every case here is a string the planner might print,
 * checked against the decision made from it. The one that matters is overlap. Two lanes
 * claiming one path is not a plan with a flaw in it, it is two agents in one file with
 * a sentence between them - which is the exact failure the worktree was bought to make
 * impossible. So it is REFUSED, never trimmed into shape: repairing it means guessing
 * which lane the file belonged to, and the cost of guessing wrong is paid later, in a
 * merge, by someone who was not here.
 *
 * The rest are the ways a good plan arrives looking like a bad one - a fence around the
 * JSON, a brief with a brace in it, Windows separators - and none of those is a reason
 * to throw the plan away.
 */
import { buildSync } from 'esbuild'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-split-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const out = join(work, 'split.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/main/split.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: out
})
const { parsePlan, laneBrief, splitPayload, MIN_LANES, MAX_LANES } = createRequire(
  import.meta.url
)(out)

let failed = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` - ${detail}`}`)
  if (!ok) failed++
}

const lane = (name, owns, brief = `build ${name}`) => ({ name, brief, owns })
const plan = (lanes, contracts = '') => JSON.stringify({ contracts, lanes })

// ---------------------------------------------------------------------------
// The good case, and that it survives the ways CLIs decorate an answer

const good = plan(
  [lane('settings', ['src/renderer/components/Settings.tsx']), lane('catalogue', ['src/main/knowledge/'])],
  'Config.splitLanes: number'
)

let p = parsePlan(good)
check('a clean two-lane plan is accepted', p.lanes.length === 2 && !p.refused, p.refused)
check('contracts are carried', p.contracts === 'Config.splitLanes: number')

p = parsePlan('Here is the plan you asked for:\n```json\n' + good + '\n```\nHope that helps!')
check('a fenced plan with prose around it is accepted', p.lanes.length === 2, p.refused)

p = parsePlan(
  plan([
    lane('a', ['src/a.ts'], 'write function f(): { ok: true } and nothing else'),
    lane('b', ['src/b.ts'])
  ])
)
check('a brief containing braces does not truncate the plan', p.lanes.length === 2, p.refused)

// ---------------------------------------------------------------------------
// Overlap - the whole reason this file exists

const cases = [
  ['the same file twice', ['src/main/index.ts'], ['src/main/index.ts']],
  ['the same file in different case', ['src/App.tsx'], ['src/app.tsx']],
  ['the same file with a backslash', ['src\\main\\index.ts'], ['src/main/index.ts']],
  ['a directory containing the other lane’s file', ['src/main'], ['src/main/split.ts']],
  ['a trailing-slash directory', ['src/main/'], ['src/main/knowledge/x.ts']],
  ['a glob over the other lane', ['src/main/**'], ['src/main/index.ts']],
  ['the repo root', ['.'], ['src/main/index.ts']]
]
for (const [what, a, b] of cases) {
  const r = parsePlan(plan([lane('one', a), lane('two', b)]))
  check(`refuses ${what}`, r.lanes.length === 0 && Boolean(r.refused), JSON.stringify(r.lanes))
}

// A name that merely starts the same is NOT containment, and refusing it would split
// fewer plans than it should.
p = parsePlan(plan([lane('one', ['src/main']), lane('two', ['src/mainWindow.ts'])]))
check('src/main does not swallow src/mainWindow.ts', p.lanes.length === 2, p.refused)

// ---------------------------------------------------------------------------
// What a real answer looked like, and the two things it broke
//
// Both were found by running the actual CLI against the actual prompt, not by reading
// the code: the plan came back with 1,300-character briefs and mixed-case paths, and
// the first version of this file silently cut the first and lowercased the second.

p = parsePlan(
  plan([
    lane('prefs', ['src/renderer/src/components/SettingsDialog.tsx']),
    lane('export', ['src/main/historyExport.ts'])
  ])
)
check(
  'a claimed path keeps its capitals - on a Mac the lowercased one does not exist',
  p.lanes[0].owns[0] === 'src/renderer/src/components/SettingsDialog.tsx' &&
    p.lanes[1].owns[0] === 'src/main/historyExport.ts',
  JSON.stringify(p.lanes.map((l) => l.owns))
)
check(
  'the brief an agent is started with names the file in its real case',
  laneBrief(p, 0, 'x').includes('src/renderer/src/components/SettingsDialog.tsx')
)

const long = 'Build the preferences tab. '.repeat(60) // ~1,600 chars, a real brief's size
p = parsePlan(plan([lane('a', ['src/a.ts'], long), lane('b', ['src/b.ts'])]))
check(
  'a real-sized brief is not truncated',
  p.lanes[0].brief.length === long.trim().length,
  `${p.lanes[0].brief.length} of ${long.trim().length}`
)

// ---------------------------------------------------------------------------
// The refusals that are the planner's own

p = parsePlan('{"refused":"The schema has to exist before the pipeline can read it."}')
check('an explicit refusal is passed through', p.refused?.includes('schema'), p.refused)
check('a refusal has no lanes', p.lanes.length === 0)

p = parsePlan(plan([lane('only', ['src/a.ts'])]))
check(`fewer than ${MIN_LANES} lanes is refused`, Boolean(p.refused), JSON.stringify(p.lanes))

p = parsePlan(plan([lane('a', ['src/a.ts']), { name: 'b', brief: '', owns: ['src/b.ts'] }]))
check('a lane with no brief is dropped, taking the plan under the floor', Boolean(p.refused))

p = parsePlan(plan([lane('a', ['src/a.ts']), lane('b', [])]))
check('a lane owning nothing is dropped', Boolean(p.refused))

p = parsePlan(plan([lane('a', ['src/a.ts']), lane('A', ['src/b.ts'])]))
check('two lanes with one name are one lane', Boolean(p.refused))

// ---------------------------------------------------------------------------
// Nothing may point outside the checkout

for (const bad of ['../../secrets.env', '/etc/passwd', 'C:/Windows/system32', 'src/../../x']) {
  const r = parsePlan(plan([lane('a', [bad]), lane('b', ['src/b.ts'])]))
  check(`refuses a claim on ${bad}`, r.lanes.length === 0 && Boolean(r.refused))
}

// ---------------------------------------------------------------------------
// Junk

for (const [what, text] of [
  ['empty output', ''],
  ['a CLI error page', 'Error: not logged in\nRun `claude login` to continue.'],
  ['truncated JSON', '{"lanes":[{"name":"a","brief":"x","owns":["src/a.ts"]}'],
  ['a JSON array', '[{"name":"a"}]']
]) {
  const r = parsePlan(text)
  check(`refuses ${what}`, r.lanes.length === 0 && Boolean(r.refused))
}

// ---------------------------------------------------------------------------
// The ceiling, and that it cuts rather than refuses

const many = plan(
  Array.from({ length: 8 }, (_, i) => lane(`lane${i}`, [`src/l${i}.ts`]))
)
p = parsePlan(many)
check(`at most ${MAX_LANES} lanes`, p.lanes.length === MAX_LANES, String(p.lanes.length))

// ---------------------------------------------------------------------------
// The brief each agent is actually started with

p = parsePlan(good)
const brief = laneBrief(p, 0, 'Add settings and a capability catalogue')
check('the brief names this lane’s own files', brief.includes('src/renderer/components/Settings.tsx'))
check('the brief names what the OTHER lane owns', brief.includes('src/main/knowledge'))
check('the brief does not leak the other lane’s instructions', !brief.includes('build catalogue'))
check('the brief repeats the contracts', brief.includes('Config.splitLanes'))
check('the brief forbids merging', /do not merge/i.test(brief))
check('the brief carries the whole task', brief.includes('Add settings and a capability catalogue'))

const payload = splitPayload('do a thing', ['src', 'scripts'])
check('the request asks for JSON only', payload.includes('"lanes"') && /JSON and nothing else/.test(payload))
check('the request offers the refusal', payload.includes('"refused"'))
check('the request carries the tree it was given', payload.includes('scripts'))

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
