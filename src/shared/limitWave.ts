// A usage limit that stops ten panes at once is ONE event, and it is over when they carry on.
//
// 2026-10-01 9:39pm the Claude 5-hour limit stopped every Claude pane on the desk inside a
// minute, and every one of them sent its own Telegram message (`paneError.ts` dedupes per
// pane, so N panes were N messages). Robert: "rather not on telegram ... put them together
// like 5h claude reset 10/10 sessions successfully continuing after all done continuing".
//
// So a limit stop that names its reset is not a message at all. It joins a WAVE - same
// provider, same reset to within a couple of minutes - and the wave does what nothing did
// before: once the reset has come it types one continue into each pane still sitting on
// the stop, watches each one actually start working, and only then says one sentence to the
// phone with the count it saw. A stop with no reset on it (an expired login, a credit
// balance, a limit line this cannot read) is not a wave and keeps today's Telegram path.
//
// This file is the decision and nothing else: no timers, no I/O, the clock passed in.
// `src/main/limitWaves.ts` is the thin half that wakes panes, types and posts.

/** Which CLI's plan ran out. A wave never mixes them: their resets are unrelated. */
export type LimitProvider = 'claude' | 'codex'

export interface LimitStop {
  provider: LimitProvider
  /** Claude's word for the limit (`session`, `weekly`, `opus`...); absent for Codex. */
  window?: string
  /** Epoch ms the CLI said the limit resets, to the minute. */
  resetAt: number
}

/** Panes whose resets are this close are one wave: the CLIs round, and they paint apart. */
export const JITTER_MS = 2 * 60_000
/**
 * How long after the named reset the continue goes in.
 *
 * Claude Code 2.1.286 continues a limit-stopped chat BY ITSELF, 38-116s after the reset
 * (`Usage limit reached · continuing automatically at 9:40pm`, then an `isMeta` user line;
 * ten transcripts of the 2026-10-01 9:40pm reset). A continue at reset + 60s raced it and
 * would have asked twice, so Claude waits past its slowest one and a pane already working
 * counts as continuing with nothing typed. An ASLEEP pane has no CLI to do that, and is the
 * one this types into. Codex does not continue itself.
 */
export const CONTINUE_AFTER_MS: Record<LimitProvider, number> = { claude: 150_000, codex: 60_000 }
/** A pane that took the message has this long to start working. */
export const START_WITHIN_MS = 3 * 60_000
/** Quiet after the last pane settled before the push, so a quick second limit is counted. */
export const SETTLE_QUIET_MS = 60_000
/** The push goes by this long after the continue went in, whatever is still undecided. */
export const WAVE_DEADLINE_MS = 10 * 60_000
/** A failed push is tried again this often, and given up after `PUSH_GIVE_UP_MS`. */
export const PUSH_RETRY_MS = 2 * 60_000
export const PUSH_GIVE_UP_MS = 60 * 60_000
/** A reset this far in the past is still "now": the line was read a little late. */
export const STALE_SLACK_MS = 10 * 60_000

/** The words typed into each pane. The agent reads them; nobody else does. */
export const CONTINUE_TEXT =
  'The usage limit has reset. Carry on with what you were doing before the limit message, from where it stopped.'

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const HOUR = 3_600_000
const DAY = 24 * HOUR
/** The furthest ahead each limit can reset. A line naming a later time is an old line. */
const MAX_AHEAD: Record<string, number> = { session: 5 * HOUR + STALE_SLACK_MS, weekly: 7 * DAY + HOUR }
const MAX_AHEAD_DATED = 32 * DAY

/** Minutes `tz` is ahead of UTC at `at`, or null for a zone this machine does not know. */
function zoneOffset(tz: string, at: number): number | null {
  try {
    const parts: Record<string, string> = {}
    for (const p of new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric'
    }).formatToParts(new Date(at))) parts[p.type] = p.value
    const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute)
    return Math.round((wall - Math.floor(at / 60_000) * 60_000) / 60_000)
  } catch {
    return null
  }
}

/** Epoch ms of a wall-clock time in `tz`. Asked twice so a DST edge lands right. */
function wallToEpoch(y: number, mo: number, d: number, h: number, m: number, tz: string): number | null {
  const wall = Date.UTC(y, mo, d, h, m)
  const first = zoneOffset(tz, wall)
  if (first === null) return null
  const second = zoneOffset(tz, wall - first * 60_000)
  return wall - (second ?? first) * 60_000
}

/** Today's (or the dated) reset, rolled forward when the time already went, or 'stale'. */
function nextReset(
  candidate: (yearShift: number, dayShift: number) => number | null,
  dated: boolean,
  window: string | undefined,
  now: number
): number | 'stale' | null {
  let at = candidate(0, 0)
  if (at === null) return null
  if (at < now - STALE_SLACK_MS) at = dated ? candidate(1, 0) : candidate(0, 1)
  if (at === null) return null
  const ahead = at - now
  const cap = (window ? MAX_AHEAD[window] : undefined) ?? (dated ? MAX_AHEAD_DATED : DAY)
  if (ahead < -STALE_SLACK_MS || ahead > cap) return 'stale'
  return at
}

/**
 * The limit a stopped pane's own words name, and when it resets.
 *
 * `text` is the stop line and the rows after it: Codex wraps its sentence, and the date is
 * on the second row. Wording measured in this desk's pane history (693 MB, 2026-10-01):
 *
 *   ⎿  You've hit your session limit · resets 1:50am (Australia/Brisbane)
 *   You've hit your weekly limit · resets Oct 1 at 3pm (Australia/Brisbane)
 *   ■ You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to
 *     purchase more credits or try again at Oct 6th, 2026 6:53 PM.
 *
 * The painted stream has its cursor moves stripped, so spaces can be missing
 * (`2026<CSI>6:53` reads `20266:53`): every gap here is optional.
 *
 * Answers null for anything that is not a limit with a readable reset - that stop keeps its
 * Telegram message - and 'stale' for a limit whose reset has already been and gone: a CLI
 * repainting an old conversation on `--resume`, which is neither news nor a wave.
 */
export function limitStopOf(text: string, now: number, localZone?: string): LimitStop | 'stale' | null {
  const said = /You['’]?ve\s*(?:hit|reached)\s*your\s*(?:([A-Za-z]+)\s*)?limit/i.exec(text)
  if (!said) return null
  const word = said[1]?.toLowerCase()
  const zone = localZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  // Claude's reset is on the stop's own row: a later row saying "resets 2am" is somebody's prose.
  const claude = /resets\s*(?:([A-Za-z]{3})[a-z]*\.?\s*(\d{1,2})(?:st|nd|rd|th)?,?\s*(?:at\s*)?)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)\s*(?:\(([^)]+)\))?/i.exec(
    text.slice(said.index).split('\n')[0]
  )
  if (claude) {
    const [, mon, day, hh, mm, ap, tz] = claude
    const month = mon ? MONTHS.indexOf(mon.toLowerCase()) : -1
    if (mon && month < 0) return null
    const hour = (Number(hh) % 12) + (ap.toLowerCase() === 'pm' ? 12 : 0)
    const where = tz?.trim() || zone
    const off = zoneOffset(where, now)
    if (off === null) return null
    const today = new Date(now + off * 60_000)
    const window = word === 'usage' ? undefined : word
    const at = nextReset(
      (years, days) =>
        wallToEpoch(
          today.getUTCFullYear() + years,
          mon ? month : today.getUTCMonth(),
          (mon ? Number(day) : today.getUTCDate()) + days,
          hour,
          Number(mm ?? 0),
          where
        ),
      Boolean(mon),
      window,
      now
    )
    if (at === null || at === 'stale') return at
    return { provider: 'claude', window, resetAt: at }
  }
  const codex = /try\s*again\s*(?:at|on|after)\s*([A-Za-z]{3})[a-z]*\.?\s*(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})?,?\s*(\d{1,2}):(\d{2})\s*([ap]m)/i.exec(
    text.slice(said.index)
  )
  if (codex) {
    const [, mon, day, year, hh, mm, ap] = codex
    const month = MONTHS.indexOf(mon.toLowerCase())
    if (month < 0) return null
    const hour = (Number(hh) % 12) + (ap.toLowerCase() === 'pm' ? 12 : 0)
    const thisYear = new Date(now + (zoneOffset(zone, now) ?? 0) * 60_000).getUTCFullYear()
    // Codex prints its machine's own clock and no zone, and that machine is this one.
    const at = year
      ? wallToEpoch(Number(year), month, Number(day), hour, Number(mm), zone)
      : nextReset((years) => wallToEpoch(thisYear + years, month, Number(day), hour, Number(mm), zone), true, undefined, now)
    if (at === null || at === 'stale') return at
    if (at < now - STALE_SLACK_MS || at - now > MAX_AHEAD_DATED) return 'stale'
    return { provider: 'codex', resetAt: at }
  }
  return null
}

/**
 * What one pane is in a wave.
 *
 * waiting    stopped, the reset has not come
 * asked      the continue was handed to the pane; the composer has not proven it took
 * submitted  the pane took it; it has `START_WITHIN_MS` to be seen working
 * continuing working again - by our message, its own retry, a person, another login
 * not        will not be counted; `why` says it in a sentence
 */
export type WaveState = 'waiting' | 'asked' | 'submitted' | 'continuing' | 'not'

export interface WavePane {
  id: string
  /** What the card said when it stopped, for a pane that has no number any more. */
  title: string
  stoppedAt: number
  /** Turns the pane had finished when it stopped, or when its continue went in. */
  turns: number
  state: WaveState
  /** When `state` last changed. */
  at: number
  why?: string
}

export interface Wave {
  provider: LimitProvider
  window?: string
  resetAt: number
  panes: WavePane[]
  /** Push attempts that failed, the last one at `triedAt`. */
  triedAt?: number
  /** When every pane first read settled; the push goes `SETTLE_QUIET_MS` after the last change. */
  settledAt?: number
}

/** What the desk knows about a pane right now. Undefined from the caller = it was closed. */
export interface PaneNow {
  /** Mid-turn: the CLI is working on something. */
  busy: boolean
  /** Turns it has finished on this desk (`Session.turnsHere`). One more = it ran again. */
  turns: number
  /** Something is typed in its box that nobody sent. */
  drafting: boolean
  /** The CLI in it exited by itself; there is nothing to type into. Asleep is NOT ended. */
  ended: boolean
  /** The conversation was moved to a fresh pane (`pf continue`), which is carrying on. */
  movedOn: boolean
}

export interface WaveStep {
  /** Panes to type `CONTINUE_TEXT` into now (waking any that are asleep). */
  prompt: string[]
  /** Waves ready for their one push. Call `pushed` with the answer. */
  push: Wave[]
}

function matches(w: Wave, stop: LimitStop): boolean {
  return w.provider === stop.provider && w.window === stop.window && Math.abs(w.resetAt - stop.resetAt) <= JITTER_MS
}

function dueAt(w: Wave): number {
  return w.resetAt + CONTINUE_AFTER_MS[w.provider]
}

function set(p: WavePane, state: WaveState, now: number, why?: string): void {
  p.state = state
  p.at = now
  p.why = why
}

const OPEN: WaveState[] = ['waiting', 'asked', 'submitted']

/**
 * Every wave on this desk. One instance in main; every method takes the clock.
 *
 * A wave holds its panes from the stop to the push and is then forgotten. In memory only:
 * an app restart between a limit and its reset loses the wave, which is what this machine
 * did before it existed - no message, no continue. Persisting it is the upgrade if that
 * turns out to matter.
 */
export class LimitWaves {
  readonly waves: Wave[] = []

  /**
   * A pane printed a limit stop. It joins the wave for that reset, or starts one.
   *
   * The same pane stopping AGAIN is the case that matters: after its continue went in it
   * means the reset did not take (or a second limit was behind the first), and that wave
   * counts it as not continuing. Before its wave was due it simply moves to the new reset.
   *
   * A second stop naming the SAME reset (or an earlier one) does not start another wave:
   * that is the limit still in force, and a fresh wave due at once would type the continue
   * straight back in - once a minute until the line went stale. Only a later reset, the
   * weekly limit standing behind the 5-hour one, queues the pane again.
   */
  noteStop(id: string, title: string, stop: LimitStop, now: number, turns = 0): void {
    let stillInForce = false
    for (const w of this.waves) {
      const at = w.panes.findIndex((p) => p.id === id)
      if (at < 0) continue
      const p = w.panes[at]
      if (p.state === 'waiting') {
        w.panes.splice(at, 1)
        continue
      }
      if (p.state !== 'not') set(p, 'not', now, 'it hit the limit again')
      if (stop.resetAt <= w.resetAt + JITTER_MS) stillInForce = true
    }
    for (let i = this.waves.length - 1; i >= 0; i--) if (!this.waves[i].panes.length) this.waves.splice(i, 1)
    if (stillInForce) return
    let wave = this.waves.find((w) => matches(w, stop) && now < dueAt(w))
    if (!wave) {
      wave = { provider: stop.provider, window: stop.window, resetAt: Math.round(stop.resetAt / 60_000) * 60_000, panes: [] }
      this.waves.push(wave)
    }
    wave.panes.push({ id, title, stoppedAt: now, turns, state: 'waiting', at: now })
  }

  /** The continue typed into `id` settled: the composer took it (`sent`) or it did not. */
  promptSettled(id: string, sent: boolean, busyNow: boolean, now: number, why?: string): void {
    for (const w of this.waves) {
      const p = w.panes.find((x) => x.id === id && x.state === 'asked')
      if (!p) continue
      if (!sent) set(p, 'not', now, why ?? 'the message did not go in')
      else if (busyNow) set(p, 'continuing', now)
      else set(p, 'submitted', now)
    }
  }

  /** A push went (`ok`) or failed. A failure is tried again later, never counted as sent. */
  pushed(wave: Wave, ok: boolean, now: number): void {
    if (ok || now - (wave.settledAt ?? now) >= PUSH_GIVE_UP_MS) {
      const at = this.waves.indexOf(wave)
      if (at >= 0) this.waves.splice(at, 1)
      return
    }
    wave.triedAt = now
  }

  /**
   * Move every wave along. `now(id)` is the pane's current reading, undefined once closed.
   * `mayPrompt` false (the automatic continue is switched off) leaves every pane to people.
   */
  step(now: number, paneNow: (id: string) => PaneNow | undefined, mayPrompt = true): WaveStep {
    const out: WaveStep = { prompt: [], push: [] }
    for (let i = this.waves.length - 1; i >= 0; i--) {
      const w = this.waves[i]
      const due = now >= dueAt(w)
      const late = now >= dueAt(w) + WAVE_DEADLINE_MS
      let changed = false
      for (let j = w.panes.length - 1; j >= 0; j--) {
        const p = w.panes[j]
        const s = paneNow(p.id)
        // Closed panes leave the count, whatever they were doing.
        if (!s) {
          w.panes.splice(j, 1)
          changed = true
          continue
        }
        if (p.state === 'not' || p.state === 'continuing') continue
        const before = p.state
        // A turn finished since the stop (or since our continue) is a pane that ran again:
        // a person got to it first, the account hook moved it to a login with room, or the
        // continue's own turn was quick enough to end between two looks.
        const carriedOn = s.movedOn || s.busy || s.turns > p.turns
        if (p.state === 'waiting') {
          if (!due) continue
          if (carriedOn) set(p, 'continuing', now)
          else if (s.ended) set(p, 'not', now, 'the chat in it had ended')
          else if (s.drafting) set(p, 'not', now, 'something was typed in its box, so it was left alone')
          else if (!mayPrompt) set(p, 'not', now, 'automatic continue is switched off')
          else {
            set(p, 'asked', now)
            p.turns = s.turns
            out.prompt.push(p.id)
          }
        } else if (p.state === 'submitted' && carriedOn) set(p, 'continuing', now)
        else if (p.state === 'submitted' && now - p.at >= START_WITHIN_MS)
          set(p, 'not', now, 'it took the message but did not start working')
        else if (late)
          set(p, 'not', now, p.state === 'asked' ? 'the message was still waiting to go in' : 'it took the message but did not start working')
        if (p.state !== before) changed = true
      }
      if (!w.panes.length) {
        this.waves.splice(i, 1)
        continue
      }
      if (!due) continue
      const open = w.panes.some((p) => OPEN.includes(p.state))
      if (open) {
        w.settledAt = undefined
        continue
      }
      if (changed || w.settledAt === undefined) w.settledAt = now
      const quietOver = now - Math.max(w.settledAt, ...w.panes.map((p) => p.at)) >= SETTLE_QUIET_MS
      if (!quietOver && !late) continue
      if (w.triedAt !== undefined && now - w.triedAt < PUSH_RETRY_MS) continue
      out.push.push(w)
    }
    return out
  }
}

/** `Claude 5h limit reset`, `Claude weekly limit reset`, `Codex limit reset`. */
export function waveTitle(w: Pick<Wave, 'provider' | 'window'>): string {
  if (w.provider === 'codex') return 'Codex limit reset'
  const word = w.window === 'session' ? '5h' : w.window
  return word ? `Claude ${word} limit reset` : 'Claude limit reset'
}

/** How a pane is named on the phone: the number on its card, then what the card says. */
export interface PaneLabel {
  /** The card number, 0 when it has none. */
  number: number
  title: string
}

const MAX_BODY = 500

/**
 * `10/10 chats continuing`, or the count and then each pane that is not, with why.
 *
 * Plain words for somebody reading a phone on the couch: the card number is how this desk
 * names a pane everywhere else, the title is what the card says, and the reason is a
 * sentence. Clipped to TaskDriver's 500 characters with the rest counted, never cut mid-name.
 */
export function waveBody(w: Wave, label: (id: string) => PaneLabel | undefined): string {
  const all = w.panes.length
  const going = w.panes.filter((p) => p.state === 'continuing').length
  const head = `${going}/${all} ${all === 1 ? 'chat' : 'chats'} continuing`
  const not = w.panes.filter((p) => p.state !== 'continuing')
  if (!not.length) return head
  const names = not.map((p) => {
    const l = label(p.id)
    const title = (l?.title || p.title).trim().slice(0, 48)
    const name = l && l.number > 0 ? `Chat ${l.number}${title ? ` (${title})` : ''}` : title || 'A chat'
    return `${name} - ${p.why ?? 'no sign it started again'}`
  })
  let body = `${head}. Not continuing: `
  for (let i = 0; i < names.length; i++) {
    const rest = names.length - i - 1
    const more = rest ? `; and ${rest} more` : ''
    const next = (i ? '; ' : '') + names[i]
    if ((body + next + more).length > MAX_BODY) return (body + `${i ? '; ' : ''}and ${names.length - i} more`).slice(0, MAX_BODY)
    body += next
  }
  return body
}

/** The one key TaskDriver drops a repeat by: same provider, same reset, same machine. */
export function waveKey(w: Pick<Wave, 'provider' | 'resetAt'>, host: string): string {
  return `pf-limit-reset:${w.provider}:${new Date(w.resetAt).toISOString()}:${host}`
}

/** Why a continue that did not go in did not, from `queuePrompt`'s own ending. */
export function whyUnsent(end: string): string {
  switch (end) {
    case 'abandoned':
      return 'somebody else was using it, so the message was not typed'
    case 'expired':
      return 'it never got ready for the message'
    case 'replaced':
      return 'the chat in it was restarted before the message went in'
    case 'withheld':
      return 'a question was on its screen, so the message was not sent'
    case 'gone':
      return 'it was closed before the message went in'
    case 'wake-failed':
      return 'it was asleep and could not be woken'
    default:
      return 'the message was typed but never went in'
  }
}

/** The body TaskDriver's notify endpoint takes (ROUTING.md "Phone push"). */
export interface PushPayload {
  title: string
  body: string
  kind: 'agent'
  category: 'agents'
  source: 'paneforge'
  priority: 'normal'
  dedupe_key: string
}

export function pushPayload(title: string, body: string, dedupeKey: string): PushPayload {
  return {
    title: title.slice(0, 140),
    body: body.slice(0, MAX_BODY),
    kind: 'agent',
    category: 'agents',
    source: 'paneforge',
    priority: 'normal',
    dedupe_key: dedupeKey
  }
}
