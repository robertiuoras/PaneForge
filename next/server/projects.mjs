import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { readdir, realpath } from 'node:fs/promises';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';

export const projectsRoot = resolve(process.env.PANEFORGE_PROJECTS_ROOT || join(homedir(), 'Projects'));
const DEFAULT_PROJECT = process.env.PANEFORGE_WORKSPACE_DIR ? resolve(process.env.PANEFORGE_WORKSPACE_DIR) : null;
const MAX_FILE_BYTES = 100_000;
const MAX_CHILDREN = 150;
const MAX_DEPTH = 12;
const MAX_DISCOVERED_PROJECTS = 120;
const SAFE_EXTENSIONS = new Set(['.css', '.html', '.js', '.json', '.jsx', '.md', '.mjs', '.py', '.rs', '.toml', '.ts', '.tsx', '.txt', '.yml', '.yaml']);
const HIDDEN_OR_BUILD = new Set(['node_modules', 'dist', 'build', 'out', 'target', 'coverage', '.git', '.next', '.turbo', '.cache']);
const SECRET_NAME = /(^|[._-])(env|secret|token|credential|password|private|id_rsa|key)([._-]|$)|\.(pem|p12|pfx|key)$/i;

function projectId(path, defaultPath) {
  if (path === defaultPath) return 'paneforge-next';
  return createHash('sha256').update(path).digest('hex').slice(0, 16);
}

function invalid(message, statusCode = 400) {
  const error = Error(message);
  error.statusCode = statusCode;
  throw error;
}

function isUnder(root, path) {
  const part = relative(root, path);
  return part && !part.startsWith(`..${sep}`) && part !== '..' && !part.includes(`..${sep}`);
}

function isRepoRoot(path) {
  const git = join(path, '.git');
  try {
    const info = statSync(git);
    return info.isDirectory() || info.isFile();
  } catch {
    return false;
  }
}

function isClientContainerName(name) {
  return name === '_client-data' || name === 'clients' || /^clients-[a-z]$/i.test(name);
}

// This policy applies both to registered project roots and to Git's reported or
// prospective worktree roots. Git output never broadens the filesystem scope.
function allowedProjectRoot(root, path) {
  if (!isUnder(root, path)) return false;
  const parts = relative(root, path).split(sep);
  return !parts.some(part => part.startsWith('.') || HIDDEN_OR_BUILD.has(part) || SECRET_NAME.test(part)) && !isClientContainerName(basename(path).toLowerCase());
}

function safeRelativePath(path, { directory = false } = {}) {
  if (typeof path !== 'string' || path.length > 300 || path.includes('\0')) return null;
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').some(part => !part || part === '..' || part.startsWith('.') || HIDDEN_OR_BUILD.has(part) || SECRET_NAME.test(part))) return null;
  if (normalized.split('/').length > MAX_DEPTH) return null;
  if (!directory && !SAFE_EXTENSIONS.has(extname(normalized).toLowerCase())) return null;
  return normalized;
}

function canonicalProjectId(project) {
  if (!project.isGit) return project.id;
  try { const common = execFileSync('git', ['-C', project.path, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); return `project-${createHash('sha256').update(common).digest('hex').slice(0, 16)}`; } catch { return project.id; }
}
function group(project) {
  if (!project.isGit) return { canonicalProjectId: project.id, projectName: project.name };
  try {
    const common = execFileSync('git', ['-C', project.path, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    return { canonicalProjectId: canonicalProjectId(project), projectName: basename(resolve(common, '..')) };
  } catch { return { canonicalProjectId: project.id, projectName: project.name }; }
}

function persisted(project) {
  return { id: project.id, name: project.name, path: project.path, isGit: project.isGit, ...group(project) };
}

function laneId(project, path) { return `lane-${createHash('sha256').update(`${canonicalProjectId(project)}:${path}`).digest('hex').slice(0, 16)}`; }
function laneName(path, branch) { return branch ? branch.replace(/^refs\/heads\//, '') : basename(path); }
function worktrees(project) {
  if (!project.isGit) return [{ id: laneId(project, project.path), projectId: project.id, name: project.name, branch: null, path: project.path, isCurrent: true }];
  let output;
  try { output = execFileSync('git', ['-C', project.path, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'pipe'] }); } catch { return []; }
  const records = output.trim().split(/\n\n+/).filter(Boolean).map(record => Object.fromEntries(record.split('\n').map(line => { const [key, ...value] = line.split(' '); return [key, value.join(' ')]; })));
  return records.map(record => {
    if (Object.hasOwn(record, 'bare') || Object.hasOwn(record, 'prunable') || typeof record.worktree !== 'string' || !record.worktree) return null;
    let path; try { const info = lstatSync(record.worktree); if (!info.isDirectory() || info.isSymbolicLink()) return null; path = realpathSync(record.worktree); if (resolve(record.worktree) !== path) return null; } catch { return null; }
    if (!allowedProjectRoot(project.workspaceRoot || projectsRoot, path)) return null;
    const branch = record.branch || null;
    return { id: laneId(project, path), projectId: project.id, name: laneName(path, branch), branch, path, isCurrent: path === project.path };
  }).filter(Boolean).sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || a.name.localeCompare(b.name));
}

export class Projects {
  constructor({ dataDir = resolve(process.env.PANEFORGE_DATA_DIR || '.local-runtime/app'), root = projectsRoot, defaultPath = DEFAULT_PROJECT } = {}) {
    this.dataDir = dataDir;
    this.root = realpathSync(resolve(root));
    this.defaultPath = defaultPath ? realpathSync(resolve(defaultPath)) : null;
    this.file = join(dataDir, 'projects.json');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.projects = this.load();
  }

  load() {
    const records = [];
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
      if (Array.isArray(parsed?.projects)) records.push(...parsed.projects);
    } catch {
      // A missing or damaged local registry never expands access. Keep only the default.
    }
    const projects = [];
    for (const record of [...(this.defaultPath ? [{ path: this.defaultPath }] : []), ...records]) {
      try {
        const project = this.validate(record.path);
        if (!projects.some(item => item.path === project.path)) projects.push(project);
      } catch {
        // Stale entries are intentionally ignored rather than followed.
      }
    }
    return projects;
  }

  refresh() {
    // The MCP process is long-lived and has its own Projects instance. Reloading an
    // atomically replaced registry lets it see registrations made by the supervisor
    // without writing an older in-memory list back over the newer file.
    this.projects = this.load();
    return this.projects;
  }

  save(projects = this.projects) {
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify({ projects: projects.map(persisted) }), { mode: 0o600 });
    renameSync(temporary, this.file);
  }

  validate(value, { requireGit = true } = {}) {
    if (typeof value !== 'string' || !value || value.length > 500 || value.includes('\0')) invalid('Project path is required.');
    const requested = resolve(value);
    let info;
    try { info = lstatSync(requested); } catch { invalid('Project directory does not exist.', 404); }
    if (info.isSymbolicLink() || !info.isDirectory()) invalid('Project must be an existing non-linked directory.');
    let path;
    try { path = realpathSync(requested); } catch { invalid('Project directory is unavailable.', 404); }
    if (!isUnder(this.root, path)) invalid('Projects must be inside /Users/robertiuoras/Projects.');
    if (isClientContainerName(basename(path).toLowerCase())) invalid('The clients container is not a project. Choose one client project instead.');
    if (!allowedProjectRoot(this.root, path)) invalid('Hidden or secret-shaped project roots are not allowed.');
    const isGit = isRepoRoot(path);
    if (requireGit && !isGit) invalid('Project must be a Git repository root.');
    return { id: projectId(path, this.defaultPath), name: basename(path), path, isGit, workspaceRoot: this.root };
  }

  discover() {
    const projects = [];
    let entries;
    try { entries = readdirSync(this.root, { withFileTypes: true }); } catch { return projects; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (projects.length >= MAX_DISCOVERED_PROJECTS) break;
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.') || HIDDEN_OR_BUILD.has(entry.name) || SECRET_NAME.test(entry.name) || isClientContainerName(entry.name.toLowerCase())) continue;
      try { projects.push(this.validate(join(this.root, entry.name), { requireGit: false })); } catch { /* Unsafe and stale folders are not workspace choices. */ }
    }
    return projects;
  }

  available() {
    const projects = [...this.projects];
    for (const project of this.discover()) if (!projects.some(item => item.path === project.path)) projects.push(project);
    return projects.sort((a, b) => a.name.localeCompare(b.name));
  }

  list() { this.refresh(); return this.available().map(persisted); }

  require(id) {
    this.refresh();
    const project = this.available().find(item => item.id === id);
    if (!project) invalid('Project is not connected.', 404);
    return project;
  }

  register(path) {
    const project = this.validate(path);
    this.refresh();
    if (!this.projects.some(item => item.path === project.path)) {
      this.projects.push(project);
      this.projects.sort((a, b) => a.name.localeCompare(b.name));
      this.save();
    }
    return this.projects.find(item => item.path === project.path);
  }

  lanes(id) { const project = this.require(id); return worktrees(project); }

  projectIds(id) {
    const projects = this.available();
    const direct = projects.find(project => project.id === id);
    const canonical = direct ? canonicalProjectId(direct) : id;
    const matches = projects.filter(project => canonicalProjectId(project) === canonical).map(project => project.id);
    if (matches.length) return matches;
    invalid('Project is not connected.', 404);
  }

  requireLane(projectId, id) {
    if (typeof id !== 'string' || !id) invalid('Lane identity is required.');
    const lane = this.lanes(projectId).find(candidate => candidate.id === id);
    if (!lane) invalid('Lane is not available for this project.', 404);
    return lane;
  }

  laneForCwd(projectId, cwd) {
    if (typeof cwd !== 'string') return null;
    let actual; try { actual = realpathSync(cwd); } catch { return null; }
    return this.lanes(projectId).find(lane => lane.path === actual) || null;
  }

  scope(projectId, cwd) {
    const project = this.require(projectId);
    const lane = this.laneForCwd(projectId, cwd);
    if (!lane) invalid('Conversation lane is no longer available for this project.', 404);
    return { ...project, path: lane.path };
  }

  createLane(projectId, name) {
    const project = this.require(projectId);
    if (!project.isGit) invalid('An isolated lane requires a Git project.');
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,60}$/i.test(name)) invalid('Lane name must use letters, numbers, dots, underscores, or hyphens.');
    const target = resolve(`${project.path}-${name}`);
    if (!allowedProjectRoot(this.root, target) || target === project.path) invalid('Lane path is outside the connected project area.');
    try { lstatSync(target); invalid('Lane name is already in use.', 409); } catch (error) { if (error.statusCode) throw error; if (error.code !== 'ENOENT') throw error; }
    try { execFileSync('git', ['-C', project.path, 'worktree', 'add', '-b', `paneforge/${name}`, target], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (error) { invalid(`Could not create isolated lane: ${String(error.stderr || error.message).trim().slice(0, 180)}`, 409); }
    return this.lanes(projectId).find(lane => lane.path === realpathSync(target)) || invalid('Created lane could not be verified.', 503);
  }

  async children(id, directory = '', cwd = null) {
    const project = cwd === null ? this.require(id) : this.scope(id, cwd);
    const rel = directory === '' ? '' : safeRelativePath(directory, { directory: true });
    if (directory !== '' && !rel) invalid('Directory is outside this project.');
    const target = resolve(project.path, rel || '.');
    const root = await realpath(project.path);
    let actual;
    try { actual = await realpath(target); } catch { invalid('Directory does not exist.', 404); }
    if (actual !== target || (actual !== root && !actual.startsWith(`${root}${sep}`))) invalid('Linked paths are not available.');
    let entries;
    try { entries = await readdir(actual, { withFileTypes: true }); } catch { invalid('Directory is unavailable.', 404); }
    const children = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (children.length >= MAX_CHILDREN || entry.name.startsWith('.') || HIDDEN_OR_BUILD.has(entry.name) || SECRET_NAME.test(entry.name)) continue;
      const childPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) children.push({ path: childPath, type: 'directory' });
      else if (entry.isFile() && safeRelativePath(childPath)) {
        const info = statSync(join(actual, entry.name));
        if (info.size <= MAX_FILE_BYTES) children.push({ path: childPath, type: 'file', bytes: info.size });
      }
    }
    return { project: persisted(project), directory: rel, children, limit: MAX_CHILDREN };
  }

  async read(id, path, cwd = null) {
    const project = cwd === null ? this.require(id) : this.scope(id, cwd);
    const rel = safeRelativePath(path);
    if (!rel) invalid('File is outside the safe project preview.');
    const target = resolve(project.path, rel);
    const root = await realpath(project.path);
    let actual;
    try { actual = await realpath(target); } catch { invalid('File does not exist.', 404); }
    if (actual !== target || !actual.startsWith(`${root}${sep}`)) invalid('Linked paths are not available.');
    const info = statSync(actual);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) invalid('File is not a bounded source preview.');
    const bytes = readFileSync(actual);
    if (bytes.includes(0)) invalid('File is not a text source preview.');
    const text = bytes.toString('utf8');
    return { project: persisted(project), path: rel, bytes: info.size, text };
  }
}
