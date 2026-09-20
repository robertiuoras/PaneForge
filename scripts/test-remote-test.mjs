import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const wrapper = fileURLToPath(new URL('./test-remote.mjs', import.meta.url))
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'))
env.PATH = '/nonexistent-paneforge-test-path'
const unavailable = spawnSync(process.execPath, [wrapper], { encoding: 'utf8', env })
assert.equal(unavailable.status, 3, unavailable.stderr)
assert.match(unavailable.stderr, /No local browser fallback/)
assert.doesNotMatch(unavailable.stdout, /PC suite snapshot/)

for (const arg of ['x&echo', 'x|echo', 'x"', 'x\n']) {
  const invalid = spawnSync(process.execPath, [wrapper, arg], { encoding: 'utf8', env })
  assert.equal(invalid.status, 2, invalid.stderr)
  assert.match(invalid.stderr, /Invalid remote test selector/)
}
if (process.platform !== 'win32') {
  const suite = spawnSync(process.execPath, [fileURLToPath(new URL('./test-all.mjs', import.meta.url))], { encoding: 'utf8', env })
  assert.equal(suite.status, 3, suite.stderr)
  assert.match(suite.stderr, /No local browser fallback/)
  assert.doesNotMatch(suite.stdout, /^ok\s/m)
}
console.log('Remote suite: unavailable transport fails closed; unsafe shell selectors rejected; non-Windows suite starts no local tests.')
