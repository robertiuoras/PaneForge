import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {transformSync} from 'esbuild'
const s=readFileSync(new URL('../src/main/index.ts',import.meta.url),'utf8')
const start=s.indexOf('function focusWindow('),end=s.indexOf('\n}\n',start)+2
assert(start>0&&end>start)
const code=transformSync(s.slice(start,end)+'\nreturn focusWindow',{loader:'ts'}).code
const pseudoAssignment=s.match(/^  pseudoMax = (.+)$/m)
assert(pseudoAssignment, 'locate the real createWindow deferred-maximize condition')
for(const mode of ['normal','minimized','headless']){
 const deferred=new Function('cfg','mode','snap','headlessMode',`return ${pseudoAssignment[1]}`)({window:{maximized:true}},mode,null,()=>mode==='headless')
 assert.equal(deferred,mode==='minimized',`deferred maximize for ${mode}`)
}
for(const headless of [true,false])for(const alive of [true,false])for(const asked of [true,false]){
 const actions=[]
 const focus=new Function('headlessMode','isGameActive','alive','createWindow','win',code)(()=>headless,()=>false,()=>alive,()=>actions.push('create'),{isMinimized:()=>true,restore:()=>actions.push('restore'),isVisible:()=>false,show:()=>actions.push('show'),focus:()=>actions.push('focus')})
 focus(asked)
 assert.equal(actions.length,headless?0:alive?3:1,`headless=${headless} alive=${alive} asked=${asked}`)
}
console.log('headless focus: activation and focus requests cannot reveal a test window; normal app retained')
