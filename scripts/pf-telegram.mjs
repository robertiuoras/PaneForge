#!/usr/bin/env node
/**
 * pf-telegram - answer a pane's question from a phone, with a button, from anywhere.
 *
 * A CLI that asks "which of these?" stops dead until somebody arrows to a row and presses
 * return. At the desk that costs two seconds; away from the desk it costs the rest of the
 * run, because the pane is idle and green and looks exactly like one that finished. The
 * phone client already draws these as buttons (see `shared/choices.ts`), but a phone has
 * to be open on the right page - a Telegram message arrives on the lock screen.
 *
 * So this is a bridge and deliberately nothing else: it watches PaneForge for a pane
 * sitting on a question, posts that question to Telegram with one button per option, and
 * turns a tap into `pty:choose` - which sends the arrows and the return into the pane, on
 * the machine that owns it.
 *
 * It talks to the app the way every other automation here does, over the phone server and
 * `src/shared/surface.ts` (repo rule: no second door into the app). It adds no channel of
 * its own and holds no state on disk - a restart re-posts whatever is still being asked
 * and forgets whatever was answered.
 *
 *   TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... node scripts/pf-telegram.mjs
 *   node scripts/pf-telegram.mjs --once     # one sweep, then exit (this is the test hook)
 *
 * Two things it will not do, both on purpose:
 *  - It never types free text into a pane. A button press is a choice off a list the CLI
 *    itself printed; a chat bot that can type anything into a shell on this machine is a
 *    different feature with a different threat model.
 *  - It never answers a question it did not see this run. The keys are derived from where
 *    the arrow is NOW, so a stale button is refused by the app rather than walked from a
 *    position that has since moved.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The bot's credentials, from the environment or from the file this machine already
 * keeps them in.
 *
 * The file is read as a fallback rather than a requirement so this stays a plain script
 * anybody can run with two variables set - but reading it means the scheduled copy needs
 * no secret of its own written anywhere new, which is the difference between "wire it up"
 * being a one-line task and being a credential to hand around.
 */
function envFile() {
  const path = process.env.PF_TELEGRAM_ENV ?? join(homedir(), '.claude', 'usage-notify.env')
  const out = {}
  let raw = ''
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return out
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line)
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
  return out
}

const FILE_ENV = envFile()
const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? FILE_ENV.TELEGRAM_BOT_TOKEN ?? ''
const CHAT = process.env.TELEGRAM_CHAT_ID ?? FILE_ENV.TELEGRAM_CHAT_ID ?? ''
const API = process.env.PF_TELEGRAM_API ?? 'https://api.telegram.org'
const POLL_MS = Number(process.env.PF_TELEGRAM_POLL_MS ?? 4000)
const ONCE = process.argv.includes('--once')

const USER_DATA =
  process.platform === 'win32'
    ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'claude-orchestrator')
    : process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support', 'claude-orchestrator')
      : join(homedir(), '.config', 'claude-orchestrator')

function fail(code, msg) {
  console.error(`pf-telegram: ${msg}`)
  process.exit(code)
}

// ---------------------------------------------------------------------------
// PaneForge, over the phone server. Same self-serve pairing as pf-ctl: the code
// is in the app's own config, so a local process that can read it is already
// inside the trust boundary.
// ---------------------------------------------------------------------------
let cookie = ''
let base = ''

async function pair() {
  let raw
  try {
    raw = readFileSync(join(USER_DATA, 'config.json'), 'utf8')
  } catch {
    fail(2, `no PaneForge config at ${USER_DATA}`)
  }
  const phone = JSON.parse(raw).phone ?? {}
  // Thrown, never exited: the daemon path below retries this for as long as it takes,
  // because every one of these is a thing that comes back by itself - the app being
  // mid-update, the phone server not switched on yet, a machine still booting.
  if (!phone.on) throw new Error('phone server is OFF - open Devices in PaneForge once')
  base = `http://127.0.0.1:${phone.port ?? 7312}`
  const res = await fetch(`${base}/pf/pair`, {
    method: 'POST',
    body: JSON.stringify({ code: phone.code ?? '' })
  }).catch(() => null)
  if (!res?.ok) throw new Error(`pairing failed - is PaneForge running on ${base}?`)
  cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]
  if (!cookie) throw new Error('pairing answered ok but set no cookie')
}

async function call(channel, args) {
  const res = await fetch(`${base}/pf/call`, {
    method: 'POST',
    headers: { cookie },
    body: JSON.stringify({ id: 1, channel, args })
  })
  const out = await res.json()
  if (out.error) throw new Error(`${channel}: ${out.error}`)
  return out.value
}

// ---------------------------------------------------------------------------
// Telegram.
// ---------------------------------------------------------------------------
async function tg(method, body) {
  const res = await fetch(`${API}/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  const out = await res.json().catch(() => ({ ok: false }))
  if (!out.ok) throw new Error(`${method}: ${JSON.stringify(out).slice(0, 200)}`)
  return out.result
}

/**
 * Telegram's callback_data is 64 BYTES, and a pane id plus an option number is well
 * inside it - but only because the id is the app's own short one (`s1-ms0hhg7c`). A
 * mirrored pane's id carries a device name (`@desk/s1-x`), so the check is real rather
 * than decorative: past the limit the button is posted and every tap is silently ignored.
 */
function callbackData(id, n) {
  const data = `c|${id}|${n}`
  return Buffer.byteLength(data) <= 64 ? data : ''
}

/** One button per row: an option's label is a sentence, not a word. */
function keyboard(id, ask) {
  const rows = []
  for (const o of ask.options) {
    const data = callbackData(id, o.n)
    if (!data) continue
    rows.push([{ text: `${o.n}. ${o.label}`.slice(0, 60), callback_data: data }])
  }
  return rows.length ? { inline_keyboard: rows } : null
}

function body(pane, ask) {
  const where = `${pane.title || pane.id}${pane.cwd ? ` · ${pane.cwd.split(/[\\/]/).pop()}` : ''}`
  return `${where} is asking:\n\n${ask.question || '(no question printed)'}`
}

// ---------------------------------------------------------------------------
// The bridge. `posted` is this run's memory and nothing else: a restart re-posts a
// question that is still live, which is the right failure - a missed one is a run
// that never continues, a duplicate is one extra message.
// ---------------------------------------------------------------------------
const posted = new Map() // paneId -> { sig, messageId }

function signature(ask) {
  return `${ask.question}|${ask.options.map((o) => `${o.n}.${o.label}`).join('|')}`
}

async function sweep() {
  const list = (await call('sessions:list', [])) ?? []
  const live = new Set()
  let sent = 0
  for (const pane of list) {
    const ask = pane.ask
    if (!ask?.options?.length) continue
    live.add(pane.id)
    const sig = signature(ask)
    const seen = posted.get(pane.id)
    // The ARROW MOVING is not a new question - `sig` deliberately leaves the selection
    // out, or every arrow key pressed at the desk would post the same question again.
    if (seen?.sig === sig) continue
    const kb = keyboard(pane.id, ask)
    if (!kb) {
      console.error(`pf-telegram: ${pane.id} has no postable options (id too long?)`)
      continue
    }
    const msg = await tg('sendMessage', {
      chat_id: CHAT,
      text: body(pane, ask),
      reply_markup: kb
    })
    posted.set(pane.id, { sig, messageId: msg.message_id })
    sent++
    console.log(`posted ${pane.id}: ${ask.options.length} options`)
  }
  // Said every sweep, not only when something happened. A bridge that prints nothing
  // when it is working prints nothing when it is broken either - the failure and the
  // good outcome share a shape, which is the one thing a watchdog must never do.
  if (ONCE || sent) console.log(`swept ${list.length} panes, ${live.size} asking, ${sent} posted`)
  // A question that went away was answered somewhere else. The message stays in the
  // chat - editing it away would delete the record of what was asked - but its buttons
  // go, so a tap cannot arrive minutes later against a pane that has moved on.
  for (const [id, seen] of posted) {
    if (live.has(id)) continue
    posted.delete(id)
    await tg('editMessageReplyMarkup', {
      chat_id: CHAT,
      message_id: seen.messageId,
      reply_markup: { inline_keyboard: [] }
    }).catch(() => {})
  }
}

/**
 * Where a button press comes from - and why it is NOT `getUpdates` by default.
 *
 * A Telegram bot token has exactly one long-poller. Robert's token already has one (the
 * assistant's own bot, which owns `getUpdates` and spools what it does not handle), and
 * a second consumer does not share the updates - it STEALS them, and the first one starts
 * failing `409 Conflict: terminated by other getUpdates request`. Measured here on the
 * first run of this script, against the live bot. So the default is post-only, which
 * conflicts with nothing, and taps arrive by being HANDED to us:
 *
 *   POST http://127.0.0.1:<PF_TELEGRAM_LOCK_PORT+1>/callback   { "data": "c|<pane>|<n>" }
 *
 * ...which is one line in whichever bot already owns the token. `--poll` is the other
 * shape and is correct only for a bot token nothing else is reading: it is opt-in
 * precisely so that turning it on is a decision somebody made rather than a default that
 * silently breaks a bot serving something else.
 */
const POLL = process.argv.includes('--poll')
let offset = 0

/** Act on one callback, whoever handed it over. Answers nothing on its own. */
async function actOn(data) {
  const [tag, id, n] = String(data ?? '').split('|')
  if (tag !== 'c' || !id) return false
  try {
    return await call('pty:choose', [id, Number(n)])
  } catch (e) {
    console.error(`pf-telegram: choose failed - ${e.message}`)
    return false
  }
}

async function serveCallbacks() {
  const { createServer } = await import('node:http')
  const port = Number(process.env.PF_TELEGRAM_LOCK_PORT ?? 7319) + 1
  createServer((req, res) => {
    if (req.method !== 'POST') return res.writeHead(405).end()
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      let ok = false
      try {
        ok = await actOn(JSON.parse(body).data)
      } catch {
        /* a malformed body is a `false`, never a crash */
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok }))
    })
  })
    // Loopback only. This endpoint presses buttons on a shell on this machine; the one
    // thing it must never be is reachable from the network.
    .listen(port, '127.0.0.1', () => console.log(`pf-telegram: callbacks on 127.0.0.1:${port}`))
}

async function drain() {
  if (!POLL) return
  const updates = await tg('getUpdates', { offset, timeout: 0, allowed_updates: ['callback_query'] })
  for (const u of updates) {
    offset = u.update_id + 1
    const q = u.callback_query
    if (!q) continue
    const [tag, id, n] = String(q.data ?? '').split('|')
    if (tag !== 'c' || !id) continue
    const ok = await actOn(q.data)
    // The answer is honest either way. `false` means the pane is not on that question
    // any more - answered at the desk in the seconds since the button was drawn - and
    // saying "sent" there would be the one lie that costs a person a wrong decision.
    await tg('answerCallbackQuery', {
      callback_query_id: q.id,
      text: ok ? `Sent option ${n}` : 'That question is gone - the pane moved on'
    }).catch(() => {})
    if (ok) {
      posted.delete(id)
      await tg('editMessageReplyMarkup', {
        chat_id: CHAT,
        message_id: q.message?.message_id,
        reply_markup: { inline_keyboard: [] }
      }).catch(() => {})
    }
  }
}

/**
 * One copy, and the lock is a listening socket rather than a file.
 *
 * A pid file outlives the process that wrote it, so the scheduled copy - fired again
 * every few minutes because it has to survive a PaneForge restart - would either refuse
 * to start after a hard kill or need a liveness check that is itself a guess. A bound
 * port is released by the kernel when the process dies, whatever killed it.
 */
async function claimSingleton() {
  const { createServer } = await import('node:net')
  const port = Number(process.env.PF_TELEGRAM_LOCK_PORT ?? 7319)
  return new Promise((resolve) => {
    const srv = createServer()
    srv.once('error', () => resolve(false))
    srv.listen(port, '127.0.0.1', () => resolve(true))
    srv.unref()
  })
}

if (!TOKEN || !CHAT) fail(2, 'set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID')
if (!ONCE && !(await claimSingleton())) {
  console.log('pf-telegram: another copy is already running')
  process.exit(0)
}

/**
 * Waiting for PaneForge rather than failing on it - but only as a daemon.
 *
 * A one-shot run that cannot reach the app should say so and exit non-zero, because a
 * person is reading it. The scheduled copy is started at logon and PaneForge may not be
 * up yet, and an updater restart takes it away for half a minute mid-day: exiting there
 * means the bridge is off exactly when it is next needed, and nothing says so.
 */
if (ONCE) await pair().catch((e) => fail(2, e.message))
else {
  for (;;) {
    try {
      await pair()
      break
    } catch (e) {
      console.error(`pf-telegram: waiting for PaneForge - ${e.message}`)
      await new Promise((r) => setTimeout(r, 15_000))
    }
  }
}

async function tick() {
  try {
    await sweep()
    await drain()
  } catch (e) {
    // Never let one bad round end the bridge: the app restarting, a network blip and a
    // Telegram 429 are all ordinary, and a bridge that exits on one is a bridge that is
    // off exactly when the pane it was watching starts asking.
    console.error(`pf-telegram: ${e.message}`)
  }
}

await tick()
if (!ONCE) {
  await serveCallbacks()
  setInterval(tick, POLL_MS)
}
