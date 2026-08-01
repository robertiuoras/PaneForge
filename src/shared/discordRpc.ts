/**
 * Discord Rich Presence, the pure half: the wire framing and what the presence says.
 *
 * Discord's local RPC socket speaks length-prefixed JSON frames - int32 LE opcode,
 * int32 LE payload length, then the payload. The pipe hands bytes over at whatever
 * boundaries it feels like, and the READY frame plus the first command ack routinely
 * arrive in one segment - the same lesson the device link learned the hard way, so
 * frames are reassembled here and decoded only when whole.
 */

export const OP_HANDSHAKE = 0
export const OP_FRAME = 1

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
  /** panes on the desk that have not exited */
  total: number
  /** project folder names of the running panes, deduped, in pane order */
  names: string[]
  /** epoch ms of the oldest running turn's start, if any turn is running */
  oldestRunSince?: number
  /** epoch ms the app came up - the elapsed clock while everything is idle */
  appStart: number
}

/** Discord rejects details/state over 128 chars, and a name list can be any length. */
const TEXT_MAX = 128

/**
 * What the two lines say and which parts show at all.
 *
 * Every string is a template and every empty string means "the built-in wording",
 * so a config that has never been touched produces the exact bytes it always did
 * and the settings fields can show the defaults as placeholders rather than as
 * saved values somebody now has to maintain.
 */
export interface DiscordStyle {
  /** line one while a turn is running; '' = `{running}/{total} {sessions} running` */
  details: string
  /** line two while a turn is running; '' = `on {projects}` */
  state: string
  /** line one while nothing is running; '' = `{total} {sessions} idle` */
  idleDetails: string
  /** include the project-names line at all */
  projects: boolean
  /** show Discord's elapsed clock under the lines */
  elapsed: boolean
  /** say anything at all while no turn is running */
  whileIdle: boolean
}

export const DEFAULT_DETAILS = '{running}/{total} {sessions} running'
export const DEFAULT_STATE = 'on {projects}'
export const DEFAULT_IDLE_DETAILS = '{total} {sessions} idle'

export const DEFAULT_DISCORD_STYLE: DiscordStyle = {
  details: '',
  state: '',
  idleDetails: '',
  projects: true,
  elapsed: true,
  whileIdle: true
}

/** The legend under the template fields, and the whole of what a template may say. */
export const DISCORD_TOKENS: ReadonlyArray<readonly [string, string]> = [
  ['{running}', 'panes with a turn running right now'],
  ['{total}', 'panes on the desk'],
  ['{idle}', 'panes not running anything'],
  ['{sessions}', '"session" or "sessions", matching the total'],
  ['{projects}', 'the project folders being worked in'],
  ['{project}', 'the first of those folders']
]

function fill(tpl: string, c: PresenceCounts, names: string[], dropped: number): string {
  const projects = names.join(', ') + (dropped ? ` +${dropped} more` : '')
  return tpl
    .replace(/\{running\}/g, String(c.running))
    .replace(/\{total\}/g, String(c.total))
    .replace(/\{idle\}/g, String(Math.max(0, c.total - c.running)))
    .replace(/\{sessions\}/g, c.total === 1 ? 'session' : 'sessions')
    .replace(/\{projects\}/g, projects)
    .replace(/\{project\}/g, names[0] ?? '')
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
 * The presence itself. An empty desk returns null - a profile advertising
 * "0/0 sessions" all day is worse than no presence at all - and the caller sends
 * that as a clear. So does an idle desk with the idle line switched off, and a
 * pair of templates that render to nothing at all: an activity with no text is a
 * blank badge on the profile, which reads as a bug rather than as a setting.
 */
export function buildActivity(
  c: PresenceCounts,
  style: DiscordStyle = DEFAULT_DISCORD_STYLE
): Record<string, unknown> | null {
  if (c.total <= 0) return null
  const running = c.running > 0
  if (!running && !style.whileIdle) return null

  const details = renderLine(
    running ? style.details || DEFAULT_DETAILS : style.idleDetails || DEFAULT_IDLE_DETAILS,
    c
  )
  const wantsState = running && style.projects && c.names.length > 0
  const state = wantsState ? renderLine(style.state || DEFAULT_STATE, c) : ''
  if (!details && !state) return null

  const activity: Record<string, unknown> = {}
  if (details) activity.details = details
  if (state) activity.state = state
  if (style.elapsed) {
    activity.timestamps = { start: running ? (c.oldestRunSince ?? c.appStart) : c.appStart }
  }
  return activity
}
