// The thin half of `shared/limitWave.ts`: read the desk, wake and type, post the push.
//
// No electron import, so `scripts/limit-wave-test.mjs` bundles this file whole and drives it
// with a fake desk, a fake fetch and a fake home directory.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Session } from '../shared/types'
import {
  CONTINUE_TEXT,
  LimitWaves,
  limitStopOf,
  pushPayload,
  waveBody,
  waveKey,
  waveTitle,
  whyUnsent,
  type PaneLabel,
  type PaneNow,
  type PushPayload
} from '../shared/limitWave'

export const NOTIFY_URL = 'https://app.taskdriver.ai/api/app/admin/notify'
const TICK_MS = 5_000
/** How much of the painted tail after the stop line is read for its reset: Codex wraps. */
const AFTER_LINE_CHARS = 400

/**
 * The TaskDriver ingest token: `TASKDRIVER_INGEST_TOKEN`, else `~/.claude/todos-ingest.token`.
 *
 * The file is not a fallback for tidiness: PaneForge started from the Dock has no shell
 * environment at all, so on the installed app the file is the only place it can come from.
 * Never logged, never put in an error.
 */
export function ingestToken(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  read: (file: string) => string = (file) => readFileSync(file, 'utf8')
): string | null {
  const unquote = (t: string): string => t.trim().replace(/^(['"])(.*)\1$/, '$2').trim()
  const fromEnv = unquote(env.TASKDRIVER_INGEST_TOKEN ?? '')
  if (fromEnv) return fromEnv
  try {
    return unquote(read(join(home, '.claude', 'todos-ingest.token'))) || null
  } catch {
    return null
  }
}

/** POST one push. True only on a 2xx; every failure is false, so the wave tries again. */
export async function postPush(
  payload: PushPayload,
  opts: { env?: NodeJS.ProcessEnv; home?: string; fetchImpl?: typeof fetch } = {}
): Promise<boolean> {
  const env = opts.env ?? process.env
  const token = ingestToken(env, opts.home)
  if (!token) return false
  try {
    const res = await (opts.fetchImpl ?? fetch)(env.PF_TASKDRIVER_NOTIFY_URL || NOTIFY_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000)
    })
    return res.ok
  } catch {
    return false
  }
}

/** The stop line and what was painted under it, which is where Codex puts its date. */
export function stopText(line: string, painted?: string): string {
  if (!painted) return line
  const at = painted.lastIndexOf(line)
  return at < 0 ? line : painted.slice(at, at + line.length + AFTER_LINE_CHARS)
}

export interface LimitWaveDeps {
  /** This desk's own panes (never a mirror). */
  list(): Session[]
  /** The number on the pane's card and its title. */
  label(id: string): PaneLabel | undefined
  /** The pane's conversation was handed to a fresh pane (`pf continue`). */
  movedOn(id: string): boolean
  /** The automatic continue switch (`recover.enabled`). */
  mayPrompt(): boolean
  /** Wake the pane if it is asleep, type the text, and say how it ended. */
  carryOn(id: string, text: string, done: (end: string) => void): void
  post(payload: PushPayload): Promise<boolean>
  host: string
  log(entry: Record<string, unknown>): void
  now?: () => number
}

/** What the wave reads off a card. */
export function paneNow(s: Session | undefined, movedOn: boolean): PaneNow | undefined {
  if (!s) return undefined
  return {
    busy: Boolean(s.runSince) || s.status === 'working',
    turns: s.turnsHere ?? 0,
    drafting: Boolean(s.drafting),
    ended: s.status === 'exited' && !s.asleep,
    movedOn
  }
}

export interface LimitWaveRunner {
  /**
   * A pane stopped. True when this is a limit with a reset - it is the wave's, and it does
   * NOT go to Telegram. False for every other stop, which keeps its Telegram message.
   * Also called for a stop on a pane whose first stop was already reported (`paneStopAgain`),
   * whose answer nobody reads: that one is only ever the wave's.
   */
  stopped(s: Session, line: string, painted?: string): boolean
  tick(): void
  readonly waves: LimitWaves
  stop(): void
}

export function startLimitWaves(deps: LimitWaveDeps, opts: { timer?: boolean } = {}): LimitWaveRunner {
  const now = deps.now ?? Date.now
  const waves = new LimitWaves()
  const posting = new Set<unknown>()
  const find = (id: string): Session | undefined => deps.list().find((s) => s.id === id)

  const tick = (): void => {
    const t = now()
    const step = waves.step(t, (id) => paneNow(find(id), deps.movedOn(id)), deps.mayPrompt())
    for (const id of step.prompt) {
      deps.log({ action: 'continue', pane: id })
      deps.carryOn(id, CONTINUE_TEXT, (end) => {
        const s = find(id)
        const sent = end === 'sent'
        waves.promptSettled(id, sent, Boolean(paneNow(s, false)?.busy), now(), whyUnsent(end))
        deps.log({ action: sent ? 'continue-sent' : 'continue-failed', pane: id, end })
      })
    }
    for (const w of step.push) {
      if (posting.has(w)) continue
      const label = (id: string): PaneLabel | undefined => deps.label(id)
      const payload = pushPayload(waveTitle(w), waveBody(w, label), waveKey(w, deps.host))
      posting.add(w)
      void deps.post(payload).then((ok) => {
        posting.delete(w)
        waves.pushed(w, ok, now())
        deps.log({ action: ok ? 'pushed' : 'push-failed', title: payload.title, body: payload.body, key: payload.dedupe_key })
      })
    }
  }

  const timer = opts.timer === false ? undefined : setInterval(tick, TICK_MS)
  if (timer && typeof timer.unref === 'function') timer.unref()

  return {
    waves,
    tick,
    stopped(s, line, painted) {
      const t = now()
      const stop = limitStopOf(stopText(line, painted), t)
      if (stop === null) return false
      // A stop as it happens names a reset still to come. One whose reset has been is a CLI
      // repainting its conversation - a woken pane's `--resume` does exactly that, after its
      // continue went in - and reading it as new would type the continue in a second time.
      if (stop === 'stale' || stop.resetAt <= t) {
        deps.log({ action: 'stale', pane: s.id, line: line.slice(0, 160) })
        return true
      }
      waves.noteStop(s.id, s.title, stop, t, s.turnsHere ?? 0)
      deps.log({ action: 'stop', pane: s.id, provider: stop.provider, window: stop.window, resetAt: new Date(stop.resetAt).toISOString() })
      return true
    },
    stop() {
      if (timer) clearInterval(timer)
    }
  }
}
