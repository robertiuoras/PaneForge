import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { transformSync } from 'esbuild'
const text = readFileSync(new URL('../src/main/config.ts', import.meta.url), 'utf8')
const start = text.indexOf('export function setConfig(')
const end = text.indexOf('\n/** Validated projects root:', start)
assert.ok(start >= 0 && end > start)
const code = transformSync(text.slice(start, end).replace('export function', 'function'), {loader:'ts'}).code
const previous = {pinnedPanes:['existing'],providerKeys:{}}
let fail = true, saved
const env = {cache:previous,getConfig:()=>env.cache, file:()=>'/fixture/config.json',dirname:()=>'/fixture',mkdirSync:()=>{},writeFileSync:(_path,body)=>{if(fail)throw Error('disk full');saved=JSON.parse(body)},renameSync:()=>{},applyLaunchAtLogin:()=>{}}
const set = runInNewContext(code+';setConfig', env)
assert.throws(()=>set({pinnedPanes:['new']}), /disk full/)
assert.equal(env.cache, previous, 'failed pin save does not claim persistence in memory')
fail = false
assert.deepEqual(set({pinnedPanes:['new']}).pinnedPanes, ['new'])
assert.deepEqual(saved.pinnedPanes, ['new'], 'successful save writes the requested pins')
console.log('pin save: disk failure is surfaced with cache rollback; successful write persisted')
