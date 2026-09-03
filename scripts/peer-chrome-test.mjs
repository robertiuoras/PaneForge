// A pane started over the link is told where the asking desk's Chrome is.
//
//   node scripts/peer-chrome-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-peer-chrome-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const out = join(work, 'peerChrome.bundle.cjs')
buildSync({ absWorkingDir: root, entryPoints: ['src/shared/peerChrome.ts'], bundle: true, format: 'cjs', platform: 'node', outfile: out })
const { chromeCdpFor, CDP_PORT } = createRequire(import.meta.url)(out)

let n = 0
const eq = (got, want, why) => { n++; assert.equal(got, want, why) }

eq(CDP_PORT, 9333, 'the port chrome-automation.sh launches on')
eq(chromeCdpFor('100.89.94.66'), 'http://100.89.94.66:9333', 'a tailnet address')
eq(chromeCdpFor('::ffff:100.89.94.66'), 'http://100.89.94.66:9333', 'an IPv4-mapped IPv6, as node reports it')
eq(chromeCdpFor('100.89.94.66:51234'), 'http://100.89.94.66:9333', "the link's port is not Chrome's")
eq(chromeCdpFor('fd7a:115c:a1e0::a63a:5e42'), 'http://[fd7a:115c:a1e0::a63a:5e42]:9333', 'an IPv6 is bracketed')
eq(chromeCdpFor('[fd7a:115c:a1e0::a63a:5e42]:51234'), 'http://[fd7a:115c:a1e0::a63a:5e42]:9333', 'bracketed with a port')
eq(chromeCdpFor('192.168.1.20'), 'http://192.168.1.20:9333', 'a LAN address')
eq(chromeCdpFor(undefined), undefined, 'a local start carries no address')
eq(chromeCdpFor(''), undefined, 'nor an empty one')
eq(chromeCdpFor('127.0.0.1'), undefined, 'loopback is this machine: the readers already look there')
eq(chromeCdpFor('::1'), undefined, 'IPv6 loopback too')
eq(chromeCdpFor('localhost'), undefined, 'by name too')

// SOURCE: the host stamps the address, the spawn reads it, nothing else invents one.
const host = readFileSync(join(root, 'src/main/remote/host.ts'), 'utf8')
n++; assert.ok(/case 'start':[\s\S]{0,400}fromAddress: conn\.address/.test(host), 'the remote host stamps the asking desk address onto a start')
const sessions = readFileSync(join(root, 'src/main/sessions.ts'), 'utf8')
n++; assert.ok(/PF_CHROME_CDP: chromeCdpFor\(req\.fromAddress\)/.test(sessions), 'the pane env carries PF_CHROME_CDP off the request')
n++; assert.equal((sessions.match(/PF_CHROME_CDP/g) ?? []).length, 1, 'one place sets it')

console.log(`peer-chrome-test: ${n} assertions OK`)
