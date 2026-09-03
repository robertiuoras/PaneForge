// The Chrome a remote pane may drive is the one on the desk that asked for the pane.
//
// Browser automation was the one reason a pane had to stay on the Mac: Chrome is here,
// the PC is in another country, and a CDP call to `127.0.0.1:9333` over there answers
// nothing. The capability is what needs to travel, not the work. The Mac exposes its CDP
// port on the tailnet (`tailscale serve --bg --tcp 9333 tcp://127.0.0.1:9333`, tailnet
// only, never the internet), and every pane started over the link is told where that is:
// `PF_CHROME_CDP=http://<desk that asked>:9333`. `cdp-bg-tab.mjs`, `chrome-automation.sh`
// and the chrome-devtools MCP wrapper in claude-config read it, and each one PROBES it
// before trusting it - a pane the PC started on the Mac is pointed at a PC with no Chrome,
// and must fall back to its own. `npm run test:peerchrome`.

/** The port Robert's automation Chrome answers on, on every machine (`chrome-automation.sh`). */
export const CDP_PORT = 9333

/**
 * The CDP address to hand a pane started for the peer at `address`, or nothing.
 *
 * `address` is what the remote host saw the asking desk connect from: a bare IPv4, an
 * IPv4-mapped IPv6 (`::ffff:100.89.94.66`), or an IPv6, with or without a port. Loopback
 * and an empty address say nothing - a pane the desk started for itself already has its
 * own Chrome on 127.0.0.1, and pointing it at itself by another name would only make the
 * readers probe twice.
 */
export function chromeCdpFor(address: string | undefined): string | undefined {
  let a = (address ?? '').trim()
  if (!a) return undefined
  a = a.replace(/^::ffff:/i, '')
  // `[fd7a::1]:1234` and `100.1.2.3:1234`: the port was the link's, not Chrome's.
  const m6 = a.match(/^\[([^\]]+)\](?::\d+)?$/)
  if (m6) a = m6[1]
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(a)) a = a.slice(0, a.lastIndexOf(':'))
  if (!a || a === '::1' || /^127\./.test(a) || a === 'localhost') return undefined
  const host = a.includes(':') ? `[${a}]` : a
  return `http://${host}:${CDP_PORT}`
}
