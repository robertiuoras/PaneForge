// A question on a pane, sent to a phone that is not in the room.
//
// `shared/choices.ts` reads a CLI's chooser off the pane's own frame and the app draws it
// as buttons - at the desk, and on the phone client. Both need somebody to be LOOKING.
// A question stops the run dead and the pane goes idle and green, so the cost of not
// noticing one is the rest of the run, which is exactly the case the desk cannot cover.
//
// `scripts/pf-telegram.mjs` was written for the other half of this - a tap in Telegram
// becoming `pty:choose` - and it is a bridge that has to be running, over the phone
// server, with a poller of its own. Nothing on this machine ever started it (checked: no
// launchd job, no npm script, no spawn in src), so the message half had never once
// arrived. This is the message half only, from the app itself:
//
//   - one HTTPS POST per question, no `getUpdates` and no long poll, so it cannot steal
//     the bot's updates from that bridge (a token has exactly one long-poller, and a
//     second does not share them - it breaks the first with 409 Conflict);
//   - credentials from the environment or from the file this machine already keeps them
//     in, so nothing new is written down anywhere;
//   - it never types into a pane. Answering is still a press, here or on the phone.
//
// With no token and no chat id this is silent and does nothing at all - which is the
// state on a machine that has never set one up, and is not a failure worth a card.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { PaneAsk } from '../shared/choices'

/** The same file pf-telegram.mjs reads, in the same shape. Missing is not an error. */
function envFile(): Record<string, string> {
  const path = process.env.PF_TELEGRAM_ENV ?? join(homedir(), '.claude', 'usage-notify.env')
  const out: Record<string, string> = {}
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

interface Creds {
  token: string
  chat: string
}

let cached: Creds | null | undefined

/** Read once per run: this is a file a person edits between launches, not between panes. */
export function telegramCreds(): Creds | null {
  if (cached !== undefined) return cached
  const file = envFile()
  const token = process.env.TELEGRAM_BOT_TOKEN ?? file.TELEGRAM_BOT_TOKEN ?? ''
  const chat = process.env.TELEGRAM_CHAT_ID ?? file.TELEGRAM_CHAT_ID ?? ''
  cached = token && chat ? { token, chat } : null
  return cached
}

/** For the test, which must not read this machine's real credentials. */
export function resetTelegramCreds(): void {
  cached = undefined
}

/**
 * The message itself.
 *
 * Plain text, and the options NUMBERED the way the CLI numbered them, because the point of
 * the message is to be readable on a lock screen - and because a number is what somebody
 * says back to whoever is at the desk. The pane's name leads: on a machine with eight panes
 * "which one" is the first thing anybody asks.
 */
export function askMessage(title: string, ask: PaneAsk, device?: string): string {
  const lines = [`${title}${device ? ` on ${device}` : ''} is asking:`, '', ask.question]
  if (ask.options.length) {
    lines.push('')
    for (let i = 0; i < ask.options.length; i++) {
      lines.push(`${i + 1}. ${ask.options[i].label}${i === ask.selected ? '  <- highlighted' : ''}`)
    }
  }
  lines.push('', 'Nothing runs until it is answered.')
  return lines.join('\n')
}

/**
 * Post one. Never throws and never waits on the caller: a pane's question must not be held
 * up by a network, and a failed post is worth a log line and nothing more.
 */
export async function postAsk(text: string): Promise<boolean> {
  const creds = telegramCreds()
  if (!creds) return false
  const api = process.env.PF_TELEGRAM_API ?? 'https://api.telegram.org'
  try {
    const res = await fetch(`${api}/bot${creds.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: creds.chat,
        text,
        disable_web_page_preview: true
      }),
      // A phone notification is worth two seconds and never more.
      signal: AbortSignal.timeout(Number(process.env.PF_TELEGRAM_TIMEOUT_MS ?? 8000))
    })
    return res.ok
  } catch {
    return false
  }
}
