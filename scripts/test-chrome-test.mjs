// Pins that a window suite never launches full Chrome on Windows: its password manager's
// blank-password probe is a failed Windows sign-in per launch, and ten lock the PC's
// account and its ssh with it (see test-chrome.mjs).
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'test-chrome.mjs'), 'utf8')
const body = src.slice(src.indexOf('export function testChrome()'))
assert.ok(body.length > 30, 'testChrome() is where it was')
assert.ok(!/chrome\.exe/i.test(src), 'no chrome.exe fallback anywhere in test-chrome.mjs')
assert.match(body, /win32'\) return installHeadlessShell\(\)/, 'Windows fetches the headless shell instead')
console.log('test-chrome: 3 checks passed')
