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
function loadRecents(userData, clipFile) {
  const stub = join(work, `electron-${Math.random().toString(36).slice(2)}.cjs`)
  // The clipboard is read out of a file when one is named, so a test can put something on
  // it between ticks. Without that there is no way to drive the watcher at all, and the
  // exclusion rules below live entirely inside it.
  const clip = clipFile
    ? `(() => { try { return JSON.parse(require('fs').readFileSync(${JSON.stringify(clipFile)}, 'utf8')) } catch { return { text: '', formats: [] } } })()`
    : `({ text: '', formats: [] })`
  writeFileSync(
    stub,
    `const clip = () => ${clip}
     module.exports = {
       app: { getPath: () => ${JSON.stringify(userData)} },
       clipboard: { readText: () => clip().text ?? '', readImage: () => ({ isEmpty: () => true }),
                    writeText: () => {}, writeImage: () => {},
                    availableFormats: () => clip().formats ?? [] },
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

console.log('\n== a clip the copying app marked concealed never reaches the disk')
{
  const dir = profile()
  const clipFile = join(work, `clip-${Math.random().toString(36).slice(2)}.json`)
  const put = (text, formats) => writeFileSync(clipFile, JSON.stringify({ text, formats }))
  put('', [])
  const R = loadRecents(dir, clipFile)
  R.startRecents(() => {})

  put('an ordinary line worth keeping', ['public.utf8-plain-text'])
  await settle()
  eq('an ordinary copy is kept', R.listRecents().length, 1)

  // The whole defect, in one step: this is what a password manager puts on the clipboard.
  put('hunter2-the-actual-password', ['public.utf8-plain-text', 'org.nspasteboard.ConcealedType'])
  await settle()
  eq('a concealed copy is not kept', R.listRecents().length, 1)
  ok(
    'and it is nowhere in the history file either',
    !readFileSync(historyOf(dir), 'utf8').includes('hunter2')
  )

  // The clip after it must still land. A refused clip that poisoned the de-duplication
  // would make the NEXT copy vanish too, silently, and that is the shape of bug nobody
  // reports because the feature looks like it is merely being slow.
  put('the very next thing copied', ['public.utf8-plain-text'])
  await settle()
  eq('the copy after a refused one still lands', R.listRecents().length, 2)

  // The user's own rule, off by default, applied to what is copied next.
  R.configureRecents({ deny: 'staging.example.com' })
  put('deploy to STAGING.EXAMPLE.COM now', ['public.utf8-plain-text'])
  await settle()
  eq('a denied clip is not kept', R.listRecents().length, 2)
  put('deploy to production now', ['public.utf8-plain-text'])
  await settle()
  eq('and the rule does not swallow everything else', R.listRecents().length, 3)
  R.stopRecents()
}

console.log('\n== search reads the bodies, and an edit corrects one in place')
{
  const body = 'line one\n' + 'filler '.repeat(60) + '\nBURIED-WORD at the very end'
  const dir = profile([
    { id: 't1', key: 't:a:1', kind: 'text', at: 3, text: body, preview: body.slice(0, 140), chars: body.length },
    { id: 't2', key: 't:b:2', kind: 'text', at: 2, text: 'wrong-branch path', preview: 'wrong-branch path', chars: 17, pinned: true },
    { id: 't3', key: 't:c:3', kind: 'text', at: 1, text: 'unrelated', preview: 'unrelated', chars: 9 }
  ])
  const R = loadRecents(dir)

  ok('the buried word is past the preview', !body.slice(0, 140).includes('BURIED-WORD'))
  eq('and search still finds that entry', R.searchRecents('BURIED-WORD').length, 1)
  eq('two words both have to appear', R.searchRecents('BURIED-WORD unrelated').length, 0)
  eq('order between them does not matter', R.searchRecents('end BURIED-WORD').length, 1)
  eq('an empty query is the whole list', R.searchRecents('').length, 3)
  ok(
    'and a result carries no body either - the same rule as every other list',
    R.searchRecents('BURIED-WORD').every((i) => i.text === undefined)
  )

  // Ids are handed out on load, not taken from the file, so they are read back rather
  // than assumed. (The seeded `t2` does not survive the read - it becomes `tr1`.)
  const idOf = (text) => R.listRecents().find((i) => i.preview.startsWith(text))?.id
  const wrong = idOf('wrong-branch')
  const before = R.listRecents().findIndex((i) => i.id === wrong)
  ok('an edit is accepted', R.editRecent(wrong, 'right-branch path'))
  const after = R.listRecents()
  eq('the row stays where it was', after.findIndex((i) => i.id === wrong), before)
  ok('its pin survives', after.find((i) => i.id === wrong).pinned === true)
  eq('the preview is the corrected text', after.find((i) => i.id === wrong).preview, 'right-branch path')
  eq('and it is what search now finds', R.searchRecents('right-branch').length, 1)
  eq('the text it used to be is gone', R.searchRecents('wrong-branch').length, 0)

  ok('an entry cannot be edited to nothing', !R.editRecent(wrong, '  '))
  ok('and neither can an id that is not there', !R.editRecent('nope', 'x'))

  // Editing one row into another row's text is one clip, not two rows that read the same.
  R.editRecent(idOf('unrelated'), 'right-branch path')
  eq('an edit onto an existing clip collapses into one row', R.listRecents().length, 2)
}

console.log('\n== a copy this app made itself is stashed, and never announces itself')
{
  // The Stash opening by itself is right for "you copied something in another app". It is
  // wrong for a copy the app made: a pane copies on SELECT, so dragging across two words
  // in a log used to make the list appear every few seconds. `own` is what separates them,
  // and the load-bearing half is that the clip is still KEPT - suppressing the row instead
  // of the announcement would quietly stop the Stash holding what you copy out of a pane.
  const dir = profile()
  const clipFile = join(work, `clip-own-${Math.random().toString(36).slice(2)}.json`)
  const put = (text) => writeFileSync(clipFile, JSON.stringify({ text, formats: ['public.utf8-plain-text'] }))
  put('')
  const R = loadRecents(dir, clipFile)
  R.startRecents(() => {})

  R.noteOwnCopy('selected in a pane')
  put('selected in a pane')
  await settle()
  const mine = R.listRecents()[0]
  eq('the app’s own copy is still stashed', mine?.preview, 'selected in a pane')
  ok('and it is marked as ours, so nothing opens for it', mine?.own === true)

  put('copied in some other app')
  await settle()
  const theirs = R.listRecents()[0]
  eq('the next clip is the other one', theirs?.preview, 'copied in some other app')
  ok('and it is NOT marked, so the Stash still announces it', theirs?.own === undefined)

  // The mark is a moment, not a string: the same text copied again from somewhere else
  // later is somebody else's copy and has to announce itself.
  R.noteOwnCopy('said twice')
  put('said twice')
  await settle()
  ok('ours the first time', R.listRecents()[0]?.own === true)
  put('')
  await settle()
  await new Promise((r) => setTimeout(r, 4200))
  put('said twice')
  await settle()
  ok(
    'and not ours once the window has passed',
    R.listRecents()[0]?.preview === 'said twice' && R.listRecents()[0]?.own === undefined
  )
  R.stopRecents()
}

rmSync(work, { recursive: true, force: true })
console.log(failed ? `\n${failed} failed\n` : '\nall good\n')
process.exit(failed ? 1 : 0)
