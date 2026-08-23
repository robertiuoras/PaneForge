#!/usr/bin/env node
// Every method the app exposes must be REACHABLE from the window.
//
// `shared/surface.ts` is typed `{ [K in keyof Api]: SurfaceEntry }`, so a method
// with no channel does not compile and a channel with no method does not compile.
// What neither check can see is the third leg: a method that compiles, ships in
// both transports, is handled in main - and that nothing in the renderer ever
// calls. That is a feature with no way in.
//
// It has happened: `remote:handoffCancel` shipped in the surface, in the preload,
// in the phone client and in `main/handoffQueue.ts`, and the only way to reach it
// was `pf-ctl call`. Two panes sat under a `waiting` chip for 13 and 18 minutes
// with no button to press. Typecheck passed, `npm test` passed, surface parity
// passed - because every one of those asks whether the plumbing agrees with
// itself, and none of them asks whether a person can get at it.
//
// So: for every key of SURFACE, is there a call site under src/renderer/src?
// A key with none is either dead or deliberately not for the window, and the only
// honest way to tell them apart is to write the reason down. That is DESK_SIDE
// below - each entry names WHO calls it instead, so an entry that stops being
// true is a line somebody has to delete rather than a silence nobody notices.
//
// Deliberately static: no window, no build, no agent. It runs in `npm test`.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rendererDir = path.join(root, 'src', 'renderer', 'src')
const surfaceFile = path.join(root, 'src', 'shared', 'surface.ts')

/**
 * Methods with no renderer call site ON PURPOSE, each with the caller that makes
 * it real. Anything not on this list and not called from the window is a finding.
 */
const DESK_SIDE = {
  // The window batches every launch through `startSessions`; the singular is the
  // automation entry point (`pf-ctl call sessions:start`, the phone's launcher,
  // and every place main opens a pane for you).
  startSession: 'automation only - pf-ctl / main; the window uses startSessions',
  // A test asking whether the clipboard fixture is armed. No person needs it.
  clipboardFixtureActive: 'scripts/*-test.mjs only - it asks whether the fixture is armed',
  // Settings drives game mode by writing `config.gameMode.manual` through the
  // ordinary config path, so this is the scripted override.
  setGameManual: 'automation only - Settings writes config.gameMode.manual instead',
  // How a stuck queue is inspected from outside the window; the card reads
  // `Session.handingOff` for the chip, which is the same fact with no poll.
  handoffPending: 'inspection from a script - the chip reads Session.handingOff',
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p)
  }
  return out
}

/** The keys of SURFACE, in source order. */
export function surfaceKeys(src) {
  const start = src.indexOf('export const SURFACE')
  if (start < 0) throw new Error('surface.ts: no `export const SURFACE`')
  const body = src.slice(start)
  return [...body.matchAll(/^ {2}(\w+):\s*\[/gm)].map((m) => m[1])
}

/**
 * Is `key` called anywhere in `text`?
 *
 * `.key(` covers `api.key(...)` and `window.api.key(...)`, which is how all but a
 * handful are written. A destructured `const { key } = window.api` is matched by
 * the second form, which is why it is not enough to look for the dot alone.
 */
export function calls(text, key) {
  if (new RegExp(`\\.${key}\\s*\\(`).test(text)) return true
  if (new RegExp(`\\b${key}\\s*,?\\s*\\}\\s*=\\s*(window\\.)?api\\b`).test(text)) return true
  if (new RegExp(`\\{[^}]*\\b${key}\\b[^}]*\\}\\s*=\\s*(window\\.)?api\\b`).test(text)) return true
  return false
}

function main() {
  const src = fs.readFileSync(surfaceFile, 'utf8')
  const keys = surfaceKeys(src)
  // browserApi.ts IS a transport - it is built from SURFACE and answers a few
  // methods itself, so it can never be evidence that the window reaches one.
  const files = walk(rendererDir).filter((f) => !/browserApi\.ts$/.test(f))
  const text = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n')

  const unreached = keys.filter((k) => !calls(text, k))
  const findings = unreached.filter((k) => !(k in DESK_SIDE))
  const excused = unreached.filter((k) => k in DESK_SIDE)
  const stale = Object.keys(DESK_SIDE).filter((k) => !unreached.includes(k))

  console.log(`surface methods: ${keys.length}`)
  console.log(`reached from the window: ${keys.length - unreached.length}`)
  for (const k of excused) console.log(`  desk-side: ${k} - ${DESK_SIDE[k]}`)

  let bad = 0
  for (const k of findings) {
    console.log(`  UNREACHABLE: ${k} - nothing under src/renderer/src calls it`)
    bad++
  }
  for (const k of stale) {
    console.log(`  STALE EXCUSE: ${k} is reachable now - drop it from DESK_SIDE`)
    bad++
  }

  if (!keys.length) {
    console.log('FAIL: parsed zero surface methods')
    process.exit(1)
  }
  if (bad) {
    console.log(
      `\nsurface-reach: ${bad} unreachable. Either give it a control in the window, or add it to ` +
        `DESK_SIDE in this file naming who calls it instead.`,
    )
    process.exit(1)
  }
  console.log('surface-reach: every method has a way in')
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main()
}
