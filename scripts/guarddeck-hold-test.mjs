#!/usr/bin/env node
/**
 * `pf hold` — the command a session uses to stop GuardDeck quitting a build it is still
 * reviewing. Driven against a REAL guarddeck-holds module in a temp directory rather
 * than a stub, because the whole value of the command is the file it writes and a
 * hand-written fixture would prove nothing about that.
 *
 * The command must work with no app running (it is a local file), and must be a harmless
 * no-op on a machine with no GuardDeck at all — a hold can only ever spare something, so
 * failing to take one is never the dangerous direction.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed += 1
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${extra ? ` (${extra})` : ''}`)
}

const CTL = join(import.meta.dirname, 'pf-ctl.mjs')
const HOLDS = join(homedir(), 'Projects', 'claude-memory', 'claude-config', 'guarddeck-holds.mjs')
const DIR = mkdtempSync(join(tmpdir(), 'pf-hold-test-'))

const pf = (args, env = {}) =>
  execFileSync(process.execPath, [CTL, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GUARDDECK_HOLDS_DIR: DIR, ...env }
  })

console.log('1. a machine with no GuardDeck is a no-op, never an error')
const absent = pf(['hold'], { GUARDDECK_HOLDS_MODULE: join(DIR, 'not-here.mjs') })
check('says so and exits 0', /nothing needs holding/.test(absent))

if (!existsSync(HOLDS)) {
  console.log('  skip: no guarddeck-holds on this machine (PC), the rest is Mac-only')
  console.log(failed ? `\n${failed} FAILED` : '\nall passed')
  process.exit(failed ? 1 : 0)
}

console.log('2. the default target is the thing this always means: a local Electron build')
const out = pf(['hold', '--reason', 'reviewing a local build', '--ttl', '30'])
check('reports an id and a wall-clock expiry', /^held \S+ until /.test(out))
const files = readdirSync(DIR).filter((f) => f.endsWith('.json'))
check('wrote exactly one hold', files.length === 1, String(files.length))
const hold = JSON.parse(readFileSync(join(DIR, files[0]), 'utf8'))
check('aimed at the Electron dev shell', hold.bundleIDs.includes('com.github.Electron'))
check('carries the reason a human can read', hold.reason === 'reviewing a local build')
check('expires', hold.expiresAt - hold.createdAt === 30 * 60000)
check('is not tied to a pid unless asked', hold.ownerPid === null)

console.log('3. --this ties the hold to the session, so closing the pane releases it')
const tied = JSON.parse(
  readFileSync(
    join(
      DIR,
      (() => {
        const before = new Set(readdirSync(DIR))
        pf(['hold', '--name', 'Electron', '--this', '--reason', 'x'])
        return readdirSync(DIR).find((f) => !before.has(f))
      })()
    ),
    'utf8'
  )
)
check('records an owner pid', Number.isFinite(tied.ownerPid) && tied.ownerPid > 0)

console.log('4. list and release')
check('list shows both holds', pf(['hold', 'list']).trim().split('\n').length === 2)
pf(['hold', 'release', hold.id])
check('release removes the one named', !existsSync(join(DIR, `${hold.id}.json`)))
check('and leaves the other', readdirSync(DIR).filter((f) => f.endsWith('.json')).length === 1)

console.log(failed ? `\n${failed} FAILED` : '\nall passed')
process.exit(failed ? 1 : 0)
