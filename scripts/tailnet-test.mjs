// Is this address one Tailscale handed out - the yes/no the Devices dialog uses to decide
// whether to offer the "install Tailscale" line, and `src/shared/net.ts` reuses for the
// tailnet origin check.
//
//   node scripts/tailnet-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-tailnet-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const out = join(work, 'tailnet.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/tailnet.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: out
})
const { isTailnetAddress } = createRequire(import.meta.url)(out)

let checks = 0
const ok = (cond, what) => {
  assert.ok(cond, what)
  checks++
}

ok(isTailnetAddress('100.64.0.1') === true, '100.64.0.1 is a tailnet address')
ok(isTailnetAddress('100.127.255.255') === true, '100.127.255.255 is a tailnet address')
ok(isTailnetAddress('100.63.0.1') === false, '100.63.x is NAT64 territory, not Tailscale')
ok(isTailnetAddress('100.128.0.1') === false, '100.128.x is past the /10 block')
ok(isTailnetAddress('192.168.1.5') === false, '192.168.x is an ordinary LAN address')
ok(
  isTailnetAddress('fd7a:115c:a1e0::1') === true,
  "Tailscale's own IPv6 ULA prefix"
)
ok(isTailnetAddress('fd7a:115c:a1e0:1234::abcd') === true, 'any address inside the /48')
ok(isTailnetAddress('fc00::1') === false, 'a generic unique-local address is not Tailscale')
ok(isTailnetAddress('') === false, 'empty string')
ok(isTailnetAddress('not an address') === false, 'garbage input')

console.log(`tailnet: ${checks} checks passed`)
