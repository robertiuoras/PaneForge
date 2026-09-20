import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

test('Windows package has a valid multi-image icon resource', () => {
  const icon = readFileSync(fileURLToPath(new URL('../src-tauri/icons/icon.ico', import.meta.url)))
  assert.deepEqual([...icon.subarray(0, 4)], [0, 0, 1, 0])
  assert.ok(icon.readUInt16LE(4) > 1)
})
