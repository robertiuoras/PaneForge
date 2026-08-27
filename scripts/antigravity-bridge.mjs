#!/usr/bin/env node
// Put the PaneForge tee into Antigravity CLI's statusline hook, from a shell.
//
// The app does this at start (`main/autoclearWatch.ts` -> `ensureAntigravityBridge`), so
// this script exists for the two cases that are not app start: proving idempotency in
// `npm run test:autoclear` against a COPY in /tmp, and repairing a hook by hand without
// launching anything.
//
// The rules live in `src/main/antigravityBridge.ts` and are bundled from there rather than
// copied here. Two copies of one file-editing contract, in two languages, with nothing
// comparing them, is exactly how autoclear lost five clears in a day - see the header of
// scripts/autoclear-test.mjs.
//
//   node scripts/antigravity-bridge.mjs            # the real ~/.gemini/antigravity-cli
//   node scripts/antigravity-bridge.mjs <dir>      # a copy, for tests

import { buildSync } from 'esbuild'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let loaded = null

/** The compiled module, built once per process. */
async function impl() {
  if (loaded) return loaded
  const out = mkdtempSync(join(tmpdir(), 'pf-agy-bridge-'))
  const entry = join(out, 'entry.ts')
  writeFileSync(
    entry,
    `export * from ${JSON.stringify(join(root, 'src/main/antigravityBridge.ts').replace(/\\/g, '/'))}`,
    'utf8'
  )
  const file = join(out, 'bridge.mjs')
  buildSync({
    absWorkingDir: root,
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'warning',
    outfile: file
  })
  loaded = await import(pathToFileURL(file).href)
  return loaded
}

/**
 * Splice the tee in, idempotently. `dir` defaults to the real one.
 *
 * Returns `{ path, created, changed, backedUp, skipped }`. `changed: false` on the second
 * run over the same directory is the property this whole thing rests on - it runs at every
 * app start, on somebody else's prompt script.
 */
export async function ensure(dir) {
  const { ensureAntigravityBridge } = await impl()
  return dir ? ensureAntigravityBridge(dir) : ensureAntigravityBridge()
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const res = await ensure(process.argv[2])
  console.log(JSON.stringify(res, null, 2))
  process.exit(res.skipped ? 1 : 0)
}
