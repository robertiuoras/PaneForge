// What the competitor watch says moved, and - more importantly - what it stays quiet about.
//
// The failure mode of a watch script is not missing a release. It is reporting so much that
// nobody reads it, at which point it is worth less than nothing: it looks like coverage and
// provides none. So the assertions are half about noise.
//
// No network. `changesFor`/`report` are pure and the fixtures are two snapshots.
//
//   node scripts/competitors-test.mjs

import { changesFor, report } from './competitors.mjs'

let failures = 0
function ok(name, pass, detail = '') {
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${pass || !detail ? '' : ` - ${detail}`}`)
  if (!pass) failures++
}
const has = (lines, re) => lines.some((l) => re.test(l))

const base = {
  stars: 10000,
  description: 'an agent runner',
  archived: false,
  release: 'v1.0.0',
  releasedAt: '2026-08-01T00:00:00Z',
  readmeSha: 'aaa'
}

// ---------------------------------------------------------------- quiet when nothing moved

{
  const lines = changesFor(base, { ...base })
  ok('an unchanged repo says nothing at all', lines.length === 0, lines.join(' / '))
}

{
  // A star count wanders all day. 10,000 -> 10,300 is three percent and is not news.
  const lines = changesFor(base, { ...base, stars: 10_300 })
  ok('star drift under the threshold is not reported', lines.length === 0, lines.join(' / '))
}

{
  const lines = changesFor(base, { ...base, stars: 11_000 })
  ok('a real move in stars is', has(lines, /stars 10\.0k → 11\.0k/), lines.join(' / '))
  ok('and it carries the direction', has(lines, /\+10%/), lines.join(' / '))
}

{
  const lines = changesFor(base, { ...base, stars: 8_000 })
  ok('a fall is reported too, without a plus sign', has(lines, /-20%/) && !has(lines, /\+/), lines.join(' / '))
}

// ---------------------------------------------------------------- the ones worth acting on

{
  const lines = changesFor(base, { ...base, readmeSha: 'bbb' })
  ok(
    'a changed README is the line that sends you back to TODO.md',
    has(lines, /README changed/),
    lines.join(' / ')
  )
}

{
  const lines = changesFor(base, { ...base, release: 'v1.1.0', releasedAt: '2026-08-07T09:00:00Z' })
  ok('a new release names both versions', has(lines, /released v1\.1\.0.*was v1\.0\.0/), lines.join(' / '))
  ok('and the date, trimmed to the day', has(lines, /2026-08-07/), lines.join(' / '))
}

{
  const lines = changesFor(base, { ...base, archived: true })
  ok('an archived repo is called what it is', has(lines, /ARCHIVED/), lines.join(' / '))
  const back = changesFor({ ...base, archived: true }, base)
  ok('and so is one that came back', has(back, /un-archived/), back.join(' / '))
}

{
  const lines = changesFor(base, { ...base, description: 'the agent IDE' })
  ok('a rewritten description is quoted', has(lines, /"the agent IDE"/), lines.join(' / '))
}

// ---------------------------------------------------------------- first sight, and failure

{
  const lines = changesFor(undefined, base)
  ok('a new repo is announced once', lines.length === 1 && /added to the watchlist/.test(lines[0]), lines.join(' / '))
  ok('with its size, so the announcement is worth something', has(lines, /10\.0k stars/), lines.join(' / '))
  ok('and NOT as a list of every field changing from nothing', !has(lines, /README changed/), lines.join(' / '))
}

{
  const lines = changesFor(base, { error: 'HTTP 404: Not Found' })
  ok('a repo that cannot be read says so rather than looking unchanged', has(lines, /could not be read/), lines.join(' / '))
  ok('and quotes what GitHub said', has(lines, /404/), lines.join(' / '))
  const recovered = changesFor({ error: 'HTTP 404' }, base)
  ok(
    'recovering does not dump every field as a change',
    recovered.length === 1 && /readable again/.test(recovered[0]),
    recovered.join(' / ')
  )
}

// ---------------------------------------------------------------- the whole report

{
  const prev = { 'a/one': base, 'b/two': base, 'c/three': base }
  const next = {
    'a/one': { ...base, why: 'the close one', readmeSha: 'bbb' },
    'b/two': { ...base, why: 'quiet' },
    'c/three': { ...base, why: 'gone', archived: true }
  }
  const r = report(prev, next)
  ok('only the repos that moved appear', r.length === 2, r.map((x) => x.repo).join(','))
  ok('in watchlist order', r[0].repo === 'a/one' && r[1].repo === 'c/three', r.map((x) => x.repo).join(','))
  ok('and each carries why it is watched', r[0].why === 'the close one', r[0].why)
}

console.log(failures ? `\n${failures} failed` : '\nall good')
process.exit(failures ? 1 : 0)
