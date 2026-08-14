/**
 * Reading what the Tailscale CLI says, with nothing that touches a process.
 *
 * The whole point of preferring Funnel over a cloudflared quick tunnel is that its
 * hostname is a FACT ABOUT THE MACHINE rather than a random four words handed out per
 * run: `<machine>.<tailnet>.ts.net` is the same string tomorrow, after a reboot, and
 * after the app updates itself. That is not a nicety - a phone's sign-in is a cookie,
 * a cookie belongs to an origin, and a new origin every launch means being approved on
 * the desk every launch. Which is exactly the complaint this file exists to end.
 *
 * Everything here is pure so `npm run test:funnel` can drive it with recorded output
 * rather than a tailnet.
 */

/** What `tailscale status --json` carries that we care about. */
interface StatusJson {
  Self?: { DNSName?: string; Online?: boolean }
  CertDomains?: string[]
  BackendState?: string
}

/**
 * The public hostname this machine would be funnelled on, or '' if it cannot be.
 *
 * Two things have to be true and they are separate: the node has a MagicDNS name, and
 * the tailnet has HTTPS certificates switched on (`CertDomains`). Without the second
 * one `tailscale funnel` refuses, and it refuses AFTER the spawn - so asking here is
 * the difference between falling straight through to cloudflared and a wasted minute.
 */
export function funnelHost(statusJson: string): string {
  let s: StatusJson
  try {
    s = JSON.parse(statusJson) as StatusJson
  } catch {
    return ''
  }
  if (s.BackendState && s.BackendState !== 'Running') return ''
  const name = (s.Self?.DNSName ?? '').replace(/\.$/, '').toLowerCase()
  if (!name.endsWith('.ts.net')) return ''
  // The cert domain list is what `funnel` will actually be able to serve on. A name with
  // no cert is a name that answers with a TLS error, which reads to a phone as "down".
  // An EMPTY list is the answer for a tailnet that has never turned HTTPS on, which is
  // exactly the tailnet Funnel refuses - so an absent list is treated as a no, not as
  // "probably fine". Being wrong in that direction costs nothing: the whole result of a
  // no here is that cloudflared is used instead.
  const certs = (s.CertDomains ?? []).map((d) => d.toLowerCase())
  if (!certs.includes(name)) return ''
  return name
}

/**
 * Is this refusal one where falling back to cloudflared is the right answer?
 *
 * Funnel is off by default on a tailnet: it needs `nodeAttrs: funnel` in the policy
 * file, and a tailnet that has never turned it on says so with a long message and a URL.
 * That is not an error to show a user who only asked for a way in - it is a reason to
 * use the other provider - so it is matched by name and reported as "unavailable".
 */
export function funnelDenied(text: string): boolean {
  const t = text.toLowerCase()
  return (
    t.includes('funnel') &&
    (t.includes('not available') ||
      t.includes('not enabled') ||
      t.includes('is not allowed') ||
      t.includes('requires') ||
      t.includes('permission') ||
      t.includes('denied') ||
      t.includes('node attribute'))
  )
}

/** `tailscale funnel status` prints the hostname it is serving; '' when nothing is. */
export function servingHost(statusText: string): string {
  const m = /https:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net)/i.exec(statusText)
  return m ? m[1].toLowerCase() : ''
}

/**
 * The arguments that put `port` on the internet, and the ones that take it off again.
 *
 * `--bg` on purpose: the foreground form holds the terminal open for as long as the
 * tunnel lives, and this app has no terminal to hold. The background form is a
 * configuration change tailscaled owns, which is also why `off` is a separate call and
 * why quitting has to make it - a funnel nobody turned off is a public address into a
 * machine with nothing listening behind it.
 */
export function funnelArgs(port: number): string[] {
  return ['funnel', '--bg', '--https=443', String(port)]
}

export function funnelOffArgs(): string[] {
  return ['funnel', '--https=443', 'off']
}
