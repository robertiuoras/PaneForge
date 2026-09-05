// A screenshot dropped on a pane shows as a PICTURE, not only as a path.
//
// A drop types a quoted path and nothing else. On a pane whose pty is on THIS machine
// that path at least names a file the person can open; on a MIRRORED pane the path is
// true only on the other desk, so the whole visible result of dragging a screenshot onto
// the pane is a sentence of somebody else's disk at a prompt - the same shape as the bug
// the attach code was written to fix, read back at the person who dropped it.
//
// The bytes are in hand one step BEFORE they are sent, so the picture is made there:
// `withShots` in main/attach.ts hangs `AttachResult.shots` on the answer, including the
// answer that came back over the link, and the renderer hangs a strip off `typePaths`.
// That is what this pins - the arithmetic in `keepShots`, and the four call sites that
// would silently stop carrying the shots if one of them were edited back.
//
//   node scripts/shots-test.mjs

import { strict as assert } from 'node:assert'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-shots-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const outfile = join(work, 'shots.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/attach.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile
})
const { keepShots, THUMB_KEEP, THUMB_WIDTH, THUMB_SHOW_MS } = createRequire(import.meta.url)(outfile)

let checks = 0
const check = (what, ok, detail) => {
  checks++
  assert.ok(ok, `${what}${detail === undefined ? '' : ` — ${detail}`}`)
}

const shot = (url, name = 'clipboard.png') => ({ name, url, at: 1 })

// --- keepShots: newest first, capped, nothing drawn twice ---------------------------

check('an empty strip takes what arrived', keepShots([], [shot('a')]).length === 1)
check('nothing added leaves the strip alone', keepShots([shot('a')], []).length === 1)
check(
  'the newest drop is drawn first',
  keepShots([shot('a')], [shot('b')]).map((s) => s.url).join('') === 'ba'
)
check(
  'a batch keeps the order it arrived in',
  keepShots([], [shot('a'), shot('b')]).map((s) => s.url).join('') === 'ab'
)
const five = keepShots([shot('a'), shot('b'), shot('c'), shot('d')], [shot('e')])
check('the strip is capped', five.length === THUMB_KEEP, `${five.length}`)
check('and it is the OLDEST that falls off', !five.some((s) => s.url === 'd'))

// Two screenshots pasted a second apart are both called `clipboard.png`, so the name
// cannot be the identity - only the bytes tell them apart.
check(
  'two attachments with one name are two pictures',
  keepShots([], [shot('a', 'clipboard.png'), shot('b', 'clipboard.png')]).length === 2
)
check('the same picture is never drawn twice', keepShots([shot('a')], [shot('a')]).length === 1)
check(
  're-dropping a picture moves it to the front',
  keepShots([shot('a'), shot('b')], [shot('b')]).map((s) => s.url).join('') === 'ba'
)
check('a shot with no url is litter, not a broken box', keepShots([], [shot('')]).length === 0)

check('a thumbnail is small enough for a data url', THUMB_WIDTH > 0 && THUMB_WIDTH <= 400)
check('the strip goes on its own, in seconds not minutes', THUMB_SHOW_MS >= 4000 && THUMB_SHOW_MS <= 30000)

// --- main: the pictures are made HERE, on both branches -----------------------------

const mainAttach = readFileSync(join(root, 'src/main/attach.ts'), 'utf8')
check('the thumbnail is made from the bytes, not from the path', /nativeImage\.createFromBuffer/.test(mainAttach))
check('it is resized before it becomes a data url', /resize\(\{ width: THUMB_WIDTH \}\)/.test(mainAttach))
check(
  'a file that is not a picture is left out rather than drawn broken',
  /if \(img\.isEmpty\(\)\) continue/.test(mainAttach)
)
check(
  'a decoder that gives up never takes the attachment down with it',
  /try \{[\s\S]*?nativeImage[\s\S]*?\} catch \{/.test(mainAttach)
)
check(
  'a refused attachment gets no strip',
  /if \(res\.error \|\| !res\.paths\.length\) return res/.test(mainAttach)
)

const index = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
for (const handler of ['pty:attach', 'pty:attachPaths', 'pty:attachClipboard']) {
  const from = index.indexOf(`ipcMain.handle('${handler}'`)
  check(`${handler} is still registered`, from > 0)
  const body = index.slice(from, index.indexOf('\n})', from))
  const remote = body.split('\n').filter((l) => l.includes('remote.attachOn'))
  check(`${handler} still answers a mirrored pane`, remote.length === 1, body.slice(0, 200))
  check(
    `${handler} makes the picture on THIS desk, mirrored pane included`,
    remote.every((l) => l.includes('withShots(')),
    remote.join(' ')
  )
  check(
    `${handler} makes it for a local pane too`,
    /withShots\([\s\S]*writeAttachments/.test(body),
    body.slice(0, 200)
  )
}

// --- renderer: every path that types a path also shows what it typed ------------------

const pane = readFileSync(join(root, 'src/renderer/src/components/TerminalPane.tsx'), 'utf8')
check('typePaths takes the pictures', /const typePaths = \(paths: string\[\], shots\?: Shot\[\]\)/.test(pane))
const carried = pane.match(/typePaths\(res\.paths[^)]*\)/g) ?? []
check('every answer from main is typed', carried.length === 4, carried.join(' | '))
check(
  'and every one of them carries its pictures',
  carried.every((c) => c.includes('res.shots')),
  carried.join(' | ')
)
check('the strip is drawn', /className="shot-strip"/.test(pane))
check('a picture can be put away by hand', /className="shot-close"/.test(pane))
check(
  'and it goes on its own after THUMB_SHOW_MS',
  /setTimeout\(\(\) => setShots\(\[\]\), THUMB_SHOW_MS\)/.test(pane)
)
check(
  'a mousedown on it does not steal the terminal focus',
  /className="shot-strip" onMouseDown=\{\(e\) => e\.preventDefault\(\)\}/.test(pane)
)

// The placement is load-bearing, not taste: bottom-LEFT is Codex's own `>` marker and
// where a restored pane draws `.pane-booting.over`, which is why the mic was moved off it.
const css = readFileSync(join(root, 'src/renderer/src/styles.css'), 'utf8')
const strip = css.slice(css.indexOf('.shot-strip {'), css.indexOf('}', css.indexOf('.shot-strip {')))
check('the strip is in the pane, not the window', /position: absolute/.test(strip), strip)
check('bottom-RIGHT, off the CLI marker at bottom-left', /right: \d+px/.test(strip) && /bottom: \d+px/.test(strip))
check('it never reaches the left edge', !/left: \d/.test(strip), strip)
check('a wide drop cannot push the pane sideways', /max-width: calc\(100% - \d+px\)/.test(strip))
check('no animation on a card that lives twelve seconds', !/animation|transition/.test(strip))

console.log(`shots: ${checks} checks passed`)
