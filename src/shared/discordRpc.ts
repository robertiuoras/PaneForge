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
  /** panes on the desk that have not exited */
  total: number
  /** project folder names of the running panes, deduped, in pane order */
  names: string[]
  /** epoch ms of the oldest running turn's start, if any turn is running */
  oldestRunSince?: number
  /** epoch ms the app came up - the elapsed clock while everything is idle */
  appStart: number
}

/** The one field of a pane the presence reads, so a caller can pass anything shaped like one. */
export interface PresenceSession {
  status: string
  cwd: string
  runSince?: number
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
  const live = sessions.filter((s) => s.status !== 'exited')
  const running = live.filter((s) => s.status === 'working')
  const names: string[] = []
  for (const s of running) {
    const name = folderName(s.cwd)
    if (name && !names.includes(name)) names.push(name)
  }
  const since = running.map((s) => s.runSince).filter((n): n is number => !!n)
  return {
    running: running.length,
    total: live.length,
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
  /** show the link button under the presence at all */
  link: boolean
  /** what the button says; '' = `toolstash.xyz/paneforge` */
  linkLabel: string
  /** where it goes; '' = the PaneForge page */
  linkUrl: string
}

export const DEFAULT_DETAILS = '{running}/{total} {sessions} running'
export const DEFAULT_STATE = 'on {projects}'
export const DEFAULT_IDLE_DETAILS = '{total} {sessions} idle'
export const DEFAULT_LINK_LABEL = 'toolstash.xyz/paneforge'
export const DEFAULT_LINK_URL = 'https://toolstash.xyz/paneforge'

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

export const DEFAULT_DISCORD_STYLE: DiscordStyle = {
  details: '',
  state: '',
  idleDetails: '',
  projects: true,
  elapsed: true,
  whileIdle: true,
  link: true,
  linkLabel: '',
  linkUrl: ''
}

/**
 * The link under the presence, as Discord will accept it - or null.
 *
 * A URL cannot be put in `details` or `state`: Discord renders those as plain
 * text, markdown and all, so `[PaneForge](https://…)` shows up literally and a
 * bare link shows up unclickable. `buttons` is the only clickable surface a rich
 * presence has, and it is the one that carries a real href.
 *
 * Two things worth knowing before reading a profile and calling this broken:
 * Discord does not show a presence button to the account it belongs to - only
 * other people see it - and it drops the whole button if the URL is not http(s).
 */
export function buildButton(style: DiscordStyle): { label: string; url: string } | null {
  if (!style.link) return null
  // Trimmed BEFORE the fallback, not after: a field the user cleared can hold
  // spaces, and `'  ' || default` keeps the spaces - which then trims to nothing
  // and threw the button away instead of falling back like an empty field does.
  const url = style.linkUrl.trim() || DEFAULT_LINK_URL
  if (!/^https?:\/\//i.test(url) || url.length > URL_MAX) return null
  const label = (style.linkLabel.trim() || DEFAULT_LINK_LABEL).slice(0, LABEL_MAX)
  return { label, url }
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
  activity.assets = { large_image: PRESENCE_IMAGE, large_text: PRESENCE_IMAGE_TEXT }
  if (style.elapsed) {
    activity.timestamps = { start: running ? (c.oldestRunSince ?? c.appStart) : c.appStart }
  }
  const button = buildButton(style)
  if (button) activity.buttons = [button]
  return activity
}
