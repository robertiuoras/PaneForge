// Hooks that hand each chat its own checkout of whatever repository it is working in,
// without anyone typing anything.
//
// Robert works in several chats at once, started from whatever project folder he happened
// to be in - "add this to PaneForge" from Toolstash, "fix this" from assistant, minutes
// apart. Two chats sharing one checkout overwrite each other's edits, race the same git
// index, and (where the repo releases) cut two versions minutes apart.
//
// That was a PaneForge problem first, because PaneForge is where the collisions happened,
// but nothing about it is specific to PaneForge: it is true of any repository two chats
// are open on. So this file is no longer about one repo. It resolves the repository the
// chat is actually in and hands lane duty to the engine:
//
//   UserPromptSubmit  --event=prompt   claims a lane in this chat's repository, and says
//                                      where the checkout is when there is anything to say
//   PreToolUse        --event=pretool  refuses an edit in another chat's checkout, and
//                                      refuses a raw release in a repo that batches them
//   SessionEnd        --event=end      gives back every lane this chat held
//
// All the real logic is `scripts/lane.mjs` inside PaneForge, driven with `--repo <dir>`.
// One engine for every project on the machine: a copy per repo would drift, and the only
// symptom of the drift would be two chats quietly sharing one checkout.
//
// This file must fail silently. A throw here breaks every session on the machine,
// including the ones with nothing to do with any of this. Nothing below throws.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// Where the engine lives. Both names: the checkout family was renamed
// claude-orchestrator* -> PaneForge*, and a machine that has not been renamed must keep
// working either way.
const CANDIDATES = [
  process.env.PANEFORGE_REPO,
  join(homedir(), 'Desktop', 'Projects', 'PaneForge'),
  join(homedir(), 'Desktop', 'Projects', 'claude-orchestrator'),
  join(homedir(), 'Projects', 'PaneForge'),
  join(homedir(), 'Projects', 'claude-orchestrator')
].filter(Boolean)

const event = process.argv.find((a) => a.startsWith('--event='))?.split('=')[1] ?? 'prompt'

// This copy ships INSIDE PaneForge, next to the engine it drives, so the engine is a
// sibling and the guessing above is only a fallback for a hook installed from somewhere
// else. That sibling is the whole point of vendoring this file: a user who installed
// PaneForge from the installer has no source checkout for CANDIDATES to find, which is
// why lanes were a Robert-only feature until now.
const SELF_DIR = dirname(fileURLToPath(import.meta.url))
const SIBLING = join(SELF_DIR, 'lane.mjs')
const ENGINE_REPO = existsSync(SIBLING)
  ? dirname(SELF_DIR)
  : CANDIDATES.find((p) => existsSync(join(p, 'scripts', 'lane.mjs')))
if (!ENGINE_REPO) {
  // Exiting quietly here reads as "this machine has no lanes", which is true right up
  // until it isn't: rename the checkout, clone it somewhere new, or install PaneForge
  // from the installer (which ships no scripts/ folder at all) and every one of these
  // hooks becomes a no-op with nothing on screen to say so. No lane is claimed, and the
  // PreToolUse guard stops refusing edits inside another chat's lane - so two chats share
  // one checkout again, silently, which is the single failure the lane system exists to
  // prevent. Silent is the expensive part: the collision surfaces later as a half-written
  // build or a lost edit, with nothing pointing back here.
  //
  // A machine that has genuinely never used lanes has no registry, and stays quiet.
  if (event === 'prompt') {
    try {
      const reg = JSON.parse(readFileSync(join(homedir(), '.claude', 'lane-repos.json'), 'utf8'))
      if (Object.keys(reg.repos ?? {}).length) {
        console.log(
          'Lanes: OFF — the engine (PaneForge scripts/lane.mjs) is not at any known path, so ' +
            'no lane is claimed for this chat and no edit is guarded. Another chat may be in the ' +
            'same files. Looked in: ' +
            CANDIDATES.join(', ') +
            '. Point PANEFORGE_REPO at the PaneForge checkout to turn enforcement back on.'
        )
      }
    } catch {
      // No registry: lanes have never run here, so there is nothing to have lost.
    }
  }
  process.exit(0)
}
const ENGINE = existsSync(SIBLING) ? SIBLING : join(ENGINE_REPO, 'scripts', 'lane.mjs')

/**
 * Repositories that are never given lanes.
 *
 * `claude-memory` is the config repo this file lives in: it is edited from every chat on
 * the machine, by hooks as well as by agents, and a worktree of it would mean a session
 * writing its memory into a copy nothing else reads. A repo can also opt itself out with
 * `{"lanes": false}` in its own `.lanes.json`, which the engine enforces too.
 */
const NEVER = ['claude-memory']

// ------------------------------------------------------------------ registry
//
// PreToolUse fires on every single edit, and it has to answer "is this path inside some
// chat's lane?" fast enough that nobody notices. Asking git that question per edit is a
// process spawn per edit. So the repos that have lanes write themselves down here when
// they are claimed, and the guard is a string comparison against that list.
//
// It is a cache, not a source of truth: deleting it costs one re-claim.

// LANE_REGISTRY is for the test, which must not leave throwaway repos in the real cache.
const REGISTRY = process.env.LANE_REGISTRY || join(homedir(), '.claude', 'lane-repos.json')

function readRegistry() {
  try {
    const r = JSON.parse(readFileSync(REGISTRY, 'utf8'))
    r.repos ??= {}
    r.sessions ??= {}
    return r
  } catch {
    return { repos: {}, sessions: {} }
  }
}

function writeRegistry(r) {
  try {
    // Two chats can claim at the same moment; a half-written file would blind the guard.
    const tmp = `${REGISTRY}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(r, null, 2) + '\n', 'utf8')
    renameSync(tmp, REGISTRY)
  } catch {
    /* the guard degrades to "no lanes known", which is the old behaviour */
  }
}

// ------------------------------------------------------------------ engine

function lane(repo, ...args) {
  const r = spawnSync(process.execPath, [ENGINE, ...args, '--repo', repo], {
    encoding: 'utf8',
    // `release` can end in a real release (merge, tag, two pushes), so it gets room.
    timeout: args[0] === 'release' ? 180_000 : 25_000
  })
  return { code: r.status ?? 1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}

/** The main checkout for a folder, or null when it is not in a git repository at all. */
function repoOf(dir) {
  if (!dir) return null
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true
  })
  if (r.status !== 0) return null
  const common = (r.stdout ?? '').trim().split(/\r?\n/)[0]
  if (!common || !/[\\/]\.git$/.test(common)) return null // bare or unusual layout
  return resolve(common, '..')
}

/**
 * Should this repository have lanes at all?
 *
 * Wanted: a real project, with somewhere for finished work to go. Not wanted: the config
 * repo, a repo that has opted out, and a throwaway with no remote - handing a scratch
 * folder a worktree and a release story is noise in a chat that was never going to need
 * either.
 */
function participates(repo) {
  if (!repo) return false
  const name = repo.split(/[\\/]/).pop()
  if (NEVER.includes(name)) return false
  try {
    const cfg = JSON.parse(readFileSync(join(repo, '.lanes.json'), 'utf8'))
    if (cfg.lanes === false) return false
    if (cfg.lanes === true) return true // an explicit yes overrides the remote check
  } catch {
    /* no config is the normal case */
  }
  const r = spawnSync('git', ['remote'], { cwd: repo, encoding: 'utf8', timeout: 10_000, windowsHide: true })
  return r.status === 0 && Boolean((r.stdout ?? '').trim())
}

/** What finishing work in the engine's own repo does - "version" unless it says otherwise. */
function engineReleaseMode() {
  try {
    return JSON.parse(readFileSync(join(ENGINE_REPO, '.lanes.json'), 'utf8')).release ?? 'version'
  } catch {
    return 'version'
  }
}

function deny(reason) {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason
      }
    })
  )
  process.exit(0)
}

let input = {}
try {
  input = JSON.parse(readFileSync(0, 'utf8') || '{}')
} catch {
  input = {}
}

const session = input.session_id ?? input.sessionId ?? ''
const cwd = input.cwd ?? process.cwd()
if (!session) process.exit(0)

// ------------------------------------------------------------------ prompt

if (event === 'prompt') {
  // Only a chat that is actually sitting in the repository. Matching a repo's NAME in the
  // prompt text is what made this speak in every project on the machine - a Toolstash chat
  // that mentioned PaneForge in passing was handed a lane, a folder to work in and a
  // release command, none of which had anything to do with what it was doing. A chat
  // elsewhere that really does go and edit another repo is still caught: the PreToolUse
  // guard claims a lane on its first write there, which is when the assignment matters.
  const repo = repoOf(cwd)
  if (!participates(repo)) process.exit(0)

  // A chat started inside a checkout keeps that one: it may already have uncommitted work
  // there, and sending it to an empty lane would hide that work from it.
  const t = resolve(cwd)
  const prefer =
    t === repo || t.startsWith(repo + sep)
      ? 'main'
      : t.startsWith(repo + '-')
        ? t.slice(repo.length + 1).split(sep)[0]
        : null

  // A VISITOR is a chat whose own project is a different repository - it is only here
  // because its shell happened to cd into this one. The tell is the transcript, which
  // lives under the project the session was STARTED in, spelled as a slug (every
  // non-alphanumeric becomes a dash); `cwd` follows the shell and cannot answer this.
  // A visitor is handed a letter lane and gives its checkout back the moment its turn
  // ends clean (`park`); a home chat is treated exactly as before.
  const slugOf = (p) => String(p).replace(/[^A-Za-z0-9-]/g, '-')
  const tp = input.transcript_path ?? input.transcriptPath ?? ''
  const home = tp ? basename(dirname(tp)) : ''
  const visitor = Boolean(home) && home !== slugOf(repo) && !home.startsWith(slugOf(repo) + '-')

  const r = lane(
    repo,
    'claim',
    '--session',
    session,
    '--cwd',
    cwd,
    ...(prefer ? ['--prefer', prefer] : []),
    ...(visitor ? ['--visitor'] : [])
  )
  if (r.code !== 0) {
    // Every lane busy is worth saying out loud: the alternative is two chats quietly
    // sharing one checkout, which is the exact failure this exists to prevent.
    console.log(
      `Lanes: ${r.err || 'could not assign a checkout'}. Do not edit ${repo.split(/[\\/]/).pop()} from this chat until one frees up.`
    )
    process.exit(0)
  }
  let info
  try {
    info = JSON.parse(r.out)
  } catch {
    process.exit(0)
  }

  const reg = readRegistry()
  reg.repos[repo] = { release: info.release, own: Boolean(info.own), seen: Date.now() }
  reg.sessions[session] = [...new Set([...(reg.sessions[session] ?? []), repo])]
  writeRegistry(reg)

  // Who holds what, so this chat can answer "is anyone else in here?" without going and
  // looking, and knows why a finished lane has not gone out yet.
  //
  // This is a ROSTER of every held lane, this chat's own included, and not a list of the
  // OTHERS - which is the whole point. The others-only list gave each pane a different
  // sentence (pane A: "lane main and lane a"; pane B: "lane a"; pane main: "lane a"), all
  // of them true, none of them the same, and none showing the reader's own row. Three
  // panes then read as three contradictory accounts of one repository. Printing the same
  // table everywhere, with `<- THIS CHAT` on one row, makes the panes agree by
  // construction.
  let roster = []
  let others = []
  let stuck = null
  let orphan = null
  try {
    const s = JSON.parse(lane(repo, 'status', '--session', session).out)
    const held = s.lanes.filter((l) => l.heldBy)
    const pad = Math.max(...held.map((l) => l.lane.length), 1)
    roster = held.map((l) => {
      // The folder a chat STARTED in is worth printing only when it is not the folder it
      // was given - that mismatch (a chat sitting in `<repo>-b` while holding lane a) is
      // the genuinely confusing case. On the normal case it was pure noise repeating the
      // lane's own name back.
      // Whole path, not its last segment: `from` is a chat's shell cwd and is often a
      // SUBDIRECTORY of a checkout (the PreToolUse guard claims with the folder of the
      // file being written), so the last segment read "started in scripts" - a folder
      // name that is not a checkout and belongs to no lane.
      const from = l.from && resolve(l.from) !== resolve(l.dir) ? `, started in ${l.from}` : ''
      const what = l.mine
        ? '<- THIS CHAT'
        : l.conflicted
          ? `another chat: finished but conflicting with ${s.branch}${from}`
          : l.ready
            ? `another chat: finished, waiting for the release${from}`
            : l.dirty
              ? `another chat: mid-edit, uncommitted changes${from}`
              : l.ahead > 0
                ? `another chat: ${l.ahead} commit${l.ahead === 1 ? '' : 's'}, not marked done yet${from}`
                : l.tentative
                  ? `another chat: only mentioned ${s.repo}, nothing claimed yet${from}`
                  : `another chat: no work yet${from}`
      return `  ${l.lane.padEnd(pad)}  ${l.dir}  ${what}`
    })
    // A lane another chat only reserved by saying the word is not another chat working
    // here; it stays on the roster (the panes must agree) but it does not make a quiet
    // repo speak up.
    others = held.filter((l) => !l.mine && !l.tentative)
    // A lane left out of a release for conflicting is the one thing the automation cannot
    // finish on its own, so the chat that lands in it is told straight away.
    const mineNow = s.lanes.find((l) => l.mine)
    if (mineNow?.conflicted) {
      stuck =
        `This lane was left out of the last release: it conflicts with ${s.branch}. ` +
        `Run: node ${ENGINE} resolve --repo ${repo} --session ${session} - it opens the merge in ${mineNow.dir}, ` +
        `then resolve, git commit, and node ${ENGINE} ready --repo ${repo} --session ${session}.`
    }
    // A conflict whose own chat has gone quiet is what stalls a release indefinitely - it
    // is nobody's job, so nobody does it. Any chat may take it over, so every chat that
    // turns up here is told which one, and the exact command.
    const abandoned = s.lanes.filter((l) => l.conflict?.adoptable && !l.mine && !l.conflict.resolver)
    if (abandoned.length) {
      orphan = abandoned
        .map(
          (l) =>
            `Lane ${l.lane} has been conflicting with ${s.branch} for ${Math.round((Date.now() - l.conflict.since) / 3600000)}h ` +
            `and its chat has stopped answering, so its finished work is in no release. ` +
            `You can finish it from here: node ${ENGINE} resolve --repo ${repo} --session ${session} --lane ${l.lane} ` +
            `(opens the merge in ${l.dir}), resolve, commit, then node ${ENGINE} ready --repo ${repo} --session ${session} --lane ${l.lane}.`
        )
        .join('\n')
    }
  } catch {
    /* status is a nicety - never block the claim on it */
  }

  // How loud to be. The engine's own repo carries release instructions worth repeating
  // every prompt; every other project gets silence unless there is something to act on -
  // a worktree it must work in, another chat in here, or a stuck lane. A line about lanes
  // on every prompt in every repo on the machine is how a useful line stops being read.
  const quiet = !info.own && info.lane === 'main' && !others.length && !stuck && !orphan
  if (quiet) process.exit(0)

  const name = repo.split(/[\\/]/).pop()
  const lines = [`${name} lane for this chat: ${info.dir} (branch ${info.branch}).`]
  if (info.lane !== 'main' || info.own) {
    lines.push(
      `Do all ${name} work there - not in any other ${name} folder. Another chat may hold those.`
    )
  }
  if (info.own) {
    lines.push(
      `Test with: cd "${info.dir}" && npm run try -- --minimized   (opens as profile "${info.profile}", never takes focus, never touches the running app).`
    )
  }
  lines.push(
    info.lane === 'main'
      ? `You are on ${info.branch}, so finished work needs no merge - commit straight to it.`
      : `Commit to ${info.branch}.`
  )
  if (info.release !== 'none') {
    lines.push(
      `When the work is done and verified, run: node ${ENGINE} ready --repo ${repo} --session ${session}`,
      info.release === 'version'
        ? `That is the whole release. It cuts the version by itself once no other chat is mid-work, and says so. Never run npm version / git tag / npm run ship yourself.`
        : info.own
          ? // This repo CAN cut releases and is deliberately set not to. Robert's words,
            // 2026-08-23: "make changes to code but need to have manual test in dev window
            // so i can check instead of wasting time with releases". A release is a build
            // to install and a restart to take it, and he was getting one per session for
            // work he had not looked at yet - so the proof is now a dev copy he can see,
            // and the release waits for him to ask.
            `That merges this lane into ${info.mainBranch} and pushes - it does NOT cut a version. Prove the change in a second copy instead (\`npm run try -- --keep --remote-debugging-port=9333\` plus \`npm run probe\`), report what you measured, and leave it there. Only cut a release when Robert asks for one, with \`npm run ship\`.`
          : // `mainBranch`, not `branch` - `branch` is this lane's own, and saying "merges into
            // lane-a" to the chat sitting in lane-a is a sentence that answers nothing.
            `That merges this lane into ${info.mainBranch} and pushes, batched with every other finished lane. No version is cut here - this repo is not set up for releases (\`"release": "version"\` in .lanes.json turns that on).`
    )
  }
  lines.push(
    roster.length
      ? `Every ${name} checkout in use right now (same table in every chat):\n${roster.join('\n')}`
      : `No chat holds a ${name} lane right now.`
  )
  console.log([...lines, stuck, orphan].filter(Boolean).join('\n'))
  process.exit(0)
}

// ------------------------------------------------------------------ pretool

if (event === 'pretool') {
  const tool = input.tool_name ?? ''
  const ti = input.tool_input ?? {}
  const reg = readRegistry()
  // The engine's own repository is always in the list, registered or not: it has lanes by
  // definition, and its guard has to work in a chat that has not prompted yet.
  const roots = [...new Set([...Object.keys(reg.repos), ENGINE_REPO])]
  // The engine can be the INSTALLED app's resources folder (no .git, nobody releases
  // from it). Reading a release mode off that made the guard refuse `npm version` in a
  // source checkout that was in `merge` mode, and point at resources/ for the fix
  // (2026-09-03). Only a checkout with a .git is a repo a release could come from.
  const modeOf = (repo) =>
    reg.repos[repo]?.release ??
    (repo === ENGINE_REPO && existsSync(join(repo, '.git')) ? engineReleaseMode() : null)

  /** The registered repo a path belongs to - its own folder, or one of its lanes. */
  const ownerOf = (p) => {
    if (!p) return null
    const t = resolve(p)
    // Longest first: `<repo>-a` and `<repo>` both prefix-match a lane path as strings.
    return (
      roots
        .filter((root) => t === root || t.startsWith(root + sep) || t.startsWith(root + '-'))
        .sort((a, b) => b.length - a.length)[0] ?? null
    )
  }

  if (tool === 'Bash' || tool === 'PowerShell') {
    const cmd = String(ti.command ?? '')
    // Where the command would land. Being IN the repo is the exact answer; naming it is
    // the one that catches `cd paneforge && npm version patch` from a chat sitting
    // somewhere else, which is a real way a second release gets cut. Only repos that cut
    // versions are considered either way - a repo that merges has no version to cut twice.
    const here = ownerOf(cwd)
    const lower = cmd.toLowerCase()
    const namesOf = (r) => {
      const b = r.split(/[\\/]/).pop().toLowerCase()
      // The engine's checkout answers to both of its names: the folder family was renamed
      // claude-orchestrator* -> PaneForge*, and either may appear in a command.
      return r === ENGINE_REPO ? [...new Set([b, 'paneforge', 'claude-orchestrator'])] : [b]
    }
    const repo =
      here && modeOf(here) === 'version'
        ? here
        : (roots.find((r) => modeOf(r) === 'version' && namesOf(r).some((n) => lower.includes(n))) ?? null)
    if (repo) {
      // A raw release from a lane is the thing that produces v0.3.5 and v0.3.6 minutes
      // apart. There is one door, and it is locked and batched.
      // `npm run ship` is fine - it is lane.mjs, which locks and batches. These are the
      // ways round it that would put two versions out minutes apart.
      //
      // Each pattern has to sit where a COMMAND starts - after nothing, a `;`, `&&`, `|`
      // or a newline, past any `sudo`/`env X=Y`. Matching anywhere in the string meant
      // `grep -n "npm version" scripts/lane.mjs` was refused as an attempt to release,
      // which is how an agent reading the release code got locked out of reading it.
      // Text that is data rather than commands is blanked first, in the order a shell
      // would read it: a heredoc body (this is how an agent writes a commit message
      // describing the release rules, and its lines start where a command would), then
      // quoted arguments (without which the `|` inside `rg "npm version|npm run release"`
      // reads as a pipe and the next word as a command). Both were refusals of a chat
      // DOCUMENTING the guard.
      const bare = cmd
        .replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^\t*\2$/gm, '<<HEREDOC')
        .replace(/'[^']*'/g, "''")
        .replace(/"[^"]*"/g, '""')
      const START = '(?:^|[;&|\\n]|\\bthen\\s|\\bdo\\s)\\s*(?:sudo\\s+|env\\s+\\S+=\\S+\\s+)*'
      const asCommand = (re) => new RegExp(START + re).test(bare)
      const rawRelease =
        asCommand('npm\\s+version\\b') ||
        asCommand('npm\\s+run\\s+release\\b') ||
        asCommand('git\\s+tag\\s+-?a?\\s*v?\\d') ||
        asCommand('git\\s+push\\s+[^\\n;&|]*\\bv\\d+\\.\\d+\\.\\d+')
      if (rawRelease) {
        deny(
          'Releases here are batched so two chats cannot ship two versions minutes apart. ' +
            `Mark this lane shippable instead: node ${ENGINE} ready --repo ${repo} --session ${session}. ` +
            `To cut the release (merges every ready lane into ONE version, behind a lock): node ${ENGINE} ship --repo ${repo}`
        )
      }
    }
  }

  const path = ti.file_path ?? ti.path ?? ti.notebook_path
  if (!path) process.exit(0)
  const repo = ownerOf(path)
  if (!repo) process.exit(0)
  const r = lane(repo, 'guard', '--session', session, '--path', String(path))
  if (r.code === 2 && r.out) deny(r.out)
  process.exit(0)
}

// ------------------------------------------------------------------ stop
//
// The turn ended. Park every hold this chat has whose lane is clean: the hold survives
// and the chat speaks again by claiming (which clears the mark), but a chat that NEEDS
// the checkout now waits minutes for it instead of the hour the silence sweep costs.
// Fast by construction - a session that never claimed a repo does one registry read and
// exits, which is every session on the machine except the handful holding lanes.

if (event === 'stop') {
  const reg = readRegistry()
  for (const repo of reg.sessions[session] ?? []) {
    if (!existsSync(repo)) continue
    lane(repo, 'park', '--session', session)
  }
  process.exit(0)
}

// ------------------------------------------------------------------ end

if (event === 'end') {
  const reg = readRegistry()
  // Only the repos this chat actually claimed in. A session that touched one project must
  // not run a release check in every project on the machine on its way out.
  //
  // Detached, never awaited: a release merges lanes, typechecks master, tags and pushes,
  // and running that inline is what made /clear hang — measured 2026-08-01, v0.4.11 was
  // cut INSIDE this hook and the next session's first prompt waited ~55s for it. Nothing
  // reads the output, lane.mjs's own release lock keeps two attempts apart, and the
  // running app retries every minute if this process dies early.
  for (const repo of reg.sessions[session] ?? []) {
    if (!existsSync(repo)) continue
    try {
      // windowsHide is NOT enough on Win11 with Windows Terminal as default terminal:
      // a detached console spawn is delegated to a VISIBLE Terminal window regardless
      // of CREATE_NO_WINDOW (measured 2026-08-01 - every /clear popped one per repo,
      // stealing focus from a fullscreen game). wscript run-hidden.vbs runs it truly
      // windowless; conhost --headless was tried first and silently never ran the child.
      const args = [ENGINE, 'release', '--session', session, '--repo', repo]
      const win = process.platform === 'win32'
      const vbs = fileURLToPath(new URL('run-hidden.vbs', import.meta.url))
      spawn(
        win ? 'wscript.exe' : process.execPath,
        win ? ['//B', '//Nologo', vbs, process.execPath, ...args] : args,
        { detached: true, stdio: 'ignore', windowsHide: true }
      ).unref()
    } catch {
      /* the app's retry timer releases instead */
    }
  }
  delete reg.sessions[session]
  writeRegistry(reg)
  process.exit(0)
}
