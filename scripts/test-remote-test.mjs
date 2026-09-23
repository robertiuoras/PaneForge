import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const wrapper = fileURLToPath(new URL('./test-remote.mjs', import.meta.url))
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'))
env.PATH = '/nonexistent-paneforge-test-path'
const unavailable = spawnSync(process.execPath, [wrapper], { encoding: 'utf8', env })
assert.equal(unavailable.status, 3, unavailable.stderr)
assert.match(unavailable.stderr, /No local browser fallback/)
assert.match(unavailable.stderr, /PC transport:.*ENOENT/)
assert.doesNotMatch(unavailable.stdout, /PC suite snapshot/)

for (const arg of ['x&echo', 'x|echo', 'x"', 'x\n']) {
  const invalid = spawnSync(process.execPath, [wrapper, arg], { encoding: 'utf8', env })
  assert.equal(invalid.status, 2, invalid.stderr)
  assert.match(invalid.stderr, /Invalid remote test selector/)
}
if (process.platform !== 'win32') {
  const bin = mkdtempSync(join(tmpdir(), 'paneforge-ssh-diagnostic-'))
  try {
    const render = fileURLToPath(new URL('../next/scripts/remote-render.mjs', import.meta.url))
    for (const [script, message] of [
      ['#!/bin/sh\necho "Connection reset by peer" >&2\nexit 255\n', /PC transport: Connection reset by peer/],
      ['#!/bin/sh\necho WRONG-PC\n', /PC transport: Expected DESKTOP-CMSUCM1; received "WRONG-PC"/],
    ]) {
      writeFileSync(join(bin, 'ssh'), script, { mode: 0o700 })
      for (const argv of [[wrapper], [render, 'review']]) {
        const failed = spawnSync(process.execPath, argv, { encoding: 'utf8', env: { ...env, PATH: bin } })
        assert.equal(failed.status, 3, failed.stderr)
        assert.match(failed.stderr, message)
        assert.doesNotMatch(failed.stdout, /PC suite snapshot|Rendering on verified PC/)
      }
    }
  } finally {
    rmSync(bin, { recursive: true, force: true })
  }
  const suite = spawnSync(process.execPath, [fileURLToPath(new URL('./test-all.mjs', import.meta.url))], { encoding: 'utf8', env })
  assert.equal(suite.status, 3, suite.stderr)
  assert.match(suite.stderr, /No local browser fallback/)
  assert.doesNotMatch(suite.stdout, /^ok\s/m)
}
console.log('Remote suite: unavailable transport fails closed; unsafe shell selectors rejected; non-Windows suite starts no local tests.')
