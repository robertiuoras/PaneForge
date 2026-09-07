// Real React effects in an isolated hidden Electron window, with deterministic IPC replies.
import { buildSync } from 'esbuild'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import electron from 'electron'
const root = resolve(import.meta.dirname, '..'), dir = mkdtempSync(join(tmpdir(), 'pf-copy-dialog-'))
try {
  buildSync({ stdin: { resolveDir: root, loader: 'tsx', contents: `
import React from 'react'; import { createRoot } from 'react-dom/client';
let calls = [], mode = 'normal', oldReply;
const work = dir => ({ dir, repo: '/p/repo', lane: dir.slice(-1), branch: 'lane-a', base: 'main', ahead: 1, dirty: mode === 'mergefail' ? 0 : 2, conflicts: [], baseDirty: false, touching: [] });
window.api = {
 laneFolders: async () => { if (mode === 'listfail') throw Error('failed'); return ['/p/repo-a','/p/repo-b','/p/repo-z']; },
 laneWork: async dir => { calls.push(dir); if (dir === '/p/repo-old') return new Promise(r => oldReply = r); if (mode === 'fail' || dir === '/p/repo-b') throw Error('failed'); return work(dir); },
 mergeLane: async () => { throw Error('failed'); },
 sendPrompt: () => { throw Error('must not prompt sleeping pane'); }
};
const Dialog = require('./src/renderer/src/components/LaneDialog.tsx').default;
const Strip = require('./src/renderer/src/components/LaneStrip.tsx').default;
const root = createRoot(document.getElementById('root'));
const session = { id: 'sleep', cwd: '/p/repo', status: 'exited', asleep: true, title: 'kept' };
const board = { repo: '/p/repo', lanes: [{ lane: 'z', dir: '/p/repo-z', ownerPane: 'sleep', held: true, seen: Date.now(), conflicted: true }] };
const props = { cwd: '/p/repo-a', boards: [board], sessions: [session], onClose(){}, onHelp(){}, onFocus(){}, onReview(){} };
const render = p => root.render(<Dialog {...props} {...p} />);
const wait = async test => { for (let n=0;n<100;n++) { if(test()) return; await new Promise(r=>setTimeout(r,10)); } throw Error('Timed out: '+document.body.textContent); };
const check = (ok, why) => { if(!ok) throw Error(why+': '+document.body.textContent); };
window.run = async () => {
 render({}); await wait(()=>document.body.textContent.includes('changes unknown'));
 check(document.body.textContent.includes('4 copies'), 'physical copy without ledger is listed');
 check(document.body.textContent.includes('asleep'), 'sleeping owner is named');
 check([...document.querySelectorAll('.lane-copy-held')].filter(e=>e.textContent.includes('asleep')).length === 1, 'assigned chat does not also own launch folder');
 check(document.body.textContent.includes('2 uncommitted files'), 'successful reads survive sibling failure');
 mode='fail'; render({cwd:'/p/repo-c'}); await wait(()=>document.body.textContent.includes('no merge is available'));
 check(!document.body.textContent.includes('Reading the lane'), 'primary rejection settles');
 mode='normal'; document.querySelector('.confirm-body button').click(); await wait(()=>document.body.textContent.includes('Lane c'));
 render({cwd:'/p/repo-old'}); await wait(()=>!!oldReply); render({cwd:'/p/repo-d'}); await wait(()=>document.body.textContent.includes('Lane d'));
 oldReply(work('/p/repo-old')); await new Promise(r=>setTimeout(r,25)); check(document.body.textContent.includes('Lane d'), 'late old result cannot replace current copy');
 mode='listfail'; render({cwd:'/p/repo-e'}); await wait(()=>document.body.textContent.includes('list may be incomplete'));
 await wait(()=>document.body.textContent.includes('asleep')); check(calls.includes('/p/repo-z'), 'ledger inspection survives enumeration failure');
 mode='mergefail'; render({cwd:'/p/repo-f'}); await wait(()=>document.body.textContent.includes('Lane f') && !document.querySelector('button.primary').disabled);
 document.querySelector('button.primary').click(); await wait(()=>document.body.textContent.includes('merge result could not be confirmed'));
 check(!document.querySelector('button.primary').disabled, 'merge rejection releases busy state');
 root.render(<Strip boards={[board]} sessions={[session]} />); await new Promise(r=>setTimeout(r,25)); check(!document.body.textContent.includes('Other copies'), 'sleeping owner not orphaned or prompted');
 return 'copy dialog: 11 runtime checks passed';
};` }, outfile: join(dir, 'ui.js'), bundle: true, platform: 'browser', jsx: 'automatic', alias: { '@shared': join(root, 'src/shared') } })
  writeFileSync(join(dir, 'index.html'), '<div id="root"></div><script src="ui.js"></script>')
  writeFileSync(join(dir, 'main.cjs'), `const {app,BrowserWindow}=require('electron'); app.setPath('userData',${JSON.stringify(join(dir,'profile'))}); app.whenReady().then(async()=>{const w=new BrowserWindow({show:false});await w.loadFile(${JSON.stringify(join(dir,'index.html'))});try{console.log(await w.webContents.executeJavaScript('window.run()'));app.exit(0)}catch(e){console.error(e);app.exit(1)}});setTimeout(()=>app.exit(2),20000);`)
  console.log(execFileSync(electron, [join(dir, 'main.cjs')], { encoding: 'utf8', timeout: 25000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } }).trim())
} finally { rmSync(dir, { recursive: true, force: true }) }
