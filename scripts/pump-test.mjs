// The pty-output pump has one contract: the renderer must receive exactly the bytes
// the pty produced, in order, per pane - just in far fewer messages.
//
//   node scripts/pump-test.mjs
//
// Compiled straight out of the source file, like outbuffer-test.mjs, so there is no
// second copy of the logic here to drift from the one that ships.
import { strict as assert } from 'node:assert'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'src/main/dataPump.ts')
assert.ok(existsSync(src), 'src/main/dataPump.ts is missing')

const tsc = (await import('typescript')).default
const js = tsc.transpileModule(readFileSync(src, 'utf8').replace(/^export /gm, ''), {
  compilerOptions: { target: tsc.ScriptTarget.ES2022, module: tsc.ModuleKind.None }
}).outputText
const DataPump = new Function(`${js}; return DataPump`)()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (label, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

// --- 1. Nothing goes out before the tick, everything goes out on it. ------------
{
  const sent = []
  const pump = new DataPump((id, data) => sent.push([id, data]))
  pump.push('a', 'one ')
  pump.push('a', 'two ')
  pump.push('a', 'three')
  check('held until the tick', sent.length === 0)
  await sleep(40)
  check('one message, not three', sent.length === 1)
  check('bytes are intact and in order', sent[0][1] === 'one two three')
  check('nothing left waiting', pump.waiting === 0)
}

// --- 2. Panes never bleed into each other. --------------------------------------
{
  const sent = []
  const pump = new DataPump((id, data) => sent.push([id, data]))
  for (let i = 0; i < 50; i++) {
    pump.push('a', `a${i};`)
    pump.push('b', `b${i};`)
  }
  await sleep(40)
  const byId = Object.fromEntries(sent.map(([id, d]) => [id, d]))
  const expectA = Array.from({ length: 50 }, (_, i) => `a${i};`).join('')
  const expectB = Array.from({ length: 50 }, (_, i) => `b${i};`).join('')
  check('two panes, two messages', sent.length === 2)
  check('pane a is exactly its own bytes', byId.a === expectA)
  check('pane b is exactly its own bytes', byId.b === expectB)
}

// --- 3. The real measured load: 7,359 chunks/sec collapses to a handful. --------
{
  const sent = []
  const pump = new DataPump((id, data) => sent.push([id, data]))
  let expect = ''
  for (let i = 0; i < 7359; i++) {
    const chunk = 'x'.repeat(41)
    expect += chunk
    pump.push('a', chunk)
  }
  pump.flush()
  const joined = sent.map(([, d]) => d).join('')
  check('every byte survives the burst', joined === expect)
  // 7359 * 41 = 301,719 bytes, so MAX_PENDING (64 KB) forces 4 early sends plus the
  // final flush. Five messages instead of 7,359 is the whole point of the file.
  check(`burst sent as ${sent.length} messages, not 7359`, sent.length <= 8)
}

// --- 4. Exit and teardown paths. ------------------------------------------------
{
  const sent = []
  const pump = new DataPump((id, data) => sent.push([id, data]))
  pump.push('a', 'last words')
  pump.push('b', 'still going')
  pump.flushOne('a')
  check('flushOne sends only that pane', sent.length === 1 && sent[0][0] === 'a')
  check("the other pane's output is still waiting", pump.waiting === 'still going'.length)
  pump.discard()
  await sleep(40)
  check('discard drops the rest and cancels the tick', sent.length === 1)
  check('nothing waiting after discard', pump.waiting === 0)
}

// --- 5. Empty pushes and empty flushes are no-ops, not messages. ----------------
{
  const sent = []
  const pump = new DataPump((id, data) => sent.push([id, data]))
  pump.push('a', '')
  pump.flush()
  await sleep(40)
  check('an empty chunk sends nothing', sent.length === 0)
}

console.log(failures ? `\n${failures} FAILED` : '\nall pump checks passed')
process.exit(failures ? 1 : 0)
