// Exercise the actual renderer provider against real xterm rows and filesystem targets.
import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { buildSync, transformSync } from 'esbuild'
const require = createRequire(import.meta.url)
const { Terminal } = require('@xterm/headless')
const scratch = mkdtempSync(join(tmpdir(), 'pf-terminal-path-'))
const load = (entry) => {
  const out = buildSync({entryPoints:[fileURLToPath(new URL(entry, import.meta.url))],bundle:true,write:false,platform:'node',format:'cjs'})
  const m = {exports:{}};new Function('module','exports','require',out.outputFiles[0].text)(m,m.exports,require);return m.exports
}
const {findPathTokens} = load('../src/shared/pathToken.ts')
const {resolveRevealTarget} = load('../src/main/revealPath.ts')
const wrappedPath = load('../src/renderer/src/wrappedPath.ts')
const source = readFileSync(fileURLToPath(new URL('../src/renderer/src/components/TerminalPane.tsx', import.meta.url)), 'utf8')
const start = source.indexOf('    const KIND_TTL = ')
const end = source.indexOf('\n    /**', source.indexOf('t.registerLinkProvider({',start))
assert(start>0&&end>start)
const providerCode = transformSync(source.slice(start,end),{loader:'ts'}).code
const install = new Function('t','api','cwdRef','findPathTokens','wrappedPathLinks','continues','MAX_RUN_ROWS',providerCode)
const t = new Terminal({cols:85,rows:20,allowProposedApi:true})
let provider;const reveals=[];let questions=0
const api={pathKind:async(cwd,text)=>(questions++,resolveRevealTarget(cwd,text)),reveal:p=>reveals.push(p)}
const wrapper={buffer:t.buffer,cols:t.cols,registerLinkProvider:p=>{provider=p}}
install(wrapper,api,{current:scratch},findPathTokens,wrappedPath.wrappedPathLinks,wrappedPath.continues,wrappedPath.MAX_RUN_ROWS)
const links = row => new Promise(resolve=>provider.provideLinks(row,x=>resolve(x??[])))
// Cold questions a prose row below a path may cost. Measured 2026-10-02: 10 under a missing
// file, 4 under a found one (before the fix: 48 and 39, the whole budget).
const PROSE_COLD_MAX = 10
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
  let pathCell=0;for(let x=0;x<t.cols;x++)if(t.buffer.active.getLine(0).getCell(x).getChars()===file[0]){pathCell=x+1;break}
  assert(pathCell > 0, 'the path start is present on the first row on either platform')
  assert.equal(soft.range.start.x,pathCell,'emoji prefix maps UTF-16 offsets to the measured terminal cells')
  await write(`\x1bc${scratch}/absent-\r\n    made-up.png\r\n`)
  assert.equal((await links(1)).length,0,'unwritten path is not falsely linked to an ancestor folder')
  const directory=join(scratch,'wrapped directory name')
  mkdirSync(directory)
  await write(`\x1bc${directory.slice(0,-4)}\r\n    name\r\n`)
  assert((await links(2)).some(l=>l.text===directory),'exact hard-wrapped directory remains clickable')

  // Robert's path (2026-10-02): seventeen words, folders and file both spaced, wrapped by
  // the CLI over 3 and 4 indented rows. Each cut is either inside a word (`numbered-` /
  // `packages`) or at a space the wrap ate; nothing on screen says which.
  const deep=join(scratch,'Client Files','Pizza Ovens R Us','3D-demo-2026-10-02','numbered-packages')
  mkdirSync(deep,{recursive:true})
  const png=join(deep,'01 - Weatherproof Outdoor Kitchen to Suit Weber Summit - 3145MM - Preview.png')
  writeFileSync(png,'fixture')
  // Split `png` at each marker: ' ' cuts at the space before the marker (the space is
  // eaten), '' cuts in front of it inside a word.
  const cutAt=(text,cuts)=>{const rows=[];let rest=text
    for(const [marker,space] of cuts){const i=rest.indexOf(marker);assert(i>0,marker);rows.push(rest.slice(0,space?i-1:i));rest=rest.slice(i)}
    return [...rows,rest]}
  const rowOf=(needle)=>{for(let y=0;y<t.buffer.active.length;y++)if(t.buffer.active.getLine(y).translateToString(true).includes(needle))return y+1;return 0}
  const shapes=[
    {name:'3 rows, Claude indent, cut in a word then at a space',indent:'  ',lead:'⏺ Saved to ',tail:'',
      cuts:[[`packages${sep}01`,false],['Kitchen to',true]]},
    {name:'4 rows, Codex indent, cut at a space, in a word, at a space in the file name',indent:'    ',lead:'  - Preview (',tail:') and the rest of the sentence',
      cuts:[[`R Us${sep}3D`,true],[`packages${sep}01`,false],['Summit -',true]]},
    {name:'4 rows, every cut inside a word',indent:'  ',lead:'⏺ ',tail:'.',
      cuts:[['ns R Us',false],['demo-2026',false],['proof Outdoor',false]]}
  ]
  for(const shape of shapes){
    const rows=cutAt(png,shape.cuts)
    await write(`\x1bc${shape.lead}${rows[0]}\r\n${rows.slice(1).map((r,i)=>shape.indent+r+(i===rows.length-2?shape.tail:'')).join('\r\n')}\r\n  next line of prose\r\n`)
    const first=rowOf(rows[0].slice(0,12)),last=rowOf(rows.at(-1).slice(0,12))
    assert(first>0&&last-first>=rows.length-1,`${shape.name}: drawn over ${rows.length}+ rows`)
    for(let r=first;r<=last;r++){
      questions=0
      const found=await links(r)
      const hit=found.find(l=>l.text===png)
      assert(hit,`${shape.name}: the whole file is the link hovering row ${r} of ${first}-${last}`)
      assert.equal(found.length,1,`${shape.name}: ONE link on row ${r}, nothing else claims its cells`)
      assert.equal(hit.range.start.y,first,'the link starts on the first row');assert.equal(hit.range.end.y,last,'and ends on the last')
      assert(questions<=wrappedPath.MAX_QUESTIONS+8,`${shape.name}: row ${r} asked the disk ${questions} times`)
      reveals.length=0;hit.activate();assert.equal(reveals[0],png,'activation reveals the file itself')
    }
  }
  // The same seventeen words on ONE line (a wide pane: here soft-wrapped, never cut) are
  // past findPathTokens' word limit, and prose after the path and on the indented rows
  // below costs a bounded number of questions and never joins the link.
  await write(`\x1bc  Wrote ${png} and then\r\n  checked every other file in that folder, which all look\r\n  right to me now\r\n`)
  const oneFirst=rowOf(png.slice(0,12)),oneLast=rowOf('and then')
  for(let r=oneFirst;r<=oneLast;r++){
    questions=0
    const found=await links(r)
    assert(found.length===1&&found[0].text===png,`one long line: the whole file is the one link on row ${r}, got ${found.map(l=>l.text)}`)
    assert(questions<=wrappedPath.MAX_QUESTIONS+16,`one long line: row ${r} asked ${questions}`)
  }
  for(const prose of ['checked every','right to me']){
    questions=0
    assert.equal((await links(rowOf(prose))).length,0,`prose row "${prose}" below a path is not part of it`)
    assert(questions<=wrappedPath.MAX_QUESTIONS,`prose hover asked ${questions}`)
  }

  // Cold hovers (an empty cache, as on the first pass of the mouse) over a path whose last
  // row also names a file that is NOT there, and prose rows below. The missing file used to
  // walk word by word into the prose and spend every question the hover had before the
  // real path was reached, so the real path lost its link on its own last row.
  const cold=async(row)=>{install(wrapper,api,{current:scratch},findPathTokens,wrappedPath.wrappedPathLinks,wrappedPath.continues,wrappedPath.MAX_RUN_ROWS);questions=0;return links(row)}
  mkdirSync(join(scratch,'cfg'),{recursive:true})
  const missing=join(scratch,'cfg','x.json')
  const proseRows=['  then lots of more words on this prose line here ok','  and another line of plain prose words to walk into','  and a third prose line that keeps on going and going']
  const starved=cutAt(png,[[`packages${sep}01`,false],['Kitchen to',true]])
  await write(`\x1bc⏺ Saved ${starved[0]}\r\n  ${starved[1]}\r\n  ${starved[2]} and ${missing}\r\n${proseRows.join('\r\n')}\r\n`)
  const sFirst=rowOf(starved[0].slice(0,12)),sLast=rowOf('Preview.png and')
  for(let r=sFirst;r<=sLast;r++){
    const found=await cold(r)
    assert(found.length===1&&found[0].text===png,`missing file on the last row: the path is still the one link on row ${r}, got ${found.map(l=>l.text)} after ${questions} questions`)
  }
  for(const prose of proseRows){
    const found=await cold(rowOf(prose.trim()))
    assert.equal(found.length,0,`prose row "${prose.trim()}" under a missing file is not a link`)
    assert(questions<=PROSE_COLD_MAX,`prose under a missing file: cold hover asked ${questions}, want <= ${PROSE_COLD_MAX}`)
  }
  // A file that ends exactly where its row does is finished: the prose below is not walked.
  const ends=cutAt(png,[[`packages${sep}01`,false]])
  await write(`\x1bc⏺ Saved ${ends[0]}\r\n  ${ends[1]}\r\n${proseRows.join('\r\n')}\r\n`)
  for(const prose of proseRows){
    const found=await cold(rowOf(prose.trim()))
    assert.equal(found.length,0,`prose row "${prose.trim()}" under a found file is not a link`)
    assert(questions<=PROSE_COLD_MAX,`prose under a found file: cold hover asked ${questions}, want <= ${PROSE_COLD_MAX}`)
  }

  // A network share (`\\server\share\...`) starts a path like a drive letter does.
  const share=String.raw`\\nas\work\Client Files\Pizza Ovens R Us\report final.pdf`
  const known=new Map([[String.raw`\\nas\work\Client Files`,{abs:'x',kind:'dir'}],[String.raw`\\nas\work\Client Files\Pizza Ovens R Us`,{abs:'x',kind:'dir'}],[share,{abs:share,kind:'file'}]])
  const shareRows=[String.raw`Wrote \\nas\work\Client Files\Pizza Ovens`,'  R Us\\report final.pdf']
  const asLine=(text,y)=>({text,cells:[...text].map((_,i)=>({x:i+1,endX:i+1,y}))})
  const shareLinks=await wrappedPath.wrappedPathLinks(shareRows.map(asLine).map((l,i)=>({...l,cells:l.cells.map(c=>({...c,y:i+1}))})),1,2,async(tok)=>known.get(tok)??null)
  assert.deepEqual(shareLinks.map(l=>l.text),[share],'a wrapped network-share path is one link')
  console.log('terminal path links: hard and soft wraps, 3- and 4-row wrapped paths on every row, cell coordinates, file reveal, missing targets passed')
} finally {t.dispose();rmSync(scratch,{recursive:true,force:true})}
