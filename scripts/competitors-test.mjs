// What the competitor watch says moved, and - more importantly - what it stays quiet about.
//
// The failure mode of a watch script is not missing a release. It is reporting so much that
// nobody reads it, at which point it is worth less than nothing: it looks like coverage and
// provides none. So the assertions are half about noise.
//
// No network. `changesFor`/`report` are pure and the fixtures are two snapshots.
//
//   node scripts/competitors-test.mjs

import { changesFor, isChallenge, report } from './competitors.mjs'

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

// ---------------------------------------------------------------- a competitor with no repo

// BridgeSpace is the same product as this one and is closed source: no README, no stars,
// nothing to count. The page's own text is the feature list, so it has to be able to say
// the same thing the README line says - and to stay just as quiet the rest of the time.

const page = {
  kind: 'site',
  title: 'BridgeSpace: Agentic Development Environment',
  chars: 8200,
  pageSha: 'aaaaaaaaaaaaaaaa'
}

{
  const lines = changesFor(page, { ...page })
  ok('an unchanged page says nothing at all', lines.length === 0, lines.join(' / '))
}

{
  // The whole point of hashing the TEXT and not the markup: a redeploy that ships a new
  // build id must not report. Only the copy is in the hash, so an identical page is silent
  // however different the HTML behind it was.
  const lines = changesFor(page, { ...page, chars: 8201 })
  ok('a page whose hash held is silent even if its length wobbled', lines.length === 0, lines.join(' / '))
}

{
  const lines = changesFor(page, { ...page, pageSha: 'bbbbbbbbbbbbbbbb' })
  ok('a changed page is the README line for a closed product', has(lines, /page changed/), lines.join(' / '))
}

{
  const lines = changesFor(page, { ...page, title: 'BridgeSpace: 32 agents' })
  ok('a renamed page is quoted', has(lines, /calls itself "BridgeSpace: 32 agents"/), lines.join(' / '))
}

{
  const lines = changesFor(undefined, page)
  ok('a new site is announced once, with no stars in it', lines.length === 1 && has(lines, /added to the watchlist as "BridgeSpace/) && !has(lines, /star/), lines.join(' / '))
}

{
  const lines = changesFor(page, { kind: 'site', error: 'HTTP 404' })
  ok('an unreachable page says so', has(lines, /could not be read: HTTP 404/), lines.join(' / '))
  const back = changesFor({ kind: 'site', error: 'HTTP 404' }, page)
  ok('and coming back does not dump every field', back.length === 1 && has(back, /reachable again/) && !has(back, /star/), back.join(' / '))
}

{
  // Measured 2026-08-21: bridgemind.ai served a node fetch its Cloudflare interstitial on
  // four runs out of five. Treating that as "could not be read" would print an error and a
  // recovery on alternate runs for ever, and would drop the last good hash with it.
  ok('a Cloudflare interstitial is recognised', isChallenge(403, '<title>Just a moment...</title>'))
  ok('a real 403 is not mistaken for one', !isChallenge(403, '<h1>Forbidden</h1>'))
  ok('a healthy page is never a challenge', !isChallenge(200, 'Just a moment, please - our docs load fast'))
  const lines = changesFor(page, { kind: 'site', blocked: true })
  ok('a blocked read reports nothing at all', lines.length === 0, lines.join(' / '))

  // The trap the blocked case sets for itself: if a challenged run wrote a row, that row
  // would read as "seen before" and the first real reading would compare its hash against
  // nothing and say nothing. A site blocked on every run so far is still a NEW site.
  const first = changesFor(undefined, page)
  ok('a site first read after being blocked is still announced', first.length === 1 && has(first, /added to the watchlist/), first.join(' / '))
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
