// Execute the real selection handler against bounded line editors, including hidden wraps.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildSync, transformSync } from 'esbuild'
const source=readFileSync(new URL('../src/renderer/src/components/TerminalPane.tsx',import.meta.url),'utf8')
const start=source.indexOf('    const deleteSelection ='),end=source.indexOf('    inputRowsRef.current =',start)
assert.ok(start>=0&&end>start)
const code=transformSync(source.slice(start,end),{loader:'ts'}).code
const bundle=buildSync({entryPoints:['src/shared/cursorMove.ts'],bundle:true,format:'esm',write:false})
const helpers=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'))
let checks=0
function fixture({text,rows,cursor,start,end,ask=false}){
 const logical={text,cursor,keys:[],cleared:false}
 const cellCursor=cursor===0?{row:0,col:rows[0].start}:{row:rows.length-1,col:rows.at(-1).end}
 const t={getSelectionPosition:()=>({start:{x:start.col,y:start.row},end:{x:end.col,y:end.row}}),buffer:{active:{type:'normal',baseY:0,cursorY:cellCursor.row,cursorX:cellCursor.col}},clearSelection:()=>{logical.cleared=true}}
 const sendKeys=keys=>{
  logical.keys.push(keys)
  for(let i=0;i<keys.length;){
   if(keys.startsWith(helpers.ARROW.right,i)){logical.cursor=Math.min(logical.text.length,logical.cursor+1);i+=3}
   else if(keys.startsWith(helpers.ARROW.left,i)){logical.cursor=Math.max(0,logical.cursor-1);i+=3}
   else if(keys.startsWith('\x1b[3~',i)){logical.text=logical.text.slice(0,logical.cursor)+logical.text.slice(logical.cursor+1);i+=4}
   else if(keys[i]===helpers.BACKSPACE){if(logical.cursor>0){logical.text=logical.text.slice(0,logical.cursor-1)+logical.text.slice(logical.cursor);logical.cursor--}i++}
   else throw Error('unexpected key sequence')
  }
 }
 const deps={t,askRef:{current:ask},inputRows:()=>({top:0,rows}),spanBottom:()=>rows.length-1,composerLength:()=>helpers.offsetIn(rows,rows.length-1,rows.at(-1).end),sendKeys,lastSelection:{current:text},...helpers}
 const run=new Function(...Object.keys(deps),code+';return deleteSelection')(...Object.values(deps))
 return {logical,run}
}
function eq(a,b,label){assert.deepEqual(a,b,label);checks++}
for(const separator of ['',' ','\n'])for(const cursorAtStart of [false,true]){
 const text='x'.repeat(156)+separator+'y'.repeat(20)
 const rows=[{start:2,end:158,full:true},{start:2,end:22,full:false}]
 const {logical,run}=fixture({text,rows,cursor:cursorAtStart?0:text.length,start:{row:0,col:2},end:{row:1,col:22}})
 eq(run(),'done','whole selection handled')
 eq(logical.text,'','all selected text deleted in the first batch despite hidden separator')
 eq(logical.keys.length,1,'one batch without delayed correction')
 logical.text=logical.text.slice(0,logical.cursor)+'Z'+logical.text.slice(logical.cursor)
 eq(logical.text,'Z','replacement cannot leave first selected character behind')
}
{
 const text='alpha beta gamma',rows=[{start:2,end:18,full:false}]
 const {logical,run}=fixture({text,rows,cursor:text.length,start:{row:0,col:8},end:{row:0,col:12}})
 eq(run(),'done','partial selection handled')
 eq(logical.text,'alpha  gamma','partial deletion preserves both unselected sides')
}
{
 const {logical,run}=fixture({text:'menu',rows:[{start:2,end:6,full:false}],cursor:4,start:{row:0,col:2},end:{row:0,col:6},ask:true})
 eq(run(),'no','chooser refuses editing')
 eq(logical.keys,[],'no destructive keys into a chooser')
}
console.log(`selection delete: ${checks} checks passed`)
