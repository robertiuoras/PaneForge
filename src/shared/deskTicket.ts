/**
 * "Taskdriver says this is Robert's phone" - the pure half of signing the Taskdriver iPhone
 * app in to a desk without Tailscale on the phone and without a code (Robert, 3 Oct 2026:
 * "no more using codes ... is there no way to identify my iPhone").
 *
 * The app, already signed in to taskdriver.ai with Google, asks taskdriver.ai for a ticket
 * naming this desk; taskdriver.ai signs one only for its owner account, with a key both
 * sides derive from the ingest token this desk already holds (`main/limitWaves.ts`
 * `ingestToken()`). `main/phone.ts` (`/pf/native/v1/auth/taskdriver`) asks this file whether
 * a ticket is good; every rule below is a refusal.
 *
 * Wire contract v1 (the taskdriver.ai route and the app follow the same text):
 *   payload = base64url (no padding) of UTF-8 JSON {email, deviceId, aud, iat, exp, jti}
 *   root    = UTF-8 bytes of the lowercase hex SHA-256 of the ingest token
 *   key     = HMAC-SHA256(key = root, "paneforge-desk-ticket-v1")
 *   sig     = base64url (no padding) of HMAC-SHA256(key, "v1." + payload)
 *   ticket  = "v1." + payload + "." + sig
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

const CONTEXT = 'paneforge-desk-ticket-v1'
/** The contract's ceiling on exp - iat; taskdriver.ai issues 120 s. */
export const DESK_TICKET_MAX_LIFE_S = 300
/** How far ahead of this desk's clock a ticket's iat may be (clock drift between machines). */
const SKEW_S = 60
/** Live tickets remembered for replay at once; past this a new ticket is refused, never forgotten. */
const MAX_SEEN = 1024
const TICKET = /^v1\.([A-Za-z0-9_-]{1,2048})\.([A-Za-z0-9_-]{43})$/

/** The 32-byte signing key both sides derive from the ingest token. */
export function deskTicketKey(ingestToken: string): Buffer {
  const root = Buffer.from(createHash('sha256').update(ingestToken, 'utf8').digest('hex'), 'utf8')
  return createHmac('sha256', root).update(CONTEXT, 'utf8').digest()
}

function sign(payload: string, key: Buffer): string {
  return createHmac('sha256', key).update(`v1.${payload}`, 'utf8').digest('base64url')
}

/** A ticket for `payloadJson` exactly as given (key order kept) - what taskdriver.ai mints; tests use it. */
export function mintDeskTicket(payloadJson: string, ingestToken: string): string {
  const payload = Buffer.from(payloadJson, 'utf8').toString('base64url')
  return `v1.${payload}.${sign(payload, deskTicketKey(ingestToken))}`
}

/** A request's Host header as the ticket's `aud` names it: lowercase, no port. */
export function deskHost(hostHeader: string | string[] | undefined): string {
  const raw = String((Array.isArray(hostHeader) ? hostHeader[0] : hostHeader) ?? '').trim().toLowerCase()
  if (raw.startsWith('[')) return raw.slice(0, raw.indexOf(']') + 1 || undefined)
  return raw.split(':')[0]
}

export interface DeskTicketInput {
  ticket: string
  /** the device id the app sent beside the ticket */
  deviceId: string
  /** `deskHost(req.headers.host)` */
  host: string
  /** milliseconds, `Date.now()` */
  now: number
  ingestToken: string
  /** the desk owner's account email (this desk's Tailscale login) */
  owner: string
  /** jti -> exp in ms; read for replay, pruned, and written on success */
  seen: Map<string, number>
}

export type DeskTicketVerdict =
  | { ok: true; email: string; jti: string; exp: number }
  /** `reason` is words for the log, never the ticket or any part of it */
  | { ok: false; reason: string }

const int = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0

export function verifyDeskTicket(input: DeskTicketInput): DeskTicketVerdict {
  const no = (reason: string): DeskTicketVerdict => ({ ok: false, reason })
  if (!input.ingestToken) return no('this desk holds no Taskdriver token')
  if (!input.owner) return no('this desk\'s owner is unknown')
  const m = typeof input.ticket === 'string' ? TICKET.exec(input.ticket) : null
  if (!m) return no('not a v1 ticket')
  const [, payload, sig] = m
  const want = Buffer.from(sign(payload, deskTicketKey(input.ingestToken)), 'utf8')
  const got = Buffer.from(sig, 'utf8')
  if (got.length !== want.length || !timingSafeEqual(got, want)) return no('signature does not match this desk\'s Taskdriver key')

  let claims: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return no('ticket payload is not an object')
    claims = parsed as Record<string, unknown>
  } catch {
    return no('ticket payload is not JSON')
  }
  const { email, deviceId, aud, iat, exp, jti } = claims
  if (typeof email !== 'string' || typeof deviceId !== 'string' || typeof aud !== 'string' || !int(iat) || !int(exp) || typeof jti !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(jti)) {
    return no('ticket payload is missing a field')
  }
  const nowS = input.now / 1000
  if (nowS >= exp) return no('ticket expired')
  if (exp - iat > DESK_TICKET_MAX_LIFE_S) return no(`ticket lives longer than ${DESK_TICKET_MAX_LIFE_S} s`)
  if (iat > nowS + SKEW_S) return no('ticket issued in the future (clocks apart?)')
  if (!input.host || aud !== input.host) return no('ticket is for another desk')
  if (deviceId !== input.deviceId) return no('ticket is for another device')
  if (email.toLowerCase() !== input.owner.toLowerCase()) return no('ticket is for another account, not this desk\'s owner')

  for (const [id, until] of input.seen) if (until <= input.now) input.seen.delete(id)
  if (input.seen.has(jti)) return no('ticket already used')
  if (input.seen.size >= MAX_SEEN) return no('too many tickets in the last few minutes')
  input.seen.set(jti, exp * 1000)
  return { ok: true, email, jti, exp }
}
