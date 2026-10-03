/**
 * "Taskdriver says this is Robert's phone" - signing the Taskdriver iPhone app in to a desk
 * with no Tailscale on the phone and no code (Robert, 3 Oct 2026: "no more using codes ... is
 * there no way to identify my iPhone"). Desk ticket contract v2.
 *
 * The app, signed in to taskdriver.ai with Google, gets a random single-use ticket for this
 * desk from taskdriver.ai (owner account only) and hands it to `/pf/native/v1/auth/taskdriver`
 * (`main/phone.ts`). The desk cannot check a ticket itself and does not try: it REDEEMS it at
 * taskdriver.ai, which marks it used in one statement and answers the owner's email. v1 let
 * the desk verify an HMAC keyed from the ingest token, and every agent on both desks can read
 * that token, so anything holding it could mint a ticket (Opus security review, 3 Oct 2026).
 * Now the token only authenticates the desk to taskdriver.ai; minting needs the owner's app.
 */

export const REDEEM_URL = 'https://app.taskdriver.ai/api/app/desk-ticket/redeem'
export const REDEEM_TIMEOUT_MS = 8000
/** taskdriver.ai answers `{"email":"..."}`; anything past this is not that answer. */
export const REDEEM_MAX_BYTES = 4096

/**
 * Where tickets are redeemed. `PF_TASKDRIVER_REDEEM_URL` is for tests on this machine: only a
 * loopback http address is taken, so an environment variable set by anything else cannot send
 * the ingest token to another server or over plain http (Opus review of v2, 3 Oct 2026).
 */
export function redeemUrl(): string {
  const override = process.env.PF_TASKDRIVER_REDEEM_URL ?? ''
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?\//.test(override) ? override : REDEEM_URL
}

/** 32 random bytes, base64url, no padding - what taskdriver.ai issues. */
export const deskTicketShape = (t: unknown): t is string => typeof t === 'string' && /^[A-Za-z0-9_-]{43}$/.test(t)

export type Redeemed = { email: string } | { refused: string }

/**
 * Spend `ticket` at taskdriver.ai for this desk (`aud` = its own Tailscale DNS name) and this
 * app install. `{ email }` only on a 200 carrying one; every other outcome is `{ refused }`
 * with words for the log - never the ticket or the token. Sent to `redeemUrl()`.
 */
export async function redeemDeskTicket(
  input: { ticket: string; deviceId: string; aud: string; token: string },
  timeoutMs = REDEEM_TIMEOUT_MS
): Promise<Redeemed> {
  let res: Response
  try {
    res = await fetch(redeemUrl(), {
      method: 'POST',
      // The header `postPush` (`main/limitWaves.ts`) sends to /api/app/admin/notify.
      headers: { Authorization: `Bearer ${input.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket: input.ticket, deviceId: input.deviceId, aud: input.aud }),
      signal: AbortSignal.timeout(timeoutMs),
      // The bearer token goes to this one address and nowhere a redirect points.
      redirect: 'error'
    })
  } catch (err) {
    const late = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
    return { refused: late ? `Taskdriver did not answer within ${timeoutMs / 1000} s` : 'Taskdriver could not be reached' }
  }
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => {})
    return { refused: `Taskdriver refused the ticket (HTTP ${res.status})` }
  }
  if (Number(res.headers.get('content-length') ?? 0) > REDEEM_MAX_BYTES) {
    await res.body?.cancel().catch(() => {})
    return { refused: 'Taskdriver answered with far more than an email' }
  }
  let text: string | null
  try {
    text = await readCapped(res, REDEEM_MAX_BYTES)
  } catch {
    return { refused: `Taskdriver did not finish answering within ${timeoutMs / 1000} s` }
  }
  if (text === null) return { refused: 'Taskdriver answered with far more than an email' }
  try {
    const j = JSON.parse(text) as { email?: unknown } | null
    const email = j && typeof j === 'object' && typeof j.email === 'string' ? j.email : ''
    return email ? { email } : { refused: 'Taskdriver answered 200 without an email' }
  } catch {
    return { refused: 'Taskdriver answered 200 with something that is not JSON' }
  }
}

/** The body as text, or null once it passes `max` bytes (a chunked answer has no length to check first). */
async function readCapped(res: Response, max: number): Promise<string | null> {
  const reader = res.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** A-Z to a-z and nothing else: no locale, no Unicode folding (the Kelvin sign is not a k). */
const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32))

/** The redeemed email is this desk's owner: ASCII-lowercased both sides, strictly equal, never empty. */
export function sameOwner(email: string, owner: string): boolean {
  const a = asciiLower(email)
  return a !== '' && a === asciiLower(owner)
}
