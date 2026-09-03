// The words a person who has never used git reads about their own copies.
//
// The report this exists for: seven rows headed "Lanes elsewhere", and a chip on a card
// reading "copy f". Neither sentence is wrong and neither can be read by the person the
// app is for. "Lane" is scripts/lane.mjs's word for a slot in a pool; "f" is that slot's
// letter; "checkout" is git's word for a folder. All three leaked onto the screen.
//
// Three things are pinned here, because each of them regressed from a rename somewhere
// else in the codebase:
//
//   1. a copy is numbered, never lettered - the project's own folder is 1, so lane `a` is
//      "copy 2" and legacy `w2` is "copy 2" as well (that scheme already counted this way);
//   2. a row names the CHAT that was working in it, when that chat left a name behind, and
//      says nothing at all when it did not - an invented name is worse than a bare folder;
//   3. the strip's own headings and states carry no jargon: no "lane", no "checkout", no
//      bare "free" or "stuck".
//
//   node scripts/lane-plain-test.mjs

import { buildSync } from 'esbuild'
import { mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const root = join(realpathSync(tmpdir()), 'paneforge-lane-plain-test')
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })

let failed = 0
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`)
  if (!cond) {
    failed++
    if (detail) console.log(`      ${detail}`)
  }
}
const is = (a, b, name) => ok(name, a === b, `got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`)

/**
 * Bundle one source file and import it.
 *
 * laneWords.ts is deliberately importable on its own - it pulls in a type and place.ts and
 * nothing else, so the sentences can be read without React or an Electron window (the same
 * reason lane-holder-test can load it).
 */
async function load(entry, name) {
  const out = join(root, `${name}.mjs`)
  buildSync({
    absWorkingDir: repoRoot,
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'node'
  })
  return import(pathToFileURL(out).href)
}

const place = await load('src/shared/place.ts', 'place')
const words = await load('src/renderer/src/laneWords.ts', 'words')

// ------------------------------------------------------------------ a copy has a number

is(place.copyNumber('a'), 2, 'the first extra copy is copy 2 - the project itself is 1')
is(place.copyNumber('b'), 3, 'and the second extra one is 3')
is(place.copyNumber('f'), 7, 'f was the letter on screen that started this')
is(place.copyNumber('w2'), 2, 'the legacy scheme already counted this way')
is(place.copyNumber('w3'), 3, '')
is(place.copyNumber('main'), null, 'the project itself is not an extra copy')
is(place.copyNumber('release-2'), null, 'a slot that is neither shape gets no invented number')

const W = 'C:\\Users\\Gamer\\Desktop\\Projects'
is(
  place.describePlace({ cwd: `${W}\\PaneForge-f`, branch: 'lane-f', lane: 'f' }).role,
  'copy 7',
  'the card chip says copy 7, never "copy f"'
)
is(
  place.describePlace({ cwd: `${W}\\PaneForge`, branch: 'master', lane: 'main' }).role,
  'main copy',
  'and the project\'s own folder is the main copy, not a "checkout"'
)
ok(
  !place.describePlace({ cwd: `${W}\\PaneForge-a`, branch: 'lane-a', lane: 'a' }).full.includes('checkout'),
  'the tooltip drops the word too - it is one paragraph the same person reads'
)

// ------------------------------------------------- a row says which job was in that copy

const lane = (extra = {}) => ({
  lane: 'f',
  dir: `${W}\\PaneForge-f`,
  branch: 'lane-f',
  from: `${W}\\PaneForge`,
  session: 'abc12345-0000',
  ownerPane: null,
  held: true,
  seen: Date.now(),
  ready: false,
  conflicted: false,
  adoptable: false,
  resolver: null,
  device: null,
  peer: false,
  ...extra
})

// The JOB leads the row. `taskdriver copy 4 "idea #675 ..."` put the one thing the reader
// was looking for last, behind a number that means nothing to them (2026-09-03).
is(words.laneHeadline(lane({ chatTitle: 'Set Up Meta Ads' })), 'Set Up Meta Ads', 'the row is headed by the name the chat was given')
is(
  words.laneUnder(lane({ chatTitle: 'Set Up Meta Ads' }), 'busy now'),
  `${words.laneLabel(lane())} - busy now`,
  'and the copy comes down to the state line, so the row still says which folder'
)
is(words.laneHeadline(lane()), words.laneLabel(lane()), 'a chat that left no name keeps the folder up top - never a guess')
is(words.laneUnder(lane(), 'busy now'), 'busy now', 'and its state line does not repeat the folder')

const tip = words.heldByTip(lane({ chatTitle: 'Set Up Meta Ads', chatAbout: 'write the ad copy' }))
ok(tip.includes('Set Up Meta Ads'), 'the tooltip spells the name out')
ok(tip.includes('write the ad copy'), 'along with what that chat was asked to do')
ok(
  !words.heldByTip(lane()).includes('undefined'),
  'a chat with no name leaves no hole in the tooltip'
)

// --------------------------------------------------------------- no jargon on the screen

is(
  words.laneState(lane({ held: false })),
  'nobody is using it',
  'a free copy says so in words, not in the word "free"'
)

// The row's own title. `clients-a` was the folder name, which is honest and is still a
// slot letter with a hyphen in front of it - and the card two inches away was already
// saying `copy 2` for the same folder.
is(
  words.laneLabel(lane({ dir: `${W}\\clients-a`, lane: 'a', branch: 'lane-a' })),
  'clients copy 2',
  'a row is headed by the project and the copy NUMBER'
)
is(
  words.laneLabel(lane({ dir: `${W}\\clients-w2`, lane: 'w2', branch: 'pf/w2' })),
  'clients copy 2',
  'and a legacy copy counts identically - it always did'
)

// The same letter came back through the sub-line, which names the holder by its FOLDER.
is(
  words.holderName(lane({ dir: `${W}\\clients-a`, lane: 'a', from: `${W}\\clients-b` })),
  'the chat in copy 3',
  'the holder is named by its copy number, never `clients-b`'
)
is(
  words.holderName(lane({ dir: `${W}\\clients-a`, lane: 'a', from: `${W}\\taskdriver` })),
  "taskdriver's chat",
  'a holder in a DIFFERENT project still names that project - the suffix comes off on evidence'
)
is(
  words.holderName(lane({ dir: `${W}\\notes-a`, lane: 'a', from: `${W}\\service-a` })),
  "service-a's chat",
  'and a project whose name simply ends in -a is not renamed out of existence'
)

is(
  words.holderName(lane({ dir: `${W}\\clients-a`, lane: 'a', from: `${W}\\clients-a` })),
  'a chat in this copy',
  'a copy held by the chat that started in it does not repeat its own number'
)
// `its own chat` was the phrase until 2026-09-01 and Robert could not read it: "its"
// points back at the row's heading, which only resolves for somebody who already knows
// the row is about a copy.
ok(
  !/its own chat/.test(
    words.holderName(lane({ dir: `${W}\\clients-a`, lane: 'a', from: `${W}\\clients-a` }))
  ),
  'and it does not ask the reader to resolve a pronoun onto a heading'
)

// The release gate's list, which was 695px of text in a 231px line (measured in the window
// 2026-09-01): every letter of the second copy was ellipsed off the end.
is(
  words.holdWords({ reason: 'waiting on chats still working: a (3 unmerged commits, last touched 13m ago), b (6 unmerged commits, last touched 13m ago)', at: Date.now() }),
  'waiting for copy 2 and copy 3',
  'the row says WHICH copies; the counts and clocks stay in the tooltip'
)
is(
  words.holdWords({ reason: 'waiting on chats still working: main (uncommitted edits, 4m ago)', at: Date.now() }),
  'waiting for the main copy',
  'the project\'s own folder is named as itself, never "copy 1"'
)

const strip = readFileSync(join(repoRoot, 'src', 'renderer', 'src', 'components', 'LaneStrip.tsx'), 'utf8')
// Only what is DRAWN: the comments in that file explain the lane system and have to say
// "lane" to do it. Text between tags, and the strings inside title={...}, are the screen.
const drawn = [
  ...strip.matchAll(/^\s*(?!\/\/|\*|\/\*)([A-Z][^<>{}\n]{3,})$/gm)
].map((m) => m[1].trim())
ok(drawn.length > 0, 'found the drawn headings to check', String(drawn.length))
ok(
  !drawn.some((t) => /\blanes?\b/i.test(t)),
  'no heading on screen calls a copy a "lane"',
  drawn.filter((t) => /\blanes?\b/i.test(t)).join(' | ')
)
ok(
  strip.includes('Other<span className="wide-word"> copies</span>'),
  'the section is headed "Other copies", and still gives the middle word up first when narrow'
)
// The desk tag is 92px of every row and says this machine's own name on a one-machine
// desk. Only the OTHER machine's rows keep it.
ok(
  /lane\.device && \(!here \|\| lane\.device !== here\)/.test(strip),
  'the desk tag is drawn only when the desk is not this one'
)
ok(
  /copyNumber\(lane\.lane\)/.test(strip),
  'the tag beside a row is the copy NUMBER, never the slot letter'
)
ok(
  !/>\s*\{stuck\} stuck/.test(strip),
  '"stuck" is a state, not a label a person can act on - the badge says who it needs'
)

console.log(failed ? `\n${failed} plain-words check(s) failed` : '\nall plain-words checks passed')
process.exit(failed ? 1 : 0)
