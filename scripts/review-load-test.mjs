#!/usr/bin/env node
// Opening Review must not wait for a full local transcript token recount. That scan can be
// several gigabytes on an established desk, while the prompt ledger itself is small and local.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
const handler = source.slice(source.indexOf("ipcMain.handle('review:daily'"), source.indexOf("ipcMain.handle('sessions:prompts'"))
const dialog = readFileSync(new URL('../src/renderer/src/components/ReviewDialog.tsx', import.meta.url), 'utf8')

assert.match(handler, /promptReview\(tokenSpend\(\), Date\.now\(\), history\.list\(\)\)/,
  'Review immediately uses the cached token total while its normal refresh runs in background')
assert.doesNotMatch(handler, /await tokenSpendFresh\(/,
  'Review never waits for a whole transcript scan before displaying local prompts')
assert.match(dialog, /window\.setInterval\(load, 60_000\)/,
  'an open Review automatically rereads the current day every minute')
assert.match(dialog, /mounted \|\| generation !== request/,
  'an older read cannot overwrite a newer response or update a closed dialog')
assert.match(dialog, /window\.clearInterval\(refresh\)/,
  'the automatic refresh is cleaned up when Review closes')
assert.match(dialog, /Token totals last counted.*refresh in the background/s,
  'Review labels the freshness of cached token totals')

console.log('review-load: local prompts do not wait for token recount')
