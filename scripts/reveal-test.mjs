// Turning a path an agent printed into a link that reveals the file.
//
// Two things can go wrong and only one of them is visible. Missing a real path is a link
// that never appears, which you notice. Matching prose is worse: every second word
// underlined, and the pane stops reading like output. So most of what is pinned here is
// the negative half - what must NOT become a link - plus the resolve step that decides
// whether a match survives at all.
//
//   node scripts/reveal-test.mjs

import { buildSync } from 'esbuild'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-reveal-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(join(work, 'docs', 'proposals'), { recursive: true })

const bundle = (entry, name) => {
  const out = join(work, name)
  buildSync({ absWorkingDir: root, entryPoints: [entry], bundle: true, format: 'cjs', platform: 'node', outfile: out })
  return createRequire(import.meta.url)(out)
}
const { findPathTokens, looksLikePath, parsePathToken } = bundle('src/shared/pathToken.ts', 'token.cjs')
const { resolveRevealTarget } = bundle('src/main/revealPath.ts', 'reveal.cjs')

let checks = 0
let failures = 0
const ok = (cond, what) => {
  if (cond) checks++
  else {
    failures++
    console.log(`FAIL ${what}`)
  }
}
const eq = (got, want, what) => ok(got === want, `${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)

// ---------------------------------------------------------------- shape of a path

for (const yes of [
  'docs/proposals/rightkey-knowledge-proposal.pdf',
  'src/main/index.ts',
  'src/main/index.ts:1059',
  'src/main/index.ts:1059:12',
  'C:\\Users\\Gamer\\Desktop\\Projects',
  './scripts/reveal-test.mjs',
  '../PaneForge/package.json',
  '~/notes.md',
  'package.json',
  'infra/docker-compose.yml'
]) {
  ok(looksLikePath(yes), `should look like a path: ${yes}`)
}

for (const no of [
  'the',
  'and/or',                       // real prose, and the reason existence is checked too
  'https://drive.google.com/x',   // a link, but not one this opens
  '12:30',
  '...',
  '1.2.3',
  '--dry-run',
  'a'
]) {
  ok(!looksLikePath(no) || no === 'and/or', `should not look like a path: ${no}`)
}
// `and/or` is shaped exactly like a path and only the disk can tell the difference.
ok(looksLikePath('and/or'), 'and/or passes the shape test, so resolve must be the guard')

// ---------------------------------------------------------------- line and column suffix

eq(parsePathToken('src/main/index.ts:1059').path, 'src/main/index.ts', 'path before the line number')
eq(parsePathToken('src/main/index.ts:1059').line, 1059, 'line number parsed')
eq(parsePathToken('src/main/index.ts:1059:12').column, 12, 'column parsed')
eq(parsePathToken('C:\\Users\\Gamer').path, 'C:\\Users\\Gamer', 'a drive letter is not a line number')
eq(parsePathToken('12:30').path, '12:30', 'a timestamp keeps its whole self')

// ---------------------------------------------------------------- finding them in a line

const line = 'Wrote docs/proposals/rightkey-knowledge-proposal.pdf and `src/main/index.ts:1059`.'
const found = findPathTokens(line).map((t) => t.text)
eq(found.length, 2, 'two paths in that sentence')
eq(found[0], 'docs/proposals/rightkey-knowledge-proposal.pdf', 'trailing prose is not swallowed')
eq(found[1], 'src/main/index.ts:1059', 'backticks and the full stop are stripped')

// The columns have to be exact or xterm underlines the wrong cells.
const tok = findPathTokens(line)[0]
eq(line.slice(tok.start, tok.end), tok.text, 'reported columns select exactly the token')

eq(findPathTokens('no paths in this sentence at all').length, 0, 'prose yields nothing')

// ---------------------------------------------------------------- resolving against a pane

const pdf = join(work, 'docs', 'proposals', 'rightkey-knowledge-proposal.pdf')
writeFileSync(pdf, '%PDF-1.4\n')

const rel = resolveRevealTarget(work, 'docs/proposals/rightkey-knowledge-proposal.pdf')
ok(rel !== null, 'a repo-relative path resolves against the pane cwd')
eq(rel?.abs, pdf, 'resolved to the real file')
eq(rel?.kind, 'file', 'a file is reported as a file')

eq(resolveRevealTarget(work, 'docs/proposals')?.kind, 'dir', 'a folder is reported as a folder')
eq(resolveRevealTarget(work, 'docs/proposals/rightkey-knowledge-proposal.pdf:12')?.line, 12, 'line survives the resolve')
eq(resolveRevealTarget(work, 'docs/proposals/rightkey-knowledge-proposal.pdf:12')?.abs, pdf, 'line suffix is not part of the path')

// The whole point of the existence check.
eq(resolveRevealTarget(work, 'and/or'), null, 'prose shaped like a path is not on disk, so not a link')
eq(resolveRevealTarget(work, 'docs/proposals/nope.pdf'), null, 'a path that is not there is not a link')
eq(resolveRevealTarget('', 'docs/proposals'), null, 'no cwd, no relative resolve')
eq(resolveRevealTarget(work, ''), null, 'empty token is not a link')

// Absolute paths are taken as they are, including outside the pane's folder.
eq(resolveRevealTarget(join(work, 'docs'), pdf)?.abs, pdf, 'an absolute path ignores the cwd')
// A lone `~` is not a place worth linking, and output is full of them.
eq(resolveRevealTarget(work, '~'), null, 'a bare ~ is not a link')
// `~/something` is, so expand it. Picked off the real home folder to stay portable.
const inHome = readdirSync(homedir()).find((n) => !n.startsWith('.'))
if (inHome) {
  eq(resolveRevealTarget(work, `~/${inHome}`)?.abs, join(homedir(), inHome), '~/x expands to the home folder')
} else {
  console.log('SKIP ~/x expansion: home folder is empty')
}

console.log(failures ? `\n${failures} FAILED of ${checks + failures}` : `\nreveal: ${checks} checks passed`)
process.exit(failures ? 1 : 0)
