/**
 * Which side of the front door an address is on, and what kind of thing is at it.
 *
 * Shared rather than kept in `main/phone.ts` because the same two answers are needed in
 * two places that must agree: the server labels each live browser with the origin it came
 * from, and the panel labels each address it offers with the origin a browser would come
 * from if it used that one. Two copies of this would let the panel promise "anywhere" for
 * an address the server would then mark "this network".
 */

import type { PhonePeer } from './types'

export type Origin = PhonePeer['origin']

/**
 * Read off the address and nothing else. `X-Forwarded-For` is whatever the client felt
 * like sending, and there is no proxy in front of this by design.
 */
export function originOf(address: string): Origin {
  if (address === '127.0.0.1' || address === '::1' || address === '?') return 'this machine'
  const v4 = /^(\d{1,3})\.(\d{1,3})\./.exec(address)
  if (!v4) {
    // IPv6: fc00::/7 is unique-local and fe80::/10 link-local, both of them this network.
    const low = address.toLowerCase()
    return /^(f[cd]|fe[89ab])/.test(low) ? 'this network' : 'internet'
  }
  const a = Number(v4[1])
  const b = Number(v4[2])
  // 100.64/10 is carrier-grade NAT, which on a desk with Tailscale on it means the tailnet.
  if (a === 100 && b >= 64 && b <= 127) return 'tailnet'
  if (a === 127) return 'this machine'
  if (a === 10) return 'this network'
  if (a === 192 && b === 168) return 'this network'
  if (a === 172 && b >= 16 && b <= 31) return 'this network'
  if (a === 169 && b === 254) return 'this network'
  return 'internet'
}

/** The host out of an address a person could type. '' when there is not one in there. */
export function hostOf(url: string): string {
  const m = /^https?:\/\/([^/:]+)/.exec(url)
  return m ? m[1] : ''
}

/**
 * What an address is good for, in the words the panel prints beside it. Not the same
 * question as `originOf`: that one is about where a connection CAME from, this one is
 * about where a connection COULD come from, and the honest answer for a private address
 * is the narrow one - it is a promise somebody will act on from a train.
 */
export function reachWords(url: string): string {
  switch (originOf(hostOf(url))) {
    case 'tailnet':
      return 'works anywhere'
    case 'internet':
      return 'public address'
    case 'this machine':
      return 'this machine only'
    default:
      return 'this network only'
  }
}

/**
 * Coarse on purpose. A user-agent is a client-supplied string and parsing it finely is a
 * losing game; all this has to answer is "which of my things is that", and for a list of
 * one or two devices the make is enough. An unrecognised one says `Browser` rather than
 * guessing.
 */
export function deviceKind(ua: string): string {
  const s = ua.toLowerCase()
  if (s.includes('ipad')) return 'iPad'
  if (s.includes('iphone')) return 'iPhone'
  if (s.includes('android')) return s.includes('mobile') ? 'Android phone' : 'Android tablet'
  // An iPad in desktop mode says Macintosh; there is no honest way to tell them apart, so
  // both read Mac rather than one of them reading wrong.
  if (s.includes('macintosh') || s.includes('mac os')) return 'Mac'
  if (s.includes('windows')) return 'Windows'
  if (s.includes('linux')) return 'Linux'
  return 'Browser'
}
