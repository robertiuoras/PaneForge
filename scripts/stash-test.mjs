// What the Stash is allowed to cost, pinned. Model-free, window-free, seconds to run.
//
// The Stash runs forever in the background and touches three expensive things on every
// single copy made anywhere on the machine: it stringifies and writes its history, and it
// ships the whole list to two renderer windows. None of that is visible while it is
// working, which is why the numbers below are written down rather than trusted:
//
//   a full 200-entry history was 414KB, of which 383KB was `text` that NOTHING on screen
//   shows (the rows draw `preview`, the first 140 characters) and a further ~207KB was
//   the same clip stored a second time inside `key`.
//
// So the invariants here are "the body never leaves the main process" and "the key is not
// the body". Both are invisible when broken - the feature keeps working perfectly and just
// gets slow - which is the only reason a test can find them and a person cannot.
//
// Run: npm run test:stash

import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require_ = createRequire(import.meta.url)
const work = mkdtempSync(join(tmpdir(), 'pf-stash-'))

let failed = 0
function ok(what, cond, detail = '') {
  if (cond) console.log(`  ok  ${what}`)
  else {
    failed++
    console.log(`FAIL  ${what}${detail ? ` - ${detail}` : ''}`)
  }
}
function eq(what, got, want) {
  ok(what, got === want, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`)
}

/**
 * recents.ts reaches Electron for three things, all of them inside functions: where
 * userData lives, the clipboard, and PNG encoding. A stub is enough, and it means this
 * whole file runs under plain node.
 */
function loadRecents(userData) {
  const stub = join(work, `electron-${Math.random().toString(36).slice(2)}.cjs`)
  writeFileSync(
    stub,
    `module.exports = {
       app: { getPath: () => ${JSON.stringify(userData)} },
       clipboard: { readText: () => '', readImage: () => ({ isEmpty: () => true }),
                    writeText: () => {}, writeImage: () => {}, availableFormats: () => [] },
       nativeImage: { createFromPath: () => ({}) }
     }`
  )
  const out = join(work, `recents-${Math.random().toString(36).slice(2)}.cjs`)
  buildSync({
    entryPoints: [join(root, 'src/main/recents.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    alias: { electron: stub },
    outfile: out
  })
  delete require_.cache?.[out]
  return require_(out)
}

/** A fresh userData folder, optionally seeded with a history written by an older build. */
function profile(history) {
  const dir = mkdtempSync(join(work, 'profile-'))
  if (history) {
    mkdirSync(join(dir, 'recents'), { recursive: true })
    writeFileSync(join(dir, 'recents', 'history.json'), JSON.stringify(history))
  }
  return dir
}

const historyOf = (dir) => join(dir, 'recents', 'history.json')
const readHistory = (dir) => JSON.parse(readFileSync(historyOf(dir), 'utf8'))
const settle = () => new Promise((r) => setTimeout(r, 1400))

console.log('\n== the clip body never leaves the main process')
{
  const dir = profile()
  const R = loadRecents(dir)
  // The real watcher reads the OS clipboard; the stub's is empty on purpose, so entries
  // are put on by the same door a dropped file uses and by driving the exported API.
  const long = 'x'.repeat(9000)
  const seen = []
  R.startRecents((items) => seen.push(items))
  // A file the watcher will accept: any real file on disk.
  const src = join(work, 'dropme.txt')
  writeFileSync(src, 'hello')
  eq('a dropped file is taken', R.addRecentFiles([src]), 1)

  // Text goes on through the same push the clipboard uses, reached via the module's own
  // history: write one by hand, reload, and check what comes back out.
  R.stopRecents()
  const withText = [
    { id: 't1', key: 't:abc:5', kind: 'text', at: 2, text: long, preview: long.slice(0, 140), chars: long.length },
    { id: 't2', key: 't:def:3', kind: 'text', at: 1, text: 'hello there', preview: 'hello there', chars: 11 }
  ]
  const dir2 = profile(withText)
  const R2 = loadRecents(dir2)
  const list = R2.listRecents()
  eq('both entries are listed', list.length, 2)
  ok(
    'no listed entry carries its body',
    list.every((i) => i.text === undefined),
    JSON.stringify(list.map((i) => (i.text ?? '').length))
  )
  ok(
    'the preview survives, because that is what the row draws',
    list[0].preview.length === 140 && list[1].preview === 'hello there'
  )
  // ...and the body is still there for the one click that needs it.
  eq('recentText returns the body byte-exact', R2.recentText(list[0].id), long)
  eq('recentText on an unknown id is empty, never undefined', R2.recentText('nope'), '')

  // The whole point, as a number.
  const fat = JSON.stringify(withText).length
  const shipped = JSON.stringify(list).length
  ok(
    `the payload is a fraction of the history (${fat}B stored, ${shipped}B shipped)`,
    shipped * 4 < fat,
    `${shipped} is not under a quarter of ${fat}`
  )
  ok('and the file on disk still has the bodies', readHistory(dir2).some((i) => i.text === long))
}

console.log('\n== the key is not the clip')
{
  const clip = 'a fairly long line of copied text that would double the file if stored twice'
  const dir = profile([
    { id: 't1', key: `t:${clip}`, kind: 'text', at: 1, text: clip, preview: clip, chars: clip.length }
  ])
  const R = loadRecents(dir)
  R.listRecents()
  await settle()
  const stored = readHistory(dir)
  eq('the entry survives the migration', stored.length, 1)
  ok('its key no longer contains the clip', !stored[0].key.includes(clip), stored[0].key)
  ok('its key is short', stored[0].key.length < 32, stored[0].key)
  eq('its body is untouched', stored[0].text, clip)
  ok('the file shrank', JSON.stringify(stored).length < clip.length * 2 + 200)
}

console.log('\n== the same thing copied twice is one row')
{
  // A terminal hands you a trailing newline, a browser does not. The clip is the same
  // clip, and two rows that read identically is how this list fills up with nothing.
  const dir = profile([
    { id: 't1', key: 't:one', kind: 'text', at: 3, text: 'npm run build\n', preview: 'npm run build', chars: 14 },
    { id: 't2', key: 't:two', kind: 'text', at: 2, text: 'npm run build', preview: 'npm run build', chars: 13 },
    { id: 't3', key: 't:three', kind: 'text', at: 1, text: '  npm run build  ', preview: 'npm run build', chars: 17 }
  ])
  const R = loadRecents(dir)
  const list = R.listRecents()
  eq('three spellings of one clip become one row', list.length, 1)
  eq('and it is the newest one that is kept', R.recentText(list[0].id), 'npm run build\n')

  // Genuinely different text is genuinely different.
  const dir2 = profile([
    { id: 't1', key: 't:a', kind: 'text', at: 2, text: 'npm run build', preview: 'npm run build', chars: 13 },
    { id: 't2', key: 't:b', kind: 'text', at: 1, text: 'npm run built', preview: 'npm run built', chars: 13 }
  ])
  eq('one character apart is two rows', loadRecents(dir2).listRecents().length, 2)
}

console.log('\n== an old history is migrated without losing anything')
{
  const old = [
    { id: 'p', key: 't:pinned', kind: 'text', at: 1, text: 'pinned clip', preview: 'pinned clip', chars: 11, pinned: true },
    { id: 'a', key: 't:newer', kind: 'text', at: 30, text: 'newer clip', preview: 'newer clip', chars: 10 },
    { id: 'b', key: 't:older', kind: 'text', at: 20, text: 'older clip', preview: 'older clip', chars: 10 }
  ]
  const dir = profile(old)
  const R = loadRecents(dir)
  const list = R.listRecents()
  eq('nothing was dropped', list.length, 3)
  ok('the pin still sorts first', !!list[0].pinned)
  eq('then newest first', R.recentText(list[1].id), 'newer clip')
  eq('then the older one', R.recentText(list[2].id), 'older clip')
}

console.log('\n== the history is never left half-written')
{
  const dir = profile([
    { id: 't1', key: 't:x', kind: 'text', at: 1, text: 'something', preview: 'something', chars: 9 }
  ])
  const R = loadRecents(dir)
  R.listRecents()
  const src = join(work, 'another.txt')
  writeFileSync(src, 'x')
  R.addRecentFiles([src])
  await settle()
  ok('history.json parses', Array.isArray(readHistory(dir)))
  ok(
    'the temp file it was written through is gone',
    !existsSync(`${historyOf(dir)}.tmp`),
    'a leftover .tmp means the rename never happened'
  )
  // The sweep deletes every file in the folder that no entry points at. The half-written
  // history is exactly such a file, and deleting it mid-write is a Stash that comes back
  // empty - so it has to be named as a keeper, not merely happen to survive.
  writeFileSync(`${historyOf(dir)}.tmp`, '{"partial":')
  R.addRecentFiles([src])
  ok('and the sweep leaves a save in flight alone', existsSync(`${historyOf(dir)}.tmp`))
}

console.log('\n== a copy made in the last second of the app reaches disk')
{
  const dir = profile()
  const R = loadRecents(dir)
  const src = join(work, 'lastsecond.txt')
  writeFileSync(src, 'x')
  R.addRecentFiles([src])
  // No wait: the debounced save has not fired, which is the whole point.
  ok('nothing is on disk yet', !existsSync(historyOf(dir)))
  R.flushRecents()
  ok('quitting writes it', existsSync(historyOf(dir)))
  eq('and it is the entry that was made', readHistory(dir).length, 1)
  R.flushRecents()
  ok('a second flush with nothing pending is harmless', readHistory(dir).length === 1)
}

rmSync(work, { recursive: true, force: true })
console.log(failed ? `\n${failed} failed\n` : '\nall good\n')
process.exit(failed ? 1 : 0)
