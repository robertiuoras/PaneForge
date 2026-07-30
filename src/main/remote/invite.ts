// One thing to copy, one thing to paste.
//
// Pairing used to be three fields typed by hand on the second machine: an address picked
// out of a list, a port, and an eight-character code read off the other screen. Every one
// of them is a chance to mistype, and the address is the one a person cannot check - a
// typo there fails as "that device did not answer in time", which reads like the network.
//
// An invite is those three fields plus the device's name, packed into a single line that
// survives a clipboard round trip: `PF1-<base64url json>`. Copy it on the device you are
// leaving, paste it on the one you are picking up, and there is nothing left to get wrong.
//
// The secret inside is exactly the secret that was on screen before - the pairing code IS
// the key the link is encrypted with - so this is no more exposed than reading it aloud.
// What it adds is an expiry: an invite is only good for INVITE_MINUTES, so a blob left in
// a clipboard manager, a note or a chat window stops being a way in. The code itself does
// not expire (that would cut every paired device off, which is what `New code` is for) -
// the invite does, and pairing is the only thing an invite is for.

/** How long a copied invite stays good for. Long enough to walk to the other desk. */
export const INVITE_MINUTES = 15

export interface Invite {
  /** what the device that issued it calls itself */
  name: string
  /** every address it answers on, best first - the joiner tries them in order */
  addresses: string[]
  port: number
  code: string
  /** epoch ms this stops being accepted */
  expires: number
}

const PREFIX = 'PF1-'

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function unb64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64')
}

/**
 * Pack an invite. `now` is a parameter so the test can pin an expiry rather than sleep.
 *
 * The keys are one letter each on purpose: this is read by a person only in the sense
 * that they have to select it, and a 400-character blob invites a partial selection.
 */
export function makeInvite(
  self: { name: string; addresses: string[]; port: number; code: string },
  now = Date.now()
): string {
  const body = {
    v: 1,
    n: self.name.slice(0, 40),
    a: self.addresses.slice(0, 6),
    p: self.port,
    c: self.code,
    e: now + INVITE_MINUTES * 60_000
  }
  return PREFIX + b64url(Buffer.from(JSON.stringify(body), 'utf8'))
}

export type InviteRead =
  | { kind: 'invite'; invite: Invite }
  /** Not an invite, but it does look like a pairing code typed by hand. */
  | { kind: 'code'; code: string }
  | { kind: 'expired'; name: string }
  | { kind: 'none' }

/**
 * Read whatever was pasted.
 *
 * Deliberately forgiving about everything except the payload: a blob that has been through
 * a chat window, an email or a terminal arrives with line breaks, zero-width characters and
 * sometimes a stray quote around it, and refusing that would send the person back to typing
 * the code - the thing this exists to remove. The `PF1-` prefix is optional for the same
 * reason: a selection that started one character late is still recoverable.
 *
 * A bare code still parses, as `kind: 'code'`, because the dialog has always accepted one
 * and an invite that has expired must leave a way through that is not "start again".
 */
export function readInvite(text: string, now = Date.now()): InviteRead {
  const raw = String(text ?? '')
    // Whitespace, the quotes a chat client wraps a pasted line in, and the zero-width and
    // direction marks that ride along with a selection made in a browser.
    .replace(/[\s"'`\u200B-\u200F\uFEFF]+/g, '')
    .trim()
  if (!raw) return { kind: 'none' }
  const at = raw.indexOf(PREFIX)
  const payload = at >= 0 ? raw.slice(at + PREFIX.length) : raw
  if (/^[A-Za-z0-9_-]{24,}$/.test(payload)) {
    try {
      const o = JSON.parse(unb64url(payload).toString('utf8')) as Record<string, unknown>
      const code = String(o.c ?? '')
      const addresses = Array.isArray(o.a) ? o.a.map(String).filter(Boolean) : []
      const port = Number(o.p ?? 0)
      const expires = Number(o.e ?? 0)
      const name = String(o.n ?? '').slice(0, 40)
      if (Number(o.v) === 1 && code && addresses.length && port > 0) {
        if (expires && expires < now) return { kind: 'expired', name }
        return { kind: 'invite', invite: { name, addresses, port, code, expires } }
      }
    } catch {
      /* not one of ours - fall through to the bare-code check below */
    }
  }
  // A pairing code is exactly what `newCode()` in wire.ts makes: eight characters from an
  // alphabet with every look-alike pair left out, split by a dash. Matching that shape
  // rather than "letters and digits, six or more" is what stops an ordinary sentence
  // pasted by mistake being reported back as a code that will not work.
  const CODE_ALPHABET = 'ACDEFGHJKMNPQRTUVWXY34679'
  const bare = raw.toUpperCase().replace(/-/g, '')
  if (bare.length === 8 && [...bare].every((ch) => CODE_ALPHABET.includes(ch)))
    return { kind: 'code', code: `${bare.slice(0, 4)}-${bare.slice(4)}` }
  return { kind: 'none' }
}
