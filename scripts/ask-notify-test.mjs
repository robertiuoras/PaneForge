// A pane's question, on the way to a phone.
//
// The pane and its card turn red with no credentials at all; this is the half that leaves
// the machine, and the two things worth pinning about it are both refusals:
//
//   1. with no token and no chat id it sends NOTHING and says so by returning false,
//      rather than throwing inside a pty read;
//   2. the message names the pane and numbers the options the way the CLI numbered them,
//      because it is read on a lock screen and answered by a person saying "3".
//
// It never long-polls: `scripts/pf-telegram.mjs` is the bridge that turns a TAP into
// `pty:choose`, and a bot token has exactly one long-poller - a second one does not share
// the updates, it steals them (409 Conflict, measured against the live bot). This posts and
// stops.
//
//   node scripts/ask-notify-test.mjs

import { buildSync } from 'esbuild'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'pf-asknotify-'))

buildSync({
  absWorkingDir: root,
  entryPoints: ['src/main/askNotify.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: join(work, 'askNotify.cjs')
})
const A = createRequire(join(work, 'x.cjs'))('./askNotify.cjs')

let failed = 0
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`)
  if (!cond) {
    failed++
    if (detail !== undefined) console.log('      ', detail)
  }
}

const ask = {
  question: 'Do you want to create src/main/askNotify.ts?',
  options: [{ label: 'Yes' }, { label: 'Yes, and do not ask again' }, { label: 'No' }],
  selected: 1
}

const msg = A.askMessage('taskdriver.ai', ask)
ok('the message leads with the pane', msg.startsWith('taskdriver.ai is asking:'), msg.split('\n')[0])
ok('the question is in it', msg.includes(ask.question))
ok(
  'the options keep the numbers the CLI printed',
  msg.includes('1. Yes') && msg.includes('3. No'),
  msg
)
ok('and the highlighted row is marked', /2\. .*<- highlighted/.test(msg), msg)
ok('it says why it matters', msg.includes('Nothing runs until it is answered.'))

// An env file that exists and carries nothing: the shape on a machine that has never set
// this up. `PF_TELEGRAM_ENV` is the same variable the bridge script reads.
const empty = join(work, 'no-creds.env')
writeFileSync(empty, '# nothing here\n')
process.env.PF_TELEGRAM_ENV = empty
delete process.env.TELEGRAM_BOT_TOKEN
delete process.env.TELEGRAM_CHAT_ID
A.resetTelegramCreds()
ok('no credentials means no credentials', A.telegramCreds() === null)
ok('and posting is a no-op that answers false', (await A.postAsk('anything')) === false)

// One half is not enough: a token with no chat id has nowhere to send.
process.env.TELEGRAM_BOT_TOKEN = 'x'
A.resetTelegramCreds()
ok('a token with no chat id is still nothing', A.telegramCreds() === null)

// Both halves, and a stub API - so the one network call this file makes is to localhost.
const { createServer } = await import('node:http')
const seen = []
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    seen.push({ url: req.url, body: JSON.parse(body || '{}') })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
process.env.PF_TELEGRAM_API = `http://127.0.0.1:${server.address().port}`
process.env.TELEGRAM_CHAT_ID = '42'
A.resetTelegramCreds()
const sent = await A.postAsk(msg)
server.close()
ok('with both, it posts once', sent === true && seen.length === 1, JSON.stringify(seen))
ok(
  'to sendMessage, with the chat id and the text',
  seen[0]?.url === '/botx/sendMessage' && seen[0]?.body.chat_id === '42' && seen[0]?.body.text === msg,
  JSON.stringify(seen[0]?.url)
)
ok(
  'and it never asks for updates - that would steal the bridge poller',
  seen.every((s) => !s.url.includes('getUpdates'))
)


// ---------------------------------------------------------------------------
// One question, several frames. The CLI streams the option labels in, so the pane reads
// the same chooser three times with a longer label each time - which is three phone
// messages for ONE question unless the frames are allowed to settle first.
const posts = []
const notifier = new A.AskNotifier({
  settleMs: 30,
  post: async (text) => {
    posts.push(text)
    return true
  }
})
const frame = (labels) => ({
  key: `Data source right now?|${labels.map((l, i) => `${i + 1}.${l}`).join("|")}`,
  text: `taskdriver.ai is asking:\n\nData source right now?\n\n${labels.map((l, i) => `${i + 1}. ${l}`).join("\n")}`
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const streamed = [["eve"], ["everythi"], ["everything live"]]
for (const labels of streamed) {
  notifier.schedule("p1", () => frame(labels))
  await sleep(5)
}
await sleep(60)
ok("a question arriving over three frames is ONE message", posts.length === 1, JSON.stringify(posts))
ok("and it is the finished text, not the first frame", posts[0]?.includes("everything live"), posts[0])

// A late frame of the SAME question, after the message already went: a label that is
// still growing must not buy a second notification.
notifier.schedule("p1", () => frame(["everything live now"]))
await sleep(60)
ok("a label that keeps growing does not send again", posts.length === 1, JSON.stringify(posts))

// Answered at the desk inside the settle window: nothing is left to tell anyone about.
notifier.schedule("p2", () => null)
await sleep(60)
ok("a question answered while it settled sends nothing", posts.length === 1, JSON.stringify(posts))

// A genuinely different question on the same pane still gets through.
notifier.schedule("p1", () => ({ key: "Ship it?|1.Yes|2.No", text: "taskdriver.ai is asking:\n\nShip it?" }))
await sleep(60)
ok("a different question is still sent", posts.length === 2, JSON.stringify(posts))

ok("nothing is left waiting", notifier.pending() === 0)
ok(
  "a growing key is the same question",
  A.sameQuestionGrowing("Q|1.eve", "Q|1.everything live") && !A.sameQuestionGrowing("Q|1.Yes", "Ship it?|1.Yes")
)

console.log(failed ? `\n${failed} failed` : '\nall ask-notify checks passed')
process.exit(failed ? 1 : 0)
