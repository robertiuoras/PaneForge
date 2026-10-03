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

/** 32 random bytes, base64url, no padding - what taskdriver.ai issues. */
export const deskTicketShape = (t: unknown): t is string => typeof t === 'string' && /^[A-Za-z0-9_-]{43}$/.test(t)

export type Redeemed = { email: string } | { refused: string }

/**
 * Spend `ticket` at taskdriver.ai for this desk (`aud` = its own Tailscale DNS name) and this
 * app install. `{ email }` only on a 200 carrying one; every other outcome is `{ refused }`
 * with words for the log - never the ticket or the token. `PF_TASKDRIVER_REDEEM_URL` overrides
 * the address (tests), as `PF_TASKDRIVER_NOTIFY_URL` does for `postPush`.
 */
export async function redeemDeskTicket(
  input: { ticket: string; deviceId: string; aud: string; token: string },
  timeoutMs = REDEEM_TIMEOUT_MS
): Promise<Redeemed> {
  let res: Response
  try {
    res = await fetch(process.env.PF_TASKDRIVER_REDEEM_URL || REDEEM_URL, {
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
  try {
    const j = (await res.json()) as { email?: unknown } | null
    const email = j && typeof j === 'object' && typeof j.email === 'string' ? j.email : ''
    return email ? { email } : { refused: 'Taskdriver answered 200 without an email' }
  } catch {
    return { refused: 'Taskdriver answered 200 with something that is not JSON' }
  }
}

/** A-Z to a-z and nothing else: no locale, no Unicode folding (the Kelvin sign is not a k). */
const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32))

/** The redeemed email is this desk's owner: ASCII-lowercased both sides, strictly equal, never empty. */
export function sameOwner(email: string, owner: string): boolean {
  const a = asciiLower(email)
  return a !== '' && a === asciiLower(owner)
}
