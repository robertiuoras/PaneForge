#!/usr/bin/env node
/**
 * pf-ctl - drive a RUNNING PaneForge from the command line, over the phone server.
 *
 * The app's whole IPC surface is already published on localhost by the phone server
 * (src/main/phone.ts): pair once with the code from config, then any `invoke` channel
 * in src/shared/surface.ts is one POST away. This wraps the handful an automation
 * actually needs - list, open, close, type - rather than adding a second door to the
 * app (repo rule: channels are added to surface.ts, not to a transport).
 *
 * `pf help` is the full reference, written for an agent that has never seen PaneForge: every
 * command, a plain-words line and a copy-paste example each (the table is `COMMANDS` in
 * scripts/pf-ctl-lib.mjs). Bare `pf`, `pf --help` and `pf -h` print it too.
 *
 *   node scripts/pf-ctl.mjs help [command]
 *   node scripts/pf-ctl.mjs list
 *   node scripts/pf-ctl.mjs agents                  agent ids --agent / --to take, installed or not
 *   node scripts/pf-ctl.mjs tidy [--dupes] [--dry-run]   clear finished panes; list (or close) idle duplicates
 *   node scripts/pf-ctl.mjs move <pane> --to <agent> [--model M]   reopen a pane's work on another agent
 *   node scripts/pf-ctl.mjs open <cwd> [--title T] [--prompt P | --task BACKLOG_ID] [--model M] [--agent A]
 *                                       [--close-when-done] [--report-to <pane>]
 *   Queue-backed observer: open <cwd> --agent shell --compute-job <submitted-id> --compute-owner <native-id>
 *   Its terminal worker receipt is retained as a review before safe closure; no idle timeout.
 *   pf-ctl close-when-done [<title-or-id>] [--report-to <pane>]
 *                                       [--resume <chat-id> | --continue] [--here | --on <device>]
 *   node scripts/pf-ctl.mjs open-many <plan.json>
 *   node scripts/pf-ctl.mjs devices
 *   node scripts/pf-ctl.mjs needs-login <site> --url <url> [--machine WORDS]
 *                                        [--why "what it will do once signed in"]
 *   node scripts/pf-ctl.mjs tell <title-or-id> <text...>
 *   node scripts/pf-ctl.mjs continue <chat-id> --prompt-file <file> [--json]   next prompt to one conversation, reopening it if closed
 *   node scripts/pf-ctl.mjs close <title-or-id>
 *   node scripts/pf-ctl.mjs review <review.json>   record an agent completion/decision/blocked result
 *   node scripts/pf-ctl.mjs watch-job <job-id> --owner <native-id> --pane <exact-local-id>
 *   node scripts/pf-ctl.mjs rename <title-or-id> <name...>
 *   node scripts/pf-ctl.mjs composer <number-title-or-id>   what is typed but not sent
 *   node scripts/pf-ctl.mjs type <title-or-id> <text...>
 *   node scripts/pf-ctl.mjs devices | cost [--seconds N] | reload
 *   node scripts/pf-ctl.mjs call <channel> [json-arg...] | send <channel> [json-arg...]
 *   node scripts/pf-ctl.mjs hold [--bundle ID|--name APP|--pid N] [--reason R] [--ttl MIN] [--this]
 *   node scripts/pf-ctl.mjs hold list | hold release <id>
 *
 * Auth is self-serve: the pairing code lives in the app's own config.json, so a local
 * process that can read it is already inside the trust boundary. Pairs fresh each run -
 * pairing is idempotent and only wrong codes are rate limited.
 *
 * THIS IS THE ONLY WAY AUTOMATION MAY OPEN A PANE ON A MAC. `open -na PaneForge --args
 * --open <dir> --prompt <text>` looks equivalent and is not: measured 2026-08-11, it
 * SILENTLY DROPS THE WHOLE ARGUMENT LIST when any argument contains an em dash (U+2014),
 * exiting 0 with empty stderr - the app launches, finds no `--open`, and quits. An em
 * dash in `--title` alone kills it too, so it is not about the prompt and escaping the
 * value cannot fix it. It cost the #momin backlog runner five bundles across two days,
 * each one reporting "session spawned" with no pane anywhere. A JSON body has no argv
 * parser to lose bytes in, and `sessions:start` answers with the pane's id, so a caller
 * can VERIFY the pane against `sessions:list` rather than trust that a launcher accepted
 * a request. `--open` on the command line stays for a human typing it.
 *
 * Exit codes: 0 ok · 1 target not found / call failed · 2 phone server unreachable/off.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  buildHandoffBrief,
  claimHolder,
  commandHelp,
  continueTarget,
  findDuplicates,
  findTranscript,
  folderRefusal,
  helpText,
  isCommand,
  isFinishedPane,
  lastExchange,
  laneLedger,
  movePrompt,
  moveRefusal,
  readTail,
  samePath,
  stripAnsi
} from './pf-ctl-lib.mjs'

/*
 * `PF_USER_DATA` points this at ONE app's settings folder.
 *
 * A `npm run try` copy runs as its own profile with its own userData, its own phone
 * server and its own port, so without this the only PaneForge a script could drive was
 * the installed one - which is the app the session is running inside, and never the one
 * a change has just been built into.
 */
const USER_DATA =
  process.env.PF_USER_DATA ||
  (process.platform === 'win32'
    ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'claude-orchestrator')
    : process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support', 'claude-orchestrator')
      : join(homedir(), '.config', 'claude-orchestrator'))

function phoneConfig() {
  let raw
  try {
    raw = readFileSync(join(USER_DATA, 'config.json'), 'utf8')
  } catch {
    fail(2, `no PaneForge config at ${USER_DATA} - is PaneForge installed on this machine?`)
  }
  // No refusal on `phone.on`: with phone access off the app still listens on this
  // machine only (`PhoneServer.localOnly`), and that listener is what `pf` talks to.
  const phone = JSON.parse(raw).phone ?? {}
  return { port: phone.port ?? 7312, code: phone.code ?? '' }
}

/** Thrown by `fail` and caught around `main`: the refusal is already printed. */
class Refused extends Error {}

function fail(codeNum, msg) {
  console.error(`pf-ctl: ${msg}`)
  // Not process.exit(): on Windows, exiting while fetch's keep-alive socket is still being
  // closed aborts inside libuv (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`)
  // and the exit code becomes 3221226505 instead of this one - measured 2026-09-26 on every
  // `pf continue` refusal made after the app had been asked something. The process ends on
  // its own once the socket is closed, with this code.
  process.exitCode = codeNum
  throw new Refused(msg)
}

let cookie = ''
let base = ''

async function post(path, body) {
  let res
  try {
    res = await fetch(base + path, {
      method: 'POST',
      headers: cookie ? { cookie } : {},
      body: JSON.stringify(body)
    })
  } catch {
    fail(
      2,
      `PaneForge is not answering on this machine (${base}) - is it running? (builds before this one answer pf only with Phone switched on in Settings)`
    )
  }
  if (res.status === 401) fail(2, 'not paired and pairing was refused - check the code in config.json')
  return res
}

async function pair() {
  const { port, code } = phoneConfig()
  base = `http://127.0.0.1:${port}`
  const res = await post('/pf/pair', { code })
  if (!res.ok) fail(2, `pairing failed (${res.status}) - wrong code or rate limited, retry in 60s`)
  const set = res.headers.get('set-cookie') ?? ''
  cookie = set.split(';')[0]
  if (!cookie) fail(2, 'pairing answered ok but set no cookie')
}

async function call(channel, args) {
  const out = await tryCall(channel, args)
  if (out.error) fail(1, `${channel}: ${out.error}`)
  return out.value
}

/** `call` that hands a refusal back instead of exiting - for a step that has to undo one before it. */
async function tryCall(channel, args) {
  const res = await post('/pf/call', { id: 1, channel, args })
  const out = await res.json().catch(() => ({ error: `unreadable answer (HTTP ${res.status})` }))
  return out.error ? { error: String(out.error) } : { value: out.value }
}

/** Fire-and-forget send channels (pty:write) go through /pf/send, ordered, no reply. */
async function send(channel, args) {
  await post('/pf/send', { calls: [{ channel, args }] })
}

async function sessions() {
  return (await call('sessions:list', [])) ?? []
}

/**
 * A title names at most one pane for automation; ids always win.
 *
 * A bare NUMBER is the pane's place on the desk - the number drawn on its card, the one
 * Ctrl+<n> reaches, and the only name Robert ever uses for a pane ("check PaneForge
 * session 12"). It was the one name this CLI could not answer to: `pf list` printed
 * `s45-mu5kq7f9` and no number at all, so another session asked about pane 12 looked at
 * that list, found no 12, and told him it did not exist (2026-09-17). The order here is
 * the order `sessions:list` returns, which is the sidebar's own order.
 */
function resolve(list, ref) {
  const byId = list.find((s) => s.id === ref)
  if (byId) return byId
  if (/^\d+$/.test(ref)) {
    const at = list[Number(ref) - 1]
    if (!at) fail(1, `there is no pane ${ref} - the desk has ${list.length}`)
    return at
  }
  const byTitle = list.filter((s) => s.title === ref)
  if (byTitle.length > 1)
    fail(1, `"${ref}" names ${byTitle.length} panes - use an id: ${byTitle.map((s) => s.id).join(', ')}`)
  return byTitle[0]
}

function flag(argv, name) {
  const i = argv.indexOf(name)
  if (i < 0) return undefined
  const v = argv[i + 1]
  argv.splice(i, 2)
  return v
}

/**
 * `pf open-many <plan.json>` - many panes, one call. The file is `[{cwd, prompt|task,
 * agent?, model?, on?}]`; `on` is the same name `--on`/the Devices dialog would take and
 * maps straight onto `StartSessionRequest.device`. Pure and exported so a caller (or this
 * suite) can check the parsing without a running app - a plan that is not an array, or a
 * row with no `cwd`, is a mistake in the file and is refused HERE, before anything is sent.
 */
export function readOpenManyPlan(path) {
  let rows
  try {
    rows = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    throw new Error(`could not read plan ${path} - ${e instanceof Error ? e.message : e}`)
  }
  if (!Array.isArray(rows)) throw new Error(`${path} must be a JSON array of {cwd, prompt|task, ...}`)
  return rows.map((row, n) => {
    if (!row || typeof row !== 'object' || !row.cwd)
      throw new Error(`row ${n} in ${path} has no "cwd"`)
    if (row.prompt && row.task) throw new Error(`row ${n} in ${path} has both "prompt" and "task"`)
    return {
      cwd: row.cwd,
      title: row.title,
      prompt: row.prompt,
      task: row.task,
      agent: row.agent,
      model: row.model,
      device: row.on
    }
  })
}

// realpath: ~/.local/bin/pf is a symlink, and a symlinked argv[1] never equals import.meta.url,
// so every `pf ...` call silently did nothing and exited 0 (2026-09-07).
const isMain = import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? "/")).href
const [cmd, ...rest] = isMain ? process.argv.slice(2) : []
if (isMain)
  await main().catch((e) => {
    if (!(e instanceof Refused)) throw e
  })

async function main() {

/*
 * Help, and every mistyped command, answer WITHOUT the app.
 *
 * 2026-09-24: a Codex chat concluded "PaneForge's local control API appears disabled, and
 * its launcher cannot select Codex" - both false (`pf list` worked, `pf open --agent codex`
 * existed). It could not find out: `pf --help` was itself an unknown command, and the only
 * list of commands was the error line, which named no flags. An agent learns a tool by
 * asking it, so the tool answers - bare `pf`, `--help`, `-h`, `pf help <command>`, and
 * `pf <command> --help` - and a wrong word points at the answer rather than at the source.
 */
if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
  const topic = cmd === 'help' ? rest[0] : undefined
  if (!topic) {
    console.log(helpText())
    process.exit(0)
  }
  const one = commandHelp(topic)
  if (!one) fail(1, `no command "${topic}" - run: pf help`)
  console.log(one)
  process.exit(0)
}
// A command agents were taught and that is gone is answered with what replaced it, rather
// than with the list of everything. `pf login` opened the sign-in picture until 2026-09-25.
const RETIRED = {
  login:
    'pf login was removed with the sign-in picture. To say a job cannot sign in: pf needs-login <site> --url <url> [--why TEXT]'
}
if (Object.hasOwn(RETIRED, cmd)) fail(1, RETIRED[cmd])
if (!isCommand(cmd))
  fail(
    1,
    `unknown command "${cmd}" - use: help | list | agents | open | open-many | devices | tell | continue | type | composer | close | close-when-done | tidy | move | rename | review | watch-job | needs-login | hold | cost | reload | call | send - run: pf help`
  )
if (rest[0] === '--help' || rest[0] === '-h') {
  console.log(commandHelp(cmd))
  process.exit(0)
}

/** One argument, safe to paste into a shell as a single word. */
function shellQuote(word) {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word
  return `'${String(word).replace(/'/g, `'"'"'`)}'`
}

/*
 * A sign-in request is checked BEFORE the app is asked for anything.
 *
 * The whole point of the card is that a person walks over to it and signs in, so an ask
 * that names no site, or an address that is not an address, must cost nobody that walk.
 * It refuses here, where the mistake was made, rather than putting up a card that sends
 * a person to nothing.
 */

/*
 * The flags `needs-login` took while it could open a live picture of the automation
 * browser (removed 2026-09-25, see docs/specs/remote-login-pane.md). Each one promised
 * something that no longer happens - a tunnel, a picture, a card on the other computer -
 * so it is refused by name rather than quietly dropped.
 */
const REMOVED_LOGIN_FLAGS = ['--host', '--port', '--open', '--desk', '--me', '--pf', '--report-to', '--report-host']

let loginArgs = null
if (cmd === 'needs-login') {
  const removed = REMOVED_LOGIN_FLAGS.find((f) => rest.includes(f))
  if (removed)
    fail(
      1,
      `${removed} was removed with the sign-in picture - pf needs-login now only puts a "needs you" card on the computer it runs on. Say which computer the sign-in is for with --machine.`
    )
  const machine = flag(rest, '--machine')
  const url = flag(rest, '--url')
  const why = flag(rest, '--why')
  const site = rest[0]
  if (!site) fail(1, 'needs-login needs a site: pf needs-login <site> --url <url>')
  if (!url) fail(1, 'needs-login needs --url <address of the sign-in page>')
  if (!/^https?:\/\//i.test(url))
    fail(1, `--url must start with http:// or https:// - got "${url}"`)
  loginArgs = { site, url, machine, why, from: process.env.PF_PANE }
}

/**
 * `pf hold` - tell GuardDeck's reapers to leave something alone while this session is
 * still using it.
 *
 * 2026-09-04: the Idle App Reaper quit a PaneForge dev build mid-review - "Electron:
 * idle 61m, holding 276 MB, 0.2% cpu". Every signal it has said abandoned, and a build
 * put on screen for review is looked at rather than clicked, so no amount of tuning
 * those signals fixes it. The session that produced the build is the only thing on the
 * machine that knows, so it says so.
 *
 * Deliberately handled BEFORE pairing: a hold is a local file, and a session wants one
 * whether or not the app is up. On a machine with no GuardDeck it is a no-op rather than
 * an error - a hold can only ever spare something, so failing to take one is never the
 * dangerous direction.
 *
 * The hold dies on its own two ways: a TTL, and (with --this) the pid of whatever
 * invoked pf. That second one is what makes "while my session is running" true instead
 * of hopeful - close the pane and the hold goes with it.
 */
if (cmd === 'hold') {
  const holdsPath =
    process.env.GUARDDECK_HOLDS_MODULE ||
    join(homedir(), 'Projects', 'claude-memory', 'claude-config', 'guarddeck-holds.mjs')
  let H
  try {
    H = await import(pathToFileURL(holdsPath).href)
  } catch {
    console.log('no GuardDeck on this machine - nothing needs holding')
    process.exit(0)
  }
  const sub = rest[0] === 'list' || rest[0] === 'release' ? rest.shift() : 'add'
  if (sub === 'list') {
    const holds = H.readHolds()
    if (!holds.length) console.log('nothing held')
    for (const h of holds)
      console.log(
        [h.id, [...h.bundleIDs, ...h.names, ...h.pids.map((n) => `pid ${n}`)].join(','), H.describe(h)].join('\t')
      )
    process.exit(0)
  }
  if (sub === 'release') {
    const id = rest.shift()
    if (!id) fail(1, 'release needs a hold id - see `pf hold list`')
    console.log(H.releaseHold(id) ? 'released' : 'no such hold')
    process.exit(0)
  }
  const many = (name) => rest.filter((a, i) => rest[i - 1] === `--${name}`)
  const bundleIDs = many('bundle')
  const names = many('name')
  const pids = many('pid')
  // The common case by a mile: this pane just built the app it is looking at.
  if (!bundleIDs.length && !names.length && !pids.length) bundleIDs.push('com.github.Electron')
  const thisSession = rest.includes('--this')
  try {
    const hold = H.addHold({
      bundleIDs,
      names,
      pids,
      reason: flag(rest, '--reason') ?? 'in use by a PaneForge session',
      owner: flag(rest, '--owner') ?? (process.env.PF_PANE ? `pane ${process.env.PF_PANE}` : 'a local session'),
      // `--this` binds the hold to the process that ran pf, which inside a pane is that
      // pane's shell. Without it the TTL is the only expiry.
      ownerPid: thisSession ? process.ppid : undefined,
      ttlMin: flag(rest, '--ttl')
    })
    console.log(
      `held ${hold.id} until ${new Date(hold.expiresAt).toLocaleTimeString()}` +
        (hold.ownerPid ? ` or until this session exits` : '')
    )
  } catch (e) {
    fail(1, e instanceof Error ? e.message : String(e))
  }
  process.exit(0)
}

// The suite drives the refusals above without an app on the machine; everything past this
// line needs one.
// `pf tell` refuses BEFORE it needs an app, like every other command that can be typed
// wrong: a line with no pane to say it to is a mistake, not a message.
if (cmd === 'tell') {
  if (rest.length < 2 || !rest[0] || !rest.slice(1).join(' ').trim())
    fail(1, 'tell needs a pane and one line: pf-ctl tell <title-or-id> <text...>')
}
// `pf continue` too: GuardDeck shows whatever this says to a person who typed a prompt and
// pressed Send, so a bad id or an empty file is refused here, before any pane is touched.
let continueArgs = null
if (cmd === 'continue') {
  const promptFile = flag(rest, '--prompt-file')
  const json = rest.includes('--json')
  const [resumeId, ...stray] = rest.filter((a) => a !== '--json')
  if (!resumeId || !promptFile)
    fail(1, 'continue needs a chat id and a prompt file: pf continue <chat-id> --prompt-file <file> - run: pf help continue')
  if (stray.length) fail(1, `continue takes one chat id, --prompt-file and --json, not: ${stray.join(' ')}`)
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(resumeId))
    fail(1, `"${resumeId}" is not a chat id - use the resumeId from the review notice, not a pane number or name`)
  let prompt
  try {
    prompt = readFileSync(promptFile, 'utf8')
  } catch (e) {
    fail(1, `could not read the prompt file ${promptFile} - ${e instanceof Error ? e.message : e}`)
  }
  if (!prompt.trim()) fail(1, `the prompt file ${promptFile} is empty - nothing to send`)
  if (prompt.length > 64000) fail(1, `the prompt is ${prompt.length} characters; the most one prompt can carry is 64000`)
  continueArgs = { resumeId, prompt: prompt.replace(/\s+$/, ''), json }
}
// So do `tidy` and `move`: a flag that is not theirs is a mistake, never a silent no-op.
let tidyArgs = null
if (cmd === 'tidy') {
  const stray = rest.filter((a) => a !== '--dupes' && a !== '--dry-run')
  if (stray.length) fail(1, `tidy takes only --dupes and --dry-run, not: ${stray.join(' ')} - run: pf help tidy`)
  tidyArgs = { dupes: rest.includes('--dupes'), dry: rest.includes('--dry-run') }
}
let moveArgs = null
if (cmd === 'move') {
  const to = flag(rest, '--to')
  const model = flag(rest, '--model')
  const [ref, ...stray] = rest
  if (!ref || !to) fail(1, 'move needs a pane and an agent: pf move <pane> --to <agent> [--model M] - run: pf help move')
  if (stray.length) fail(1, `move takes one pane, --to and --model, not: ${stray.join(' ')}`)
  moveArgs = { ref, to, model }
}

if (process.env.PF_CTL_NO_APP === '1') process.exit(0)

await pair()

/**
 * Where Claude Code keeps a folder's conversations. It spells the path with every
 * character that is not a letter or a digit turned into a dash, so `taskdriver.ai-a`
 * under `/Users/x/Projects` is `-Users-x-Projects-taskdriver-ai-a`.
 */
function projectDirFor(cwd) {
  return join(homedir(), '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'))
}

/** The transcript file for a chat id, wherever on this machine it was recorded. */
function transcriptAnywhere(id) {
  const root = join(homedir(), '.claude', 'projects')
  if (!existsSync(root)) return null
  for (const dir of readdirSync(root)) {
    const file = join(root, dir, `${id}.jsonl`)
    if (existsSync(file)) return file
  }
  return null
}

/**
 * `claude --resume <id>` reads the transcript out of the folder it is RUN IN, and the
 * app may open the pane in a lane copy (`taskdriver.ai-a`) because the project's own
 * folder is taken. The conversation is then simply not there and the resume falls back
 * to an empty chat - no error, which is how this went unnoticed. So the transcript is
 * copied next to the pane that is going to read it. Returns true when it had to.
 */
function placeTranscript(cwd, id) {
  const want = join(projectDirFor(cwd), `${id}.jsonl`)
  if (existsSync(want)) return false
  const found = transcriptAnywhere(id)
  if (!found) fail(1, `no conversation ${id} on this machine - check the id with pf-ctl list`)
  mkdirSync(projectDirFor(cwd), { recursive: true })
  copyFileSync(found, want)
  return true
}


if (cmd === 'list') {
  const list = await sessions()
  // The number leads, because it is the name on the card. See `resolve`.
  for (const [i, s] of list.entries()) console.log([i + 1, s.id, s.status, s.title, s.cwd].join('\t'))
  // A sign-in request is not a pane - it is a card waiting for somebody - so it is listed
  // too, and says which computer it is waiting on.
  const logins = (await call('login:list', [])) ?? []
  for (const r of logins)
    console.log([r.id, 'needs you', `Sign in to ${r.site} on ${r.machine}`, r.url].join('\t'))
} else if (cmd === 'agents') {
  // The running app's own catalogue, so an agent the person added is here too, and
  // "installed" is this computer's answer rather than a list baked into this file.
  for (const a of (await call('agents:list', [])) ?? [])
    console.log(
      [
        a.id,
        a.available === false ? 'not installed' : 'installed',
        a.label ?? a.id,
        (a.models ?? []).map((m) => (typeof m === 'string' ? m : m?.id)).filter(Boolean).join(', ')
      ].join('\t')
    )
} else if (cmd === 'tidy') {
  // One call to tidy the desk. Finished panes go the way the window's "Clear finished"
  // button sends them (same channel, same rule, their last reply kept in Review); then
  // duplicates - two panes of one agent in one folder - are listed, and with --dupes the
  // idle extras close. Which pane is safe to close is `findDuplicates`, the pure half.
  const { dupes, dry } = tidyArgs
  const self = process.env.PF_PANE
  const before = await sessions()
  const at = (list, p) => `${p.id} (pane ${list.indexOf(p) + 1} "${p.title}")`
  let closed = 0
  // A dry run numbers panes as they are now; a real one as they are once the finished
  // ones are gone - either way the number printed is the one on the card at that moment.
  // `findDuplicates` skips exited panes, so a dry run can hand it the desk as it stands.
  let desk = before
  if (dry) {
    const finished = before.filter(isFinishedPane)
    for (const p of finished) console.log(`would clear ${at(before, p)} - finished; its last reply stays in Review`)
    closed += finished.length
  } else {
    await call('sessions:clearFinished', [])
    desk = await sessions()
    for (const p of before.filter((p) => !desk.some((x) => x.id === p.id))) {
      console.log(`cleared ${at(before, p)} - finished; its last reply stays in Review`)
      closed++
    }
  }
  const groups = findDuplicates(desk, { now: Date.now(), self })
  let suggested = 0
  for (const g of groups) {
    const of = `duplicate of pane ${g.keep.number} "${g.keep.pane.title}" (${g.agent} in ${g.cwd})`
    for (const m of g.close) {
      const idle = Math.max(1, Math.round((Date.now() - (m.pane.lastOutput || Date.now())) / 60_000))
      if (!dupes) {
        console.log(`pf close ${m.pane.id}    # pane ${m.number} "${m.pane.title}", idle ${idle} min - ${of}`)
        suggested++
      } else if (dry) {
        console.log(`would close ${at(desk, m.pane)} - idle ${idle} min, ${of}`)
        closed++
      } else {
        await call('sessions:kill', [m.pane.id])
        if ((await sessions()).some((x) => x.id === m.pane.id)) {
          console.log(`could not close ${at(desk, m.pane)} - the app answered but it is still listed`)
          continue
        }
        console.log(`closed ${at(desk, m.pane)} - idle ${idle} min, ${of}`)
        closed++
      }
    }
    for (const m of g.held) console.log(`kept ${at(desk, m.pane)} - ${of}, but ${m.why.join(', ')}`)
  }
  if (!groups.length) console.log('no duplicate panes')
  if (suggested) console.log(`${suggested} idle duplicate${suggested === 1 ? '' : 's'} above: run the pf close lines, or: pf tidy --dupes`)
  const left = dry ? before.length - closed : (await sessions()).length
  console.log(dry ? `would close ${closed}, keep ${left} (dry run - nothing changed)` : `closed ${closed}, kept ${left}`)
} else if (cmd === 'move') {
  // Reopen a pane's work on another agent, with no copy-paste: the case is Claude's usage
  // running out mid-task and the same work carrying on in Codex (Robert, 2026-09-24).
  //
  // The OLD pane closes BEFORE the new one opens, which looks backwards and is not. The
  // folder is still in use until the old pane goes, and the app gives a second pane in a
  // busy git folder its own copy of it - measured 2026-09-24: two `pf open --here` into one
  // scratch repo landed in `/tmp/pf-lane-probe` and `/private/tmp/pf-lane-probe-a`. The new
  // agent would carry on in a copy on another branch, without the old one's uncommitted
  // work. So the safety runs the other way round: refuse while the pane is mid-anything
  // (`moveRefusal`), write the brief BEFORE closing, and reopen the old conversation if the
  // new pane does not start.
  const { ref, to, model } = moveArgs
  const agents = (await call('agents:list', [])) ?? []
  const target = agents.find((a) => a.id === to)
  const usable = agents.filter((a) => a.id !== 'shell' && a.available !== false).map((a) => a.id)
  if (!target) fail(1, `unknown agent "${to}" - use one of: ${agents.map((a) => a.id).join(', ')}`)
  if (to === 'shell') fail(1, `a shell cannot read a handoff brief - move to an agent: ${usable.join(', ')}`)
  if (target.available === false)
    fail(1, `${target.label ?? to} is not installed on this computer - installed: ${usable.join(', ')}`)
  // A model the agent does not list would start a CLI that quits on its first word. Only
  // checked when the catalogue lists models at all: Claude and Codex take any name.
  const models = (target.models ?? []).map((m) => (typeof m === 'string' ? m : m?.id)).filter(Boolean)
  if (model && models.length && !models.includes(model))
    fail(1, `${to} has no model "${model}" - it lists: ${models.join(', ')}`)
  const list = await sessions()
  const pane = resolve(list, ref)
  if (!pane) fail(1, `no pane named "${ref}"`)
  const number = list.indexOf(pane) + 1
  const refused = moveRefusal(pane, { now: Date.now(), self: process.env.PF_PANE })
  if (refused) fail(1, `will not move pane ${number} "${pane.title}" (${pane.id}): ${refused}`)
  // The folder has to be free the moment the old pane goes, or the new one opens in a copy.
  const holder = claimHolder(laneLedger(pane.cwd), pane.cwd)
  const taken = folderRefusal(list, pane, holder)
  if (taken) fail(1, `will not move pane ${number} "${pane.title}" (${pane.id}): ${taken}`)

  const transcript = findTranscript({
    cwd: pane.cwd,
    resumeId: pane.resumeId,
    agent: pane.agent,
    claudeHome: join(homedir(), '.claude'),
    codexHome: process.env.CODEX_HOME || join(homedir(), '.codex')
  })
  let exchange = null
  if (transcript) {
    try {
      exchange = lastExchange(readTail(transcript))
    } catch {
      exchange = null
    }
    if (exchange && !exchange.ask && !exchange.reply) exchange = null
  }
  // No readable conversation (an agent that keeps none where this looks): the pane's own
  // screen is the next best record of where it stopped.
  let screen
  if (!exchange) {
    const buf = await tryCall('sessions:buffer', [pane.id])
    if (typeof buf.value === 'string') screen = stripAnsi(buf.value)
  }
  const dir = join(tmpdir(), 'paneforge-move')
  mkdirSync(dir, { recursive: true })
  const brief = join(dir, `${pane.id.replace(/[^A-Za-z0-9-]/g, '_')}-${Date.now()}.md`)
  writeFileSync(brief, buildHandoffBrief({ pane, number, to, model, transcript, exchange, screen }))
  // Said BEFORE anything closes: if the app stops answering halfway, this is the way back.
  const undo = ['pf', 'open', pane.cwd, '--agent', pane.agent, ...(pane.resumeId ? ['--resume', pane.resumeId] : []), '--here']
    .map(shellQuote)
    .join(' ')
  console.log(`brief: ${brief}`)
  console.log(`if this stops halfway, reopen the old chat with: ${undo}`)

  await call('sessions:kill', [pane.id])
  if ((await sessions()).some((x) => x.id === pane.id))
    fail(1, `could not close pane ${number} (${pane.id}) - nothing was moved`)

  const reportTo = process.env.PF_PANE
  let fresh = null
  let why = ''
  let state = 'starting'
  // A lane claim is let go by the closed chat's own exit hook, a moment after the close.
  if (holder === pane.id) {
    for (const deadline = Date.now() + 15_000; Date.now() < deadline; ) {
      if (claimHolder(laneLedger(pane.cwd), pane.cwd) !== pane.id) break
      await new Promise((r) => setTimeout(r, 500))
    }
    if (claimHolder(laneLedger(pane.cwd), pane.cwd) === pane.id)
      why = `the closed chat still held ${pane.cwd} 15s later, so ${to} would have opened in a copy of it`
  }
  if (!why) {
    const opened = await tryCall('sessions:start', [
      { cwd: pane.cwd, title: pane.title, prompt: movePrompt(brief), agent: to, model, reportTo, where: 'local' }
    ])
    fresh = opened.value?.id ? opened.value : null
    why = opened.error ?? (fresh ? '' : 'the app opened nothing')
  }
  // "Started" is the pane listed, drawing, and STILL THERE a little later: `starting` is a
  // process with no output yet, and a CLI that draws its banner can still quit at a gate
  // before it reads a word. Measured 2026-09-24: Codex 0.156 in a folder it had not been
  // told to trust drew its banner, showed "Trust this folder?", and exited 3s after launch
  // - a first-output check had already printed `moved`, with the old pane gone.
  if (fresh && !samePath(fresh.cwd ?? pane.cwd, pane.cwd)) {
    why = `the app opened ${to} in ${fresh.cwd}, a copy of the folder, not in ${pane.cwd}`
    await tryCall('sessions:kill', [fresh.id])
    fresh = null
  }
  const stateOf = async () => (await sessions()).find((x) => x.id === fresh.id)?.status ?? 'gone'
  for (const deadline = Date.now() + 30_000; fresh && state === 'starting' && Date.now() < deadline; ) {
    await new Promise((r) => setTimeout(r, 500))
    state = await stateOf()
  }
  for (const settle = Date.now() + 10_000; fresh && state !== 'exited' && state !== 'gone' && Date.now() < settle; ) {
    await new Promise((r) => setTimeout(r, 500))
    state = await stateOf()
  }
  if (fresh && (state === 'exited' || state === 'gone')) {
    why = `the ${to} pane ${state === 'gone' ? 'disappeared' : 'quit'} as it started`
    if (state === 'exited') {
      // Its last words are the reason (a sign-in wall, a trust question, a bad model name).
      const buf = await tryCall('sessions:buffer', [fresh.id])
      const said = typeof buf.value === 'string' ? stripAnsi(buf.value).replace(/\s+/g, ' ').trim().slice(-300) : ''
      if (said) why += ` - its screen ended with: "${said}"`
      await tryCall('sessions:kill', [fresh.id])
    }
    fresh = null
  }
  if (!fresh) {
    // Put the old chat back. It may land in a copy too (the same claim is still held), so
    // its conversation file goes with it, the way `pf open --resume` does it.
    const back = await tryCall('sessions:start', [
      {
        cwd: pane.cwd,
        title: pane.title,
        agent: pane.agent,
        model: pane.model,
        reportTo,
        where: 'local',
        resume: Boolean(pane.resumeId) || undefined,
        resumeId: pane.resumeId || undefined
      }
    ])
    const at = back.value?.cwd ?? pane.cwd
    if (back.value?.id && pane.resumeId && pane.agent !== 'codex' && transcriptAnywhere(pane.resumeId)) {
      if (placeTranscript(at, pane.resumeId)) await tryCall('sessions:restart', [back.value.id])
    }
    fail(
      1,
      `could not start ${to}: ${why}. ` +
        (back.value?.id
          ? pane.resumeId
            ? `Reopened the old conversation as ${back.value.id} in ${at}.`
            : `Reopened ${pane.agent} as ${back.value.id} in ${at} - with no conversation id it starts empty; the brief has where it stopped.`
          : `Reopening the old chat failed too (${back.error ?? 'no pane'}) - reopen it with: ${undo}`) +
        ` Brief: ${brief}`
    )
  }
  const now = await sessions()
  console.log(
    `moved pane ${number} ${pane.id} (${pane.agent}) -> pane ${now.findIndex((x) => x.id === fresh.id) + 1} ${fresh.id} (${to}${model ? ` ${model}` : ''}) in ${fresh.cwd ?? pane.cwd}`
  )
  if (!transcript) console.log(`note: no conversation file found for ${pane.id}; the brief carries its last screen instead`)
  if (state === 'starting') console.log(`note: ${fresh.id} has drawn nothing yet after 40s - check it with pf list`)
} else if (cmd === 'needs-login') {
  const req = await call('login:need', [loginArgs])
  if (!req?.id) fail(1, 'PaneForge did not accept the sign-in request')
  console.log(req.id)
} else if (cmd === 'open') {
  const title = flag(rest, '--title')
  // A pane opened on a backlog task is briefed FROM the task: the app compiles the prompt
  // out of the row - what it is, why, the acceptance criterion it will be judged by, and
  // what the last failed attempt said - through the same forge every other prompt in the
  // app goes through. The lookup happens BEFORE the pane exists, so an id naming nothing
  // (or two things) refuses and opens no pane. Proved against the installed 0.8.188, which
  // does not carry the channel yet: `unknown channel backlog:task`, exit 1, no pane opened.
  const task = flag(rest, '--task')
  let prompt = flag(rest, '--prompt')
  if (task) {
    if (prompt) fail(1, 'open takes --task or --prompt, not both')
    const brief = await call('backlog:task', [task])
    if (!brief || brief.error) fail(1, brief?.error ?? 'the app could not read the backlog')
    prompt = brief.prompt
  }
  const model = flag(rest, '--model')
  const agent = flag(rest, '--agent')
  // A pane opened by automation has nobody sitting in it to close it when the job is
  // done, so it can be told to close itself - and to say so in the pane that opened it.
  // `--report-to` defaults to PF_PANE, which every pane's own agent is spawned with, so a
  // session opening a helper pane needs to name nothing.
  const closeWhenDone = rest.includes('--close-when-done')
  const reportTo = flag(rest, '--report-to') ?? process.env.PF_PANE
  // Reopening a conversation rather than starting one. `--resume <id>` names the chat -
  // the transcript's filename, which `pf-ctl list` and the history file both carry -
  // and `--continue` takes whichever is newest in the folder.
  //
  // BOTH halves go to the app: `buildArgs` only spells `--resume <id>` when `resume` is
  // true AS WELL, so a request carrying resumeId alone opens a silent fresh chat.
  const resumeId = flag(rest, '--resume')
  const continueLast = rest.includes('--continue')
  if (resumeId && continueLast) fail(1, 'open takes --resume <id> or --continue, not both')
  // Keep the pane on THIS desk. Without it `startOrSend` may hand the launch to the paired
  // machine, which is right for a person opening a pane and wrong for automation: the
  // caller is holding files, a lane and a transcript that exist only here, and a resume in
  // particular cannot follow - the conversation is not on that disk. Measured 2026-09-04:
  // three `pf-ctl open --resume` calls opened three empty panes on the PC.
  const here = rest.includes('--here') || Boolean(resumeId)
  // `--on <device>` names a paired device by its id or its Devices name - the same field
  // `StartSessionRequest.device` carries. It beats `--here` and `where`: a device asked for
  // by name is refused by name, never silently opened here instead (see offloadFirst.ts).
  const device = flag(rest, '--on')
  if (device && here) fail(1, 'open takes --here or --on <device>, not both')
  const cwd = rest[0]
  if (!cwd) fail(1, 'open needs a cwd: pf-ctl open <cwd> [--title T] [--prompt P]')
  const computeId = flag(rest, '--compute-job'), computeOwner = flag(rest, '--compute-owner')
  if ((computeId || computeOwner) && (!computeId || !computeOwner || agent !== 'shell' || closeWhenDone || prompt)) fail(1, 'compute observer requires --agent shell --compute-job ID --compute-owner native-ID, without --prompt or --close-when-done; submit the job first')
  const s = await call('sessions:start', [
    {
      cwd,
      title,
      prompt,
      model,
      agent,
      closeWhenDone,
      computeJob: computeId ? { id: computeId, owner: computeOwner } : undefined,
      // Always, not only with --close-when-done: the 3-minute auto-close takes these panes
      // too, and the opener hears once, when the last of them has closed
      // (`shared/finishedDigest.ts`).
      reportTo,
      where: here ? 'local' : undefined,
      device: device || undefined,
      resume: Boolean(resumeId) || continueLast || undefined,
      resumeId: resumeId || undefined
    }
  ])
  const landed = s?.cwd ?? cwd
  // Which of the two things happened: a new pane, or a prompt handed to the pane that was
  // already open on that folder. Only an IDLE pane with nothing queued takes a send - see
  // `shared/sendOrOpen.ts` - and a caller that cannot tell them apart cannot tell whether
  // its brief is being worked on now or behind somebody else's turn.
  if (s?.startAction === 'send') console.log(`sent to ${s?.id ?? '?'} (idle) in ${landed}`)
  else console.log(`opened ${s?.id ?? '?'} in ${landed}`)
  // The pane may have been placed in a lane copy, which is a different folder and so a
  // different set of conversations. Put the transcript there and start the agent again -
  // a pane seconds old has nothing to lose, and this is the only moment the id is known.
  if (resumeId && s?.id && placeTranscript(landed, resumeId)) {
    await call('sessions:restart', [s.id])
    console.log(`copied conversation ${resumeId} into ${landed} and restarted the pane`)
  }
} else if (cmd === 'open-many') {
  // Many panes, one call - 10s or 20+ at a time, "for any cli/model it chooses". Each row
  // is the same shape a single `open` builds; a `task` row is briefed the same way, one
  // `backlog:task` lookup per row, BEFORE anything is sent. `sessions:startMany` answers
  // one row per request and in the same order, each carrying either the pane it opened or
  // the words saying why that folder got none - so a refusal prints its own reason rather
  // than `see the app for why`. Matched back by POSITION, never by folder: a pane that
  // lands in a lane comes back with a different `cwd` (the worktree).
  const planPath = rest[0]
  if (!planPath) fail(1, 'open-many needs a plan file: pf-ctl open-many <plan.json>')
  let plan
  try {
    plan = readOpenManyPlan(planPath)
  } catch (e) {
    fail(1, e instanceof Error ? e.message : String(e))
  }
  const reqs = []
  for (const row of plan) {
    let prompt = row.prompt
    if (row.task) {
      const brief = await call('backlog:task', [row.task])
      if (!brief || brief.error) fail(1, `${row.cwd}: ${brief?.error ?? 'the app could not read the backlog'}`)
      prompt = brief.prompt
    }
    reqs.push({ cwd: row.cwd, title: row.title, prompt, agent: row.agent, model: row.model, device: row.device })
  }
  const rows = (await call('sessions:startMany', [reqs])) ?? []
  let refused = 0
  for (let n = 0; n < reqs.length; n++) {
    const on = reqs[n].device ? ` on ${reqs[n].device}` : ''
    const pane = rows[n]?.session
    if (pane?.id) {
      console.log(`opened ${pane.id} in ${pane.cwd ?? reqs[n].cwd}${on}`)
    } else {
      refused++
      console.log(`refused ${reqs[n].cwd}${on} - ${rows[n]?.why ?? 'the app said nothing about why'}`)
    }
  }
  if (refused) fail(1, `${refused} of ${reqs.length} panes were not opened`)
} else if (cmd === 'devices') {
  // What a plan could target: every paired device, whether it is online right now, and how
  // many panes it is already running - the numbers `--on <device>` and a plan's `on` field
  // are checked against.
  const state = await call('remote:state', [])
  console.log([state?.self?.id ?? '?', state?.self?.name ?? 'this machine', 'self', '-'].join('\t'))
  for (const p of state?.peers ?? [])
    console.log([p.id, p.name, p.status, String(p.panes?.length ?? p.sessions ?? 0)].join('\t'))
} else if (cmd === 'close') {
  const ref = rest[0]
  if (!ref) fail(1, 'close needs a pane: pf-ctl close <title-or-id>')
  const s = resolve(await sessions(), ref)
  if (!s) fail(1, `no pane named "${ref}"`)
  await call('sessions:kill', [s.id])
  // kill() deletes the session and re-emits the list, so absence IS the verification.
  const still = (await sessions()).some((x) => x.id === s.id)
  if (still) fail(1, `sessions:kill answered but ${s.id} is still listed`)
  console.log(`closed ${s.id} (${s.title})`)
} else if (cmd === 'watch-job') {
  const pane = flag(rest, '--pane')
  const job = rest[0], owner = flag(rest, '--owner')
  if (!pane || !job || !owner) fail(1, 'watch-job requires job ID, --owner native session ID, and --pane exact local shell ID; run on the job device')
  console.log(JSON.stringify(await call('sessions:watchCompute', [pane, job, owner])))
} else if (cmd === 'review') {
  const path = rest[0]
  if (!path) fail(1, 'review needs a JSON file with id, sessionId, kind, report, and proof')
  let input
  try { input = JSON.parse(readFileSync(path, 'utf8')) } catch (e) { fail(1, `could not read review JSON - ${e instanceof Error ? e.message : e}`) }
  const out = await call('reviews:record', [input])
  if (!out?.review?.id) fail(1, 'review was not recorded')
  console.log(JSON.stringify(out))
} else if (cmd === 'close-when-done') {
  // `pf open --close-when-done` only covers a pane automation opened. This arms the same
  // rule on a pane already on the desk - with no argument, the pane it is typed in, so a
  // chat that has finished its own work can say so about itself.
  const named = rest[0] && !rest[0].startsWith('--') ? rest[0] : undefined
  const ref = named ?? process.env.PF_PANE
  if (!ref) fail(1, 'close-when-done needs a pane: pf-ctl close-when-done [title-or-id]')
  const s = resolve(await sessions(), ref)
  if (!s) fail(1, `no pane named "${ref}"`)
  const armed = await call('sessions:closeWhenDone', [s.id, flag(rest, '--report-to')])
  if (!armed) fail(1, `the app would not arm ${s.id}`)
  console.log(`${s.id} (${s.title}) will close itself once it is done`)
} else if (cmd === 'rename') {
  // A pane wearing a name a person typed is never renamed by the app - that is the point
  // of `mayRename` - so a name typed WRONG (a client called `PiaTeam` when the roster says
  // `PIA Team`) can only be put right from outside. Without this the only way in was the
  // `call` escape hatch and the channel name, which is not something to rediscover.
  const ref = rest.shift()
  const name = rest.join(' ').trim()
  if (!ref || !name) fail(1, 'rename needs a pane and a name: pf-ctl rename <title-or-id> <name...>')
  const s = resolve(await sessions(), ref)
  if (!s) fail(1, `no pane named "${ref}"`)
  const was = s.title
  await call('sessions:rename', [s.id, name])
  // The rename re-emits the list, so the new name being LISTED is the verification.
  const now = (await sessions()).find((x) => x.id === s.id)
  if (now?.title !== name) fail(1, `sessions:rename answered but ${s.id} is still "${now?.title ?? '?'}"`)
  console.log(`renamed ${s.id} (${was} -> ${name})`)
} else if (cmd === 'composer') {
  // What is typed into a pane and NOT sent - the one thing every other read here misses.
  // The pty log carries the redraw stream, so a line sitting in a CLI's composer is
  // invisible in it; the app reconstructs the line from the keystrokes it relayed, which
  // is what this prints. Reads only: nothing is typed, submitted or cleared.
  const ref = rest.shift()
  if (!ref) fail(1, 'composer needs a pane: pf-ctl composer <number-title-or-id>')
  const pane = resolve(await sessions(), ref)
  if (!pane) fail(1, `no pane called "${ref}"`)
  const draft = await call('sessions:draft', [pane.id])
  if (!draft) fail(1, `pane ${pane.id} is not running, so it has no composer`)
  // An empty line with `certain` true is the one shape that really means nothing is
  // pending. Everything else is said out loud rather than printed as if it were the
  // screen: a line the app could not follow is a guess, and a pane typed into before
  // this app process started relayed nothing and has no draft at all.
  const screen = draft.from === 'screen'
  if (!draft.text) {
    console.error(
      screen
        ? `pane ${pane.id} has nothing unsent`
        : draft.certain
          ? `pane ${pane.id} has nothing unsent that this app relayed - its window could not be asked, so a line typed before the app started would not show here`
          : `pane ${pane.id} has nothing the app can vouch for - it relayed no keystrokes for the current line`
    )
    process.exitCode = screen || draft.certain ? 0 : 1
    return
  }
  if (!screen && !draft.certain)
    console.error(`(uncertain - the line was edited in a way the app could not follow, so this may be incomplete)`)
  console.log(draft.text)
} else if (cmd === 'tell') {
  // One line into a pane, queued for the gap between its turns rather than typed into
  // the middle of one - the same door the sign-in card reports back through.
  const ref = rest.shift()
  const text = rest.join(' ')
  if (!ref || !text) fail(1, 'tell needs a pane and one line: pf-ctl tell <title-or-id> <text...>')
  // Resolved HERE, not by the app: `tellPane` matches an id or a title and nothing else,
  // and a send channel has no reply - so `pf tell 3 ...` printed `told 3` and delivered
  // nothing, to the one name for a pane everybody uses (2026-09-24).
  const s = resolve(await sessions(), ref)
  if (!s) fail(1, `no pane named "${ref}"`)
  await send('pane:tell', [s.id, text])
  console.log(`told ${s.id} (${s.title})`)
} else if (cmd === 'continue') {
  // GuardDeck's "next prompt" box (Robert, 2026-09-26): a finished chat closes itself, its
  // result shows in GuardDeck, and what he types there has to reach THAT conversation -
  // open, asleep, or closed. `continueTarget` decides which; this only carries it out.
  const { resumeId, prompt, json } = continueArgs
  const target = continueTarget(resumeId, await sessions(), (await call('history:list', [])) ?? [])
  if (target.error) fail(1, target.error)
  let paneId
  const reopened = target.action === 'reopen'
  if (target.action === 'tell') paneId = target.pane.id
  else if (target.action === 'wake') {
    const woke = await tryCall('sessions:wake', [target.pane.id])
    if (!woke.value?.id) fail(1, `pane ${target.pane.id} has chat ${resumeId} but would not wake${woke.error ? ` - ${woke.error}` : ''}; nothing was sent`)
    // `wake()` starts a NEW conversation when the saved one is gone, and says so by
    // dropping the id. The prompt was written for the old one.
    if (woke.value.resumeId !== resumeId)
      fail(1, `pane ${target.pane.id} woke into a new chat because the saved conversation ${resumeId} could not be resumed; nothing was sent`)
    paneId = target.pane.id
  } else {
    // History's own "Open again" request: BOTH resume and resumeId, or the CLI starts an
    // empty chat in that folder (`buildArgs` spells `--resume <id>` only with both). No
    // prompt on the start: a pane that has to be restarted below would be handed it twice.
    const h = target.entry
    const opened = await tryCall('sessions:start', [
      { cwd: h.cwd, title: h.title, agent: h.agent, model: h.model, resume: true, resumeId, where: 'local' }
    ])
    const pane = opened.value
    if (!pane?.id) fail(1, `could not reopen chat ${resumeId} in ${h.cwd} - ${opened.error ?? 'the app opened nothing'}; nothing was sent`)
    // The app opens a conversation it cannot find on disk ASLEEP rather than as an empty
    // chat (`startOrSend`). That pane holds nothing, so it goes, and the answer says why.
    if (pane.asleep || pane.status === 'exited') {
      await tryCall('sessions:kill', [pane.id])
      fail(1, `the saved conversation for chat ${resumeId} is no longer on this computer (${pane.laneNote ?? 'it could not be resumed'}); nothing was sent`)
    }
    // Claude reads a conversation out of the folder it runs in, and a busy folder gets its
    // own copy - see `pf open --resume`.
    const landed = pane.cwd ?? h.cwd
    if (h.agent === 'claude' && placeTranscript(landed, resumeId)) await call('sessions:restart', [pane.id])
    paneId = pane.id
  }
  await send('pane:tell', [paneId, prompt])
  const list = await sessions()
  const number = list.findIndex((x) => x.id === paneId) + 1
  if (!number) fail(1, `pane ${paneId} disappeared before the prompt could be handed to it`)
  if (json) console.log(JSON.stringify({ paneId, number, reopened }))
  else console.log(`sent to pane ${number} (${paneId})${reopened ? ' - reopened from History' : target.action === 'wake' ? ' - woken first' : ''}`)
} else if (cmd === 'type') {
  const ref = rest.shift()
  const text = rest.join(' ')
  if (!ref || !text) fail(1, 'type needs a pane and text: pf-ctl type <title-or-id> <text...>')
  const s = resolve(await sessions(), ref)
  if (!s) fail(1, `no pane named "${ref}"`)
  // The submit RETURN has to arrive as its OWN pty read. Claude Code treats a chunk
  // that lands in one read as a PASTE, and a CR inside a paste is a newline, not a
  // submit - so `${text}\r` in a single write leaves anything long sitting unsent in
  // the target composer. Measured 2026-08-28: a 470-character FYI typed from the
  // assistant pane into the clients pane was still in the composer an hour later,
  // while short lines had always worked, which is why this went unnoticed.
  await send('pty:write', [s.id, text])
  await new Promise((r) => setTimeout(r, 800))
  await send('pty:write', [s.id, '\r'])
  console.log(`typed into ${s.id} (${s.title})`)
} else if (cmd === 'call') {
  // The escape hatch, and deliberately the last one: every `invoke` channel in surface.ts
  // is already published, so a setting that only has a switch in the dialog can still be
  // turned on from a script without adding a second door to the app. Arguments are JSON so
  // an object survives - `pf-ctl call config:set '{"autoHandoff":{...}}'`.
  const channel = rest.shift()
  if (!channel) fail(1, 'call needs a channel: pf-ctl call <channel> [json-arg...]')
  let args
  try {
    args = rest.map((a) => JSON.parse(a))
  } catch (e) {
    fail(1, `each argument must be JSON - ${e instanceof Error ? e.message : e}`)
  }
  const out = await call(channel, args)
  console.log(out === undefined ? 'ok' : JSON.stringify(out))
} else if (cmd === 'cost') {
  // What the live app's window is spending. `ps` gives a lifetime average and `sample`
  // names only the busy thread, so this is the only reading that says which FUNCTION,
  // taken by the installed app against its own window.
  const i = rest.indexOf('--seconds')
  const seconds = i >= 0 && rest[i + 1] ? Number(rest[i + 1]) : 10
  const cost = await call('app:renderCost', [seconds])
  if (!cost) fail(1, 'no window to profile - is the app running?')
  console.log(
    `${cost.spanMs} ms profiled, window up ${cost.upMinutes} min, heap ${cost.heapMb} MB\n` +
      `${cost.busyPct.toFixed(1)}% of one core in JS, ${cost.idlePct.toFixed(1)}% idle\n` +
      (cost.busyPct < 20
        ? 'JS is not the cost here: the time is going on paint, the GPU, or another process.\n'
        : 'JS is the cost: the rows below are where it went.\n')
  )
  for (const r of cost.rows.filter((r) => r.pct >= 0.4)) {
    console.log(
      `${r.pct.toFixed(1).padStart(5)}%  ${(r.us / 1000).toFixed(0).padStart(6)}ms  ${r.name}${r.where ? '  ' + r.where : ''}`
    )
  }
} else if (cmd === 'reload') {
  // Draw the desk again from the record main holds. Panes, ptys and conversations live in
  // main and survive it - the same recovery renderWatch.ts performs on a wedged window.
  const done = await call('app:reloadWindow', [])
  console.log(done ? 'the window is drawing itself again' : 'no window to reload')
} else if (cmd === 'send') {
  // The same escape hatch for the `send` half of surface.ts. `call` cannot reach these -
  // a send channel has no reply to wait on - and some of them are the only way to say a
  // thing at all: `pty:return` is how a pane whose size a vanished phone is still holding
  // gets handed back to the desk without dragging the window.
  const channel = rest.shift()
  if (!channel) fail(1, 'send needs a channel: pf-ctl send <channel> [json-arg...]')
  let args
  try {
    args = rest.map((a) => JSON.parse(a))
  } catch (e) {
    fail(1, `each argument must be JSON - ${e instanceof Error ? e.message : e}`)
  }
  await send(channel, args)
  console.log('sent')
} else {
  // Unreachable while every `COMMANDS` row has a branch above; pf-ctl-help-test pins that.
  fail(1, `"${cmd}" has help but nothing here runs it - a bug in pf-ctl.mjs`)
}
}
