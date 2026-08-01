/**
 * Discord Rich Presence: the desk's headline numbers on the user's Discord profile,
 * refreshed as turns start and finish. Counts and project folder names only - never
 * a byte of what any pane says.
 *
 * The module owns its own lifecycle so the rest of the app can treat it as a sink:
 * Discord not running costs one failed pipe connect per retry interval and nothing
 * else, and every socket error is handled - an unhandled stream error takes the whole
 * main process down with it, which is the pipe tee's lesson applied here.
 *
 * Updates are throttled to one per THROTTLE_MS with the trailing state winning:
 * Discord drops presence updates past ~5 in 20 seconds, and a swarm launch is six
 * session events in a second that are worth one frame.
 */
import net from 'node:net'
import { join } from 'node:path'
import {
  DEFAULT_DISCORD_STYLE,
  FrameStream,
  OP_FRAME,
  OP_HANDSHAKE,
  buildActivity,
  encodeFrame,
  type DiscordStyle,
  type PresenceCounts
} from '../shared/discordRpc'

function defaultPipePaths(): string[] {
  const n = [...Array(10).keys()]
  if (process.platform === 'win32') return n.map((i) => `\\\\?\\pipe\\discord-ipc-${i}`)
  const base = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || '/tmp'
  return n.map((i) => join(base, `discord-ipc-${i}`))
}

export interface PresenceOptions {
  clientId: string
  enabled: boolean
  /** what the lines say and which parts show; omitted means the built-in wording */
  style?: DiscordStyle
  /** test seams - the real app never passes these */
  pipePaths?: string[]
  retryMs?: number
  throttleMs?: number
}

export class DiscordPresence {
  private clientId: string
  private enabled: boolean
  private style: DiscordStyle
  private readonly pipePaths?: string[]
  private readonly retryMs: number
  private readonly throttleMs: number

  private sock: net.Socket | null = null
  private ready = false
  private retryTimer: NodeJS.Timeout | null = null
  private sendTimer: NodeJS.Timeout | null = null
  private lastSentAt = 0
  private lastSentJson = ''
  private counts: PresenceCounts | null = null
  private disposed = false
  private nonce = 0

  constructor(opts: PresenceOptions) {
    this.clientId = opts.clientId
    this.enabled = opts.enabled
    this.style = opts.style ?? DEFAULT_DISCORD_STYLE
    this.pipePaths = opts.pipePaths
    this.retryMs = opts.retryMs ?? 60_000
    this.throttleMs = opts.throttleMs ?? 15_000
    if (this.enabled) this.connect()
  }

  /** Every Discord setting lands here: the switch, the client id, the wording. */
  configure(enabled: boolean, clientId: string, style?: DiscordStyle): void {
    const idChanged = clientId !== this.clientId
    this.clientId = clientId
    if (style) {
      // Rewording changes what the next frame says, not who is connected - dropping the
      // pipe for it would cost a reconnect per keystroke in the template field. The
      // last-sent memo has to go though, or an edit that lands on the same numbers is
      // read as "nothing changed" and never reaches the profile.
      if (JSON.stringify(style) !== JSON.stringify(this.style)) this.lastSentJson = ''
      this.style = style
    }
    if (!enabled || idChanged) this.teardown(enabled)
    this.enabled = enabled
    if (enabled && !this.sock && !this.retryTimer) this.connect()
  }

  /** Latest desk shape. Remembered even while disconnected, sent once ready. */
  update(counts: PresenceCounts): void {
    this.counts = counts
    this.scheduleSend()
  }

  /** before-quit: stop timers and drop the pipe. Discord clears presence on close. */
  dispose(): void {
    this.disposed = true
    this.teardown(false)
  }

  private connect(attempt = 0): void {
    if (this.disposed || !this.enabled) return
    const paths = this.pipePaths ?? defaultPipePaths()
    if (attempt >= paths.length) {
      this.scheduleRetry()
      return
    }
    const sock = net.connect(paths[attempt])
    let settled = false
    sock.once('error', () => {
      // This pipe is not Discord (or Discord is not running). Try the next one;
      // the socket for a path that never connected holds nothing worth keeping.
      sock.destroy()
      if (!settled) {
        settled = true
        this.connect(attempt + 1)
      }
    })
    sock.once('connect', () => {
      settled = true
      this.adopt(sock)
    })
  }

  private adopt(sock: net.Socket): void {
    this.sock = sock
    const frames = new FrameStream()
    sock.on('data', (chunk: Buffer) => {
      let parsed
      try {
        parsed = frames.push(chunk)
      } catch {
        // A frame that is not JSON means the far end is not speaking this protocol.
        this.teardown(true)
        return
      }
      for (const f of parsed) {
        if (f.op === OP_FRAME && f.payload.evt === 'READY') {
          this.ready = true
          this.lastSentJson = ''
          this.scheduleSend()
        }
      }
    })
    sock.on('error', () => this.teardown(true))
    sock.on('close', () => this.teardown(true))
    sock.write(encodeFrame(OP_HANDSHAKE, { v: 1, client_id: this.clientId }))
  }

  private teardown(retry: boolean): void {
    this.ready = false
    if (this.sock) {
      this.sock.removeAllListeners()
      // A late error on a dying socket must still land on a handler, not the process.
      this.sock.on('error', () => {})
      this.sock.destroy()
      this.sock = null
    }
    if (this.sendTimer) {
      clearTimeout(this.sendTimer)
      this.sendTimer = null
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    if (retry && !this.disposed) this.scheduleRetry()
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.disposed || !this.enabled) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.connect()
    }, this.retryMs)
    this.retryTimer.unref?.()
  }

  private scheduleSend(): void {
    if (!this.ready || !this.counts) return
    const wait = this.lastSentAt + this.throttleMs - Date.now()
    if (wait <= 0) {
      this.sendNow()
      return
    }
    if (this.sendTimer) return
    this.sendTimer = setTimeout(() => {
      this.sendTimer = null
      this.sendNow()
    }, wait)
    this.sendTimer.unref?.()
  }

  private sendNow(): void {
    if (!this.ready || !this.sock || !this.counts) return
    const activity = buildActivity(this.counts, this.style)
    const json = JSON.stringify(activity)
    // Renames and reorders fire the sessions event without changing the numbers;
    // an identical frame is rate-limit budget spent on nothing.
    if (json === this.lastSentJson) return
    const args: Record<string, unknown> = { pid: process.pid }
    if (activity) args.activity = activity
    this.sock.write(
      encodeFrame(OP_FRAME, { cmd: 'SET_ACTIVITY', nonce: String(++this.nonce), args })
    )
    this.lastSentJson = json
    this.lastSentAt = Date.now()
  }
}
