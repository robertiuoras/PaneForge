// The sentence at the top of a feature, and the wiring that puts it there.
//
// A blurb rots in a way nothing else in this app does: it is prose about behaviour, in a
// file the behaviour does not import. Rename a dialog, drop a feature, add a new one, and
// the note keeps rendering - correct-looking, unowned, and wrong. Worse, the FIRST thing
// somebody reads about a feature is the thing least likely to be re-read by whoever
// changes it.
//
// So the test is mostly a contract between two directories rather than a check on the
// strings: every blurb is rendered by exactly one component, every `<Blurb id>` in the
// renderer names a blurb that exists, and nothing drifts into a paragraph.
//
//   node scripts/blurb-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-blurb-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const out = join(work, 'blurbs.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/blurbs.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: out
})
const { BLURBS, blurbFor, blurbShown } = createRequire(import.meta.url)(out)

let checks = 0
const is = (actual, expected, what) => {
  assert.equal(actual, expected, what)
  checks++
}
const ok = (cond, what) => {
  assert.ok(cond, what)
  checks++
}

// ---------------------------------------------------------------------------
// The strings themselves

ok(BLURBS.length >= 8, `every feature that opens has a note (${BLURBS.length})`)

const ids = new Set()
for (const b of BLURBS) {
  const at = `blurb "${b.id}"`
  ok(/^[a-z][A-Za-z0-9]*$/.test(b.id), `${at}: id is a plain token - it is what a dismissal is saved under`)
  ok(!ids.has(b.id), `${at}: id is unique`)
  ids.add(b.id)
  ok(b.title, `${at}: names the feature it belongs to`)

  // Long enough to say something, short enough that it is read rather than skipped. The
  // upper bound is the load-bearing half: the failure mode of a note like this is that
  // somebody adds "and also" to it once a year until nobody reads any of them.
  ok(b.text.length >= 90, `${at}: says something (${b.text.length} chars)`)
  ok(b.text.length <= 340, `${at}: is a note, not documentation (${b.text.length} chars)`)
  const sentences = b.text.split(/\.\s+/).filter(Boolean)
  ok(sentences.length <= 3, `${at}: is at most three sentences (${sentences.length})`)
  ok(/^[A-Z]/.test(b.text), `${at}: starts like a sentence`)
  ok(b.text.trim().endsWith('.'), `${at}: ends like one`)

  // It is rendered as text, not as markup: an entity or a tag would appear on screen
  // literally, and the component deliberately has no dangerouslySetInnerHTML.
  ok(!/<[a-z/]/i.test(b.text), `${at}: contains no HTML - the component renders it as text`)
  ok(!/&[a-z]+;/i.test(b.text), `${at}: contains no HTML entities, for the same reason`)

  // The rule that stops a note being a restatement of its own title. "Board: the board
  // lets you manage your board" passes every check above and tells nobody anything.
  const first = b.text.split(/[.,]/)[0].toLowerCase()
  ok(!first.includes(b.title.toLowerCase()), `${at}: opens by saying what it IS, not by repeating its name`)
}

// ---------------------------------------------------------------------------
// Dismissal

ok(blurbShown('board', []), 'a note nobody has closed is shown')
ok(blurbShown('board', ['history']), 'closing one leaves the others alone')
ok(!blurbShown('board', ['board']), 'and closing it closes it')
ok(blurbShown('board', undefined), 'a config written before this feature existed shows them all')
ok(!blurbShown('nope', []), 'an unknown id draws nothing rather than throwing')
is(blurbFor('nope'), null, 'and looks up to nothing')
is(blurbFor('devices').title, 'Devices', 'a real one looks up to itself')

// ---------------------------------------------------------------------------
// The contract with the renderer
//
// This is the half that catches a rename. Everything above would still pass with the
// component deleted.

const dir = join(root, 'src/renderer/src/components')
const rendered = new Map()
for (const file of readdirSync(dir).filter((f) => f.endsWith('.tsx'))) {
  const src = readFileSync(join(dir, file), 'utf8')
  for (const m of src.matchAll(/<Blurb\s+id="([^"]+)"/g)) {
    ok(!rendered.has(m[1]), `blurb "${m[1]}" is rendered in one place (${file}, also ${rendered.get(m[1])})`)
    rendered.set(m[1], file)
  }
}

for (const [id, file] of rendered)
  ok(blurbFor(id), `${file} renders <Blurb id="${id}">, which must name a real blurb`)

for (const b of BLURBS) ok(rendered.has(b.id), `blurb "${b.id}" is actually rendered somewhere`)

// The component that draws them, and the one thing it may never do.
const comp = readFileSync(join(dir, 'Blurb.tsx'), 'utf8')
ok(!comp.includes('dangerouslySetInnerHTML'), 'Blurb renders text, never markup')
ok(comp.includes('blurbShown'), 'Blurb asks the shared rule whether to draw, rather than keeping its own')

// Settings has to be able to undo every dismissal, or a closed note is closed forever and
// the × becomes a trap.
const settings = readFileSync(join(dir, 'SettingsDialog.tsx'), 'utf8')
ok(settings.includes('hiddenBlurbs: []'), 'Settings can bring every note back')

rmSync(work, { recursive: true, force: true })
console.log(`blurbs: ${checks} checks passed (${BLURBS.length} notes, ${rendered.size} rendered)`)
