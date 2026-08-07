/**
 * JSON for the phone link, with the two shapes `JSON.stringify` gets wrong.
 *
 * The surface it carries is the app's whole IPC surface, and two of those calls move
 * bytes rather than words: `soundData` answers a Uint8Array and `transcribe` is handed
 * one. Plain JSON turns a typed array into `{"0":12,"1":255,...}` - four times the size
 * and, on the way back, an object the caller then treats as an array and reads NaN out
 * of. So a typed array travels as base64 under a tag, and `undefined` inside an array
 * survives as itself instead of turning into null.
 *
 * Both ends import this file: the tag is the agreement, so it lives once.
 */

const B64 = '__pf_b64'
const UNDEF = '__pf_undefined'

type Tagged = { [B64]: string } | { [UNDEF]: true }

function isBytes(v: unknown): v is Uint8Array {
  return v instanceof Uint8Array
}

function toB64(bytes: Uint8Array): string {
  // btoa is the browser's; Buffer is Node's. The link has one end in each.
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64')
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function fromB64(text: string): Uint8Array {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(text, 'base64'))
  const raw = atob(text)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

function pack(value: unknown): unknown {
  if (value === undefined) return { [UNDEF]: true } satisfies Tagged
  if (isBytes(value)) return { [B64]: toB64(value) } satisfies Tagged
  if (Array.isArray(value)) return value.map(pack)
  if (value && typeof value === 'object') {
    if (value instanceof Date) return value.toISOString()
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue // an absent property stays absent, as in plain JSON
      out[k] = pack(v)
    }
    return out
  }
  return value
}

function unpack(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(unpack)
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>
    if (typeof rec[B64] === 'string') return fromB64(rec[B64] as string)
    if (rec[UNDEF] === true) return undefined
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(rec)) out[k] = unpack(v)
    return out
  }
  return value
}

export function encodeWire(value: unknown): string {
  return JSON.stringify(pack(value))
}

export function decodeWire(text: string): unknown {
  return unpack(JSON.parse(text))
}
