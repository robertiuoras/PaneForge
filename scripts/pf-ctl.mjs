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
 *   node scripts/pf-ctl.mjs list
 *   node scripts/pf-ctl.mjs open <cwd> [--title T] [--prompt P | --task BACKLOG_ID] [--model M] [--agent A]
 *                                       [--close-when-done] [--report-to <pane>]
 *                                       [--resume <chat-id> | --continue] [--here]
 *   node scripts/pf-ctl.mjs needs-login <site> --url <url> [--host user@ip] [--port N] [--machine WORDS]
 *   node scripts/pf-ctl.mjs login [url] [--site NAME] [--host user@ip] [--port N] [--machine WORDS]
 *   node scripts/pf-ctl.mjs close <title-or-id>
 *   node scripts/pf-ctl.mjs rename <title-or-id> <name...>
 *   node scripts/pf-ctl.mjs type <title-or-id> <text...>
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
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

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
  const phone = JSON.parse(raw).phone ?? {}
  if (!phone.on)
    fail(2, 'phone server is OFF - enable "Phone" in PaneForge Settings, then rerun')
  return { port: phone.port ?? 7312, code: phone.code ?? '' }
}

function fail(codeNum, msg) {
  console.error(`pf-ctl: ${msg}`)
  process.exit(codeNum)
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
    fail(2, `PaneForge not answering on ${base} - is the app running?`)
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
  const res = await post('/pf/call', { id: 1, channel, args })
  const out = await res.json()
  if (out.error) fail(1, `${channel}: ${out.error}`)
  return out.value
}

/** Fire-and-forget send channels (pty:write) go through /pf/send, ordered, no reply. */
async function send(channel, args) {
  await post('/pf/send', { calls: [{ channel, args }] })
}

async function sessions() {
  return (await call('sessions:list', [])) ?? []
}

/** A title names at most one pane for automation; ids always win. */
function resolve(list, ref) {
  const byId = list.find((s) => s.id === ref)
  if (byId) return byId
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

const [cmd, ...rest] = process.argv.slice(2)

/*
 * A sign-in request is checked BEFORE the app is asked for anything.
 *
 * The whole point of the card is that a person walks over to it and types a password, so
 * an ask that names no site, or an address that is not an address, must cost nobody that
 * walk. It refuses here, where the mistake was made, rather than putting up a card that
 * opens a browser at nothing.
 */
let loginArgs = null
if (cmd === 'needs-login') {
  const host = flag(rest, '--host')
  const port = flag(rest, '--port')
  const machine = flag(rest, '--machine')
  const url = flag(rest, '--url')
  const site = rest[0]
  if (!site) fail(1, 'needs-login needs a site: pf-ctl needs-login <site> --url <url> [--host user@ip]')
  if (!url) fail(1, 'needs-login needs --url <address of the sign-in page>')
  if (!/^https?:\/\//i.test(url))
    fail(1, `--url must start with http:// or https:// - got "${url}"`)
  if (port && !/^\d+$/.test(port)) fail(1, `--port must be a number - got "${port}"`)
  loginArgs = { site, url, host, port: port ? Number(port) : undefined, machine, from: process.env.PF_PANE }
}

/*
 * `pf login` is the same ask, said the short way, by the session that already hit the wall.
 *
 * Robert, 2026-09-03: "allow me to just ask, like that session who wanted it, to open
 * again the login and it knows how to open it." So this names no site and no computer -
 * the app remembers what this pane asked for last (`askAgain` in shared/remoteLogin.ts) -
 * and it does not put a card up to be clicked: the picture opens.
 */
let reopenArgs = null
if (cmd === 'login') {
  const host = flag(rest, '--host')
  const port = flag(rest, '--port')
  const machine = flag(rest, '--machine')
  const site = flag(rest, '--site')
  const url = rest[0]
  if (url && !/^https?:\/\//i.test(url))
    fail(1, `a sign-in page starts with http:// or https:// - got "${url}"`)
  if (port && !/^\d+$/.test(port)) fail(1, `--port must be a number - got "${port}"`)
  reopenArgs = {
    site,
    url,
    host,
    port: port ? Number(port) : undefined,
    machine,
    from: process.env.PF_PANE,
    open: true
  }
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
  for (const s of list) console.log([s.id, s.status, s.title, s.cwd].join('\t'))
  // A sign-in request is not a pane yet - it is a card waiting for somebody - so it is
  // listed too, and says which computer it is waiting on.
  const logins = (await call('login:list', [])) ?? []
  for (const r of logins)
    console.log([r.id, r.state, `Sign in to ${r.site} on ${r.machine}`, r.url].join('\t'))
} else if (cmd === 'needs-login') {
  const req = await call('login:need', [loginArgs])
  if (!req?.id) fail(1, 'PaneForge did not accept the sign-in request')
  console.log(req.id)
} else if (cmd === 'login') {
  const req = await call('login:need', [reopenArgs])
  if (!req?.id) fail(1, 'PaneForge did not accept the sign-in request')
  console.log(`sign in to ${req.site} on ${req.machine} - the picture is on screen now`)
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
  const cwd = rest[0]
  if (!cwd) fail(1, 'open needs a cwd: pf-ctl open <cwd> [--title T] [--prompt P]')
  const s = await call('sessions:start', [
    {
      cwd,
      title,
      prompt,
      model,
      agent,
      closeWhenDone,
      reportTo: closeWhenDone ? reportTo : undefined,
      where: here ? 'local' : undefined,
      resume: Boolean(resumeId) || continueLast || undefined,
      resumeId: resumeId || undefined
    }
  ])
  const landed = s?.cwd ?? cwd
  console.log(`opened ${s?.id ?? '?'} in ${landed}`)
  // The pane may have been placed in a lane copy, which is a different folder and so a
  // different set of conversations. Put the transcript there and start the agent again -
  // a pane seconds old has nothing to lose, and this is the only moment the id is known.
  if (resumeId && s?.id && placeTranscript(landed, resumeId)) {
    await call('sessions:restart', [s.id])
    console.log(`copied conversation ${resumeId} into ${landed} and restarted the pane`)
  }
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
  fail(1, `unknown command "${cmd ?? ''}" - use: list | open | needs-login | login | close | rename | type | hold | call | send`)
}
