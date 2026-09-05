// npm run test:promptseed
//
// A restored pane's rail tags: they must not survive the buffer they point into, and a
// pane that came back with none must be given the one deeper draw that can find some.
//
// This is a SOURCE test, like `quiet-state-test.mjs`, because both faults look right in
// review and only show up as "the tag scrolls nowhere":
//
//   - `redrawHistory` resets the terminal and writes 4 MB of the log back in. Every mark
//     is anchored INTO the buffer that reset throws away, and a dead marker reports line
//     -1 rather than disappearing - so the rail kept drawing tags that go nowhere. The
//     same non-empty rail is what made the `seedMarks()` at the end a no-op, since it
//     refuses a rail that is not empty.
//   - Main's live replay is capped at 400 KB (BUFFER_LIMIT) because it is held for every
//     pane. Measured 2026-09-04 over this desk's own 301 history logs above 50 KB, each
//     rendered through a headless xterm at its own recorded width and read by
//     `seedPrompts`: 400 KB gave 351 tags with 103 of 237 panes carrying NO tag at all,
//     against 1,320 tags and 27 empty panes from 4 MB. So a restored pane came back with
//     30.8% of its own prompts tagged.
import { transformSync } from 'esbuild'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(root, 'src/renderer/src/components/TerminalPane.tsx'), 'utf8')
let failed = 0
const check = (ok, what, note = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${note ? ` - ${note}` : ''}`)
  if (!ok) failed++
}

const redraw = src.slice(src.indexOf('const redrawHistory = async'))
const body = redraw.slice(0, redraw.indexOf('paneRedraw.set('))
check(body.includes('api.replayHistory(sessionId)'), 'redraw asks main for an ordered history snapshot')
check(!body.includes('t.reset()'), 'redraw cannot reset ahead of queued terminal output')
const reset = src.slice(src.indexOf('const offReset = '), src.indexOf('const off = api.onData'))
check(reset.includes('m.marker.dispose()') && reset.includes('seedMarks()'), 'ordered reset replaces obsolete tags and seeds the new snapshot')

// `seedMarks` may only add tags to a rail that has none: a pane that has been typed into
// owns its own tags and must never get a second one for the same prompt.
const seed = src.slice(src.indexOf('const seedMarks = (): void =>'))
const actualSeed = src.slice(src.indexOf('const seedMarks = (): void =>'), src.indexOf('const addMark = ', src.indexOf('const seedMarks = (): void =>')))
const executable = transformSync(actualSeed, { loader: 'ts', target: 'node20' }).code
const entries = [{ key: 'one', at: 123, marker: { line: 1, dispose() {} } }]
let serial = 0
const terminal = { buffer: { active: { baseY: 0, cursorY: 5, getLine: () => ({ translateToString: () => '', getCell: () => ({getBgColor: () => 0}) }) } }, registerMarker: offset => ({ id: ++serial, line: 5 + offset, dispose() { this.disposed = true } }) }
const runSeed = new Function('agent', 't', 'list', 'seedPrompts', 'echoKey', 'flatDraft', 'anchor', 'MARK_CAP', 'RAIL_LABEL_CHARS', 'publish', 'syncTotal', executable + ';return seedMarks')(
  'claude', terminal, entries, () => [{ line: 1, text: 'one' }, { line: 3, text: 'two' }], x => x, x => x, () => {}, 80, 200, () => {}, () => {})
runSeed()
check(entries.length === 2 && entries[1].key === 'two', 'a partial rail recovers its missing prompt tag')
check(entries[0].at === 123, 'a surviving live tag preserves its original identity and time')
runSeed()
check(entries.length === 2 && serial === 1, 'repeated repair never duplicates existing prompt tags')

const replay = src.slice(src.indexOf('const replayBuffer = '))
const done = replay.slice(0, replay.indexOf('reshape(t, f)'))
check(done.includes('deepSeeded.current = true'), 'the restore replay arms one deeper draw')
check(
  done.includes('!list.length') && !done.includes('!mirrorRef.current'),
  'the deeper draw is only for a pane whose rail came back EMPTY, including a mirror with a host log'
)
check(
  done.indexOf('seedMarks()') < done.indexOf('deepSeeded.current'),
  'the deeper draw is decided AFTER the ordinary seed has had its go'
)
check(done.includes('host.current?.offsetParent'), 'a hidden pane is not charged for the deeper draw')
check(
  /const deepSeeded = useRef\(false\)/.test(src),
  'the deeper draw happens at most once per pane'
)

console.log(failed ? `\n${failed} failed` : '\nall ok')
process.exit(failed ? 1 : 0)
