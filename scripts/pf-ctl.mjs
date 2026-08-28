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
 *   node scripts/pf-ctl.mjs open <cwd> [--title T] [--prompt P] [--model M] [--agent A]
 *   node scripts/pf-ctl.mjs close <title-or-id>
 *   node scripts/pf-ctl.mjs type <title-or-id> <text...>
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
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const USER_DATA =
  process.platform === 'win32'
    ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'claude-orchestrator')
    : process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support', 'claude-orchestrator')
      : join(homedir(), '.config', 'claude-orchestrator')

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
await pair()

if (cmd === 'list') {
  const list = await sessions()
  for (const s of list) console.log([s.id, s.status, s.title, s.cwd].join('\t'))
} else if (cmd === 'open') {
  const title = flag(rest, '--title')
  const prompt = flag(rest, '--prompt')
  const model = flag(rest, '--model')
  const agent = flag(rest, '--agent')
  const cwd = rest[0]
  if (!cwd) fail(1, 'open needs a cwd: pf-ctl open <cwd> [--title T] [--prompt P]')
  const s = await call('sessions:start', [{ cwd, title, prompt, model, agent }])
  console.log(`opened ${s?.id ?? '?'} in ${cwd}`)
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
} else if (cmd === 'type') {
  const ref = rest.shift()
  const text = rest.join(' ')
  if (!ref || !text) fail(1, 'type needs a pane and text: pf-ctl type <title-or-id> <text...>')
  const s = resolve(await sessions(), ref)
  if (!s) fail(1, `no pane named "${ref}"`)
  await send('pty:write', [s.id, `${text}\r`])
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
  fail(1, `unknown command "${cmd ?? ''}" - use: list | open | close | type | call | send`)
}
