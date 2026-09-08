// Exercise the actual renderer provider against real xterm rows and filesystem targets.
import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { buildSync, transformSync } from 'esbuild'
const require = createRequire(import.meta.url)
const { Terminal } = require('@xterm/headless')
const scratch = mkdtempSync(join(tmpdir(), 'pf-terminal-path-'))
const load = (entry) => {
  const out = buildSync({entryPoints:[new URL(entry, import.meta.url).pathname],bundle:true,write:false,platform:'node',format:'cjs'})
  const m = {exports:{}};new Function('module','exports','require',out.outputFiles[0].text)(m,m.exports,require);return m.exports
}
const {findPathTokens} = load('../src/shared/pathToken.ts')
const {resolveRevealTarget} = load('../src/main/revealPath.ts')
const source = readFileSync(new URL('../src/renderer/src/components/TerminalPane.tsx', import.meta.url), 'utf8')
const start = source.indexOf('    const KIND_TTL = ')
const end = source.indexOf('\n    /**', source.indexOf('t.registerLinkProvider({',start))
assert(start>0&&end>start)
const providerCode = transformSync(source.slice(start,end),{loader:'ts'}).code
const install = new Function('t','api','cwdRef','findPathTokens',providerCode)
const t = new Terminal({cols:85,rows:20,allowProposedApi:true})
let provider;const reveals=[]
const api={pathKind:async(cwd,text)=>resolveRevealTarget(cwd,text),reveal:p=>reveals.push(p)}
const wrapper={buffer:t.buffer,cols:t.cols,registerLinkProvider:p=>{provider=p}}
install(wrapper,api,{current:scratch},findPathTokens)
const links = row => new Promise(resolve=>provider.provideLinks(row,x=>resolve(x??[])))
const write = data => new Promise(resolve=>t.write(data,resolve))
const file = join(scratch,'output','pdf','bmk','bmk-social-concept.png')
mkdirSync(join(scratch,'output','pdf','bmk'),{recursive:true});writeFileSync(file,'fixture')
try {
  // The actual Codex output shape: hard CRLF and four-space continuation, no OSC link.
  const cut=file.lastIndexOf('concept.png'),front=file.slice(0,cut),back=file.slice(cut)
  await write(`\x1bc  - Social image (${front}\r\n    ${back})\r\n`)
  // Locate the row containing the continuation even when the temp path itself soft-wraps.
  let continuation=0;for(let y=0;y<t.buffer.active.length;y++)if(t.buffer.active.getLine(y).translateToString(true).includes(back))continuation=y+1
  for(const row of [continuation-1,continuation]){
    const hit=(await links(row)).find(l=>l.text===file)
    assert(hit,`hard-wrapped Codex path is clickable on row ${row}`)
    hit.activate();assert.equal(reveals.at(-1),file,'activation reveals the actual file in its folder')
    assert(hit.range.start.y<hit.range.end.y,'link covers both displayed rows')
  }
  await write(`\x1bc📎 ${file}\r\n`)
  const soft=(await links(2)).find(l=>l.text===file)
  assert(soft,'soft-wrapped path is linked from its continuation row')
  let pathCell=0;for(let x=0;x<t.cols;x++)if(t.buffer.active.getLine(0).getCell(x).getChars()==='/'){pathCell=x+1;break}
  assert.equal(soft.range.start.x,pathCell,'emoji prefix maps UTF-16 offsets to the measured terminal cells')
  await write(`\x1bc${scratch}/absent-\r\n    made-up.png\r\n`)
  assert.equal((await links(1)).length,0,'unwritten path is not falsely linked to an ancestor folder')
  const directory=join(scratch,'wrapped directory name')
  mkdirSync(directory)
  await write(`\x1bc${directory.slice(0,-4)}\r\n    name\r\n`)
  assert((await links(2)).some(l=>l.text===directory),'exact hard-wrapped directory remains clickable')
  console.log('terminal path links: hard and soft wraps, cell coordinates, file reveal, missing targets passed')
} finally {t.dispose();rmSync(scratch,{recursive:true,force:true})}
