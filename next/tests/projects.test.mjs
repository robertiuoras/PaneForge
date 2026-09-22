import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { Projects } from '../server/projects.mjs';

function fixture() {
  const temp = mkdtempSync(join(tmpdir(), 'paneforge-projects-'));
  const root = join(temp, 'Projects');
  const dataDir = join(temp, 'data');
  const app = join(root, 'paneforge-next');
  const other = join(root, 'other-app');
  const plain = join(root, 'plain-folder');
  for (const path of [app, other]) { mkdirSync(join(path, '.git'), { recursive: true }); }
  mkdirSync(plain, { recursive: true });
  mkdirSync(join(app, 'src'), { recursive: true });
  writeFileSync(join(app, 'src', 'main.ts'), 'export const visible = true;');
  writeFileSync(join(app, 'src', 'component.jsx'), 'export default null;');
  writeFileSync(join(app, 'src', 'assistant.py'), 'print("ready")');
  writeFileSync(join(app, '.env'), 'never list this');
  writeFileSync(join(app, 'src', 'token.txt'), 'never list this');
  mkdirSync(join(app, 'node_modules', 'nested'), { recursive: true });
  writeFileSync(join(app, 'node_modules', 'nested', 'skip.ts'), 'no');
  return { temp, root, app, other, plain, projects: new Projects({ root, defaultPath: app, dataDir }), close() { rmSync(temp, { recursive: true, force: true }); } };
}

test('registered roots are existing direct repositories under the configured Projects directory', () => {
  const t = fixture();
  try {
    const listed = t.projects.list();
    assert.deepEqual(listed.map(p => p.name), ['other-app', 'paneforge-next', 'plain-folder']);
    assert.equal(listed.find(p => p.name === 'plain-folder').isGit, false);
    assert.ok(listed.every(p => !p.path.includes('src/main.ts') && !p.path.includes('.env')));
    const other = t.projects.register(t.other);
    assert.equal(other.name, 'other-app');
    assert.equal(t.projects.require(other.id).name, 'other-app');
    assert.throws(() => t.projects.register(join(t.root, 'missing')), /does not exist/);
    assert.throws(() => t.projects.register(t.root), /inside/);
    assert.throws(() => t.projects.register('/tmp'), /inside|non-linked/);
  } finally { t.close(); }
});

test('discovery is immediate-folder-only and excludes unsafe container roots', () => {
  const t = fixture();
  try {
    const clients = join(t.root, 'clients'); mkdirSync(join(clients, '.git'), { recursive: true });
    const clientData = join(t.root, '_client-data'); mkdirSync(join(clientData, '.git'), { recursive: true });
    const clientLane = join(t.root, 'clients-a'); mkdirSync(join(clientLane, '.git'), { recursive: true });
    const clientProject = join(t.root, 'acme-client'); mkdirSync(join(clientProject, '.git'), { recursive: true });
    const hidden = join(t.root, '.hidden-project'); mkdirSync(join(hidden, '.git'), { recursive: true });
    const linked = join(t.root, 'linked-project'); symlinkSync(t.other, linked, 'junction');
    const listed = t.projects.list();
    assert.ok(!listed.some(project => ['_client-data', 'clients', 'clients-a', '.hidden-project', 'linked-project'].includes(project.name)));
    assert.ok(listed.some(project => project.name === 'acme-client'));
    assert.equal(listed.find(project => project.name === 'plain-folder').path, realpathSync(t.plain));
  } finally { t.close(); }
});

test('project registry refuses linked and client-container roots', () => {
  const t = fixture();
  try {
    const link = join(t.root, 'linked');
    symlinkSync(t.other, link, 'junction');
    assert.throws(() => t.projects.register(link), /non-linked/);
    const clients = join(t.root, 'clients'); mkdirSync(join(clients, '.git'), { recursive: true });
    assert.throws(() => t.projects.register(clients), /clients container/);
    const clientLane = join(t.root, 'clients-b'); mkdirSync(join(clientLane, '.git'), { recursive: true });
    assert.throws(() => t.projects.register(clientLane), /clients container/);
    const hidden = join(t.root, '.secret', 'repo'); mkdirSync(join(hidden, '.git'), { recursive: true });
    assert.throws(() => t.projects.register(hidden), /Hidden or secret-shaped/);
  } finally { t.close(); }
});

test('verified Git worktrees are stable lanes and a requested new lane is isolated', () => {
  const t = fixture();
  try {
    execFileSync('git', ['init'], { cwd: t.app, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: t.app });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: t.app });
    execFileSync('git', ['add', '.'], { cwd: t.app });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: t.app, stdio: 'ignore' });
    const initial = t.projects.lanes('paneforge-next');
    assert.equal(initial.length, 1); assert.equal(initial[0].isCurrent, true);
    const lane = t.projects.createLane('paneforge-next', 'client-work');
    assert.equal(lane.name, 'paneforge/client-work');
    assert.ok(lane.path.endsWith('paneforge-next-client-work'));
    assert.equal(t.projects.requireLane('paneforge-next', lane.id).path, lane.path);
    assert.equal(t.projects.laneForCwd('paneforge-next', lane.path).id, lane.id);
    assert.deepEqual(t.projects.projectIds('paneforge-next').sort(), t.projects.projectIds(t.projects.list().find(project => project.id === 'paneforge-next').canonicalProjectId).sort());
    assert.throws(() => t.projects.createLane('paneforge-next', 'client-work'), /already in use/);
    const excluded = join(t.root, '.hidden-lane');
    execFileSync('git', ['worktree', 'add', '-b', 'hidden-lane', excluded], { cwd: t.app, stdio: 'ignore' });
    assert.ok(!t.projects.lanes('paneforge-next').some(candidate => candidate.path === excluded));
    assert.throws(() => t.projects.createLane('paneforge-next', 'env'), /outside the connected project area/);
    assert.throws(() => lstatSync(`${t.app}-env`));
    const listed = t.projects.list().find(project => project.id === 'paneforge-next');
    assert.ok(listed.canonicalProjectId.startsWith('project-')); assert.equal(listed.projectName, 'paneforge-next');
  } finally { t.close(); }
});

test('a long-lived reader refreshes registrations from the atomically replaced registry', () => {
  const t = fixture();
  try {
    const reader = t.projects;
    const writer = new Projects({ root: t.root, defaultPath: t.app, dataDir: join(t.temp, 'data') });
    const registered = writer.register(t.other);
    assert.equal(reader.require(registered.id).name, 'other-app');
    assert.ok(reader.list().some(project => project.id === registered.id));
  } finally { t.close(); }
});

test('directory listing and text reads stay inside each selected project', async () => {
  const t = fixture();
  try {
    const root = await t.projects.children('paneforge-next');
    assert.ok(root.children.some(item => item.path === 'src' && item.type === 'directory'));
    assert.ok(root.children.every(item => !/\.env|node_modules|token/i.test(item.path)));
    const src = await t.projects.children('paneforge-next', 'src');
    assert.ok(src.children.some(item => item.path === 'src/main.ts' && item.type === 'file'));
    assert.ok(src.children.some(item => item.path === 'src/component.jsx' && item.type === 'file'));
    assert.ok(src.children.some(item => item.path === 'src/assistant.py' && item.type === 'file'));
    const read = await t.projects.read('paneforge-next', 'src/main.ts');
    assert.equal(read.text, 'export const visible = true;');
    const python = await t.projects.read('paneforge-next', 'src/assistant.py');
    assert.equal(python.text, 'print("ready")');
    await assert.rejects(t.projects.read('paneforge-next', '../other-app/package.json'), /safe project preview/);
    await assert.rejects(t.projects.read('paneforge-next', '.env'), /safe project preview/);
  } finally { t.close(); }
});
