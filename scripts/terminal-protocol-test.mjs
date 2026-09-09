import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { transformSync } from 'esbuild'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { Terminal } = require('@xterm/headless')
const src = readFileSync(new URL('../src/renderer/src/components/TerminalPane.tsx', import.meta.url), 'utf8')
const helper = readFileSync(new URL('../src/shared/terminalProtocol.ts', import.meta.url), 'utf8')
const { isTerminalReply, withoutReplayQueries } = await import('data:text/javascript;base64,' + Buffer.from(transformSync(helper, {loader:'ts',format:'esm'}).code).toString('base64'))
const start = src.indexOf('    t.onData((d) => {')
const end = src.indexOf('\n    t.onSelectionChange', start)
assert(start > 0 && end > start)
const callback = transformSync(src.slice(start, end), {loader:'ts'}).code
const t = new Terminal({cols:80, rows:10, allowProposedApi:true})
const writes = [], feeds = [], states = []
const pinned = {current:false}
const api = {write:(id,data)=>writes.push({id,data})}
const setScrolledUp = value => states.push(value)
const feedInput = data => feeds.push(data)
const install = new Function('t','api','pinned','setScrolledUp','feedInput','isTerminalReply', `
 const sessionId = 'source', handoverRef = {current:0}, asleepRef = {current:false};
 const syncedPanes = new Set(['source','peer']), paneFeed = new Map([['peer',feedInput]]);
 let keyboardData = null;
 ${callback}
 return key => { keyboardData = key; t.input(key, true); };
`)
const key = install(t,api,pinned,setScrolledUp,feedInput,isTerminalReply)
const write = data => new Promise(resolve => t.write(data,resolve))
await write('\x1b[c')
assert.equal(pinned.current,false,'automatic device reply must preserve reading position')
assert.deepEqual(writes,[{id:'source',data:'\x1b[?1;2c'}],'reply reaches only its own PTY')
assert.deepEqual(feeds,[],'reply never becomes a draft')
assert.deepEqual(states,[],'reply does not change scroll intent')
for (const query of ['\x1b[5n','\x1b[6n','\x1b[?6n','\x1b[>c','\x1b[?1004$p','\x1bP$qm\x1b\\']) {
 writes.length = 0
 await write(query)
 assert.equal(writes.length,1,`one local reply to ${JSON.stringify(query)}`)
 assert.equal(pinned.current,false)
}
for (const data of ['\x1b[I','\x1b[O','\x1b]11;rgb:0000/0000/0000\x1b\\']) {
 writes.length = 0
 t.input(data,false)
 assert.equal(writes.length,1)
 assert.equal(pinned.current,false)
}
for (const data of ['hello','\x1b[D','\x1b[1;2R','\x1b[200~paste\x1b[201~']) {
 pinned.current = false
 writes.length = 0
 key(data)
 assert.equal(pinned.current,true,'typing and Shift-F3 follow output')
 assert.equal(writes.length,2,'typing still synchronizes')
}
writes.length = 0
await write(withoutReplayQueries('saved\r\n\x1b[c\x1b[6n\x1b[?1004$p\x1bP$qm\x1b\\\x1b]11;?\x07'))
assert.deepEqual(writes,[],'saved queries never write into the waking PTY')
await write(withoutReplayQueries('\x9bc\x9b6n\x9b?1004$p\x90$qm\x9c\x9d11;?\x9c\x1bZ\x1b[0;0c\x1b[5;0n'))
assert.deepEqual(writes,[],'C1 and legacy saved queries never reach the waking PTY')
const paint = '\x1b[31mred\x1b[0m\x1b[2J\x1b[H\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\'
assert.equal(withoutReplayQueries(paint),paint,'replay retains drawing, colours and links')
t.dispose()
console.log('terminal-protocol: real xterm replies, keyboard, synchronization and replay checks passed')
