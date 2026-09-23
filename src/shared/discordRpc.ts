/**
 * Discord Rich Presence, the pure half: the wire framing and what the presence says.
 *
 * Discord's local RPC socket speaks length-prefixed JSON frames - int32 LE opcode,
 * int32 LE payload length, then the payload. The pipe hands bytes over at whatever
 * boundaries it feels like, and the READY frame plus the first command ack routinely
 * arrive in one segment - the same lesson the device link learned the hard way, so
 * frames are reassembled here and decoded only when whole.
 */

import { formatTokens } from './tokenTally'
import { fleetState, type FleetPane } from './fleet'

export const OP_HANDSHAKE = 0
export const OP_FRAME = 1

/**
 * The Discord application every copy of PaneForge reports under. A constant, not a
 * setting.
 *
 * Discord prints this application's NAME as the header of the card and resolves its
 * uploaded art by name, so the id is not a preference - it is the app's identity, the
 * same way the window title is. It was a text field for one release and that was a
 * mistake in three separate directions: a user who cleared it or typed a digit wrong
 * got a presence nobody could see and no error saying so; anyone on the old borrowed
 * id kept a stranger's brand on their profile until a migration caught up with them;
 * and it read as "you need to make your own application", which was never true.
 *
 * What a user may still do is turn the presence off, or reword it - see `DiscordStyle`.
 */
export const DISCORD_APP_ID = '1533054088454082601'

export function encodeFrame(op: number, payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload))
  const out = Buffer.alloc(8 + body.length)
  out.writeInt32LE(op, 0)
  out.writeInt32LE(body.length, 4)
  body.copy(out, 8)
  return out
}

export interface RpcFrame {
  op: number
  payload: Record<string, unknown>
}

/** Holds partial bytes between data events and yields only complete frames. */
export class FrameStream {
  private held: Buffer = Buffer.alloc(0)

  push(chunk: Buffer): RpcFrame[] {
    this.held = this.held.length ? Buffer.concat([this.held, chunk]) : chunk
    const frames: RpcFrame[] = []
    while (this.held.length >= 8) {
      const len = this.held.readInt32LE(4)
      if (this.held.length < 8 + len) break
      const op = this.held.readInt32LE(0)
      const body = this.held.subarray(8, 8 + len).toString()
      this.held = this.held.subarray(8 + len)
      frames.push({ op, payload: JSON.parse(body) })
    }
    return frames
  }
}

export interface PresenceCounts {
  /** panes whose turn is running right now */
  running: number
  /** panes on the desk, INCLUDING the ones asleep - a slept pane is still a pane */
  total: number
  /**
   * Panes whose agent has been stopped but whose card, screen and conversation are still
   * on the desk.
   *
   * They read as `exited` and used to be dropped outright, so the desk's own number went
   * DOWN every time the idle clock slept something and the profile said five sessions
   * where there were eight. Robert, 2026-09-10: "can u also count sleeping sessions in
   * paneforge as well for our discord rich presence".
   */
  asleep: number
  /** project folder names of the running panes, deduped, in pane order */
  names: string[]
  /** epoch ms of the oldest running turn's start, if any turn is running */
  oldestRunSince?: number
  /** epoch ms the app came up - the elapsed clock while everything is idle */
  appStart: number
  /** tokens every agent on this machine has spent since local midnight */
  tokensToday?: number
  /** the same, over the last seven days including today */
  tokensWeek?: number
  /**
   * The name of another desk that is connected to this one and so already counts every
   * pane here. Set, this machine says nothing: a Discord account shows ONE presence, and
   * the PC's own desk of one pane went up as "1/1 session running" over the Mac's 7/15
   * (2026-09-23).
   */
  countedBy?: string
}

/** The few fields of a pane the presence reads, so a caller can pass anything shaped like one. */
export interface PresenceSession extends Omit<FleetPane, 'status'> {
  status: string
  cwd: string
  /** used only to drop a pane that arrived twice; a pane without one is always kept */
  id?: string
}

/**
 * The folder a pane is working in, as a bare name.
 *
 * Split on BOTH separators rather than calling `basename`: that is the POSIX one on a
 * Mac, and a mirrored pane's cwd arrives in the other machine's notation, so
 * `C:\Users\Gamer\Desktop\Projects\assistant-b` came back whole and would have gone
 * onto the profile as the full Windows path.
 */
export function folderName(cwd: string): string {
  const parts = String(cwd ?? '').split(/[\\/]+/)
  for (let i = parts.length - 1; i >= 0; i--) if (parts[i]) return parts[i]
  return ''
}

/**
 * What the profile says about the desk, from the desk.
 *
 * Pure and here rather than in the main entry so the suite can pin it: the counting is
 * the half that was wrong (mirrored panes left out, Windows paths unsplit) and the main
 * entry is an Electron module no test can load.
 */
export function countPresence(sessions: PresenceSession[], appStart: number): PresenceCounts {
  // The desk is now two lists stitched together, and the numbers are the one part of
  // this that was NOT protected against a pane arriving in both: the name list has
  // always deduped, so a pane counted twice would inflate the fraction while leaving
  // the projects line looking right - the shape of a bug nobody reads as one.
  const seen = new Set<string>()
  const live: PresenceSession[] = []
  for (const s of sessions) {
    if (s.id) {
      if (seen.has(s.id)) continue
      seen.add(s.id)
    }
    live.push(s)
  }
  // `exited` is a pane whose agent is stopped and whose card is still here - what the idle
  // clock does. It is not a pane that has gone: a closed pane is not in this list at all.
  const asleep = live.filter((s) => s.status === 'exited').length
  // A running turn, or a turn that is over with a background job still going - the
  // sidebar's Running heading holds both (`fleet.ts` `fleetState`). Reading
  // `status === 'working'` alone, the profile said 6 running while that heading held 16
  // (2026-09-23). A pane still booting stays out, as before.
  const running = live.filter((s) => s.status === 'working' || fleetState(s as FleetPane) === 'working')
  const names: string[] = []
  for (const s of running) {
    const name = folderName(s.cwd)
    if (name && !names.includes(name)) names.push(name)
  }
  const since = running.map((s) => s.runSince ?? s.backJobSince).filter((n): n is number => !!n)
  return {
    running: running.length,
    total: live.length,
    asleep,
    names,
    oldestRunSince: since.length ? Math.min(...since) : undefined,
    appStart
  }
}

/**
 * What Discord itself last said about the presence - the only honest answer to "is this
 * working", and the reason the settings tab can stop guessing.
 *
 * Discord acknowledges every `SET_ACTIVITY` by echoing back the activity it STORED,
 * complete with the application name it resolved and the asset id the image name turned
 * into, or by answering `evt: 'ERROR'` with a reason. Until now every one of those frames
 * was dropped on the floor and a presence that Discord had refused looked exactly like
 * one it had accepted.
 *
 * What it deliberately cannot say is whether anyone ELSE can see the card. Discord does
 * not tell an application that, and the switches that hide it (Activity Privacy, and
 * Activity Status per server) live in Discord's own settings.
 */
export interface PresenceStatus {
  /** the app's own switch */
  enabled: boolean
  /** a Discord pipe answered and the handshake went through */
  connected: boolean
  /** the account Discord handed over at READY, by the name it shows */
  user: string | null
  /** epoch ms Discord last acknowledged a presence */
  acceptedAt: number | null
  /** the header Discord resolved from the application id - "PaneForge" when all is well */
  appName: string | null
  /** the two lines Discord actually stored, as it echoed them back */
  lines: string[]
  /** true when the last thing Discord stored was "no activity" - an empty desk */
  cleared: boolean
  /** Discord refused the last frame, in its own words */
  error: string | null
  /** another desk shows this one's panes, so this machine sends nothing (`PresenceCounts.countedBy`) */
  countedBy?: string | null
}

export const NO_PRESENCE_STATUS: PresenceStatus = {
  enabled: false,
  connected: false,
  user: null,
  acceptedAt: null,
  appName: null,
  lines: [],
  cleared: false,
  error: null
}


/** Discord rejects details/state over 128 chars, and a name list can be any length. */
const TEXT_MAX = 128

/**
 * How many text lines Discord will draw. Two, and it has always been two.
 *
 * A rich presence is: the application's name, `details`, `state`, one elapsed clock and
 * up to two buttons. There is no third text field to send, so "add another row" cannot
 * mean another line on the card - it means another line in the LIST, and which two of
 * them are on top. Rows past the second are kept, not sent, and the settings tab says
 * so rather than letting a row be written that silently goes nowhere.
 */
export const VISIBLE_ROWS = 2
/** Discord takes at most two buttons on an activity, and drops the activity over three. */
export const MAX_BUTTONS = 2

/** When a row has anything to say. */
export type RowWhen = 'always' | 'running' | 'idle'

/**
 * One line of the card, as the user arranged it.
 *
 * Every row is a template over the same tokens, so the card is not three fixed fields
 * any more - the numbers line can be moved under the projects line, the projects line
 * can be the only one, and a row that says the week's tokens can be added under either.
 * The wording used to be three separate settings (`details`, `state`, `idleDetails`)
 * which could not be reordered, could not be turned off one at a time, and had one
 * fixed meaning each; `migrateRows` turns an old config into the same three rows.
 */
export interface DiscordRow {
  /** stable across reorders, so the editor's fields keep their identity */
  id: string
  /** the template; a row that renders to nothing is skipped and the next one moves up */
  text: string
  when: RowWhen
  on: boolean
}

/** The clickable line under the card. Discord shows it to everyone except its owner. */
export interface DiscordButton {
  id: string
  label: string
  url: string
  on: boolean
}

/**
 * What the two lines say, which parts show, and what the buttons are.
 *
 * The legacy wording fields are still here because a config written before the rows
 * existed has them and nothing else; `migrateRows` is the only thing that reads them.
 */
export interface DiscordStyle {
  /** the whole card's wording, in the order the user put it */
  rows: DiscordRow[]
  /** show Discord's elapsed clock under the lines */
  elapsed: boolean
  /** up to MAX_BUTTONS links under the presence */
  buttons: DiscordButton[]
  /** @deprecated read once, by the migration */
  details?: string
  /** @deprecated read once, by the migration */
  state?: string
  /** @deprecated read once, by the migration */
  idleDetails?: string
  /** @deprecated read once, by the migration */
  projects?: boolean
  /** @deprecated read once, by the migration */
  whileIdle?: boolean
  /** @deprecated read once, by the migration */
  link?: boolean
  /** @deprecated read once, by the migration */
  linkLabel?: string
  /** @deprecated read once, by the migration */
  linkUrl?: string
}

export const DEFAULT_DETAILS = '{running}/{total} {sessions} running'
export const DEFAULT_STATE = 'on {projects}'
export const DEFAULT_IDLE_DETAILS = '{total} {sessions} idle'
export const DEFAULT_LINK_LABEL = 'toolstash.xyz/paneforge'
export const DEFAULT_LINK_URL = 'https://toolstash.xyz/paneforge'

export const DEFAULT_ROWS: DiscordRow[] = [
  { id: 'running', text: DEFAULT_DETAILS, when: 'running', on: true },
  { id: 'projects', text: DEFAULT_STATE, when: 'running', on: true },
  { id: 'idle', text: DEFAULT_IDLE_DETAILS, when: 'idle', on: true }
]

export const DEFAULT_DISCORD_STYLE: DiscordStyle = {
  rows: DEFAULT_ROWS.map((r) => ({ ...r })),
  elapsed: true,
  buttons: [
    { id: 'link', label: DEFAULT_LINK_LABEL, url: DEFAULT_LINK_URL, on: true }
  ]
}

/** A row id nothing else on the card is using. */
export function newRowId(taken: ReadonlyArray<{ id: string }>): string {
  const used = new Set(taken.map((r) => r.id))
  for (let i = 1; ; i++) if (!used.has(`row${i}`)) return `row${i}`
}

/**
 * An old config's wording, as rows - and a config that already has rows, untouched.
 *
 * The three legacy fields were templates with an EMPTY string meaning "the built-in
 * wording", so the fallback has to happen here: a row carrying '' would render to
 * nothing and be skipped, which would silently blank the card of anyone who had never
 * touched the settings.
 */
export function migrateRows(raw: Partial<DiscordStyle> | undefined): DiscordStyle {
  const base = raw ?? {}
  if (Array.isArray(base.rows) && base.rows.length) {
    return {
      rows: base.rows.map((r) => ({ ...r })),
      elapsed: base.elapsed !== false,
      buttons: Array.isArray(base.buttons) && base.buttons.length
        ? base.buttons.map((b) => ({ ...b }))
        : DEFAULT_DISCORD_STYLE.buttons.map((b) => ({ ...b }))
    }
  }
  const rows: DiscordRow[] = [
    { id: 'running', text: base.details || DEFAULT_DETAILS, when: 'running', on: true },
    {
      id: 'projects',
      text: base.state || DEFAULT_STATE,
      when: 'running',
      on: base.projects !== false
    },
    {
      id: 'idle',
      text: base.idleDetails || DEFAULT_IDLE_DETAILS,
      when: 'idle',
      on: base.whileIdle !== false
    }
  ]
  return {
    rows,
    elapsed: base.elapsed !== false,
    buttons: [
      {
        id: 'link',
        label: base.linkLabel || DEFAULT_LINK_LABEL,
        url: base.linkUrl || DEFAULT_LINK_URL,
        on: base.link !== false
      }
    ]
  }
}

/**
 * The art asset the card draws, by the name it was uploaded under in the Discord
 * portal - not a URL and not the application's icon hash.
 *
 * An application's icon names the header only; it is never the artwork. A presence
 * that sends no `assets` is drawn as text with no image at all, which is why the
 * mark was missing from every profile long after the application stopped being a
 * borrowed one and got the icon uploaded. `large_text` is its hover tooltip.
 */
export const PRESENCE_IMAGE = 'icon'
export const PRESENCE_IMAGE_TEXT = 'PaneForge'

/** Discord's own limits on a presence button. Over either one it rejects the frame. */
const LABEL_MAX = 32
const URL_MAX = 512

/**
 * The links under the presence, as Discord will accept them.
 *
 * A URL cannot be put in a text row: Discord renders those as plain text, markdown and
 * all, so `[PaneForge](https://…)` shows up literally and a bare link shows up
 * unclickable. `buttons` is the only clickable surface a rich presence has.
 *
 * Two things worth knowing before reading a profile and calling this broken: Discord
 * does not show a presence button to the account it belongs to - only other people see
 * it - and it drops the WHOLE activity, not just the button, over a malformed URL. So a
 * button that cannot be sent is left out here rather than sent and refused.
 */
export function buildButtons(style: DiscordStyle): { label: string; url: string }[] {
  const out: { label: string; url: string }[] = []
  for (const b of style.buttons ?? []) {
    if (!b.on) continue
    // Trimmed BEFORE the fallback, not after: a field the user cleared can hold
    // spaces, and `'  ' || default` keeps the spaces - which then trims to nothing
    // and threw the button away instead of falling back like an empty field does.
    const url = (b.url ?? '').trim() || DEFAULT_LINK_URL
    if (!/^https?:\/\//i.test(url) || url.length > URL_MAX) continue
    out.push({ label: ((b.label ?? '').trim() || DEFAULT_LINK_LABEL).slice(0, LABEL_MAX), url })
    if (out.length >= MAX_BUTTONS) break
  }
  return out
}

/** The legend under the template fields, and the whole of what a template may say. */
export const DISCORD_TOKENS: ReadonlyArray<readonly [string, string]> = [
  ['{running}', 'panes with a turn running right now'],
  ['{total}', 'panes on the desk'],
  ['{idle}', 'panes not running anything'],
  ['{asleep}', 'panes asleep - stopped to save memory, one press wakes them'],
  ['{sessions}', '"session" or "sessions", matching the total'],
  ['{projects}', 'the project folders being worked in'],
  ['{project}', 'the first of those folders'],
  ['{tokens}', 'tokens every agent here has spent since midnight, as 1.2M'],
  ['{tokensWeek}', 'the same over the last seven days']
]

/**
 * One button per `DISCORD_TOKENS` entry, in plain words, for the "insert this" chips in
 * the editor. `label` is what the button says; `phrase` is what gets added to the line -
 * never the raw `{token}` itself, so nobody has to know that syntax exists to build a
 * line. Order matches `DISCORD_TOKENS`.
 */
export const TOKEN_PHRASES: ReadonlyArray<{ token: string; label: string; phrase: string }> = [
  { token: '{running}', label: 'Running count', phrase: '{running} running' },
  { token: '{total}', label: 'Total panes', phrase: '{total} {sessions} total' },
  { token: '{idle}', label: 'Idle count', phrase: '{idle} idle' },
  { token: '{asleep}', label: 'Asleep count', phrase: '{asleep} asleep' },
  { token: '{sessions}', label: 'Running / total', phrase: DEFAULT_DETAILS },
  { token: '{projects}', label: 'Projects', phrase: 'on {projects}' },
  { token: '{project}', label: 'First project', phrase: 'on {project}' },
  { token: '{tokens}', label: 'Tokens today', phrase: '{tokens} tokens today' },
  { token: '{tokensWeek}', label: 'Tokens this week', phrase: '{tokensWeek} tokens this week' }
]

/**
 * A whole ready-made line, for the "Add a line" picker - a complete row with sensible
 * wording and timing, so starting a new line never needs typing.
 */
export const PRESET_ROWS: ReadonlyArray<{ label: string; text: string; when: RowWhen }> = [
  { label: 'Panes running', text: DEFAULT_DETAILS, when: 'running' },
  { label: 'Projects being worked on', text: DEFAULT_STATE, when: 'running' },
  { label: 'Panes asleep', text: '{asleep} asleep', when: 'always' },
  { label: 'Tokens spent today', text: '{tokens} tokens today', when: 'always' },
  { label: 'Tokens spent this week', text: '{tokensWeek} tokens this week', when: 'always' }
]

/**
 * Adds `phrase` to `text`, or takes it back out if it is already there - the chip is a
 * toggle, not just an inserter. Joined with " · ", the same separator the rest of the
 * app uses to run short facts together, and never put in front of an empty line.
 */
export function togglePhrase(text: string, phrase: string): string {
  const parts = text
    .split(' · ')
    .map((p) => p.trim())
    .filter(Boolean)
  const at = parts.indexOf(phrase)
  if (at >= 0) {
    parts.splice(at, 1)
  } else {
    parts.push(phrase)
  }
  return parts.join(' · ')
}

/** Whether anything on the card asks for the token numbers, which cost a disk walk. */
export function needsTokens(style: DiscordStyle): boolean {
  return (style.rows ?? []).some((r) => r.on && /\{tokens(Week)?\}/.test(r.text))
}

function fill(tpl: string, c: PresenceCounts, names: string[], dropped: number): string {
  const projects = names.join(', ') + (dropped ? ` +${dropped} more` : '')
  return tpl
    .replace(/\{running\}/g, String(c.running))
    .replace(/\{total\}/g, String(c.total))
    .replace(/\{idle\}/g, String(Math.max(0, c.total - c.running)))
    .replace(/\{asleep\}/g, String(c.asleep))
    .replace(/\{sessions\}/g, c.total === 1 ? 'session' : 'sessions')
    .replace(/\{projects\}/g, projects)
    .replace(/\{project\}/g, names[0] ?? '')
    .replace(/\{tokensWeek\}/g, formatTokens(c.tokensWeek ?? 0))
    .replace(/\{tokens\}/g, formatTokens(c.tokensToday ?? 0))
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * A line, short enough for Discord to accept it. A name list is the only part that
 * can be any length, so it gives ground first - dropping trailing projects for a
 * "+2 more" beats truncating mid-word, and only a template with no names left in it
 * falls back to the ellipsis.
 */
export function renderLine(tpl: string, c: PresenceCounts): string {
  let names = [...c.names]
  let dropped = 0
  let out = fill(tpl, c, names, dropped)
  while (out.length > TEXT_MAX && names.length > 1) {
    names = names.slice(0, -1)
    dropped++
    out = fill(tpl, c, names, dropped)
  }
  return out.length > TEXT_MAX ? out.slice(0, TEXT_MAX - 1) + '…' : out
}

/**
 * Every row that has something to say right now, in the user's own order.
 *
 * A row is dropped for any of three reasons and they are not the same reason: it is
 * switched off, it is for the other half of the day, or it rendered to nothing. The
 * last one is what makes the list feel like rows rather than slots - `on {projects}`
 * with nothing running has no text, so it takes no line and whatever is under it moves
 * up, which is exactly what the old `projects` switch did by hand.
 */
/**
 * A row whose own subject has gone missing says nothing at all.
 *
 * `on {projects}` with no project to name renders as the bare word `on`, which is what
 * a card with a dangling preposition on it looks like. The old fixed second line dodged
 * this with a switch beside it - once any row can hold any token, the row itself has to
 * know. Only the two name tokens can come out empty: every number renders as a digit
 * and both token totals render as `0`.
 */
function rowSpeaks(tpl: string, c: PresenceCounts): boolean {
  return !(/\{projects?\}/.test(tpl) && c.names.length === 0)
}

export function chosenRows(
  c: PresenceCounts,
  style: DiscordStyle
): { id: string; text: string }[] {
  const running = c.running > 0
  const out: { id: string; text: string }[] = []
  for (const row of style.rows ?? []) {
    if (!row.on) continue
    if (row.when === 'running' && !running) continue
    if (row.when === 'idle' && running) continue
    if (!rowSpeaks(row.text, c)) continue
    const text = renderLine(row.text, c)
    if (!text) continue
    out.push({ id: row.id, text })
    if (out.length >= VISIBLE_ROWS) break
  }
  return out
}

/** The same, as the two lines themselves. */
export function visibleRows(c: PresenceCounts, style: DiscordStyle): string[] {
  return chosenRows(c, style).map((r) => r.text)
}

/**
 * The presence itself. An empty desk returns null - a profile advertising
 * "0/0 sessions" all day is worse than no presence at all - and the caller sends
 * that as a clear. So does a card with no row left to draw: an activity with no text
 * is a blank badge on the profile, which reads as a bug rather than as a setting.
 */
export function buildActivity(
  c: PresenceCounts,
  style: DiscordStyle = DEFAULT_DISCORD_STYLE,
  /** test seam; the app never passes it */
  now: number = Date.now()
): Record<string, unknown> | null {
  if (c.total <= 0 || c.countedBy) return null
  const rows = visibleRows(c, style)
  if (!rows.length) return null

  const activity: Record<string, unknown> = {}
  activity.details = rows[0]
  if (rows[1]) activity.state = rows[1]
  activity.assets = { large_image: PRESENCE_IMAGE, large_text: PRESENCE_IMAGE_TEXT }
  if (style.elapsed) {
    // Discord counts UP from this stamp, so a start in the future is not a small error -
    // it renders as a negative or absurd clock on the profile. Since the desk started
    // including mirrored panes, `oldestRunSince` can be the OTHER machine's clock, and
    // two machines are never exactly in step. Clamp rather than drop: a turn that began
    // a moment ago is the truth being approximated, and no timer at all would be worse.
    const started = c.running > 0 ? (c.oldestRunSince ?? c.appStart) : c.appStart
    activity.timestamps = { start: Math.min(started, now) }
  }
  const buttons = buildButtons(style)
  if (buttons.length) activity.buttons = buttons
  return activity
}
