// Two agents in one folder is the one setup that reliably breaks: they clobber
// each other's edits, race the git index, and fight over the dev server port. A
// git worktree gives each session its own checkout and its own branch off the
// same repo, so "open a second session here" stops being a trap.
//
// This runs on the way in to a session start: the second session in a folder is
// moved into `<repo>-w2` without being asked, the third into `-w3`, and so on.
// Nothing is ever moved out of the original folder - the first session keeps it.

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
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

/** Highest lane number offered. Past this the folder is genuinely oversubscribed. */
const MAX_LANES = 9

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

function git(cwd: string, args: string[], timeout = 15000): { ok: boolean; out: string } {
  try {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout })
    return { ok: r.status === 0, out: (r.stdout ?? '').trim() || (r.stderr ?? '').trim() }
  } catch {
    return { ok: false, out: '' }
  }
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
function mainRepo(cwd: string): string | null {
  const common = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!common.ok || !common.out) return null
  const dir = common.out.split(/\r?\n/)[0]
  // `<repo>/.git` normally; a bare or unusual layout is left alone.
  if (!/[\\/]\.git$/.test(dir)) return null
  const root = dirname(dir)
  return existsSync(root) ? root : null
}

/** Is this folder already a checkout of the same repo (ours to reuse)? */
function isWorktreeOf(candidate: string, repo: string): boolean {
  if (!existsSync(candidate)) return false
  const root = mainRepo(candidate)
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
    '.env',
    '.env.local'
  ]) {
    const text = readText(join(repo, rel))
    if (!text) continue
    const m = text.match(/\bport"?\s*[:=]\s*"?(\d{3,5})|localhost:(\d{3,5})|^\s*PORT\s*=\s*(\d{3,5})/m)
    const found = m && asPort(m[1] ?? m[2] ?? m[3])
    if (found) return found
  }
  return null
}

/** "w2" -> 2. Anything unparseable is treated as the first lane. */
function laneIndex(label: string): number {
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
  const rels = ['node_modules']
  try {
    // Monorepo layouts install per package (`backend/node_modules`); one level
    // down is the same depth the .env seeding covers.
    for (const e of readdirSync(repo, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === '.git' || e.name === 'node_modules') continue
      rels.push(join(e.name, 'node_modules'))
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
        else renameSync(tmp, to)
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
 * What a lane needs beyond its folder: a dev-server port of its own, and the
 * original folder's agent memory.
 *
 * Split out from resolveLane() so a lane restored after an app update (which
 * already knows its folder and label, and must not be moved again) gets the same
 * treatment as one being created.
 */
export function laneExtras(laneCwd: string, label: string): LaneExtras {
  const repo = mainRepo(laneCwd) ?? laneCwd
  const base = detectDevPort(repo) ?? FALLBACK_PORT
  const port = Math.min(base + laneIndex(label) - 1, 65000)
  const sharedMemory = samePath(repo, laneCwd) ? false : shareClaudeMemory(repo, laneCwd)
  if (sharedMemory) seedClaudeProjectSettings(repo, laneCwd)
  return {
    env: {
      // PORT is what most dev servers read on their own (Next, CRA, Nuxt, Nitro,
      // anything Express-shaped). The other two are for the ones that do not:
      // the launch toast states the number so `--port $PORT` is one keystroke.
      PORT: String(port),
      PF_LANE: label,
      PF_LANE_PORT: String(port)
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
  for (const rel of [join('.claude', 'settings.local.json'), join('.vscode', 'settings.json')]) {
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
export function resolveLane(cwd: string, taken: string[]): Lane {
  const clash = taken.some((t) => samePath(t, cwd))
  if (!clash) return { cwd }

  const repo = mainRepo(cwd)
  if (!repo) {
    return { cwd, note: 'Second session in the same folder - not a git repo, so both share it.' }
  }

  const parent = dirname(repo)
  const name = basename(repo)
  for (let i = 2; i <= MAX_LANES; i++) {
    const label = `w${i}`
    const path = join(parent, `${name}-${label}`)
    if (taken.some((t) => samePath(t, path))) continue

    const branch = `pf/${label}`
    if (existsSync(path)) {
      // Left behind by an earlier session and nobody is in it: reuse rather than
      // pile up folders. Anything at that path that is not this repo is skipped.
      if (!isWorktreeOf(path, repo)) continue
      seedLane(repo, path)
      const head = git(path, ['rev-parse', '--abbrev-ref', 'HEAD'])
      return { cwd: path, lane: label, branch: head.ok ? head.out : branch, ...laneExtras(path, label) }
    }

    // New branch off whatever the repo has checked out now. If the branch already
    // exists from a previous lane, check that out instead of failing.
    let made = git(repo, ['worktree', 'add', '-b', branch, path])
    if (!made.ok) made = git(repo, ['worktree', 'add', path, branch])
    if (!made.ok) {
      return { cwd, note: `Could not create a worktree lane: ${made.out.split('\n')[0]}` }
    }
    seedLane(repo, path)
    return { cwd: path, lane: label, branch, ...laneExtras(path, label) }
  }

  return { cwd, note: `All ${MAX_LANES} lanes for ${name} are in use - this session shares the folder.` }
}
