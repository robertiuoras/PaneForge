// Two agents in one folder is the one setup that reliably breaks: they clobber
// each other's edits, race the git index, and fight over the dev server port. A
// git worktree gives each session its own checkout and its own branch off the
// same repo, so "open a second session here" stops being a trap.
//
// This runs on the way in to a session start: the second session in a folder is
// moved into `<repo>-a` without being asked, the third into `-b`, and so on.
// Nothing is ever moved out of the original folder - the first session keeps it.
//
// The letters are shared, not decorative. scripts/lane.mjs - the half that merges
// finished lanes back and cuts releases - has always called its checkouts `<repo>-a`
// on branch `lane-a`, while this half made `<repo>-w2` on `pf/w2`. Two systems, one
// idea, two vocabularies: a Projects folder ended up holding `Toolstash-a` next to
// `Toolstash-w2` with nothing to say what the difference was, and the prompt hook -
// which asks for the lane matching the folder a chat sits in - would ask lane.mjs for
// a lane called `w2` and have it try to create `lane-w2` on top of the `pf/w2`
// worktree already there. They are one naming scheme now. Lanes made under the old
// one keep working (laneWork.ts still reads, merges and sweeps `-w<N>`/`pf/w<N>`);
// they are simply never created again, and disappear once their work has landed.

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import type { Dirent } from 'node:fs'
import { link, mkdir, readdir, readlink, symlink } from 'node:fs/promises'
import { execFile, execFileSync } from 'node:child_process' // sync-on-purpose: ensureLaneFolder only
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

/**
 * Every lane label, in the order they are handed out: `<repo>-a`, then `-b`, and so on.
 * Past the end of this list the folder is genuinely oversubscribed and the session shares.
 *
 * Letters rather than numbers because a pane already carries a NUMBER (its Ctrl+N switch
 * key), and two digits on one card with nothing to say which is which is the confusion this
 * replaced. It is also the alphabet scripts/lane.mjs has always used for the same folders.
 */
const LANE_LABELS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const
const MAX_LANES = LANE_LABELS.length

/**
 * Dev-server port a lane starts from when the project never names one.
 *
 * 3000 is deliberate: the lane gets `base + laneIndex - 1`, so an undetected
 * project lands on 3001 and up - clear of every default a project that named
 * nothing is likely to actually use (3000, 5173, 8080, 4200, 1420).
 */
const FALLBACK_PORT = 3000

export interface Lane {
  /** folder the session should actually start in */
  cwd: string
  /** lane label ("w2") when the session was moved, undefined when it was not */
  lane?: string
  /** branch checked out in the lane, for the message shown to the user */
  branch?: string
  /** why no lane was made, when one was wanted - shown once, never fatal */
  note?: string
  /** extra environment the session is launched with - the lane's own dev port */
  env?: Record<string, string>
  /** the port that env hands the lane, for the message shown to the user */
  port?: number
  /** the lane reuses the original folder's Claude Code project memory */
  sharedMemory?: boolean
}

export interface LaneExtras {
  env: Record<string, string>
  port: number
  sharedMemory: boolean
}

/**
 * Run git without blocking the window.
 *
 * `spawnSync` here froze the Electron main process for as long as git took, and this one
 * runs on the pane-open path: every second session in a repo paid it before its terminal
 * appeared, and a slow git held the whole window - every other pane included - for up to
 * the full 15s timeout. Same reasoning, and the same measurement, as laneWork.ts's run().
 */
function git(cwd: string, args: string[], timeout = 15000): Promise<{ ok: boolean; out: string }> {
  return new Promise((done) => {
    execFile(
      'git',
      args,
      { cwd, encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        done({ ok: !err, out: (stdout ?? '').trim() || (stderr ?? '').trim() })
      }
    )
  })
}

/** Windows paths differ in case and slash direction for the same folder. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => resolve(p).replace(/[\\/]+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

/**
 * The repo a folder belongs to, following a worktree back to its main checkout.
 * `--git-common-dir` is the shared `.git` of the whole repo, so a lane asked to
 * spawn another lane still branches off the original, not off itself.
 */
async function mainRepo(cwd: string): Promise<string | null> {
  const common = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!common.ok || !common.out) return null
  const dir = common.out.split(/\r?\n/)[0]
  // `<repo>/.git` normally; a bare or unusual layout is left alone.
  if (!/[\\/]\.git$/.test(dir)) return null
  const root = dirname(dir)
  return existsSync(root) ? root : null
}

/** Is this folder already a checkout of the same repo (ours to reuse)? */
async function isWorktreeOf(candidate: string, repo: string): Promise<boolean> {
  if (!existsSync(candidate)) return false
  const root = await mainRepo(candidate)
  return Boolean(root && samePath(root, repo))
}

/**
 * Copy the files a fresh checkout cannot have: `.env` and friends are gitignored
 * by design, so a lane without them fails on the first run for reasons that look
 * nothing like "you are in a new folder". Root and one level down covers the
 * usual `backend/.env`, `mobile/.env` layout; nothing else is touched.
 */
function seedEnvFiles(repo: string, lane: string): void {
  const envish = (name: string): boolean => /^\.env(\.|$)/.test(name)
  const copy = (rel: string): void => {
    const from = join(repo, rel)
    const to = join(lane, rel)
    if (!existsSync(from) || existsSync(to)) return
    try {
      // The subfolder may not exist yet: a `backend/` that holds nothing but an
      // ignored .env is not in the checkout at all.
      mkdirSync(dirname(to), { recursive: true })
      copyFileSync(from, to)
    } catch {
      /* locked or unreadable - the lane still works, it just needs its own copy */
    }
  }
  try {
    for (const e of readdirSync(repo, { withFileTypes: true })) {
      if (e.isFile() && envish(e.name)) copy(e.name)
      if (!e.isDirectory() || e.name === '.git' || e.name === 'node_modules') continue
      try {
        for (const f of readdirSync(join(repo, e.name), { withFileTypes: true })) {
          if (f.isFile() && envish(f.name)) copy(join(e.name, f.name))
        }
      } catch {
        /* unreadable subfolder */
      }
    }
  } catch {
    /* unreadable repo root - lane still usable */
  }
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** A number that could plausibly be a dev server's port, or null. */
function asPort(raw: string | undefined): number | null {
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1024 && n <= 65000 ? n : null
}

/**
 * The port this project's dev server actually wants.
 *
 * A lane is useless for running the app if it collides with the original on one
 * port, and "just use 3000" is wrong for most repos. So read it out of the place
 * the project already states it - a `--port` in the dev script, `server.port` in
 * a vite/next config, Tauri's `devUrl`, a `PORT=` in `.env` - and fall back to
 * what the framework in the dev script defaults to.
 *
 * A wrong guess here costs nothing: the lane gets a port near it either way, and
 * a project that ignores PORT was never going to be moved by us.
 */
function detectDevPort(repo: string): number | null {
  const pkg = readText(join(repo, 'package.json'))
  if (pkg) {
    let scripts = ''
    try {
      const parsed = JSON.parse(pkg) as { scripts?: Record<string, string> }
      scripts = Object.values(parsed.scripts ?? {}).join(' ; ')
    } catch {
      scripts = pkg
    }
    const flag = scripts.match(/--port[= ]"?(\d{3,5})|(?:^|\s)-p[= ](\d{3,5})|PORT=(\d{3,5})/)
    const stated = flag && asPort(flag[1] ?? flag[2] ?? flag[3])
    if (stated) return stated
    // Nothing stated: the framework's own default is still better than a guess,
    // because that is the port the original folder is sitting on right now.
    const dev = scripts
    if (/\bnext\b/.test(dev)) return 3000
    if (/\bng serve\b/.test(dev)) return 4200
    if (/\btauri\b/.test(dev)) return 1420
    if (/\bnuxt\b/.test(dev)) return 3000
    if (/\bremix\b/.test(dev)) return 3000
    if (/\bexpo\b/.test(dev)) return 8081
    if (/\bstorybook\b/.test(dev)) return 6006
    if (/\bvue-cli-service\b/.test(dev)) return 8080
    if (/\b(vite|astro)\b/.test(dev)) return 5173
  }

  for (const rel of [
    'vite.config.ts',
    'vite.config.js',
    'vite.config.mjs',
    'electron.vite.config.ts',
    'next.config.js',
    'next.config.mjs',
    'nuxt.config.ts',
    'astro.config.mjs',
    'svelte.config.js',
    'src-tauri/tauri.conf.json',
    'docker-compose.yml',
    'docker-compose.yaml',
    'compose.yaml',
    '.env',
    '.env.local'
  ]) {
    const text = readText(join(repo, rel))
    if (!text) continue
    // A compose file states the port the host actually gets, on the left of the
    // colon: `- "8080:80"`. Reading the right-hand side would hand the lane the
    // container's port, which nothing on the machine is listening on.
    if (/^(docker-)?compose\./.test(basename(rel))) {
      const mapped = text.match(/^\s*-\s*"?(\d{3,5}):\d{2,5}/m)
      const host = mapped && asPort(mapped[1])
      if (host) return host
      continue
    }
    const m = text.match(/\bport"?\s*[:=]\s*"?(\d{3,5})|localhost:(\d{3,5})|^\s*PORT\s*=\s*(\d{3,5})/m)
    const found = m && asPort(m[1] ?? m[2] ?? m[3])
    if (found) return found
  }

  // Nothing in the JS-shaped places, so this is one of the many repos that is not
  // a JS project at all. Every one of these has a dev server on a well-known port,
  // and handing them all the same 3000 fallback puts two Django lanes on the same
  // port as each other and as whatever else on the machine wanted 3000.
  const has = (rel: string): boolean => existsSync(join(repo, rel))
  if (has('manage.py')) return 8000 // Django
  if (has('artisan')) return 8000 // Laravel
  if (has('config.ru') || has('Gemfile')) return 3000 // Rails / Rack
  if (has('Cargo.toml')) return 8080 // axum/actix convention
  if (has('go.mod')) return 8080
  const py = `${readText(join(repo, 'pyproject.toml'))}\n${readText(join(repo, 'requirements.txt'))}`
  if (/\bflask\b/i.test(py)) return 5000
  if (/\b(fastapi|uvicorn|starlette)\b/i.test(py)) return 8000
  if (py.trim()) return 8000
  for (const rel of ['Properties/launchSettings.json', 'src/Properties/launchSettings.json']) {
    const url = readText(join(repo, rel)).match(/https?:\/\/localhost:(\d{3,5})/)
    const found = url && asPort(url[1])
    if (found) return found
  }
  return null
}

/**
 * Is this port actually free right now?
 *
 * Both addresses are tried because they are not the same question: a dev server
 * bound to 127.0.0.1 leaves 0.0.0.0 bindable on Windows, so testing only the
 * wildcard reports a busy port as free and the lane is handed a collision.
 */
function portFree(port: number): Promise<boolean> {
  const bind = (host: string): Promise<boolean> =>
    new Promise((done) => {
      const srv = createServer()
      srv.once('error', () => done(false))
      srv.once('listening', () => srv.close(() => done(true)))
      try {
        srv.listen(port, host)
      } catch {
        done(false)
      }
    })
  return bind('127.0.0.1').then((ok) => (ok ? bind('0.0.0.0') : false))
}

/**
 * The first free port at or after `from`.
 *
 * `base + laneIndex` alone is a guess, and it is wrong exactly when it matters:
 * the second lane of a Next project asks for 3001, which is also what the first
 * lane of every other Next project on the machine asked for. Two lanes then race
 * for one port and the loser's dev server dies on startup with EADDRINUSE, which
 * reads as "the lane is broken". Probing costs a few milliseconds once per lane.
 */
async function freePort(from: number): Promise<number> {
  for (let p = from; p < Math.min(from + 40, 65000); p++) {
    if (await portFree(p)) return p
  }
  return from
}

/**
 * A compose project name for this lane: lowercase, and starting with a letter or
 * digit, because compose rejects anything else and a repo called `.dotfiles` or
 * `My_App` would take the whole `up` down with it.
 */
function composeProject(repo: string, label: string): string {
  const cleaned = basename(repo)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
  return `${cleaned || 'project'}-${label}`
}

/**
 * A lane's position among the checkouts of its project, counting the project's own folder
 * as 1. So the first lane is 2, which is what the dev-server port offset has always meant.
 *
 * "a" -> 2, "b" -> 3, and the legacy "w2" -> 2 for lanes made before the labels changed,
 * so an old lane's port does not move under a running dev server. Anything unparseable is
 * treated as the first lane.
 */
function laneIndex(label: string): number {
  const letter = LANE_LABELS.indexOf(label as (typeof LANE_LABELS)[number])
  if (letter >= 0) return letter + 2
  const n = Number(label.replace(/^\D+/, ''))
  return Number.isInteger(n) && n >= 2 ? n : 2
}

/** Claude Code's config folder, honouring the override it reads itself. */
function claudeHome(): string {
  const override = process.env.CLAUDE_CONFIG_DIR?.trim()
  return override || join(homedir(), '.claude')
}

/**
 * Claude Code's per-folder key: every path separator and the drive colon becomes
 * a dash, and nothing else is touched (`taskdriver.ai` keeps its dot).
 */
function projectKey(path: string): string {
  return resolve(path).replace(/[\\/:]/g, '-')
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * Give the lane the original folder's Claude Code memory instead of a blank one.
 *
 * Claude Code keys a project by its folder path, so a session moved into
 * `<repo>-w2` starts with no transcripts, no /resume, and no project memory -
 * the lane is the same codebase, but the agent in it has amnesia. That is the
 * one real cost of auto-laning, and it is fixable: point the lane's project
 * folder at the original's with a junction (Windows) or a directory symlink, and
 * both see one history. Concurrent sessions do not fight over it - a transcript
 * is one file per session id.
 *
 * Returns whether the lane now shares memory. Never throws: a lane with its own
 * empty history is still a working lane.
 */
function shareClaudeMemory(repo: string, lane: string): boolean {
  const projects = join(claudeHome(), 'projects')
  // Claude Code has never run on this machine - nothing to share, and creating
  // its folder layout for it is not our business.
  if (!existsSync(projects)) return false

  const laneDir = join(projects, projectKey(lane))
  if (isLink(laneDir)) {
    // Already pointed somewhere by an earlier run of this lane.
    try {
      return existsSync(resolve(dirname(laneDir), readlinkSync(laneDir)))
    } catch {
      return true
    }
  }
  // A real folder means the lane already has its own transcripts. Replacing it
  // would throw that work away, so it keeps them.
  if (existsSync(laneDir)) return false

  const target = join(projects, projectKey(repo))
  try {
    // The original may have no folder yet (first ever session in this repo went
    // straight to a lane). Making it now means both directions share from here.
    if (!existsSync(target)) mkdirSync(target, { recursive: true })
    symlinkSync(target, laneDir, process.platform === 'win32' ? 'junction' : 'dir')
    return true
  } catch {
    /* no symlink privilege (junctions need none, but a locked profile can fail) */
    return false
  }
}

/**
 * The folders a project installs into, which git never checks out.
 *
 * `node_modules` alone covered exactly one ecosystem: a Python, PHP or Ruby repo
 * got a lane with no interpreter environment at all, so the first command the
 * agent ran there failed on a missing module and the lane looked broken. These
 * are the four that are both universally named and genuinely absent from a fresh
 * worktree. Rust's `target` is deliberately not here - cargo stores absolute
 * paths in its fingerprints, so a cloned target is rebuilt anyway, and the walk
 * over a six-figure file count would cost more than the rebuild it saves.
 */
const DEP_DIRS = ['node_modules', '.venv', 'venv', 'vendor']

/** Past this a tree is big enough that cloning it costs more than installing. */
const MAX_DEP_FILES = 150_000
/** Lanes whose dependency clone is still running, so a reuse cannot start a second. */
const cloning = new Set<string>()

/**
 * A directory junction to the repo's `node_modules` was the obvious way to do
 * this and it is a trap: `git worktree remove` on Windows walks into the junction
 * and deletes the real dependency tree out of the original folder, leaving the
 * first session broken by a tidy-up in the second. Verified on git 2.53.
 *
 * Hardlinks do not have that failure. Each file in the lane is a second name for
 * the same bytes, so the clone costs no disk, and deleting either name leaves the
 * other file whole. An install inside the lane replaces files rather than editing
 * them in place, so the two trees simply drift apart from then on.
 */
async function hardlinkTree(from: string, to: string, budget: { left: number }): Promise<void> {
  const dirs: Array<[string, string]> = [[from, to]]
  const files: Array<[string, string]> = []
  const links: Array<[string, string]> = []

  // Walk first, link second. Recursing and linking together sounds tidier and is
  // several times slower: every file waits behind the directory listing above it,
  // when the whole point is to keep a pool of link calls busy.
  for (let i = 0; i < dirs.length; i++) {
    const [src, dst] = dirs[i]
    let entries: Dirent[]
    try {
      entries = await readdir(src, { withFileTypes: true })
    } catch {
      continue /* vanished mid-walk - an install running in the original folder */
    }
    for (const e of entries) {
      if (budget.left-- <= 0) throw new Error('dependency tree too large to clone')
      const pair: [string, string] = [join(src, e.name), join(dst, e.name)]
      if (e.isDirectory()) dirs.push(pair)
      // Workspace packages and POSIX `.bin` shims are links; copying what they
      // point at would silently fork a local package away from its source.
      else if (e.isSymbolicLink()) links.push(pair)
      else if (e.isFile()) files.push(pair)
    }
  }

  for (const [, dst] of dirs) await mkdir(dst, { recursive: true })
  for (const [src, dst] of links) {
    try {
      await symlink(await readlink(src), dst)
    } catch {
      /* a broken or unreadable link is not worth failing the whole clone over */
    }
  }

  // Each hardlink is one syscall on a libuv thread; a wide pool keeps them all
  // busy while the app stays responsive, because none of this is on the main
  // thread. Narrow pools are what made this take a minute instead of seconds.
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < files.length) {
      const [src, dst] = files[next++]
      try {
        await link(src, dst)
      } catch {
        /* one unreadable file should not sink the tree */
      }
    }
  }
  await Promise.all(Array.from({ length: 64 }, worker))
}

/**
 * Point a cloned virtualenv at the lane it now lives in.
 *
 * A venv is the one dependency folder that knows its own absolute path: it is
 * written into `pyvenv.cfg`, into `VIRTUAL_ENV` in every activate script, and
 * into the shebang of every console script pip installed. Cloned untouched, the
 * lane's `.venv/bin/pytest` runs the *original* folder's interpreter against the
 * *original* folder's packages - the exact cross-checkout bleed lanes exist to
 * prevent, and invisible while the two trees still match.
 *
 * The file must be deleted before it is rewritten. Every file in here is a
 * hardlink at this point, so writing through it would edit the original venv as
 * well and break the first session's environment - the same class of damage the
 * junction approach caused, arriving by a different door.
 */
function repointVenv(from: string, to: string): void {
  if (!/^\.?venv$/i.test(basename(to))) return
  const forms: Array<[string, string]> = [
    [resolve(from), resolve(to)],
    [resolve(from).replace(/\\/g, '/'), resolve(to).replace(/\\/g, '/')]
  ]

  const rewrite = (file: string): void => {
    try {
      const stat = lstatSync(file)
      if (!stat.isFile() || stat.size > 512 * 1024) return
      const buf = readFileSync(file)
      // A console script on Windows is an .exe with the path inside a zip
      // trailer; there is no safe text edit for it, and `python -m` works.
      if (buf.subarray(0, 4096).includes(0)) return
      let text = buf.toString('utf8')
      const before = text
      for (const [a, b] of forms) if (text.includes(a)) text = text.split(a).join(b)
      if (text === before) return
      rmSync(file, { force: true })
      writeFileSync(file, text, 'utf8')
    } catch {
      /* unreadable or locked - the venv still resolves, just to the original */
    }
  }

  rewrite(join(to, 'pyvenv.cfg'))
  for (const dir of ['bin', 'Scripts']) {
    try {
      for (const e of readdirSync(join(to, dir), { withFileTypes: true })) {
        if (e.isFile()) rewrite(join(to, dir, e.name))
      }
    } catch {
      /* the other platform's layout is simply not there */
    }
  }
}

/**
 * Give a lane the dependencies the repo already has, without blocking anything.
 *
 * A worktree is a clean checkout, so it has no `node_modules`: the first build,
 * test or dev server an agent runs in a fresh lane fails with a missing module,
 * which reads as "this lane is broken" rather than "nothing is installed here
 * yet". The clone takes seconds, so it runs after the session has already
 * started, and lands in a temporary folder that is renamed into place only once
 * it is complete - a half-populated `node_modules` fails in far stranger ways
 * than an absent one.
 */
function cloneDeps(repo: string, lane: string): void {
  const rels = [...DEP_DIRS]
  try {
    // Monorepo layouts install per package (`backend/node_modules`, `api/.venv`);
    // one level down is the same depth the .env seeding covers.
    for (const e of readdirSync(repo, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === '.git' || DEP_DIRS.includes(e.name)) continue
      for (const dep of DEP_DIRS) rels.push(join(e.name, dep))
    }
  } catch {
    /* unreadable repo root - the root tree below is the one that matters */
  }

  for (const rel of rels) {
    const from = join(repo, rel)
    const to = join(lane, rel)
    const tmp = `${to}.pf-tmp`
    // Only where the repo actually installed, only where the lane checked the
    // folder out, and never over something the lane already has.
    if (!existsSync(from) || existsSync(to) || !existsSync(dirname(to))) continue
    if (cloning.has(to)) continue
    cloning.add(to)

    void (async () => {
      try {
        rmSync(tmp, { recursive: true, force: true })
        await hardlinkTree(from, tmp, { left: MAX_DEP_FILES })
        // An install the agent kicked off in the meantime wins; drop ours.
        if (existsSync(to)) rmSync(tmp, { recursive: true, force: true })
        else {
          renameSync(tmp, to)
          repointVenv(from, to)
        }
      } catch {
        // Different volume, no permission, or an oversized tree: leave the lane
        // without dependencies rather than with a partial set. An install there
        // then behaves exactly like a fresh clone of the repo.
        try {
          rmSync(tmp, { recursive: true, force: true })
        } catch {
          /* nothing more to do */
        }
      } finally {
        cloning.delete(to)
      }
    })()
  }
}

/**
 * Copy the original folder's Claude Code project settings onto the lane path.
 *
 * The transcripts live in `projects/` and are handled by the junction above, but
 * trust, allowed tools and MCP servers are keyed by path inside `.claude.json`.
 * Without this the lane opens on the "do you trust this folder?" prompt and has
 * forgotten every permission you granted - for a checkout of a repo you are
 * already working in. Only what the original folder already had is copied;
 * nothing is granted that was not granted there.
 *
 * Both slash forms are written because Claude Code keys on its own `cwd` string,
 * and that arrives as `C:\repo` or `C:/repo` depending on how it was launched.
 */
function seedClaudeProjectSettings(repo: string, lane: string): void {
  // Lives beside the config folder when one is set, in the home folder otherwise.
  const path = [join(claudeHome(), '.claude.json'), join(homedir(), '.claude.json')].find((p) =>
    existsSync(p)
  )
  if (!path) return

  const KEEP = [
    'allowedTools',
    'mcpContextUris',
    'mcpServers',
    'enabledMcpjsonServers',
    'disabledMcpjsonServers',
    'hasTrustDialogAccepted',
    'hasCompletedProjectOnboarding',
    'projectOnboardingSeenCount',
    'hasClaudeMdExternalIncludesApproved',
    'hasClaudeMdExternalIncludesWarningShown',
    'exampleFiles',
    'history'
  ]
  const forms = (p: string): string[] => [resolve(p), resolve(p).replace(/\\/g, '/')]

  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as {
      projects?: Record<string, Record<string, unknown>>
    }
    if (!data.projects) return
    // Already seeded, or the lane has its own settings: leave it alone.
    if (forms(lane).some((k) => data.projects![k])) return

    const from = forms(repo)
      .map((k) => data.projects![k])
      .find(Boolean)
    if (!from) return

    const entry: Record<string, unknown> = {}
    for (const k of KEEP) if (k in from) entry[k] = from[k]
    // Prompt history is the largest field by far and only the recent end of it is
    // any use; the whole thing per lane would bloat a file read on every launch.
    if (Array.isArray(entry.history)) entry.history = (entry.history as unknown[]).slice(0, 50)
    for (const k of forms(lane)) data.projects[k] = { ...entry }

    // Write-then-rename: this file is Claude Code's own, and a torn write would
    // cost the user every setting in it.
    const tmp = `${path}.paneforge.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    renameSync(tmp, path)
  } catch {
    /* unreadable or being written by a live session - the lane still works */
  }
}

/**
 * Carry the original folder's Codex approval onto the lane path.
 *
 * PaneForge runs thirteen CLIs, and until now exactly one of them - Claude Code -
 * had its per-folder state carried into a lane. A Codex user got the feature's
 * downside (a strange new folder) with none of its upside: Codex keys trust by
 * absolute path in `~/.codex/config.toml`, so every lane opened on the approval
 * prompt for a repo already approved one folder over.
 *
 * The file is TOML and this appends one section rather than parsing it, because a
 * parse-and-reserialise would reformat a file the user owns and Codex writes
 * concurrently. Nothing is granted that the original folder was not already
 * granted, and a repo that was never trusted is left untrusted.
 */
function seedCodexTrust(repo: string, lane: string): void {
  const home = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')
  const path = join(home, 'config.toml')
  if (!existsSync(path)) return
  // Codex writes these keys lowercased, and a path holding a quote cannot be
  // expressed in this quoting style at all - both are left alone rather than
  // guessed at.
  const key = (p: string): string => resolve(p).toLowerCase()
  if (key(lane).includes("'") || key(repo).includes("'")) return

  try {
    const text = readFileSync(path, 'utf8')
    const header = (p: string): string => `[projects.'${key(p)}']`
    if (text.includes(header(lane))) return
    const at = text.indexOf(header(repo))
    if (at < 0) return

    // The section runs to the next header or the end of the file.
    const rest = text.slice(at + header(repo).length)
    const end = rest.search(/\r?\n\[/)
    const body = (end < 0 ? rest : rest.slice(0, end)).replace(/\s+$/, '')
    const next = `${text.replace(/\s+$/, '')}\n\n${header(lane)}${body}\n`

    // Write-then-rename: this is Codex's own file and a torn write would cost the
    // user every setting in it.
    const tmp = `${path}.paneforge.tmp`
    writeFileSync(tmp, next, 'utf8')
    renameSync(tmp, path)
  } catch {
    /* unreadable, or Codex is writing it right now - the lane still works */
  }
}

/**
 * What a lane needs beyond its folder: a dev-server port of its own, and the
 * original folder's agent memory.
 *
 * Split out from resolveLane() so a lane restored after an app update (which
 * already knows its folder and label, and must not be moved again) gets the same
 * treatment as one being created.
 */
export async function laneExtras(laneCwd: string, label: string): Promise<LaneExtras> {
  const repo = (await mainRepo(laneCwd)) ?? laneCwd
  const base = detectDevPort(repo) ?? FALLBACK_PORT
  const port = await freePort(Math.min(base + laneIndex(label) - 1, 65000))
  const moved = !samePath(repo, laneCwd)
  const sharedMemory = moved ? shareClaudeMemory(repo, laneCwd) : false
  if (sharedMemory) seedClaudeProjectSettings(repo, laneCwd)
  // Not gated on the Claude share: a lane running Codex still opens on a trust
  // prompt for a repo the user already approved, whether or not Claude is even
  // installed on this machine.
  if (moved) seedCodexTrust(repo, laneCwd)
  return {
    env: {
      // PORT is what most dev servers read on their own (Next, CRA, Nuxt, Nitro,
      // anything Express-shaped). The other two are for the ones that do not:
      // the launch toast states the number so `--port $PORT` is one keystroke.
      PORT: String(port),
      PF_LANE: label,
      PF_LANE_PORT: String(port),
      // A port is not the only thing two lanes fight over. `docker compose`
      // derives container, network and volume names from the folder name, and a
      // worktree called `<repo>-w2` is close enough to `<repo>` in some layouts -
      // and identical when compose is run from a subfolder both lanes share - that
      // `compose up` in the second lane recreates the first lane's containers out
      // from under it. Naming the project after the lane keeps the two stacks
      // apart, and `compose down` in a lane stops only its own.
      COMPOSE_PROJECT_NAME: composeProject(repo, label)
    },
    port,
    sharedMemory
  }
}

/**
 * Per-machine agent config lives outside git on purpose, and a lane without it
 * re-asks for every permission the original folder already answered. Only the
 * local settings files are copied; anything else is the checkout's business.
 */
function seedLocalConfig(repo: string, lane: string): void {
  // One entry per agent that keeps per-repo settings outside git. A name that is
  // wrong or that the user does not use costs nothing: the file is not there and
  // the copy is skipped.
  for (const rel of [
    join('.claude', 'settings.local.json'),
    join('.vscode', 'settings.json'),
    join('.cursor', 'mcp.json'),
    join('.gemini', 'settings.json'),
    join('.qwen', 'settings.json'),
    join('.opencode', 'opencode.json'),
    join('.goose', 'config.yaml'),
    '.crush.json',
    '.aider.conf.yml',
    '.mcp.json'
  ]) {
    const from = join(repo, rel)
    const to = join(lane, rel)
    if (!existsSync(from) || existsSync(to)) continue
    try {
      mkdirSync(dirname(to), { recursive: true })
      copyFileSync(from, to)
    } catch {
      /* not fatal - the lane just starts with defaults */
    }
  }
}

/** Everything a fresh checkout needs before an agent is dropped into it. */
function seedLane(repo: string, lane: string): void {
  seedEnvFiles(repo, lane)
  seedLocalConfig(repo, lane)
  cloneDeps(repo, lane)
  // `git worktree add` checks out the superproject and leaves every submodule as
  // an empty folder, so a repo that keeps its SDK, theme or protobufs in one gets
  // a lane that cannot build and does not say why. Not awaited - a submodule
  // fetch is network-bound and the pane should already be open - and a no-op on
  // the repos that have none, or on a lane that was seeded once before.
  if (existsSync(join(lane, '.gitmodules'))) {
    void git(lane, ['submodule', 'update', '--init', '--recursive'], 180000)
  }
}

/**
 * Where a new session in `cwd` should really run, given the folders live sessions
 * already hold.
 *
 * Returns `cwd` unchanged when nothing else is using it, when it is not a git
 * repo (there is no safe way to split a plain folder), or when every lane is
 * taken. Creating a lane is a few git calls and only happens on the second and
 * later session in one repo, so the common launch pays nothing.
 */
export async function resolveLane(cwd: string, taken: string[]): Promise<Lane> {
  const clash = taken.some((t) => samePath(t, cwd))
  if (!clash) return { cwd }

  const repo = await mainRepo(cwd)
  if (!repo) {
    return { cwd, note: 'Second session in the same folder - not a git repo, so both share it.' }
  }

  const parent = dirname(repo)
  const name = basename(repo)
  for (const label of LANE_LABELS) {
    const path = join(parent, `${name}-${label}`)
    if (taken.some((t) => samePath(t, path))) continue

    const branch = `lane-${label}`
    if (existsSync(path)) {
      // Left behind by an earlier session and nobody is in it: reuse rather than
      // pile up folders. Anything at that path that is not this repo is skipped.
      if (!(await isWorktreeOf(path, repo))) continue
      seedLane(repo, path)
      const head = await git(path, ['rev-parse', '--abbrev-ref', 'HEAD'])
      return {
        cwd: path,
        lane: label,
        branch: head.ok ? head.out : branch,
        ...(await laneExtras(path, label))
      }
    }

    // New branch off whatever the repo has checked out now. If the branch already
    // exists from a previous lane, check that out instead of failing.
    let made = await git(repo, ['worktree', 'add', '-b', branch, path])
    if (!made.ok) made = await git(repo, ['worktree', 'add', path, branch])
    if (!made.ok) {
      return { cwd, note: `Could not create a worktree lane: ${made.out.split('\n')[0]}` }
    }
    seedLane(repo, path)
    return { cwd: path, lane: label, branch, ...(await laneExtras(path, label)) }
  }

  return { cwd, note: `All ${MAX_LANES} lanes for ${name} are in use - this session shares the folder.` }
}

/**
 * Put a lane checkout back on disk before a session is spawned into it.
 *
 * sweepLanes() deletes a lane that is merged, empty and unheld, and that is right: an
 * empty lane is tens of thousands of node_modules hardlinks holding no work. What the
 * sweep cannot know is that a chat will be LAUNCHED into that folder afterwards - a pane
 * restored after the app was closed, or a terminal opened there by hand.
 *
 * That launch used to fail in a way nothing could report. Claude Code spawns every hook
 * with the session's own cwd, so a cwd that is not there fails all of them at once with
 * `posix_spawn '/bin/sh'` ENOENT - the lane hook included, which is the thing whose job is
 * to put the folder back. Its heal runs on UserPromptSubmit, so it only lands once a human
 * has already typed into a session whose SessionStart hooks all died. 2026-08-07: eight of
 * them died that way in taskdriver.ai-a, and the folder reappeared 33 seconds into the
 * session when the prompt hook finally claimed the lane.
 *
 * Synchronous on purpose - start() spawns its pty inline and this is one local git call -
 * and silent on every failure, because a lane that cannot be rebuilt is the caller's
 * existing "that folder is gone" path and not a new kind of problem.
 */
export function ensureLaneFolder(cwd: string): void {
  if (existsSync(cwd)) return
  const m = new RegExp(`^(.+)-(${LANE_LABELS.join('|')})$`).exec(cwd)
  if (!m) return
  const [, repo, label] = m
  // Only ever rebuild a lane OF a real repo. Any other folder ending in `-a` is somebody's
  // project and must not have a worktree dropped on top of it.
  if (!existsSync(join(repo, '.git'))) return
  const branch = `lane-${label}`
  const run = (args: string[]): boolean => {
    try {
      // One local git call inside start(), never on a poll or a sweep - see above. The
      // trailing tag is what lane-lag-test.mjs reads; it has to be on the call's own line,
      // because the guard strips whole comment lines before it looks for the exception.
      execFileSync('git', args, { cwd: repo, windowsHide: true, timeout: 60000, stdio: 'ignore' }) // sync-on-purpose
      return true
    } catch {
      return false
    }
  }
  // git still holds a registration pointing at the folder the sweep removed; until that is
  // pruned every `worktree add` for this branch is refused as already checked out.
  run(['worktree', 'prune'])
  if (!run(['worktree', 'add', cwd, branch]) && !run(['worktree', 'add', '-b', branch, cwd])) return
  seedLane(repo, cwd)
}

/**
 * The lane a folder ALREADY is, for a pane opened in a worktree this app did not create.
 *
 * `resolveLane` only ever labels a pane it moved itself, so a chat started by hand in
 * `taskdriver.ai-c` - by the lane hook, by a terminal, by a restored desk - arrived with
 * `Session.lane` unset. `place.ts` then had no lane id to strip the suffix with and drew
 * the raw folder `taskdriver.ai-c` beside another card saying `assistant` + `lane a`, for
 * the same kind of folder. `projectOf` is deliberately not allowed to guess (`service-a`
 * is a real project name), so the answer has to be PROVED here instead.
 *
 * The proof is git's, not the name's: the folder is a lane only when a sibling by the
 * un-suffixed name is a repo AND this folder is a worktree of exactly that repo. A real
 * project called `service-a` is its own main checkout, so `mainRepo` answers itself and it
 * is refused - which is the same identity test `resolveLane` uses before reusing a folder.
 *
 * Deliberately NOT read from `<repo>/.git/paneforge-lanes.json`: that ledger's lane IDS
 * are slots and do not have to match the folder they hold. On this machine right now it
 * files `taskdriver.ai-a` under lane `b` and `taskdriver.ai-c` under lane `d`, so taking
 * the id from there would strip nothing and print a letter that contradicts the folder.
 */
export async function detectLane(cwd: string): Promise<string | undefined> {
  const m = new RegExp(`^(.+)-(${LANE_LABELS.join('|')}|w\\d+)$`).exec(basename(cwd))
  if (!m) return undefined
  const repo = join(dirname(cwd), m[1])
  if (!existsSync(join(repo, '.git'))) return undefined
  return (await isWorktreeOf(cwd, repo)) ? m[2] : undefined
}
