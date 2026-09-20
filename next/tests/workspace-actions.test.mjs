import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkspaceActions, workspaceApps, workspaceTools } from '../server/workspace-actions.mjs';

function fixture() {
  const changed = [];
  const assistant = { id: 'assistant-paneforge-next', kind: 'assistant', projectId: 'paneforge-next', title: 'PaneForge assistant', items: [], voiceHistory: [{ delta: 'Find the release notes from yesterday.' }] };
  const chat = { id: 'chat-1', sessionNumber: 12, group: 'Releases', kind: 'conversation', projectId: 'paneforge-next', title: 'Release planning', status: 'idle', items: [{ type: 'userMessage', text: 'Please check the release notes and terminal evidence.' }] };
  const other = { id: 'other-1', sessionNumber: 31, kind: 'conversation', projectId: 'other-project', title: 'Private client', items: [{ text: 'never reveal' }] };
  const sessions = { sessions: [assistant, chat, other], get(id) { const found = this.sessions.find(session => session.id === id); if (!found) throw Error('Unknown conversation'); return found; }, changed() { changed.push(JSON.parse(JSON.stringify(assistant.workspaceActions || []))); }, async create(input) { const session = { id: 'new-1', kind: 'conversation', projectId: input.projectId, cwd: input.cwd, title: input.title, items: [] }; this.sessions.push(session); return session; }, async organize(id, input) { const session = this.get(id); Object.assign(session, input); return session; } };
  const lanes = [{ id: 'lane-main', projectId: 'paneforge-next', name: 'main', path: '/safe/paneforge-next', isCurrent: true }];
  const projects = { list() { return [{ id: 'paneforge-next', name: 'PaneForge Next', isGit: true, canonicalProjectId: 'project-next', projectName: 'PaneForge Next' }, { id: 'other-project', name: 'NGC', isGit: true, canonicalProjectId: 'project-ngc', projectName: 'NGC' }]; }, projectIds(id) { if (id === 'project-ngc') return ['other-project']; if (!['paneforge-next', 'other-project'].includes(id)) throw Error('Project is not connected.'); return [id]; }, require(id) { if (!['paneforge-next', 'other-project'].includes(id)) throw Error('Project is not connected.'); return { id, name: id === 'other-project' ? 'NGC' : 'PaneForge Next', path: `/safe/${id}`, isGit: true }; }, lanes(id) { return id === 'paneforge-next' ? lanes : [{ id: 'lane-ngc', projectId: id, name: 'client', path: `/safe/${id}`, isCurrent: true }]; }, requireLane(id, laneId) { const lane = this.lanes(id).find(item => item.id === laneId); if (!lane) throw Error('Lane is not available for this project.'); return lane; }, laneForCwd(id, cwd) { return this.lanes(id).find(lane => lane.path === cwd) || null; }, createLane(id, name) { const lane = { id: `lane-${name}`, projectId: id, name, path: `/safe/${id}-${name}`, isCurrent: false }; lanes.push(lane); return lane; }, async read(id, path) { if (id !== 'paneforge-next' || path !== 'README.md') throw Error('File is outside the safe project preview.'); return { path, text: 'safe source' }; } };
  const terminal = { creates: 0, state() { return [{ id: 'term-1', sessionId: 'chat-1', projectId: 'paneforge-next', exited: false }, { id: 'term-other', sessionId: 'other-1', projectId: 'other-project', exited: false }]; }, async create(input) { this.creates++; assert.equal(input.projectId, 'paneforge-next'); return { id: 'term-new', reused: this.creates > 1 }; } };
  const brain = { async file(scope, path) { if (scope !== 'paneforge' || path !== 'agent-memory:notes/release.md') throw Error('Source is outside the current workspace scope'); return { scope, path, title: 'Release', text: 'verified note' }; } };
  const navigations = []; const appRequests = [];
  return { assistant, chat, sessions, projects, terminal, brain, changed, navigations, appRequests, actions: new WorkspaceActions({ sessions, projects, terminal, brain, onNavigate: async request => { navigations.push(request); }, openApp: async appId => { appRequests.push(appId); } }) };
}

test('workspace tools are strict dynamic function specs', () => {
  assert.equal(workspaceTools.length, 21);
  for (const tool of workspaceTools) { assert.equal(tool.type, 'function'); assert.equal(tool.inputSchema.additionalProperties, false); }
  assert.deepEqual(workspaceApps.map(app => app.appId), ['calculator', 'finder', 'obsidian', 'safari', 'vscode', 'paneforge-next']);
});

test('local shortcuts use no assistant turn and voice results request the same visual cards', async () => {
  const t=fixture();let turns=0;t.sessions.turn=()=>{turns++;throw Error('No provider call expected')};
  t.actions.listApps=async query=>({apps:[{appId:'installed-abc',name:query||'Notes'}]});
  t.actions.deviceFiles={roots:async()=>[{id:'downloads',name:'Downloads',available:true}],search:async args=>({results:[{...args,path:'notes.txt',name:'notes.txt',previewable:true}],truncated:false}),preview:async()=>({path:'notes.txt',text:'x'.repeat(20000),truncated:false})};
  assert.equal((await t.actions.executeLocal('list_workspace_apps',{query:'Notes'})).apps[0].name,'Notes');
  assert.equal((await t.actions.executeLocal('list_device_folders',{})).folders[0].id,'downloads');
  const args={rootId:'downloads',query:'notes'};
  const direct=await t.actions.executeLocal('search_device_files',args);
  const shown=await t.actions.execute('search_device_files',args,{assistantId:t.assistant.id,clientId:'client-1',callId:'file-search'});
  assert.deepEqual(shown.results,direct.results);assert.equal(shown.type,'results');assert.equal(shown.category,'files');
  const preview=await t.actions.execute('preview_device_file',{rootId:'downloads',path:'notes.txt'},{assistantId:t.assistant.id,clientId:'client-1',callId:'file-preview'});
  assert.equal(preview.text.length,12000);assert.equal(preview.truncated,true);
  await assert.rejects(t.actions.executeLocal('create_workspace_session',{title:'No',mode:'chat'}),/not available as a local shortcut/);
  await assert.rejects(t.actions.executeLocal('search_device_files',{rootId:'home',query:'notes'}),/Unsupported rootId/);
  assert.equal(turns,0);
});

test('connected project filename search stays bounded and preserves project identity', async () => {
  const t=fixture();t.projects.children=async(id,directory)=>({limit:150,children:directory?[{path:'docs/readme.md',type:'file',bytes:12}]:[{path:'docs',type:'directory'}]});
  const result=await t.actions.executeLocal('search_workspace_files',{projectId:'paneforge-next',query:'readme'});
  assert.equal(result.results[0].path,'docs/readme.md');assert.equal(result.results[0].projectId,'paneforge-next');assert.equal(result.scanned,2);
  await assert.rejects(t.actions.executeLocal('search_workspace_files',{projectId:'unknown',query:'readme'}),/not connected/);
});

test('returns actual current time in a validated IANA zone', async () => {
  const t = fixture(); const before = Date.now();
  const result = await t.actions.execute('get_workspace_time', {}, { assistantId: t.assistant.id, callId: 'time-1', clientId: 'client-1' });
  const after = Date.now();
  assert.equal(result.timeZone, 'Australia/Brisbane'); assert.match(result.localDate, /^\d{4}-\d{2}-\d{2}$/); assert.match(result.localTime, /^\d{2}:\d{2}:\d{2}$/); assert.ok(Date.parse(result.utc) >= before - 5 && Date.parse(result.utc) <= after + 5);
  await assert.rejects(t.actions.execute('get_workspace_time', { timeZone: 'not/a-zone' }, { assistantId: t.assistant.id, callId: 'time-invalid', clientId: 'client-1' }), /Invalid IANA time zone/);
});

test('lists scoped sessions and searches saved voice history without leaking another project', async () => {
  const t = fixture();
  const listed = await t.actions.execute('list_workspace_sessions', {}, { assistantId: t.assistant.id, callId: 'list-1', clientId: 'client-1' });
  assert.deepEqual(listed.sessions.map(item => item.sessionId), ['chat-1']);
  assert.match(listed.sessions[0].promptPreview, /release notes/i);
  assert.equal(listed.sessions[0].sessionNumber, 12); assert.equal(listed.sessions[0].group, 'Releases'); assert.equal(listed.sessions[0].terminalStatus, 'interactive');
  const numbered = await t.actions.execute('list_workspace_sessions', { query: '#12', offset: 0 }, { assistantId: t.assistant.id, callId: 'list-numbered', clientId: 'client-1' });
  assert.deepEqual(numbered.sessions.map(item => item.sessionId), ['chat-1']); assert.equal(numbered.offset, 0);
  const history = await t.actions.execute('search_workspace_history', { query: 'yesterday' }, { assistantId: t.assistant.id, callId: 'search-1', clientId: 'client-1' });
  assert.deepEqual(history.results.map(item => item.sessionId), [t.assistant.id]);
  assert.doesNotMatch(JSON.stringify(history), /never reveal/);
});

test('explicit project and lane selection can find, open, create, and continue client work', async () => {
  const t = fixture();
  const projects = await t.actions.execute('list_workspace_projects', {}, { assistantId: t.assistant.id, callId: 'projects-1', clientId: 'client-1' });
  assert.deepEqual(projects.projects.map(project => project.id), ['paneforge-next', 'other-project']);
  const lanes = await t.actions.execute('list_workspace_lanes', { projectId: 'other-project' }, { assistantId: t.assistant.id, callId: 'lanes-1', clientId: 'client-1' });
  assert.equal(lanes.lanes[0].id, 'lane-ngc');
  const listed = await t.actions.execute('list_workspace_sessions', { projectId: 'other-project' }, { assistantId: t.assistant.id, callId: 'client-list-1', clientId: 'client-1' });
  assert.deepEqual(listed.sessions.map(item => item.sessionId), ['other-1']);
  await t.actions.execute('open_workspace_session', { projectId: 'other-project', sessionId: 'other-1', mode: 'chat' }, { assistantId: t.assistant.id, callId: 'client-open-1', clientId: 'client-1' });
  const created = await t.actions.execute('create_workspace_session', { projectId: 'other-project', newLane: 'ngc-research', title: 'NGC research', mode: 'chat' }, { assistantId: t.assistant.id, callId: 'client-create-1', clientId: 'client-1' });
  assert.equal(created.lane.name, 'ngc-research'); assert.equal(t.sessions.sessions.at(-1).cwd, '/safe/other-project-ngc-research');
  let continued; t.terminal.state = () => []; t.sessions.turn = async (id, input) => { continued = { id, input }; return {}; };
  await t.actions.execute('continue_workspace_session', { projectId: 'other-project', sessionId: 'other-1', text: 'Continue the client review.' }, { assistantId: t.assistant.id, callId: 'client-continue-1', clientId: 'client-1' });
  assert.equal(continued.id, 'other-1'); assert.match(continued.input.requestId, /^workspace-[a-f0-9]{64}$/); assert.equal(continued.input.clientId, 'client-1'); assert.equal(continued.input.text, 'Continue the client review.');
  await assert.rejects(t.actions.execute('list_workspace_lanes', { projectId: 'unknown' }, { assistantId: t.assistant.id, callId: 'unknown-project-1', clientId: 'client-1' }), /not connected/);
});

test('deduplicates concurrent calls and never replays an unresolved persisted reservation', async () => {
  const t = fixture();
  let calls = 0; t.actions.openApp = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 5)); };
  const options = { assistantId: t.assistant.id, callId: 'launch-1', clientId: 'client-1' };
  const [first, second] = await Promise.all([t.actions.execute('open_workspace_app', { appId: 'finder' }, options), t.actions.execute('open_workspace_app', { appId: 'finder' }, options)]);
  assert.deepEqual(first, second); assert.equal(calls, 1);
  t.assistant.workspaceActions.push({ tool: 'open_workspace_app', args: { appId: 'finder' }, callId: 'after-restart', clientId: 'client-1', status: 'reserved', createdAt: '2026-01-01T00:00:00.000Z' });
  await assert.rejects(t.actions.execute('open_workspace_app', { appId: 'finder' }, { assistantId: t.assistant.id, callId: 'after-restart', clientId: 'client-1' }), /not replayed/);
  assert.equal(calls, 1);
});

test('rejects cross-project sessions, unsafe file paths, unknown apps and extra arguments before side effects', async () => {
  const t = fixture();
  await assert.rejects(t.actions.execute('open_workspace_session', { sessionId: 'other-1', mode: 'chat' }, { assistantId: t.assistant.id, callId: 'scope-1', clientId: 'client-1' }), /outside the selected project/);
  await assert.rejects(t.actions.execute('open_project_file', { path: '../secret.env' }, { assistantId: t.assistant.id, callId: 'file-1', clientId: 'client-1' }), /safe project preview/);
  await assert.rejects(t.actions.execute('open_workspace_app', { appId: 'terminal' }, { assistantId: t.assistant.id, callId: 'app-1', clientId: 'client-1' }), /Unsupported appId/);
  await assert.rejects(t.actions.execute('list_workspace_apps', { shell: 'open /' }, { assistantId: t.assistant.id, callId: 'extra-1', clientId: 'client-1' }), /Unsupported argument/);
  assert.deepEqual(t.appRequests, []);
  assert.ok(t.assistant.workspaceActions.some(action => action.callId === 'scope-1'));
});

test('stale requests cannot create an isolated worktree', async () => {
  const t = fixture(); let made = 0; t.projects.createLane = () => { made++; return { id: 'lane-new', name: 'new', path: '/safe/new', isCurrent: false }; };
  await assert.rejects(t.actions.execute('create_workspace_session', { title: 'Stale lane', mode: 'chat', newLane: 'stale' }, { assistantId: t.assistant.id, callId: 'stale-lane-1', clientId: 'client-1', isCurrent: () => false }), /no longer current/);
  assert.equal(made, 0);
});

test('requests existing scoped grid and code session once, without a Mac fallback', async () => {
  const t = fixture();
  const grid = await t.actions.execute('show_workspace_grid', {}, { assistantId: t.assistant.id, callId: 'grid-1', clientId: 'client-1' });
  assert.deepEqual(grid.terminalIds, ['term-1']);
  const all = await t.actions.execute('show_workspace_grid', { allProjects: true }, { assistantId: t.assistant.id, callId: 'grid-all-1', clientId: 'client-1' });
  assert.deepEqual(all.terminalIds, ['term-1', 'term-other']); assert.equal(all.allProjects, true);
  await assert.rejects(t.actions.execute('show_workspace_grid', { allProjects: true, projectId: 'other-project' }, { assistantId: t.assistant.id, callId: 'grid-invalid-1', clientId: 'client-1' }), /one project or all/);
  assert.equal(t.terminal.creates, 0);
  const created = await t.actions.execute('create_workspace_session', { title: 'PC code only', mode: 'code' }, { assistantId: t.assistant.id, callId: 'code-1', clientId: 'client-1' });
  assert.equal(created.state, 'navigation_requested'); assert.equal(created.mode, 'code'); assert.equal(t.terminal.creates, 0);
  assert.equal(t.navigations.at(-1).terminalId, undefined);
});

test('call identities are assistant-local and cannot change arguments, while second-brain scope is server mapped', async () => {
  const t = fixture();
  await t.actions.execute('list_workspace_apps', {}, { assistantId: t.assistant.id, callId: 'shared-call', clientId: 'client-1' });
  await assert.rejects(t.actions.execute('open_workspace_app', { appId: 'finder' }, { assistantId: t.assistant.id, callId: 'shared-call', clientId: 'client-1' }), /reused with different details/);
  const source = await t.actions.execute('open_second_brain_source', { path: 'agent-memory:notes/release.md' }, { assistantId: t.assistant.id, callId: 'brain-1', clientId: 'client-1' });
  assert.equal(source.scope, 'paneforge');
  await assert.rejects(t.actions.execute('open_second_brain_source', { scope: 'assistant', path: 'agent-memory:notes/release.md' }, { assistantId: t.assistant.id, callId: 'brain-extra', clientId: 'client-1' }), /Unsupported argument/);
});

test('missing host bridges fail rather than claiming navigation or a launch', async () => {
  const t = fixture();
  const unavailable = new WorkspaceActions({ sessions: t.sessions, projects: t.projects, terminal: t.terminal, brain: t.brain });
  await assert.rejects(unavailable.execute('open_workspace_app', { appId: 'finder' }, { assistantId: t.assistant.id, callId: 'no-app-1', clientId: 'client-1' }), /unavailable/);
  await assert.rejects(unavailable.execute('open_workspace_session', { sessionId: 'chat-1', mode: 'chat' }, { assistantId: t.assistant.id, callId: 'no-nav-1', clientId: 'client-1' }), /unavailable/);
});

test('does not navigate after the bound assistant turn becomes stale while a source read is pending', async () => {
  const t = fixture();
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let current = true;
  t.projects.read = async () => { await pending; return { path: 'README.md', text: 'safe source' }; };
  const request = t.actions.execute('open_project_file', { path: 'README.md' }, {
    assistantId: t.assistant.id,
    callId: 'stale-read-1',
    clientId: 'client-1',
    isCurrent: () => current
  });
  await Promise.resolve();
  current = false;
  release();
  await assert.rejects(request, /no longer current for the bound assistant turn/);
  assert.deepEqual(t.navigations, []);
  const action = t.assistant.workspaceActions.find(item => item.callId === 'stale-read-1');
  assert.equal(action.status, 'failed');
  assert.match(action.error, /no longer current/);
});


test('creates an explicitly selected Claude Code lane with exact project identity', async () => {
  const t=fixture(); let received;
  t.sessions.create=async input=>{ received=input; const s={...input,id:'claude-client',items:[]}; t.sessions.sessions.push(s); return s; };
  t.terminal.create=async()=>{throw Error('Opening Code must not allocate another provider session');};
  const result=await t.actions.execute('create_workspace_session',{projectId:'other-project',title:'NGC website',newLane:'website',provider:'claude',mode:'code'},{assistantId:t.assistant.id,callId:'claude-code',clientId:'client-1'});
  assert.equal(received.provider,'claude'); assert.equal(received.projectId,'other-project'); assert.equal(received.cwd,'/safe/other-project-website'); assert.equal(received.laneId,'lane-website'); assert.equal(result.terminalId,undefined);
});


test('explicit Code continuation forwards the saved lane and deduplicates the bound request', async()=>{
 const t=fixture();Object.assign(t.chat,{cwd:'/safe/paneforge-next',laneId:'lane-main',provider:'codex'});t.terminal.state=()=>[];let runs=0,input;
 t.terminal.runCodeTurn=async args=>{runs++;input=args;return {id:'code-turn',state:'running'};};
 const args={sessionId:t.chat.id,text:'Build the requested page',mode:'code'};const context={assistantId:t.assistant.id,callId:'run-work',clientId:'client-1'};
 const first=await t.actions.execute('continue_workspace_session',args,context);const second=await t.actions.execute('continue_workspace_session',args,context);
 assert.equal(runs,1);assert.deepEqual(first,second);assert.equal(input.cwd,t.chat.cwd);assert.equal(input.laneId,'lane-main');assert.equal(input.text,args.text);assert.equal(first.mode,'code');assert.equal(first.executionState,'running');
 t.chat.cwd='/other/lane';await assert.rejects(t.actions.execute('continue_workspace_session',args,{...context,callId:'stale-code-lane'}),/lane is no longer/);assert.equal(runs,1);
});

test('organizes only scoped non-assistant sessions and does not mutate invalid targets', async () => {
 const t = fixture(); let calls = 0; const original = t.sessions.organize; t.sessions.organize = async (...args) => { calls++; return original.apply(t.sessions, args); };
 const result = await t.actions.execute('organize_workspace_session', { sessionId: 'chat-1', title: 'Release receipt', group: '', beforeSessionId: 'chat-1' }, { assistantId: t.assistant.id, callId: 'organize-1', clientId: 'client-1' });
 assert.equal(result.state, 'organized'); assert.equal(calls, 1); assert.equal(t.chat.title, 'Release receipt'); assert.equal(t.chat.group, '');
 await assert.rejects(t.actions.execute('organize_workspace_session', { sessionId: 'other-1', group: 'Nope' }, { assistantId: t.assistant.id, callId: 'organize-cross', clientId: 'client-1' }), /outside the selected project/);
 await assert.rejects(t.actions.execute('organize_workspace_session', { sessionId: 'chat-1', beforeSessionId: 'assistant-paneforge-next' }, { assistantId: t.assistant.id, callId: 'organize-before', clientId: 'client-1' }), /placement conversation/);
 assert.equal(calls, 1);
});

test('launches a scoped CLI in the saved lane and rejects invalid continuation states', async () => {
 const t = fixture(); Object.assign(t.chat, { cwd: '/safe/paneforge-next', laneId: 'lane-main', provider: 'claude' }); let input;
 t.terminal.create = async value => { input = value; return { id: 'terminal-cli', reused: false }; };
 const launched = await t.actions.execute('launch_workspace_cli', { sessionId: 'chat-1', projectId: 'paneforge-next', machine: 'mac' }, { assistantId: t.assistant.id, callId: 'cli-1', clientId: 'client-1' });
 assert.equal(launched.terminalId, 'terminal-cli'); assert.equal(input.machine, 'mac'); assert.equal(input.laneId, 'lane-main'); assert.equal(input.provider, 'claude');
 await assert.rejects(t.actions.execute('launch_workspace_cli', { sessionId: 'other-1', machine: 'pc' }, { assistantId: t.assistant.id, callId: 'cli-cross', clientId: 'client-1' }), /outside the selected project/);
 await assert.rejects(t.actions.execute('continue_workspace_session', { sessionId: 'chat-1', text: '   ' }, { assistantId: t.assistant.id, callId: 'blank', clientId: 'client-1' }), /cannot be blank/);
 t.chat.status = 'uncertain'; await assert.rejects(t.actions.execute('continue_workspace_session', { sessionId: 'chat-1', text: 'Resume' }, { assistantId: t.assistant.id, callId: 'uncertain', clientId: 'client-1' }), /busy or uncertain/);
 t.chat.status = 'idle'; await assert.rejects(t.actions.execute('continue_workspace_session', { sessionId: 'chat-1', text: 'Resume' }, { assistantId: t.assistant.id, callId: 'interactive', clientId: 'client-1' }), /active interactive terminal/);
});


test('direct commands open exact apps and search without a provider, preserve ambiguity', async () => {
 const t=fixture();const queries=[];
 t.actions.listApps=async()=>({apps:[{appId:'safari',name:'Safari'},{appId:'calculator',name:'Calculator'}]});
 t.actions.openSearch=async query=>{queries.push(query);return {state:'search_open_requested'}};
 assert.equal((await t.actions.executeCommand('Open Safari')).handled,true);
 assert.deepEqual(t.appRequests,['safari']);
 assert.match((await t.actions.executeCommand('open Editor')).message,/Several apps/);
 assert.equal((await t.actions.executeCommand('open session 12')).handled,false);
 await t.actions.executeCommand('search the web for Brisbane weather');assert.deepEqual(queries,['Brisbane weather']);
 await assert.rejects(()=>t.actions.executeCommand('open Safari',()=>false),/no longer current/);
 assert.equal((await t.actions.executeCommand('write some code')).handled,false);
});

test('spoken direct typing retains exact text and avoids a provider',async()=>{
 const t=fixture();const entries=[];t.actions.appendText=async(app,text)=>{entries.push({app,text});return {state:'text_appended'}};
 await t.actions.executeCommand('type hello there into TextEdit');await t.actions.executeCommand('type "hello again" in Notes.');
 assert.deepEqual(entries,[{app:'TextEdit',text:'hello there'},{app:'Notes',text:'hello again'}]);
});


test('speech filler and spaced TextEdit use direct action with progress before completion',async()=>{
 const t=fixture();let release;const pending=new Promise(r=>release=r);const labels=[];const calls=[];
 t.actions.appendText=async(app,text)=>{calls.push({app,text});await pending;return {state:'text_appended'}};
 const result=t.actions.executeCommand('Um, please type hello there into text edit.',()=>true,label=>labels.push(label));
 assert.deepEqual(labels,['Typing in TextEdit…']);assert.deepEqual(calls,[{app:'TextEdit',text:'hello there'}]);
 release();assert.equal((await result).state,'text_appended');
 assert.equal((await t.actions.executeCommand('Do not type hello there into text edit')).handled,false);
});


test('polite spoken commands stay local while questions and negations do not execute',async()=>{
 const t=fixture();const searches=[],entries=[];
 t.actions.openSearch=async query=>{searches.push(query);return {state:'search_open_requested'}};
 t.actions.appendText=async(app,text)=>{entries.push({app,text});return {state:'text_appended'}};
 for(const prefix of ['Can you ', 'Could you please ', 'Would you ', 'Um, could you please ']){
  assert.equal((await t.actions.executeCommand(prefix+'google Brisbane weather')).handled,true);
 }
 await t.actions.executeCommand('Could you please type Hello, Robert! into TextEdit.');
 assert.deepEqual(entries,[{app:'TextEdit',text:'Hello, Robert!'}]);
 assert.deepEqual(searches,Array(4).fill('Brisbane weather'));
 for(const input of ['Can you not open Safari','Could you please avoid opening Safari','Would you explain how to open Safari']){
  assert.equal((await t.actions.executeCommand(input)).handled,false);
 }
 await t.actions.executeCommand('Can you open Safari and delete my history');
 assert.deepEqual(t.appRequests,[]);
});


test('find app presents local results without launching or using a provider',async()=>{
 const t=fixture();const queries=[];t.actions.listApps=async query=>{queries.push(query);return {apps:[{appId:'calculator',name:'Calculator'}],truncated:false}};
 t.sessions.turn=()=>{throw Error('Must not start a model')};
 const result=await t.actions.executeCommand('Find the Calculator app and show it without opening it.',()=>true,()=>{},{assistantId:t.assistant.id,clientId:'find-client',callId:'find-app'});
 assert.equal(result.handled,true);assert.equal(result.type,'results');assert.equal(result.category,'apps');
 assert.deepEqual(queries,['Calculator']);assert.deepEqual(t.appRequests,[]);
 assert.equal(t.assistant.workspaceActions.at(-1).status,'completed');
 const direct=await t.actions.executeCommand('Could you please show the Calculator app');assert.equal(direct.apps[0].name,'Calculator');
 assert.equal((await t.actions.executeCommand('Do not find the Calculator app')).handled,false);
 await assert.rejects(()=>t.actions.executeCommand('find Calculator app',()=>false),/no longer current/);
});

test('simple date requests use the local clock without a model or workspace mutation',async()=>{
 const {actions}=fixture();
 for(const input of ["what's the date today?",'what is the time now?','what day is it today?']){
  const result=await actions.executeCommand(input);assert.equal(result.handled,true);assert.equal(result.timeZone,'Australia/Brisbane');assert.ok(Math.abs(Date.now()-Date.parse(result.utc))<1000);
 }
 assert.equal((await actions.executeCommand('what is the date of the next meeting?')).handled,false);
});
