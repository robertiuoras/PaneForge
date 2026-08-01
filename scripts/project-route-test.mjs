// Which project a first message is about.
//
// The bug being pinned is a session opened in the wrong folder, which nothing ever
// reports: the agent answers, plausibly, out of another project's instructions and
// indexes, and the only symptom is that everything costs more and an edit occasionally
// lands in the wrong checkout. Routing turns that into a tick in a dialog, so the two
// things worth testing are that it ticks the right project for a real message, and that
// it stays quiet rather than ticking a plausible wrong one.
//
//   node scripts/project-route-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-route-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const bundle = (entry, name) => {
  const out = join(work, name)
  buildSync({ absWorkingDir: root, entryPoints: [entry], bundle: true, format: 'cjs', platform: 'node', outfile: out })
  return createRequire(import.meta.url)(out)
}
const { routePrompt, tokens, trunkOf } = bundle('src/shared/projectRoute.ts', 'route.cjs')
const { aliasesFor, routeCandidates, clearAliasCache } = bundle('src/main/projectAliases.ts', 'aliases.cjs')

let checks = 0
let failures = 0
const ok = (cond, what) => {
  if (cond) checks++
  else {
    failures++
    console.log(`FAIL ${what}`)
  }
}
const is = (actual, expected, what) => ok(actual === expected, `${what} (got ${JSON.stringify(actual)})`)

// ---- projects on disk, named the way real ones are ----------------------------------

const projects = []
function project(name, files = {}) {
  const path = join(work, name)
  mkdirSync(path, { recursive: true })
  for (const [file, body] of Object.entries(files)) {
    mkdirSync(dirname(join(path, file)), { recursive: true })
    writeFileSync(join(path, file), body)
  }
  const p = { name, path, lastUsed: 0, isGit: !!files['.git/config'] }
  projects.push(p)
  return p
}

project('Toolstash', {
  'package.json': JSON.stringify({ name: 'toolstash', homepage: 'https://toolstash.xyz' }),
  'README.md': '# Toolstash\n\nLive at https://toolstash.xyz - source on github.com/robertiuoras/toolstash\n',
  '.git/config': '[remote "origin"]\n\turl = https://github.com/robertiuoras/toolstash.git\n'
})
project('PaneForge', {
  'package.json': JSON.stringify({ name: 'paneforge' }),
  '.git/config': '[remote "origin"]\n\turl = git@github.com:robertiuoras/PaneForge.git\n'
})
project('assistant', { 'CLAUDE.md': '# CLAUDE.md\n\nAirtasker co-pilot lives here.\n' })
project('taskdriver', {
  'package.json': JSON.stringify({ name: 'taskdriver', homepage: 'https://app.taskdriver.ai' })
})
project('Toolstash-b')
project('PaneForge-w3')
project('crypto')

const cands = routeCandidates(projects)
const route = (text) => routePrompt(text, cands)
const top = (text) => {
  const r = route(text)
  return r.confident ? r.matches[0].name : null
}

// ---- the message that started this ---------------------------------------------------

// Robert's real one, and the reason the scorer prefers the strongest single alias over a
// count of them: this names two projects, and the one it is ABOUT is the site, not the
// page on it.
is(top('Add visit tracking to toolstash.xyz/paneforge'), 'Toolstash', 'domain beats a folder name in the same sentence')
is(top('fix the paneforge lane healer stashing my work'), 'PaneForge', 'a plain folder name routes')
is(top('deploy app.taskdriver.ai and check the agents tab'), 'taskdriver', 'a subdomain routes to its project')

// ---- lane checkouts are the same project ---------------------------------------------

is(trunkOf('Toolstash-b'), 'Toolstash', 'lane suffix strips')
is(trunkOf('PaneForge-w3'), 'PaneForge', 'worktree suffix strips')
is(trunkOf('taskdriver'), null, 'a trunk is not a lane')
ok(!cands.some((c) => c.name === 'Toolstash-b'), 'lane checkouts are never offered as targets')
is(top('the toolstash-b checkout is dirty'), 'Toolstash', 'a lane name routes to its trunk')

// ---- silence is the important half ----------------------------------------------------

is(top('write an assistant that answers my email'), null, 'a project named after an ordinary word does not win on that word')
is(top('the crypto wallet paid out again'), null, 'nor does another one')
is(top('make the button bigger'), null, 'a message naming nothing routes nowhere')
is(top('hi'), null, 'too short to mean anything')
is(top('compare paneforge and toolstash startup time'), null, 'two projects named equally is not a decision')
is(top('open a pull request on github.com'), null, 'vendor domains in a README never become aliases')

// A project still routes when it is named alongside a generic word, because the generic
// word is discounted rather than banned.
is(top('the assistant repo airtasker screening in taskdriver'), 'taskdriver', 'a real name outranks a discounted one')

// ---- aliases come off disk ------------------------------------------------------------

const tool = projects.find((p) => p.name === 'Toolstash')
const alias = (p) => aliasesFor(p).map((a) => a.value)
ok(alias(tool).includes('toolstash.xyz'), 'homepage domain harvested')
ok(alias(tool).includes('robertiuoras/toolstash'), 'git remote slug harvested')
ok(!alias(tool).some((v) => v.includes('github.com')), 'the vendor host in the same README is dropped')
ok(alias(tool).includes(tool.path), 'the path itself is an alias')

// A path in the message is an instruction, not a hint, so it beats every other signal.
is(top(`read ${join(work, 'crypto')}\\notes.md`), 'crypto', 'a literal path routes even for a generic name')

// ---- tokenising -----------------------------------------------------------------------

const t = tokens('Add tracking to toolstash.xyz/paneforge, then app.taskdriver.ai')
ok(t.has('toolstash.xyz'), 'domains survive whole')
ok(t.has('toolstash'), 'and split')
ok(t.has('paneforge'), 'path segments split')
ok(t.has('taskdriver'), 'subdomains split')

// ---- cheap enough to run on every keystroke -------------------------------------------

clearAliasCache()
const cold = Date.now()
routeCandidates(projects)
const coldMs = Date.now() - cold
const warm = Date.now()
for (let i = 0; i < 200; i++) route('add visit tracking to toolstash.xyz/paneforge')
const perCall = (Date.now() - warm) / 200
ok(perCall < 2, `200 routes averaged ${perCall.toFixed(2)}ms (cold alias scan ${coldMs}ms)`)
console.log(`     alias scan ${coldMs}ms cold, route ${perCall.toFixed(2)}ms warm`)

assert.equal(failures, 0, `${failures} failing check(s)`)
console.log(`ok   ${checks} checks`)
rmSync(work, { recursive: true, force: true })
