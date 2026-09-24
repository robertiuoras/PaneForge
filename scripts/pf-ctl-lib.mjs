/**
 * pf-ctl-lib - the parts of `pf` that are rules rather than calls: the help text, which
 * panes `pf tidy` may close, which pane `pf move` may move, and the handoff brief a moved
 * chat opens with.
 *
 * Pure and node-builtins-only on purpose. pf-ctl.mjs ships inside the installed app, where
 * src/ does not exist, so nothing here may import from it - and a rule that decides which
 * pane to CLOSE has to be testable without a running app (`scripts/pf-ctl-help-test.mjs`).
 *
 * The safety readings mirror the app's own: `keepable` in src/shared/reclaim.ts (what the
 * idle sweep may close), `isFinished` in src/shared/exitedSweep.ts (what "Clear finished"
 * takes) and the continuation guard in src/main/continuation.ts (when a chat is at a safe
 * boundary to hand over). They are restated rather than imported for the reason above.
 */
import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/*
 * Every command pf answers to, in the order `pf help` prints them. `pf-ctl-help-test.mjs`
 * reads the dispatcher in pf-ctl.mjs and fails when a command there has no row here (or a
 * row here names a command nothing dispatches), so the help can never fall behind.
 */
export const COMMANDS = [
  {
    name: 'help',
    summary: 'Show this help, or everything about one command.',
    usage: 'pf help [command]',
    example: 'pf help move'
  },
  {
    name: 'list',
    summary: 'List every pane: number, id, state, name, folder. Sign-in cards waiting on a person follow.',
    usage: 'pf list',
    example: 'pf list',
    detail: [
      'Columns (tab separated): number, id, state, name, folder.',
      'The number is the one drawn on the pane\'s card. It shifts when a pane above it closes; the id never changes.',
      'States: starting (just opened), working (busy), idle (waiting for a person or a prompt), exited (finished or asleep).',
      'An id starting with @ is a pane on another paired computer.'
    ]
  },
  {
    name: 'agents',
    summary: 'List the agents a pane can run on this computer - the ids --agent and --to take.',
    usage: 'pf agents',
    example: 'pf agents',
    detail: ['Columns: id, installed or not, name, models it offers (if it lists any).']
  },
  {
    name: 'open',
    summary: 'Open a new pane in a folder, on any agent, optionally with a first message.',
    usage:
      'pf open <folder> [--agent A] [--model M] [--prompt TEXT | --task BACKLOG_ID] [--title T]\n' +
      '        [--here | --on DEVICE] [--close-when-done] [--report-to PANE] [--resume CHAT_ID | --continue]',
    example: 'pf open ~/Projects/site --agent codex --here --prompt "Run the tests and fix what fails"',
    detail: [
      '--agent: an id from `pf agents` (claude, codex, grok, antigravity, shell, ...). Default: the app\'s default agent.',
      '--here keeps the pane on this computer. Use it from automation: without it the app may start the pane on a paired computer.',
      '--on DEVICE starts it on a paired computer instead (a name or id from `pf devices`).',
      '--close-when-done: the pane closes itself once its work is finished and tells the pane that opened it (--report-to, default: the pane running pf).',
      '--resume CHAT_ID reopens an earlier conversation; --continue reopens the newest one in that folder.',
      'Prints `opened <id> in <folder>`. The folder can differ from the one asked for: a folder another pane is using gets its own copy.',
      'Check the result with `pf list`.'
    ]
  },
  {
    name: 'open-many',
    summary: 'Open many panes in one call, from a JSON plan file.',
    usage: 'pf open-many <plan.json>',
    example: 'pf open-many plan.json    # [{"cwd":"~/a","prompt":"...","agent":"codex","model":"...","on":"PC"}]',
    detail: [
      'The file is a JSON array of {cwd, prompt | task, agent?, model?, title?, on?}.',
      'Prints one `opened` or `refused ... - why` line per row; exit 1 if any row was refused.'
    ]
  },
  {
    name: 'devices',
    summary: 'List paired computers: id, name, online or not, how many panes each runs.',
    usage: 'pf devices',
    example: 'pf devices'
  },
  {
    name: 'tell',
    summary: 'Hand a pane one line of text, delivered between its turns (never typed into the middle of one).',
    usage: 'pf tell <pane> <text...>',
    example: 'pf tell 3 "When this step is done, commit and stop"',
    detail: ['<pane> is a number from `pf list`, an exact pane name, or an id. Panes on another computer cannot be told.']
  },
  {
    name: 'type',
    summary: 'Type text into a pane\'s prompt box and press Enter right now (even mid-turn). Prefer `tell`.',
    usage: 'pf type <pane> <text...>',
    example: 'pf type 3 "yes"'
  },
  {
    name: 'composer',
    summary: 'Show what is typed in a pane\'s prompt box and not sent yet. Reads only.',
    usage: 'pf composer <pane>',
    example: 'pf composer 3'
  },
  {
    name: 'close',
    summary: 'Close one pane and check it is gone.',
    usage: 'pf close <pane>',
    example: 'pf close 3',
    detail: [
      'It does not ask first: a working pane is stopped mid-turn. Look at its state in `pf list` before closing.',
      'Numbers shift after a close; close several panes by id, or from the highest number down.'
    ]
  },
  {
    name: 'close-when-done',
    summary: 'Make a pane close itself once its work is finished (default: the pane running pf).',
    usage: 'pf close-when-done [<pane>] [--report-to PANE]',
    example: 'pf close-when-done 3'
  },
  {
    name: 'tidy',
    summary: 'Tidy the desk: clear finished panes, find (or close) duplicate idle panes.',
    usage: 'pf tidy [--dupes] [--dry-run]',
    example: 'pf tidy --dry-run',
    detail: [
      'Always: clears finished panes - ones that exited on their own, asked nothing and were not touched since.',
      '  Same as the window\'s "Clear finished" button; their last reply stays in Review.',
      'Then lists duplicates: 2+ panes on the same folder AND the same agent. The most recently active one is kept;',
      '  each idle extra is printed as a `pf close <id>` line you can run.',
      '--dupes also closes those idle extras.',
      'Never closed: a pane that is working, asking a question, mid-handoff, has text typed and not sent, runs a',
      '  background job or command, is set to stay open, is being watched on a phone, was typed into in the last',
      '  10 minutes, is on another computer, or is the pane running this command.',
      '--dry-run prints what it would do and changes nothing.',
      'One line per action, then a total: `closed 3, kept 7` (kept = panes left on the desk).'
    ]
  },
  {
    name: 'move',
    summary: 'Move a pane\'s work to another agent (e.g. Claude -> Codex when a usage limit runs out). No copy-paste.',
    usage: 'pf move <pane> --to <agent> [--model M]',
    example: 'pf move 3 --to codex',
    detail: [
      'Writes a handoff brief to a file (folder, previous agent, path to its full conversation, the last ask and',
      '  the last reply), closes the old pane, and opens <agent> in the SAME folder with the prompt:',
      '  "Continue this work. Handoff brief: <file>. Read it first."',
      'The old pane closes first because a folder still in use would put the new pane in a separate copy of it.',
      '  Before closing it prints the brief\'s path and the command that reopens the old chat.',
      '  If the new pane does not start, quits within 10 seconds (a sign-in or folder-trust gate), or the app',
      '  puts it in a copy of the folder, the old conversation is reopened and the reason is printed (exit 1).',
      'Refuses (exit 1, says why, changes nothing) while the pane is working, asking a question, mid-handoff, has',
      '  text typed and not sent, or runs a background job - wait for it to go idle. Also refuses when another pane',
      '  is open in the same folder, when its conversation has no id yet, shell panes, and panes on another computer.',
      '--to takes an id from `pf agents`. Prints the old and new pane ids.'
    ]
  },
  {
    name: 'rename',
    summary: 'Rename a pane.',
    usage: 'pf rename <pane> <name...>',
    example: 'pf rename 3 Client site fixes'
  },
  {
    name: 'review',
    summary: 'Record a finished result, decision or blocker in Review, from a JSON file.',
    usage: 'pf review <review.json>',
    example: 'pf review /tmp/result.json    # a JSON object with id, sessionId, kind, report, proof'
  },
  {
    name: 'watch-job',
    summary: 'Bind a shell pane to a submitted compute job so its receipt is kept for review.',
    usage: 'pf watch-job <job-id> --owner <native-id> --pane <pane-id>',
    example: 'pf watch-job job-42 --owner 1234 --pane s12-abc'
  },
  {
    name: 'needs-login',
    summary: 'Say a job cannot sign in: a "needs you" card names the site, and the pane is marked.',
    usage: 'pf needs-login <site> --url <url> [--why TEXT] [--machine WORDS]',
    example: 'pf needs-login keap --url https://keap.com/login --why "finish the footer check"',
    detail: [
      'Opens nothing and connects to nothing: the person signs in themselves, then presses the card.',
      'Pressing Signed in tells the pane that asked to carry on. --machine names the computer if it is not this one.'
    ]
  },
  {
    name: 'hold',
    summary: 'Ask GuardDeck\'s idle-app reapers to leave an app alone while you use it.',
    usage: 'pf hold [--bundle ID | --name APP | --pid N] [--reason R] [--ttl MIN] [--this]  |  pf hold list  |  pf hold release <id>',
    example: 'pf hold --name Electron --reason "reviewing a build" --this',
    detail: ['--this ends the hold when the process that ran pf exits. Without GuardDeck on the machine it does nothing.']
  },
  {
    name: 'cost',
    summary: 'Profile the PaneForge window\'s JavaScript for a few seconds and show where the time went.',
    usage: 'pf cost [--seconds N]',
    example: 'pf cost --seconds 5'
  },
  {
    name: 'reload',
    summary: 'Redraw the PaneForge window. Panes and chats keep running.',
    usage: 'pf reload',
    example: 'pf reload'
  },
  {
    name: 'call',
    summary: 'Call any app channel by name with JSON arguments and print the answer (escape hatch).',
    usage: 'pf call <channel> [json-arg...]',
    example: 'pf call sessions:list',
    detail: ['Channels are listed in src/shared/surface.ts of the PaneForge source. Each argument must be JSON: strings need quotes, e.g. \'"s12-abc"\'.']
  },
  {
    name: 'send',
    summary: 'Fire a one-way app channel with JSON arguments (escape hatch; no answer).',
    usage: 'pf send <channel> [json-arg...]',
    example: 'pf send pty:return \'"s12-abc"\''
  }
]

/** The six things an agent reaches for first, each one copy-paste line. */
const RECIPES = [
  ['See every pane (number, id, state, name, folder)', 'pf list'],
  ['Open a pane in a folder on a given agent, with a first message', 'pf open ~/Projects/site --agent codex --here --prompt "Fix the failing build"'],
  ['Tell a pane something (delivered between its turns)', 'pf tell 3 "When this step is done, commit and stop"'],
  ['Close a pane', 'pf close 3'],
  ['Tidy the desk: clear finished panes, list duplicate idle ones (add --dupes to close them)', 'pf tidy --dry-run'],
  ['Move a pane\'s work to another agent (e.g. when Claude\'s usage runs out)', 'pf move 3 --to codex']
]

export const COMMAND_NAMES = COMMANDS.map((c) => c.name)

export function isCommand(name) {
  return COMMAND_NAMES.includes(name)
}

export function helpText() {
  const out = [
    'pf - drive PaneForge (the window of terminal panes, each running a coding agent or a shell) from any shell.',
    '',
    'For agents:'
  ]
  for (const [what, line] of RECIPES) out.push(`  ${what}:`, `      ${line}`)
  out.push('', 'Commands:')
  const width = Math.max(...COMMANDS.map((c) => c.name.length)) + 2
  for (const c of COMMANDS) {
    out.push(`  ${c.name.padEnd(width)}${c.summary}`)
    out.push(`  ${' '.repeat(width)}e.g. ${c.example}`)
  }
  out.push(
    '',
    'A <pane> is its number from `pf list` (the number on its card), its exact name, or its id.',
    'Agents: `pf agents` lists the ids installed here (claude, codex, grok, antigravity, shell, ...).',
    'More on one command: pf help <command>',
    'Exit codes: 0 ok, 1 refused / not found / call failed, 2 PaneForge not running or its phone server is off.'
  )
  return out.join('\n')
}

/** Everything about one command, or null when there is no such command. */
export function commandHelp(name) {
  const c = COMMANDS.find((x) => x.name === name)
  if (!c) return null
  const out = [`pf ${c.name} - ${c.summary}`, '', `Usage: ${c.usage}`, `Example: ${c.example}`]
  if (c.detail?.length) out.push('', ...c.detail)
  return out.join('\n')
}

// ------------------------------------------------------------------------ pane safety

/** Minutes a keystroke keeps a pane "in use" for `pf tidy`. */
export const RECENT_TYPING_MS = 10 * 60_000

const isRemote = (p) => Boolean(p.remote) || String(p.id).startsWith('@')
const isBusy = (p) => p.status === 'working' || p.status === 'starting' || Boolean(p.runSince)

/**
 * Why a pane is in the middle of something. Each reason is a plain sentence, printed as is.
 * Shared by tidy (never close it) and move (not at a safe boundary yet).
 */
function busyReasons(p, now) {
  const why = []
  if (isBusy(p)) why.push('it is working')
  if (p.ask) why.push('it is asking a question')
  if (p.handingOff || p.handoffQueuedAt || p.handoffStage) why.push('it is in the middle of a handoff')
  if (p.handoverUntil && p.handoverUntil > now) why.push('it is being cleared and resumed')
  if (p.autoClearAt) why.push('an automatic clear is scheduled for it')
  if (p.owedPrompt) why.push('a message is queued for it')
  if (p.drafting) why.push('text is typed in its prompt box and not sent')
  if (p.backJob || p.subagent) why.push('a background job is running inside it')
  if (p.job) why.push('a command is running in it')
  return why
}

/** Why `pf tidy --dupes` must leave this pane where it is. Empty = it may be closed. */
export function tidyHoldReasons(p, { now = Date.now(), self } = {}) {
  const why = []
  if (self && p.id === self) why.push('it is the pane running this command')
  if (isRemote(p)) why.push('it is on another computer - close it there')
  why.push(...busyReasons(p, now))
  if (p.status !== 'idle' && !isBusy(p)) why.push(`it is ${p.asleep ? 'asleep' : p.status}`)
  if (p.keepOpen || p.closeKept) why.push('it is set to stay open')
  if (p.focused) why.push('it is the pane open on screen')
  if (p.watched) why.push('somebody is looking at it on a phone')
  const typed = typedAt(p)
  if (typed && now - typed < RECENT_TYPING_MS)
    why.push(`it was typed into ${Math.max(1, Math.round((now - typed) / 60_000))} min ago`)
  return why
}

/**
 * When a person last typed into the pane, or 0. The app stamps `lastKeyboard` with the
 * moment a pane opens, so a pane nobody has touched reads as typed-into at birth - measured
 * 2026-09-24 on two fresh shell panes, `lastKeyboard - createdAt` = 0 on both.
 */
function typedAt(p) {
  const born = Math.max(p.createdAt ?? 0, p.openedAt ?? 0)
  return p.lastKeyboard && p.lastKeyboard > born + 1000 ? p.lastKeyboard : 0
}

/** The same test "Clear finished" applies (src/shared/exitedSweep.ts `isFinished`). */
export function isFinishedPane(p) {
  if (isRemote(p) || p.status !== 'exited' || p.asleep || p.ask || p.handingOff || !p.exitedAt) return false
  if (p.lastKeyboard && p.lastKeyboard > p.exitedAt) return false
  return true
}

function folderKey(p) {
  const device = isRemote(p) ? String(p.id).split('/')[0] : ''
  let cwd = String(p.cwd ?? '').replace(/[\\/]+$/, '')
  // A Windows path names the same folder in any case.
  if (/^[A-Za-z]:[\\/]/.test(cwd)) cwd = cwd.toLowerCase().replace(/\//g, '\\')
  if (cwd.startsWith('/private/tmp/')) cwd = cwd.slice('/private'.length)
  return `${device}|${cwd}|${p.agent ?? ''}`
}

const lastActive = (p) => Math.max(p.lastOutput ?? 0, typedAt(p))

/**
 * Duplicate panes: 2+ panes (not finished, not screen views) on the same folder and agent
 * on the same computer. Per group the most recently active pane is kept - a busy one counts
 * as the most active of all - and every other one is either `close` (idle, nothing holds
 * it) or `held` with the reasons it stays.
 *
 * `list` is the `sessions:list` answer in its own order; `number` is the 1-based place in
 * it, the number on the card.
 */
export function findDuplicates(list, { now = Date.now(), self } = {}) {
  const groups = new Map()
  list.forEach((p, i) => {
    if (p.status === 'exited' || p.agent === 'screen' || p.screen) return
    const key = folderKey(p)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push({ pane: p, number: i + 1 })
  })
  const out = []
  for (const members of groups.values()) {
    if (members.length < 2) continue
    // Busy first, then a pane something was ever asked of (`engaged`): a pane opened a
    // minute ago and never used has the newest output (its banner) and nothing to lose,
    // and ranking by time alone kept it and closed the chat with the work in it.
    const ranked = [...members].sort(
      (a, b) =>
        Number(isBusy(b.pane)) - Number(isBusy(a.pane)) ||
        Number(Boolean(b.pane.engaged)) - Number(Boolean(a.pane.engaged)) ||
        lastActive(b.pane) - lastActive(a.pane)
    )
    const [keep, ...rest] = ranked
    const close = []
    const held = []
    for (const m of rest) {
      const why = tidyHoldReasons(m.pane, { now, self })
      if (why.length) held.push({ ...m, why })
      else close.push(m)
    }
    out.push({ cwd: keep.pane.cwd, agent: keep.pane.agent, keep, close, held })
  }
  return out
}

/** Agents whose conversation the app tracks by id - the ones a failed move can reopen. */
const TRACKED = new Set(['claude', 'openrouter', 'deepseek', 'glm', 'codex'])

/**
 * Why `pf move` must not move this pane now, or null when it may. A pane mid-turn would
 * lose the turn; one asking a question would lose the question; one whose conversation
 * has no id yet could not be reopened if the new agent fails to start (the same guard as
 * `src/main/continuation.ts`).
 */
export function moveRefusal(p, { now = Date.now(), self } = {}) {
  if (self && p.id === self)
    return 'a pane cannot move itself while it is running a command - run pf move from another pane or a terminal'
  if (isRemote(p)) return 'it runs on another computer, and its conversation is not on this one - move it from there'
  if (p.agent === 'shell') return 'it is a shell - there is no conversation to move'
  if (p.agent === 'screen' || p.screen) return 'it is a screen view, not a chat'
  const why = busyReasons(p, now)
  if (why.length) return `${why.join(', ')} - wait until it is idle, then move it`
  if (TRACKED.has(p.agent) && !p.resumeId)
    return 'its conversation has not been identified yet, so it could not be reopened if the move failed - try again in a minute'
  return null
}

/** Two spellings of one folder (`/tmp` is `/private/tmp` on a Mac, a Windows drive in any case). */
export function samePath(a, b) {
  const norm = (p) => {
    let s = String(p ?? '')
    try {
      s = realpathSync(s)
    } catch {
      /* a folder that is gone compares as written */
    }
    s = s.replace(/[\\/]+$/, '')
    return /^[A-Za-z]:[\\/]/.test(s) ? s.toLowerCase().replace(/\//g, '\\') : s
  }
  return norm(a) === norm(b)
}

/**
 * The repo's lane ledger (`.git/paneforge-lanes.json`, written by scripts/lane.mjs), or
 * null when the folder is not in a git repo that has one. The app counts every folder a
 * ledger lane claims as taken (`ledgerTakenFolders` in src/main/laneLedger.ts).
 */
export function laneLedger(cwd) {
  const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
    encoding: 'utf8',
    windowsHide: true
  })
  const common = r.status === 0 ? r.stdout.trim() : ''
  if (!common || basename(common) !== '.git') return null
  try {
    const state = JSON.parse(readFileSync(join(common, 'paneforge-lanes.json'), 'utf8'))
    return { main: dirname(common), lanes: state.lanes ?? {} }
  } catch {
    return null
  }
}

/** Which pane id the ledger says holds `cwd`, or null. Lane `a` of `/x/repo` is `/x/repo-a`. */
export function claimHolder(ledger, cwd) {
  if (!ledger) return null
  for (const [lane, claim] of Object.entries(ledger.lanes)) {
    const dir = lane === 'main' ? ledger.main : join(dirname(ledger.main), `${basename(ledger.main)}-${lane}`)
    if (claim?.pane && samePath(dir, cwd)) return claim.pane
  }
  return null
}

/**
 * Why the moved chat could not reopen in the SAME folder, or null. The app gives a pane
 * opened in a folder that is taken - by another pane on this desk, open or asleep, or by
 * another chat's lane claim - its own copy of the folder, and the new agent would carry on
 * without the old one's uncommitted work.
 */
export function folderRefusal(list, pane, holder) {
  const other = list.findIndex(
    (x) => x.id !== pane.id && !isRemote(x) && (x.status !== 'exited' || x.asleep) && samePath(x.cwd, pane.cwd)
  )
  if (other >= 0)
    return `pane ${other + 1} "${list[other].title}" is also in ${pane.cwd}, so the new agent would open in a separate copy of it - close or move that pane first`
  if (holder && holder !== pane.id)
    return `another chat (${holder}) holds ${pane.cwd}, so the new agent would open in a separate copy of it`
  return null
}

// ------------------------------------------------------------------------ handoff brief

/** Claude Code spells a folder's conversation directory with every non-alphanumeric as `-`. */
export function claudeProjectDir(claudeHome, cwd) {
  return join(claudeHome, 'projects', String(cwd).replace(/[^A-Za-z0-9]/g, '-'))
}

/**
 * The file a pane's conversation is recorded in, or null. Claude-family CLIs keep
 * `<claudeHome>/projects/<folder>/<id>.jsonl`; Codex keeps
 * `<codexHome>/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`.
 */
export function findTranscript({ cwd, resumeId, agent, claudeHome, codexHome }) {
  if (!resumeId || !/^[A-Za-z0-9-]+$/.test(resumeId)) return null
  const claude = () => {
    const direct = join(claudeProjectDir(claudeHome, cwd), `${resumeId}.jsonl`)
    if (existsSync(direct)) return direct
    const root = join(claudeHome, 'projects')
    if (!existsSync(root)) return null
    for (const dir of readdirSync(root)) {
      const file = join(root, dir, `${resumeId}.jsonl`)
      if (existsSync(file)) return file
    }
    return null
  }
  const codex = () => {
    const suffix = `-${resumeId}.jsonl`
    const walk = (dir) => {
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return null
      }
      for (const e of entries) {
        const path = join(dir, e.name)
        if (e.isDirectory()) {
          const hit = walk(path)
          if (hit) return hit
        } else if (e.name.endsWith(suffix)) return path
      }
      return null
    }
    return walk(join(codexHome, 'sessions'))
  }
  return agent === 'codex' ? codex() ?? claude() : claude() ?? codex()
}

/** Only the tail of a very long conversation is read: the last exchange is at the end. */
const TAIL_BYTES = 16 * 1024 * 1024

export function readTail(file, max = TAIL_BYTES) {
  const fd = openSync(file, 'r')
  try {
    const size = fstatSync(fd).size
    const start = Math.max(0, size - max)
    const buf = Buffer.alloc(size - start)
    let n = 0
    while (n < buf.length) {
      const read = readSync(fd, buf, n, buf.length - n, start + n)
      if (!read) break
      n += read
    }
    const text = buf.toString('utf8', 0, n)
    // A cut into the middle of a line is not JSON: drop that partial first line.
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text
  } finally {
    closeSync(fd)
  }
}

const textOf = (blocks, type) =>
  Array.isArray(blocks)
    ? blocks
        .filter((b) => b && b.type === type && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n')
    : ''

/** Words the CLI put in the user's name that nobody typed: slash-command echoes, context blocks. */
const notTyped = (t) =>
  !t.trim() || /^\s*</.test(t) || t.startsWith('[Request interrupted') || t.startsWith('Caveat:') || t.startsWith('# AGENTS.md')

/** One transcript row as a turn, or null when it is not something a person or the agent said. */
function turnOf(row) {
  if (!row || typeof row !== 'object' || row.isSidechain || row.isMeta) return null
  // Claude Code: one row per content block; tool calls and results ride in the same rows.
  if ((row.type === 'user' || row.type === 'assistant') && row.message) {
    const c = row.message.content
    if (row.type === 'user') {
      const text = typeof c === 'string' ? c : textOf(c, 'text')
      return notTyped(text) ? null : { role: 'user', text }
    }
    const text = textOf(c, 'text')
    return text.trim() ? { role: 'assistant', text } : null
  }
  // Codex rollouts.
  if (row.type === 'response_item' && row.payload?.type === 'message') {
    const p = row.payload
    if (p.role === 'user') {
      const text = textOf(p.content, 'input_text')
      return notTyped(text) ? null : { role: 'user', text }
    }
    if (p.role === 'assistant') {
      const text = textOf(p.content, 'output_text')
      return text.trim() ? { role: 'assistant', text } : null
    }
  }
  return null
}

/**
 * The last thing asked and the last reply, out of a transcript's text (JSONL).
 * `answered` is false when the last ask has no reply yet - the reply is then the one
 * before it, and the brief says so.
 */
export function lastExchange(jsonl) {
  let ask = ''
  let reply = []
  let earlier = ''
  for (const line of String(jsonl).split('\n')) {
    if (!line.trim()) continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    const turn = turnOf(row)
    if (!turn) continue
    if (turn.role === 'user') {
      if (reply.length) earlier = reply.join('\n\n')
      ask = turn.text
      reply = []
    } else reply.push(turn.text)
  }
  return reply.length ? { ask, reply: reply.join('\n\n'), answered: true } : { ask, reply: earlier, answered: false }
}

/** Keep the END of a long reply (where the result and next steps are); the start of a long ask. */
export function clipTail(text, max) {
  const t = String(text ?? '').trim()
  return t.length <= max ? t : `[... ${t.length - max} earlier characters cut ...]\n${t.slice(-max)}`
}
export function clipHead(text, max) {
  const t = String(text ?? '').trim()
  return t.length <= max ? t : `${t.slice(0, max)}\n[... ${t.length - max} more characters cut - see the conversation file ...]`
}

export const REPLY_CHARS = 4000
export const ASK_CHARS = 3000

/** Colour codes and cursor moves out of raw terminal output. */
export function stripAnsi(s) {
  return String(s ?? '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
}

/**
 * The file a moved chat opens with. Everything the next agent needs to carry on without
 * the person repeating themselves: where, what was being done, and where the full record is.
 */
export function buildHandoffBrief({ pane, number, to, model, transcript, exchange, screen, now = new Date() }) {
  const from = `${pane.agent}${pane.model ? ` (${pane.model})` : ''}`
  const next = `${to}${model ? ` (${model})` : ''}`
  const out = [
    `# Handoff: continue this work on ${next}`,
    '',
    `This chat was moved from ${from} to ${next} with \`pf move\` on ${now.toISOString()} -`,
    `usually because the previous agent's usage limit ran out. Pick up where it stopped.`,
    '',
    `- Folder: ${pane.cwd} (work here; changes the previous chat made and did not commit are still in it)`,
    `- Previous agent: ${from}`,
    `- Previous pane: ${number ? `${number} ` : ''}"${pane.title}" (${pane.id})`,
    transcript
      ? `- Full conversation, one JSON event per line - search it for anything this brief leaves out: ${transcript}`
      : '- Full conversation: not found on this computer.',
    ''
  ]
  if (exchange) {
    out.push('## The last thing that was asked', '', clipHead(exchange.ask, ASK_CHARS) || '(not found in the conversation)', '')
    const cut = (exchange.reply ?? '').trim().length > REPLY_CHARS ? ` (its last ${REPLY_CHARS} characters)` : ''
    out.push(
      exchange.answered
        ? `## The last reply${cut}`
        : `## The reply before that${cut} - the last ask above had no reply yet`,
      '',
      clipTail(exchange.reply, REPLY_CHARS) || '(no reply found)',
      ''
    )
  } else if (screen) {
    out.push(`## The previous pane's last screen (its last ${REPLY_CHARS} characters)`, '', '```', clipTail(screen, REPLY_CHARS), '```', '')
  }
  out.push(
    '## Before you start',
    '',
    '1. If the ask and reply above do not make "done" clear, read the conversation file.',
    '2. Look at the folder\'s current state (in a git folder: `git status`, `git log --oneline -5`).',
    '3. Carry on with the next step. Do not redo work that is already finished.',
    ''
  )
  return out.join('\n')
}

export function movePrompt(briefPath) {
  return `Continue this work. Handoff brief: ${briefPath}. Read it first.`
}
