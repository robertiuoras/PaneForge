/**
 * The phone's half of the typing gate.
 *
 * Nothing here draws anything. The whole interaction is the platform's own sheet - Face ID
 * on an iPhone, Windows Hello on a desk - raised by `navigator.credentials`, so the UI for
 * this feature is one the user already trusts and we do not have to build, style or make
 * accessible. What this module owns is the round trip either side of that sheet.
 *
 * Decisions worth not re-litigating:
 *
 * - **It is driven by a 423, not by a check up front.** The transport asks for what it
 *   wanted, and only a refusal starts an unlock. That means the common case - inside the
 *   window, or a gate that is not armed at all - costs zero extra requests, and there is
 *   exactly one place that knows what "locked" looks like.
 * - **Enrolment and unlock are the same entry point.** A phone with no key yet needs to
 *   create one; a phone with a key needs to use it. Both are "prove a human is here", and
 *   asking the user to understand the difference would be asking them to understand
 *   WebAuthn. `state.ids` decides, silently.
 * - **One unlock in flight, shared.** A keystroke batch and an invoke can be refused within
 *   milliseconds of each other, and two overlapping `credentials.get()` calls on iOS cancel
 *   each other - the second sheet dismisses the first and both reject.
 */

const b64url = (b: ArrayBuffer): string => {
  const bytes = new Uint8Array(b)
  let s = ''
  for (const byte of bytes) s += String.fromCharCode(byte)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// Built over a freshly allocated ArrayBuffer rather than with `Uint8Array.from`, because
// WebAuthn's BufferSource will not accept a view whose buffer might be a SharedArrayBuffer
// - which is what the general Uint8Array type admits to being.
const unb64url = (s: string): Uint8Array<ArrayBuffer> => {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(pad + '='.repeat((4 - (pad.length % 4)) % 4))
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

/** Same reason as `unb64url`: a BufferSource that is provably not shared. */
const bytesOf = (text: string): Uint8Array<ArrayBuffer> => {
  const src = new TextEncoder().encode(text)
  const out = new Uint8Array(new ArrayBuffer(src.length))
  out.set(src)
  return out
}

interface GateState {
  armed: boolean
  unlocked: boolean
  rpId: string
  origin: string
  ids: string[]
  challenge: string
}

/** What the desk should call this authenticator in its list. Never sent as truth, only as a label. */
function labelForThisDevice(): string {
  const ua = navigator.userAgent
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/iPad/.test(ua)) return 'iPad'
  if (/Android/.test(ua)) return 'Android phone'
  if (/Macintosh/.test(ua)) return 'Mac'
  if (/Windows/.test(ua)) return 'Windows Hello'
  return 'passkey'
}

let inFlight: Promise<boolean> | null = null

/** Raise the platform's sheet and open an unlock window. False means it was refused or cancelled. */
export function unlock(): Promise<boolean> {
  if (!inFlight) {
    inFlight = run().finally(() => {
      inFlight = null
    })
  }
  return inFlight
}

async function run(): Promise<boolean> {
  // No WebAuthn at all means this browser could never satisfy the gate. The desk only arms
  // it over TLS, so reaching here without it is a browser too old to be worth a code path -
  // and returning false shows the caller's own "locked" message rather than a crash.
  if (!window.PublicKeyCredential || !navigator.credentials) return false
  const state = (await (await fetch('/pf/key/state')).json()) as GateState
  try {
    return state.ids.length ? await assert(state) : await enrol(state)
  } catch {
    // A cancelled sheet throws, and a cancellation is an answer, not an error: the user
    // decided not to type. The pane stays watchable and the next keystroke asks again.
    return false
  }
}

async function enrol(state: GateState): Promise<boolean> {
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: unb64url(state.challenge),
      rp: { id: state.rpId, name: 'PaneForge' },
      // The user handle is per-desk, not per-person: this desk has one owner by
      // construction, and a stable handle is what lets a second enrolment REPLACE the first
      // on the same authenticator instead of piling up rows.
      user: {
        id: bytesOf(state.rpId),
        name: 'this desk',
        displayName: 'this desk'
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 }
      ],
      authenticatorSelection: {
        // The authenticator built into the thing in your hand. A roaming key would work,
        // but asking for a security key on a phone is a sheet most people cancel.
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'preferred'
      },
      // We do not check attestation, so asking for it only adds a scarier consent screen.
      attestation: 'none',
      timeout: 60_000
    }
  })) as PublicKeyCredential | null
  if (!cred) return false
  const att = cred.response as AuthenticatorAttestationResponse
  return await post('/pf/key/enrol', {
    challenge: state.challenge,
    clientDataJSON: b64url(att.clientDataJSON),
    attestationObject: b64url(att.attestationObject),
    label: labelForThisDevice()
  })
}

async function assert(state: GateState): Promise<boolean> {
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: unb64url(state.challenge),
      rpId: state.rpId,
      allowCredentials: state.ids.map((id) => ({
        type: 'public-key' as const,
        id: unb64url(id)
      })),
      userVerification: 'required',
      timeout: 60_000
    }
  })) as PublicKeyCredential | null
  if (!cred) return false
  const asr = cred.response as AuthenticatorAssertionResponse
  return await post('/pf/key/unlock', {
    challenge: state.challenge,
    id: cred.id,
    clientDataJSON: b64url(asr.clientDataJSON),
    authenticatorData: b64url(asr.authenticatorData),
    signature: b64url(asr.signature)
  })
}

async function post(path: string, body: Record<string, string>): Promise<boolean> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  return res.ok
}
