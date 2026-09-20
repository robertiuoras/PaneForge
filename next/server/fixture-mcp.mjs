// Deliberately narrow read-only MCP server. No shell, network, client data, or writes.
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Brain, brainScopes } from './brain.mjs';
import { Projects } from './projects.mjs';
import { searchSavedConversationHistory } from './sessions.mjs';

const workspaceRoot=fileURLToPath(new URL('..',import.meta.url)).replace(/\/$/,'');

export const readOnlyTools = [
  { name: 'read_fixture', description: 'Read the PaneForge synthetic fixture. confirm=true requests an explicit harmless approval first.', inputSchema: { type: 'object', properties: { confirm: { type: 'boolean' } }, additionalProperties: false } },
  { name: 'search_second_brain', description: 'Search verified internal/public notes in one allowed PaneForge workspace scope. It uses the existing local index and does not write memory.', inputSchema: { type: 'object', required: ['query', 'scope'], properties: { query: { type: 'string', minLength: 1, maxLength: 300 }, scope: { type: 'string', enum: brainScopes.map(scope => scope.id) } }, additionalProperties: false } },
  { name: 'search_conversation_history', description: 'Search earlier saved conversations in this conversation project. Deleted conversations and this assistant session are excluded. Results contain bounded local excerpts and source session IDs.', inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string', minLength: 1, maxLength: 300 }, limit: { type: 'integer', minimum: 1, maximum: 5 } }, additionalProperties: false } },
  { name: 'list_project_files', description: 'List one directory of bounded safe, non-secret source and documentation files in this conversation project. The project is fixed by the conversation scope; omit projectId.', inputSchema: { type: 'object', properties: { projectId: { type: 'string', minLength: 1, maxLength: 80 }, directory: { type: 'string', maxLength: 300 } }, additionalProperties: false } },
  { name: 'read_project_file', description: 'Read one bounded safe source or documentation file from this conversation project. The project is fixed by the conversation scope; omit projectId. Paths outside the allowlist and possible secrets are rejected.', inputSchema: { type: 'object', required: ['path'], properties: { projectId: { type: 'string', minLength: 1, maxLength: 80 }, path: { type: 'string', minLength: 1, maxLength: 300 } }, additionalProperties: false } }
];

function text(value, isError = false) { return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) }; }

function conversationProjectId(projectId = process.env.PANEFORGE_PROJECT_ID || 'paneforge-next') {
  if (typeof projectId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(projectId)) throw Error('MCP project scope is invalid.');
  return projectId;
}

function scopedProject(args, projectId) {
  if (Object.hasOwn(args, 'projectId') && args.projectId !== projectId) throw Error('Project is outside this conversation scope.');
  return projectId;
}

export function createToolHandler({ projectId, cwd = process.env.PANEFORGE_PROJECT_CWD || workspaceRoot, brain = new Brain(), projects = new Projects({root:dirname(workspaceRoot),defaultPath:workspaceRoot,dataDir:resolve(workspaceRoot,process.env.PANEFORGE_DATA_DIR||'.local-runtime/app')}), historySearch = (query,scope,limit) => searchSavedConversationHistory(resolve(workspaceRoot,process.env.PANEFORGE_DATA_DIR||'.local-runtime/app'),{query,projectId:scope,limit}), requestElicitation = async () => ({ action: 'decline' }) } = {}) {
  const boundProjectId = conversationProjectId(projectId);
  return async ({ name, arguments: args = {} }) => {
    try {
      if (name === 'read_fixture') {
        if (args.confirm && (await requestElicitation())?.action !== 'accept') return text('Fixture read declined by user.');
        return text(readFileSync(new URL('./fixtures/research.txt', import.meta.url), 'utf8'));
      }
      if (name === 'search_second_brain') return text(await brain.search(args.query, args.scope));
      if (name === 'search_conversation_history') {
        if(typeof args.query!=='string'||!args.query.trim()||args.query.length>300)throw Error('History query is required (maximum 300 characters)');
        if(args.limit!==undefined&&(!Number.isInteger(args.limit)||args.limit<1||args.limit>5))throw Error('History limit must be between 1 and 5');
        return text({results:await historySearch(args.query,boundProjectId,args.limit||5)});
      }
      if (name === 'list_project_files') {
        const result = await projects.children(scopedProject(args, boundProjectId), args.directory || '', cwd);
        return text({ project: result.project, directory: result.directory, files: result.children, limit: result.limit });
      }
      if (name === 'read_project_file') {
        const result = await projects.read(scopedProject(args, boundProjectId), args.path, cwd);
        return text({ project: result.project, path: result.path, bytes: result.bytes, content: result.text });
      }
      return text('Unsupported tool.', true);
    } catch (error) { return text(error instanceof Error ? error.message : 'Read-only tool failed.', true); }
  };
}

export function startStdioServer() {
  const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const pending = new Map(); let next = 1000;
  const callTool = createToolHandler({ requestElicitation: () => new Promise(resolve => {
    const id = next++; pending.set(id, resolve);
    send({ id, method: 'elicitation/create', params: { mode: 'form', message: 'Allow reading the synthetic PaneForge fixture?', requestedSchema: { type: 'object', properties: {}, required: [] } } });
  }) });
  createInterface({ input: process.stdin }).on('line', async line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    if (!message.method) { pending.get(message.id)?.(message.result); pending.delete(message.id); return; }
    if (message.id === undefined) return;
    if (message.method === 'initialize') send({ id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'paneforge-readonly', version: '0.2.0' } } });
    else if (message.method === 'tools/list') send({ id: message.id, result: { tools: readOnlyTools } });
    else if (message.method === 'tools/call') send({ id: message.id, result: await callTool(message.params) });
    else if (message.method === 'ping') send({ id: message.id, result: {} });
    else send({ id: message.id, error: { code: -32601, message: 'Unsupported method' } });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startStdioServer();
