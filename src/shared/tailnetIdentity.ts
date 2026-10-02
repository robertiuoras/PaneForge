/**
 * "Is this Robert's phone, on Tailscale?" - the pure half. `main/tailnetIdentity.ts` asks
 * the tailscale CLI; `main/phone.ts` asks this file what the answers mean.
 *
 * A phone on the tailnet reaches the desk through `tailscale serve`, which terminates TLS
 * and re-issues the request to the phone server on loopback. Measured 2026-10-02 (PC serve,
 * Mac and public clients, forged headers on both paths):
 *
 * - `X-Forwarded-For` is OVERWRITTEN with the one address serve saw - the tailnet IP on the
 *   tailnet, the public IP over Funnel. A forged value never survives.
 * - `Tailscale-User-Login` is set on a tailnet request (forged value replaced) and absent
 *   over Funnel (forged value dropped).
 * - `Tailscale-Funnel-Request: ?1` is set by serve on every Funnel request; a forged one on
 *   the tailnet is stripped.
 * - `CF-Connecting-IP` passes straight through serve. It is the header `addressOf` prefers,
 *   which is why this file never reads it as an address - only as a refusal.
 *
 * So the address is serve's XFF and nothing else, and the DEVICE behind it is whatever
 * `tailscale whois` says owns that address. Every rule below is a refusal; a request that
 * fails any one of them is treated exactly as it was before this file existed.
 */

import { isTailnetAddress } from './tailnet'

/** The two things a request carries that this rule reads. */
export interface TrustInput {
  /** the socket's own peer address, already normalised (no `::ffff:` prefix) */
  socket: string
  headers: Record<string, string | string[] | undefined>
}

/** One node, as `tailscale whois --json` describes it. Ids are strings: they pass 2^53. */
export interface TailnetNode {
  stableId: string
  userId: string
  login: string
  os: string
  name: string
  tagged: boolean
}

export type TailnetSource = { ip: string; login: string } | { refused: string }

export interface TailnetVerdict {
  trusted: boolean
  /** words for the log, never a token or a header value beyond names and addresses */
  reason: string
  ip: string
  node?: TailnetNode
}

/** "Only my phone": the OS strings tailscale reports for a phone. iPadOS reports `iOS`. */
const PHONE_OS = new Set(['ios', 'android'])

function header(h: TrustInput['headers'], name: string): string {
  const v = h[name]
  return String((Array.isArray(v) ? v[0] : v) ?? '').trim()
}

function loopback(address: string): boolean {
  return address === '::1' || address === '127.0.0.1' || address.startsWith('127.')
}

/** Where serve says this request came from, or why nothing here may be believed. */
export function tailnetSource(input: TrustInput): TailnetSource {
  // Headers are believed from loopback only - the one hop we put there ourselves. A LAN
  // or tailnet caller hitting the port directly writes whatever headers it likes.
  if (!loopback(input.socket)) return { refused: 'did not come through Tailscale serve' }
  if (header(input.headers, 'tailscale-funnel-request')) {
    return { refused: 'came over Funnel (the public internet), not the tailnet' }
  }
  // cloudflared is the other loopback hop, and Cloudflare always sets these two. A request
  // with either one cannot be told apart from a forgery, so it is not trusted at all.
  if (header(input.headers, 'cf-connecting-ip') || header(input.headers, 'cf-ray')) {
    return { refused: 'came through the cloudflared tunnel' }
  }
  const login = header(input.headers, 'tailscale-user-login')
  if (!login) return { refused: 'Tailscale named no user (not a tailnet request)' }
  const xff = header(input.headers, 'x-forwarded-for')
  const hops = xff.split(',').map((s) => s.trim()).filter(Boolean)
  // serve writes exactly one address. Anything else was not written by serve.
  if (hops.length !== 1) return { refused: 'forwarded address is not the single one serve writes' }
  const ip = hops[0]
  if (!isTailnetAddress(ip)) return { refused: `forwarded address ${ip.slice(0, 45)} is not a tailnet address` }
  return { ip, login }
}

/**
 * JSON whose integer ids are quoted first. A tailnet's user and node ids are 16-17 digit
 * numbers; parsed as numbers two different ids can compare equal past 2^53, and this
 * comparison is the whole of "same person".
 */
function parseIds(text: string): unknown {
  return JSON.parse(text.replace(/"(User|UserID|ID)"\s*:\s*(-?\d+)/g, '"$1":"$2"'))
}

/** `tailscale whois --json <ip>`; null for anything that is not a node (`peer not found`). */
export function parseWhois(text: string): TailnetNode | null {
  let j: {
    Node?: { StableID?: string; User?: string; Tags?: string[]; Name?: string; ComputedName?: string; Hostinfo?: { OS?: string } }
    UserProfile?: { LoginName?: string }
  }
  try {
    j = parseIds(text) as typeof j
  } catch {
    return null
  }
  const n = j?.Node
  if (!n || !n.StableID || !n.User) return null
  return {
    stableId: String(n.StableID),
    userId: String(n.User),
    login: String(j.UserProfile?.LoginName ?? ''),
    os: String(n.Hostinfo?.OS ?? ''),
    name: String(n.ComputedName || String(n.Name ?? '').split('.')[0] || ''),
    tagged: Array.isArray(n.Tags) && n.Tags.length > 0
  }
}

/** This desk's own Tailscale user id out of `tailscale status --json`; '' when unreadable. */
export function parseSelfUser(text: string): string {
  try {
    const j = parseIds(text) as { BackendState?: string; Self?: { UserID?: string } }
    if (j?.BackendState && j.BackendState !== 'Running') return ''
    return String(j?.Self?.UserID ?? '')
  } catch {
    return ''
  }
}

/** The whole rule: serve's address, a node tailscale knows, the desk's own user, a phone. */
export function judgeTailnet(source: TailnetSource, node: TailnetNode | null, selfUser: string): TailnetVerdict {
  if ('refused' in source) return { trusted: false, reason: source.refused, ip: '' }
  const { ip } = source
  if (!node) return { trusted: false, reason: 'Tailscale does not know this address (or did not answer)', ip }
  const no = (reason: string): TailnetVerdict => ({ trusted: false, reason, ip, node })
  if (node.tagged) return no('a tagged device, not a person\'s')
  if (!selfUser) return no('this desk\'s own Tailscale user is unknown')
  if (node.userId !== selfUser) return no('another person\'s device')
  if (node.login.toLowerCase() !== source.login.toLowerCase()) return no('serve and whois name different users')
  if (!PHONE_OS.has(node.os.toLowerCase())) return no(`not a phone (${node.os || 'unknown OS'})`)
  return { trusted: true, reason: 'the same person\'s phone on Tailscale', ip, node }
}

/** One `phone-trust.log` row. Names and addresses only. */
export function trustLine(v: TailnetVerdict, what: string, at = new Date()): string {
  const who = v.node ? `${v.node.name || '?'} (${v.node.os || '?'})` : '-'
  return `${at.toISOString()} ${v.trusted ? 'ALLOWED' : 'REFUSED'} ${what} ip=${v.ip || '-'} node=${who} - ${v.reason}`
}
