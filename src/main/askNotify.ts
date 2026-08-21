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

/**
 * Read once per run: this is a file a person edits between launches, not between panes.
 *
 * The environment wins over the file, deliberately and for one reason: `pf-telegram.mjs`
 * resolves them in exactly that order, and two paths to one bot that disagree about which
 * credential is authoritative is worse than either order. The cost is real and is why this
 * says which source it used out loud - an edit to the file does nothing while a shell
 * variable is set, and that is invisible otherwise.
 */
export function telegramCreds(): Creds | null {
  if (cached !== undefined) return cached
  const file = envFile()
  const token = process.env.TELEGRAM_BOT_TOKEN ?? file.TELEGRAM_BOT_TOKEN ?? ''
  const chat = process.env.TELEGRAM_CHAT_ID ?? file.TELEGRAM_CHAT_ID ?? ''
  cached = token && chat ? { token, chat } : null
  if (cached && process.env.TELEGRAM_BOT_TOKEN && file.TELEGRAM_BOT_TOKEN)
    console.log(
      'telegram: TELEGRAM_BOT_TOKEN is set in the environment AND in the env file - the environment wins, so file edits will not take effect until it is unset'
    )
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

/**
 * How long the question has to stop CHANGING before a word of it leaves the machine.
 *
 * A chooser is not painted in one frame. The CLI streams the option labels in, so the
 * pane reads `4. eve`, then `4. everythi`, then `4. everything live` - three different
 * questions by `sameAsk`, which compares labels, and therefore three `ask` events and
 * three phone notifications for ONE question. That is what a person sees as spam, and it
 * is not a rare race: it happens on every question whose options are still arriving.
 *
 * Two and a half seconds is longer than a repaint and far shorter than a person walking
 * back to the desk, and the wait costs nothing - the pane is already red at the desk from
 * the frame the question first appeared in.
 */
export const ASK_SETTLE_MS = 2500

/** How long one question stays "already sent" for a pane. */
export const ASK_REPEAT_WINDOW_MS = 5 * 60_000

/**
 * Is `next` the same question as `prev`, only more of it?
 *
 * The settle timer covers the common case; this covers the one it cannot - a label that
 * is still arriving when the timer fires, so the post goes out on a half-typed question
 * and the rest of it lands a moment later as a second one. A streamed question only ever
 * GROWS, so a key that is a prefix of the one already sent (or vice versa) is the same
 * question and must not be sent twice.
 */
export function sameQuestionGrowing(prev: string, next: string): boolean {
  if (!prev || !next) return false
  return next.startsWith(prev) || prev.startsWith(next)
}

/** What the notifier asks for at the moment it is about to post - never before. */
export interface AskSnapshot {
  key: string
  text: string
}

export interface AskNotifierOpts {
  settleMs?: number
  repeatWindowMs?: number
  post?: (text: string) => Promise<boolean>
  now?: () => number
}

/**
 * One phone message per question, no matter how many frames that question arrived in.
 *
 * Every `ask` frame calls `schedule`, which restarts the timer. When it finally fires the
 * caller is asked for the question as it stands RIGHT THEN - so a question answered at the
 * desk inside the settle window sends nothing at all, and a question still being typed
 * sends its finished text rather than the first frame of it.
 */
export class AskNotifier {
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private lastKey = new Map<string, string>()
  private lastAt = new Map<string, number>()
  private readonly settleMs: number
  private readonly repeatWindowMs: number
  private readonly post: (text: string) => Promise<boolean>
  private readonly now: () => number

  constructor(opts: AskNotifierOpts = {}) {
    this.settleMs = opts.settleMs ?? ASK_SETTLE_MS
    this.repeatWindowMs = opts.repeatWindowMs ?? ASK_REPEAT_WINDOW_MS
    this.post = opts.post ?? postAsk
    this.now = opts.now ?? (() => Date.now())
  }

  /** A frame carrying a question. `resolve` is called once, at the end of the wait. */
  schedule(id: string, resolve: () => AskSnapshot | null): void {
    const running = this.timers.get(id)
    if (running) clearTimeout(running)
    const timer = setTimeout(() => {
      this.timers.delete(id)
      void this.fire(id, resolve)
    }, this.settleMs)
    // A pending notification must never hold the app open.
    timer.unref?.()
    this.timers.set(id, timer)
  }

  /** The pane went away. Anything still waiting for it is not worth sending. */
  cancel(id: string): void {
    const running = this.timers.get(id)
    if (running) clearTimeout(running)
    this.timers.delete(id)
    this.lastKey.delete(id)
    this.lastAt.delete(id)
  }

  /** For the test: how many panes have a message waiting. */
  pending(): number {
    return this.timers.size
  }

  private async fire(id: string, resolve: () => AskSnapshot | null): Promise<boolean> {
    const snap = resolve()
    // Answered, or the pane is gone: the question this was about no longer exists.
    if (!snap || !snap.key) return false
    const prev = this.lastKey.get(id) ?? ''
    const at = this.lastAt.get(id) ?? 0
    const now = this.now()
    if (prev && now - at < this.repeatWindowMs && sameQuestionGrowing(prev, snap.key)) {
      // Keep the LONGER key so the growing question converges on one identity.
      if (snap.key.length > prev.length) this.lastKey.set(id, snap.key)
      return false
    }
    this.lastKey.set(id, snap.key)
    this.lastAt.set(id, now)
    return await this.post(snap.text)
  }
}
