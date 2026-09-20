import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { Claude, claudeReadOnlyTools } from '../server/claude.mjs';

const id = '11111111-1111-4111-8111-111111111111';
function childWith(lines, code = 0) { const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.killed = false; child.kill = () => { child.killed = true; child.emit('close', 0); }; queueMicrotask(() => { child.stdout.emit('data', Buffer.from(`${lines.join('\n')}\n`)); child.emit('close', code); }); return child; }

test('Claude requires first-party Claude.ai Max authentication', async () => {
  const ready = new Claude({ execFileFn: async () => ({ stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' }) }) });
  assert.deepEqual(await ready.start(), { status: 'ready', authType: 'claude.ai', plan: 'max', model: 'claude', tools: claudeReadOnlyTools });
  const blocked = new Claude({ execFileFn: async () => ({ stdout: JSON.stringify({ loggedIn: true, authMethod: 'apiKey', apiProvider: 'firstParty', subscriptionType: 'max' }) }) });
  await assert.rejects(blocked.start(), /Claude.ai Max subscription/);
});

test('Claude streams only under its restricted read-only CLI contract and resumes the supplied native identity', async () => {
  let command, args, options;
  const bridge = new Claude({ spawnFn: (nextCommand, nextArgs, nextOptions) => { command = nextCommand; args = nextArgs; options = nextOptions; return childWith([JSON.stringify({type:'system',subtype:'init',session_id:id,tools:claudeReadOnlyTools,mcp_servers:[{name:'paneforge_fixture'}]}),JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { text: 'marker ' } } }), JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { text: 'read' } } }),JSON.stringify({type:'result',result:'marker read'})]); } });
  const events = [];
  const result = await bridge.send({ sessionId: id, projectId:'project-a', cwd: '/safe/project', text: 'Read marker only.', onEvent: event => events.push(event) });
  assert.equal(command, 'claude');assert.equal(result.text, 'marker read');assert.deepEqual(events.map(event => event.text), ['marker ', 'read']);
  for (const flag of ['--restricted', '--strict-mcp-config', '--verbose', '--disable-slash-commands', '--no-chrome']) assert.ok(args.includes(flag));
  assert.equal(args[args.indexOf('--tools')+1],'');assert.ok(!args.includes('--safe-mode'));for(const tool of claudeReadOnlyTools)assert.ok(args.includes(`mcp__paneforge_fixture__${tool}`));assert.equal(JSON.parse(args[args.indexOf('--mcp-config')+1]).mcpServers.paneforge_fixture.env.PANEFORGE_PROJECT_ID,'project-a');
  assert.ok(args.includes('--resume'));assert.equal(args.at(-2), id);assert.equal(options.cwd, '/safe/project');assert.equal(options.env.API_KEY, undefined);
});

test('a first Claude turn uses the selected UUID and cancellation is durable to its caller', async () => {
  let child;const bridge = new Claude({ spawnFn: (_command, args) => { assert.ok(args.includes('--session-id'));assert.ok(!args.includes('--resume'));child = new EventEmitter();child.stdout = new EventEmitter();child.stderr = new EventEmitter();child.killed = false;child.kill = () => { child.killed = true;child.emit('close', 0); };return child; } });
  const request = bridge.send({ sessionId: id, projectId:'project-a', cwd: '/safe/project', text: 'first', resume: false });
  assert.equal(await bridge.stop(id), true);await assert.rejects(request, /cancelled/);assert.equal(child.killed, true);
});

test('Claude preserves streamed provider errors for durable session failure state', async () => {
  const bridge = new Claude({ spawnFn: () => childWith([JSON.stringify({type:'system',subtype:'init',session_id:id,tools:claudeReadOnlyTools,mcp_servers:[{name:'paneforge_fixture'}]}),JSON.stringify({ type: 'result', is_error: true, result: 'weekly limit reached' })], 0) });
  await assert.rejects(bridge.send({ sessionId: id, projectId:'project-a', cwd: '/safe/project', text: 'read' }), /weekly limit reached/);
});


test('Claude rejects unverified native identity and built-in tool exposure', async () => {
 const wrong=new Claude({spawnFn:()=>childWith([JSON.stringify({type:'system',subtype:'init',session_id:'22222222-2222-4222-8222-222222222222',tools:claudeReadOnlyTools,mcp_servers:[{name:'paneforge_fixture'}]})])});
 await assert.rejects(wrong.send({sessionId:id,projectId:'project-a',cwd:'/safe/project',text:'read'}),/mismatched native session/);
 const tools=new Claude({spawnFn:()=>childWith([JSON.stringify({type:'system',subtype:'init',session_id:id,tools:[...claudeReadOnlyTools,'Read'],mcp_servers:[{name:'paneforge_fixture'}]})])});
 await assert.rejects(tools.send({sessionId:id,projectId:'project-a',cwd:'/safe/project',text:'read'}),/outside the PaneForge MCP scope/);
});


test('Claude requires a final result receipt even after a verified initialization',async()=>{const bridge=new Claude({spawnFn:()=>childWith([JSON.stringify({type:'system',subtype:'init',session_id:id,tools:claudeReadOnlyTools,mcp_servers:[{name:'paneforge_fixture'}]})])});await assert.rejects(bridge.send({sessionId:id,projectId:'project-a',cwd:'/safe/project',text:'read'}),/final result receipt/);});


test('Claude rejects an initialized MCP server with no registered read tools',async()=>{const bridge=new Claude({spawnFn:()=>childWith([JSON.stringify({type:'system',subtype:'init',session_id:id,tools:[],mcp_servers:[{name:'paneforge_fixture'}]}),JSON.stringify({type:'result',result:'empty'})])});await assert.rejects(bridge.send({sessionId:id,projectId:'project-a',cwd:'/safe/project',text:'read'}),/outside the PaneForge MCP scope/);});
