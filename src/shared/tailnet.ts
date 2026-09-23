/**
 * Is this address one Tailscale handed out.
 *
 * Tailscale addresses two machines can only reach each other through when they are on
 * different networks - the case an invite's plain LAN addresses cannot cover. Kept as its
 * own pure function because two places need the same yes/no: the Devices dialog (does THIS
 * machine have one, to decide whether to offer the "install Tailscale" line) and anywhere
 * that already hand-codes the 100.64/10 range (`src/shared/net.ts` `originOf`).
 *
 * IPv4: 100.64.0.0/10, the carrier-grade-NAT block Tailscale assigns from.
 * IPv6: fd7a:115c:a1e0::/48, Tailscale's own ULA prefix (distinct from a LAN's generic
 * fc00::/7 unique-local range, which `originOf` already treats as "this network").
 */
export function isTailnetAddress(address: string): boolean {
  const addr = String(address ?? '').trim()
  if (!addr) return false
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(addr)
  if (v4) {
    const a = Number(v4[1])
    const b = Number(v4[2])
    return a === 100 && b >= 64 && b <= 127
  }
  const low = addr.toLowerCase()
  return low.startsWith('fd7a:115c:a1e0:')
}
