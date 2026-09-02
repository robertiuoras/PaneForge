// A paired machine can be one release behind, and the Devices panel says so on the
// connected row - "on 0.8.186, this one is 0.8.189" - only when both versions are known
// and differ. versionGap (src/shared/remoteVersion.ts) is the one place that decides it.
//
//   node scripts/remote-version-test.mjs

import { buildSync } from 'esbuild'
import { mkdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const root = join(realpathSync(tmpdir()), 'paneforge-remote-version-test')
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })

let failed = 0
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`)
  if (!cond) {
    failed++
    if (detail) console.log(`      ${detail}`)
  }
}
const is = (a, b, name) => ok(name, a === b, `got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`)

async function load(entry, name) {
  const out = join(root, `${name}.mjs`)
  buildSync({
    absWorkingDir: repoRoot,
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'node'
  })
  return import(pathToFileURL(out).href)
}

const remoteVersion = await load('src/shared/remoteVersion.ts', 'remoteVersion')

is(
  remoteVersion.versionGap('0.8.189', '0.8.189'),
  null,
  'same version on both ends says nothing'
)
is(
  remoteVersion.versionGap(undefined, '0.8.189'),
  null,
  'a version not known yet (not connected, or an older build with no field) says nothing'
)
is(
  remoteVersion.versionGap('0.8.186', '0.8.189'),
  'on 0.8.186, this one is 0.8.189',
  'a real gap names theirs first, ours second'
)
is(
  remoteVersion.versionGap('  0.8.189  ', '0.8.189'),
  null,
  'whitespace-padded equal versions still read as equal'
)

console.log(failed ? `\n${failed} remote-version check(s) failed` : '\nall remote-version checks passed')
process.exit(failed ? 1 : 0)
