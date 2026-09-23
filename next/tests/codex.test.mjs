import assert from 'node:assert/strict';
import { basename, isAbsolute, join } from 'node:path';
import test from 'node:test';
import { scopedCodexConfig, verifyEffectiveCapabilities } from '../server/codex.mjs';

const tools = { read_fixture: {}, search_second_brain: {}, search_conversation_history: {}, list_project_files: {}, read_project_file: {} };
const config = { web_search: 'live', features: { shell_tool: false, unified_exec: false, apps: false, plugins: false, browser_use: false, computer_use: false, code_mode_host: true }, mcp_servers: { paneforge_fixture: {} } };

test('accepts only the explicit read-only MCP capability set', () => {
  assert.deepEqual(verifyEffectiveCapabilities({ config }, { data: [{ name: 'paneforge_fixture', tools }] }), { mcpServers: ['paneforge_fixture'], tools: ['list_project_files', 'read_fixture', 'read_project_file', 'search_conversation_history', 'search_second_brain'] });
});
test('accepts the App Server array tool-status shape without widening capabilities', () => {
  assert.deepEqual(verifyEffectiveCapabilities({ config }, { data: [{ name: 'paneforge_fixture', tools: Object.keys(tools).map(name => ({ name })) }] }), { mcpServers: ['paneforge_fixture'], tools: ['list_project_files', 'read_fixture', 'read_project_file', 'search_conversation_history', 'search_second_brain'] });
});
test('fails closed when the MCP tool set changes', () => assert.throws(() => verifyEffectiveCapabilities({ config }, { data: [{ name: 'paneforge_fixture', tools: { ...tools, write_file: {} } }] }), /unexpected tool set/));


test('creates a dedicated fixture process configuration for each conversation lane',()=>{
  const config=scopedCodexConfig('project-a','/safe/project-a-lane').mcp_servers.paneforge_fixture;
  assert.equal(config.env.PANEFORGE_PROJECT_ID,'project-a');
  assert.equal(config.env.PANEFORGE_PROJECT_CWD,'/safe/project-a-lane');
  assert.ok(isAbsolute(config.env.PANEFORGE_DATA_DIR));
  assert.ok(config.env.PANEFORGE_DATA_DIR.endsWith(join('.local-runtime', 'app')));
  assert.equal(config.command,process.execPath);assert.equal(basename(config.args[0]),'fixture-mcp.mjs');
});

test('fails closed when live search is disabled',()=>assert.throws(()=>verifyEffectiveCapabilities({config:{...config,web_search:'disabled'}},{data:[]}),/Live web search/));
