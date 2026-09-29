import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { transformSync } from 'esbuild'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { Terminal } = require('@xterm/headless')
const src = readFileSync(new URL('../src/renderer/src/components/TerminalPane.tsx', import.meta.url), 'utf8')
const helper = readFileSync(new URL('../src/shared/terminalProtocol.ts', import.meta.url), 'utf8')
const { isTerminalReply, withoutReplayQueries } = await import('data:text/javascript;base64,' + Buffer.from(transformSync(helper, {loader:'ts',format:'esm'}).code).toString('base64'))
const surface = readFileSync(new URL('../src/shared/surface.ts',import.meta.url),'utf8')
const { buildApi } = await import('data:text/javascript;base64,' + Buffer.from(transformSync(surface,{loader:'ts',format:'esm'}).code).toString('base64'))
const bridgeWrites = []
const bridge = buildApi({send:(channel,args)=>bridgeWrites.push({channel,args}),invoke:async()=>{},on:()=>()=>{}})
bridge.write('source','\x1b[1;1R',true)
assert.deepEqual(bridgeWrites,[{channel:'pty:write',args:['source','\x1b[1;1R',true]}],'existing preload/browser surface preserves the reply context')
const start = src.indexOf('    t.onData((d) => {')
const end = src.indexOf('\n    t.onSelectionChange', start)
assert(start > 0 && end > start)
const callback = transformSync(src.slice(start, end), {loader:'ts'}).code
const t = new Terminal({cols:80, rows:10, allowProposedApi:true})
const writes = [], feeds = [], states = []
const pinned = {current:false}
const api = {write:(id,data,terminalReply)=>writes.push({id,data,...(terminalReply ? {terminalReply:true} : {})})}
const setScrolledUp = value => states.push(value)
const feedInput = data => feeds.push(data)
const install = new Function('t','api','pinned','setScrolledUp','feedInput','isTerminalReply', `
 const sessionId = 'source', handoverRef = {current:0}, asleepRef = {current:false};
 const syncedPanes = new Set(['source','peer']), paneFeed = new Map([['peer',feedInput]]);
 // The expand card's gate (a long prompt's held Enter) is its own suite's; here it holds nothing.
 const holdForExpand = () => false, startExpandEarly = () => {};
 let keyboardData = null;
 ${callback}
 return key => { keyboardData = key; t.input(key, true); };
`)
const key = install(t,api,pinned,setScrolledUp,feedInput,isTerminalReply)
const write = data => new Promise(resolve => t.write(data,resolve))
await write('\x1b[c')
assert.equal(pinned.current,false,'automatic device reply must preserve reading position')
assert.deepEqual(writes,[{id:'source',data:'\x1b[?1;2c',terminalReply:true}],'reply reaches only its own PTY with protocol ownership')
assert.deepEqual(feeds,[],'reply never becomes a draft')
assert.deepEqual(states,[],'reply does not change scroll intent')
for (const query of ['\x1b[5n','\x1b[6n','\x1b[?6n','\x1b[>c','\x1b[?1004$p','\x1bP$qm\x1b\\']) {
 writes.length = 0
 await write(query)
 assert.equal(writes.length,1,`one local reply to ${JSON.stringify(query)}`)
 assert.equal(writes[0].terminalReply,true,'generated protocol context crosses the API')
 assert.equal(pinned.current,false)
}
for (const data of ['\x1b[I','\x1b[O','\x1b]11;rgb:0000/0000/0000\x1b\\',
  '\x1b[<64;25;8M', '\x1b[<65;25;8M', '\x1b[<0;25;8m', '\x1b[M`99']) {
 writes.length = 0
 t.input(data,false)
 assert.equal(writes.length,1)
  assert.equal(pinned.current,false)
  assert.deepEqual(feeds,[], 'mouse and focus reports never become draft text')
}
for (const data of ['hello','\x1b[D','\x1b[1;2R','\x1b[200~paste\x1b[201~']) {
 pinned.current = false
 writes.length = 0
 key(data)
 assert.equal(pinned.current,true,'typing and Shift-F3 follow output')
 assert.equal(writes.length,2,'typing still synchronizes')
 assert(writes.every(w => !w.terminalReply),'real keys, including cursor-report-shaped Shift-F3, remain ordinary input')
}
// Execute the existing main IPC/write routing, including the paired-owner hop.
const main = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
const routeStart = main.indexOf('function writePane(')
const routeEnd = main.indexOf('\n// A phone\'s write', routeStart)
const ipcStart = main.indexOf("ipcMain.on('pty:write'")
const ipcEnd = main.indexOf('\n)', ipcStart) + 2
assert(routeStart > 0 && routeEnd > routeStart && ipcStart > 0 && ipcEnd > ipcStart)
const route = transformSync(main.slice(routeStart,routeEnd) + '\n' + main.slice(ipcStart,ipcEnd),{loader:'ts'}).code
const localWrites = [], remoteWrites = []
let receiveWrite
new Function('ipcMain','manager','remote','watchForClear',route)(
 {on:(_channel,handler)=>{receiveWrite=handler}},
 {write:(...args)=>localWrites.push(args)},
 {owns:id=>id==='mirror',send:(id,msg)=>remoteWrites.push({id,msg})},
 ()=>{}
)
const desk = {sender:{isDestroyed:()=>false}}, phone = {sender:{isDestroyed:()=>true}}
receiveWrite(desk,'local','\x1b[1;1R',true)
receiveWrite(phone,'local','\x1b[?1;2c',true)
receiveWrite(desk,'local','\x1b[1;2R')
assert.deepEqual(localWrites,[['local','\x1b[1;1R','desk',true],['local','\x1b[?1;2c','phone',true],['local','\x1b[1;2R','desk',false]])
receiveWrite(desk,'mirror','\x1b[1;1R',true)
receiveWrite(desk,'mirror','\x1b[1;2R')
assert.deepEqual(remoteWrites,[{id:'mirror',msg:{t:'write',data:'\x1b[1;1R',terminalReply:true}},{id:'mirror',msg:{t:'write',data:'\x1b[1;2R'}}])
const host = readFileSync(new URL('../src/main/remote/host.ts', import.meta.url),'utf8')
const hostStart = host.indexOf("        case 'write':")
const hostEnd = host.indexOf("        case 'prompt':",hostStart)
assert(hostStart > 0 && hostEnd > hostStart)
const hostWrites = [], backend = {write:(...args)=>hostWrites.push(args)}
const receiveRemote = new Function('m',transformSync(`const id='owned',guest={}; switch(m.t){${host.slice(hostStart,hostEnd)}}`,{loader:'ts'}).code).bind({backend})
remoteWrites.forEach(({msg})=>receiveRemote(msg))
assert.deepEqual(hostWrites,[['owned','\x1b[1;1R',true],['owned','\x1b[1;2R',false]],'paired owner preserves protocol context and ordinary key ownership')
// The production host backend carries that same flag to the session owner.
const backendStart = main.indexOf('  write: (id, data, terminalReply) =>')
assert(backendStart > 0)
const backendWrite = new Function('manager',transformSync(`const backend = {${main.slice(backendStart,main.indexOf('\n',backendStart))}}`,{loader:'ts'}).code + '\nreturn backend.write')
const backendWrites = []
backendWrite({write:(...args)=>backendWrites.push(args)})('owned','\x1b[1;1R',true)
assert.deepEqual(backendWrites,[['owned','\x1b[1;1R','phone',true]])
writes.length = 0
await write(withoutReplayQueries('saved\r\n\x1b[c\x1b[6n\x1b[?1004$p\x1bP$qm\x1b\\\x1b]11;?\x07'))
assert.deepEqual(writes,[],'saved queries never write into the waking PTY')
await write(withoutReplayQueries('\x9bc\x9b6n\x9b?1004$p\x90$qm\x9c\x9d11;?\x9c\x1bZ\x1b[0;0c\x1b[5;0n'))
assert.deepEqual(writes,[],'C1 and legacy saved queries never reach the waking PTY')
const paint = '\x1b[31mred\x1b[0m\x1b[2J\x1b[H\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\'
assert.equal(withoutReplayQueries(paint),paint,'replay retains drawing, colours and links')
t.dispose()
console.log('terminal-protocol: real xterm replies, keyboard, synchronization and replay checks passed')
