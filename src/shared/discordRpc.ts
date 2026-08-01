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

function capNames(names: string[]): string {
  let text = `on ${names.join(', ')}`
  let dropped = 0
  while (text.length > TEXT_MAX && names.length > 1) {
    names = names.slice(0, -1)
    dropped++
    text = `on ${names.join(', ')} +${dropped} more`
  }
  return text.length > TEXT_MAX ? text.slice(0, TEXT_MAX - 1) + '…' : text
}

/**
 * The presence itself. An empty desk returns null - a profile advertising
 * "0/0 sessions" all day is worse than no presence at all - and the caller sends
 * that as a clear.
 */
export function buildActivity(c: PresenceCounts): Record<string, unknown> | null {
  if (c.total <= 0) return null
  const noun = c.total === 1 ? 'session' : 'sessions'
  if (c.running > 0) {
    const activity: Record<string, unknown> = {
      details: `${c.running}/${c.total} ${noun} running`,
      timestamps: { start: c.oldestRunSince ?? c.appStart }
    }
    if (c.names.length) activity.state = capNames([...c.names])
    return activity
  }
  return {
    details: `${c.total} ${noun} idle`,
    timestamps: { start: c.appStart }
  }
}
