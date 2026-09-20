import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const resources = resolve(root, 'src-tauri/resources/runtime');
const prepareOnly = process.argv.slice(2).every(arg => arg === '--prepare-only');
if (!prepareOnly) throw Error('Usage: node scripts/package-app.mjs --prepare-only');

function output(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function portableNode(node) {
  if (!existsSync(node)) throw Error(`Node runtime does not exist: ${node}`);
  if (process.platform !== 'darwin') return [];
  const dependencies = output('otool', ['-L', node]).split('\n').slice(1)
    .map(line => line.trim().split(' ')[0]).filter(Boolean);
  const hostBound = dependencies.filter(path => !path.startsWith('/usr/lib/') && !path.startsWith('/System/Library/'));
  if (hostBound.length) throw Error(`Refusing to bundle host-bound Node runtime (${hostBound.join(', ')}). Set PANEFORGE_NODE_RUNTIME to a self-contained runtime.`);
  return dependencies;
}

function addInventory(path, files) {
  const entry = statSync(path);
  if (entry.isDirectory()) {
    for (const child of readdirSync(path).sort()) addInventory(resolve(path, child), files);
    return;
  }
  if (entry.isFile()) files.push({ path: relative(resources, path), bytes: entry.size, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') });
}

const node = resolve(process.env.PANEFORGE_NODE_RUNTIME || process.execPath);
const nodeDependencies = portableNode(node);
const sourceRevision = output('git', ['rev-parse', 'HEAD']).trim();
const sourceDirty = output('git', ['status', '--porcelain']).trim().length > 0;
for (const required of ['dist/index.html', 'scripts/start.mjs', 'server/index.mjs', 'node_modules']) {
  if (!existsSync(resolve(root, required))) throw Error(`Packaging input is missing: ${required}. Run the existing local build/install workflow first.`);
}
rmSync(resources, { recursive: true, force: true });
mkdirSync(resolve(resources, 'node'), { recursive: true });
for (const input of ['dist', 'scripts', 'server', 'node_modules', 'package.json']) cpSync(resolve(root, input), resolve(resources, input), { recursive: true });
cpSync(node, resolve(resources, 'node', process.platform === 'win32' ? 'node.exe' : 'node'));
const files = []; addInventory(resources, files);
const bundledNode = resolve(resources, 'node', process.platform === 'win32' ? 'node.exe' : 'node');
const source = { revision: sourceRevision, dirty: sourceDirty };
writeFileSync(resolve(resources, 'runtime-manifest.json'), JSON.stringify({ source, node: { version: output(node, ['--version']).trim(), sha256: createHash('sha256').update(readFileSync(bundledNode)).digest('hex'), dependencies: nodeDependencies }, files }, null, 2) + '\n', { mode: 0o600 });
writeFileSync(resolve(resources, 'runtime-revision.txt'), `${sourceRevision}${sourceDirty ? '-dirty' : ''}\n`, { mode: 0o600 });
console.log(`Prepared ${files.length} bundled runtime files at ${resources}. Tauri packaging is intentionally separate from this preparation step.`);
