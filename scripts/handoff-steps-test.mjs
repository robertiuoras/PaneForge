// What a pane's handoff says is still open.
//
// Two halves. The first is the reading itself, over real handoff shapes. The second is
// PARITY: `src/shared/handoffSteps.ts` is a mirror of the judgement in
// `claude-memory/claude-config/autoclear.mjs`, which decides the same thing from inside the
// session, and two copies of one algorithm split in silence. That half SKIPS OUT LOUD when
// the canonical file is not on this machine rather than passing on its absence.

import assert from 'node:assert'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, normalize } from 'node:path'
import { pathToFileURL } from 'node:url'

const { openNextSteps, actionableNextSteps, stepsWord } = await import(
  '../src/shared/handoffSteps.ts'
)
const { handoffCandidates } = await import('../src/shared/handoffSteps.ts')
const noSymlinks = () => false

let pass = 0
const t = (name, fn) => {
  fn()
  pass++
  console.log('ok -', name)
}

const withSteps = (body) => `# Handoff\n\n## State\n\nstuff\n\n## Next steps\n\n${body}\n`

// ---------------------------------------------------------------------------
// The parse.

t('a numbered list of real work is open work', () => {
  const md = withSteps('1. Run the suite and expect 128 green.\n2. Commit and push.')
  assert.deepStrictEqual(openNextSteps(md).length, 2)
  assert.deepStrictEqual(actionableNextSteps(md).length, 2)
})

t('bullets, checkboxes and bold all parse to the same body', () => {
  const md = withSteps('- [ ] **Ship it.** now\n* Rebuild the icon.')
  assert.deepStrictEqual(openNextSteps(md), ['Ship it. now', 'Rebuild the icon.'])
})

t('None is not a step - in any of the shapes the rules ask for', () => {
  for (const body of ['- None.', '1. None', '- Nothing to do.', '- n/a']) {
    assert.deepStrictEqual(openNextSteps(withSteps(body)), [], body)
  }
})

t('a PARAGRAPH saying None is not a step either', () => {
  // This is the exact shape that was cleared on 2026-08-30: the reporting rules say to
  // write `None` and a session wrote it as prose, not as a list item.
  const md = withSteps('None. Verified (128 tests), committed as b698adb, pushed to master.')
  assert.deepStrictEqual(openNextSteps(md), [])
  assert.deepStrictEqual(actionableNextSteps(md), [])
})

t('the section ends at the next heading', () => {
  const md = `## Next steps\n\n- Do the thing.\n\n## Notes\n\n- Not a step.\n`
  assert.deepStrictEqual(openNextSteps(md), ['Do the thing.'])
})

t('no Next steps section at all is no steps, never a crash', () => {
  assert.deepStrictEqual(openNextSteps('# Handoff\n\nsome prose'), [])
  assert.deepStrictEqual(openNextSteps(''), [])
  assert.deepStrictEqual(openNextSteps(undefined), [])
})

// ---------------------------------------------------------------------------
// The judgement. The weight is in the NEGATIVES: the expensive mistake is clearing a
// session for work nobody can start, which throws away a scrollback and continues nothing.

t('a step behind a trigger is not work a fresh session can start', () => {
  for (const body of [
    'Only after the release installs does the chip appear.',
    'Once CI is green, merge it.',
    'When Robert reports it again, re-measure.',
    'Waiting on the other machine.',
    'Monitor the log for another day.'
  ]) {
    assert.deepStrictEqual(actionableNextSteps(withSteps(`- ${body}`)), [], body)
    assert.deepStrictEqual(openNextSteps(withSteps(`- ${body}`)).length, 1, 'but it IS parsed')
  }
})

t('a step owned by a person is not work a fresh session can start', () => {
  for (const body of [
    'Cutting a build is Robert’s call.',
    'Your call whether to ship.',
    'Sign in to the vendor console first.',
    'Approve the purchase.'
  ]) {
    assert.deepStrictEqual(actionableNextSteps(withSteps(`- ${body}`)), [], body)
  }
})

t('a home path is NOT person-owned', () => {
  // `robert` unanchored on the right matched inside `robertiuoras`, which is in the home
  // directory of every absolute path on this machine - so every step naming a file read as
  // somebody else's. The alternative carries its own trailing \b for this.
  const md = withSteps('- Rebuild /Users/robertiuoras/Projects/PaneForge/scripts/probe.mjs.')
  assert.deepStrictEqual(actionableNextSteps(md).length, 1)
})

t('one blocked step among real ones leaves the real ones', () => {
  const md = withSteps('1. Run the suite.\n2. Only after that, cut the build.\n3. Push.')
  assert.deepStrictEqual(actionableNextSteps(md).length, 2)
})

// ---------------------------------------------------------------------------
// The words.

t('the chip says nothing for a pane with nothing open', () => {
  assert.strictEqual(stepsWord(0), null)
  assert.strictEqual(stepsWord(1), '1 step open')
  assert.strictEqual(stepsWord(3), '3 steps open')
})

// ---------------------------------------------------------------------------
// Finding the file. Newest wins, and the pane's own slot is asked for first.

t("a pane's own slot is the first candidate, and the unscoped name is still asked", () => {
  const list = handoffCandidates('/Users/x/Projects/App', 's6-abc', '/Users/x/.claude', noSymlinks)
  assert.ok(list[0].endsWith('session-handoff.pane-s6-abc.md'), list[0])
  assert.ok(list.some((p) => p.endsWith('memory/session-handoff.md')))
  assert.ok(list.every((p) => p.includes('-Users-x-Projects-App')))
})

t('a lane worktree also looks under the trunk project it belongs to', () => {
  const list = handoffCandidates('/Users/x/Projects/App-a', 's1-z', '/Users/x/.claude', noSymlinks)
  assert.ok(list.some((p) => p.includes('-Users-x-Projects-App/memory/session-handoff.App-a.md')))
  assert.ok(list.some((p) => p.includes('-Users-x-Projects-App/memory/session-handoff.md')))
})

t('a pane id that is not a plain name never becomes a path', () => {
  const list = handoffCandidates('/Users/x/Projects/App', '../../etc/passwd', '/Users/x/.claude', noSymlinks)
  assert.ok(!list.some((p) => p.includes('..')), list.join(' '))
})

// ---------------------------------------------------------------------------
// PARITY with the hook that decides the same thing from inside the session.

const canonical = join(
  homedir(),
  'Projects',
  'claude-memory',
  'claude-config',
  'autoclear.mjs'
)
if (!existsSync(canonical)) {
  console.log(`\nSKIP parity: ${canonical} is not on this machine`)
} else {
  const hook = await import(pathToFileURL(canonical).href)
  t('the mirror answers exactly what the hook answers', () => {
    const cases = [
      withSteps('1. Run the suite.\n2. Commit and push.'),
      withSteps('- None.'),
      withSteps('None. Verified and pushed.'),
      withSteps('- Only after the release installs.'),
      withSteps("- Cutting a build is Robert's call."),
      withSteps('- Rebuild /Users/robertiuoras/Projects/PaneForge/x.mjs.'),
      withSteps('1. Do a thing.\n2. Once CI is green, merge.'),
      '# Handoff\n\nno section at all'
    ]
    for (const md of cases) {
      assert.deepStrictEqual(openNextSteps(md), hook.openNextSteps(md), `open: ${md.slice(0, 40)}`)
      assert.deepStrictEqual(
        actionableNextSteps(md),
        hook.actionableNextSteps(md),
        `actionable: ${md.slice(0, 40)}`
      )
    }
  })
}

// ---------------------------------------------------------------------------
// The reading off disk: newest wins, and a pane with no handoff is not a pane with none open.

console.log(`\n${pass} cases passed`)

// A cached reading is only the file it read: the clear hook rewrites the handoff and asks
// for the clear inside the same second, and a 30s wall-clock cache refused a clear whose
// steps were already on disk (2026-09-04, s10-mtm6ccmk at 206k tokens, `NOTHING_OPEN`).
{
  const main = readFileSync(join(process.cwd(), 'src/main/handoffSteps.ts'), 'utf8')
  const served = /if \(hit && now - hit\.at < CACHE_MS\) \{[\s\S]*?top\.mtimeMs === hit\.reading\.mtimeMs/.test(main)
  assert.ok(served, 'handoffFor serves a cached reading only while the newest handoff on disk is the one it read')
  assert.ok(!/if \(hit && now - hit\.at < CACHE_MS\) return hit\.reading/.test(main), 'a wall-clock-only cache hit must not be served')
  console.log('ok   a rewritten handoff is read again inside the cache window')
}

// A cached reading is only the file it CHOSE, too: the hook writes a NEW pane-scoped
// handoff and asks for the clear inside the same second, while the idle sweep has kept a
// 30s reading of the older unscoped project handoff warm. Re-statting only that file finds
// it unchanged and the arm reads `open: 0` off it - `NOTHING_OPEN` for a pane whose own
// handoff had two steps on disk (2026-09-18, s15-mu6q4smz, 196k tokens, twice in one day).
{
  const { mkdtempSync, mkdirSync, writeFileSync, utimesSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const home = mkdtempSync(join(tmpdir(), 'pf-handoff-'))
  process.env.PF_CLAUDE_HOME = home
  const { buildSync } = await import('esbuild')
  const built = join(home, 'handoffSteps.mjs')
  buildSync({ absWorkingDir: process.cwd(), entryPoints: [join(process.cwd(), 'src/main/handoffSteps.ts')], bundle: true, platform: 'node', format: 'esm', logLevel: 'warning', outfile: built })
  const { handoffFor, clearHandoffCache } = await import(pathToFileURL(built).href)
  const { slugFor } = await import('../src/shared/handoffSteps.ts')
  const cwd = '/Users/x/Projects/proj'
  const dir = join(home, 'projects', slugFor(cwd), 'memory')
  mkdirSync(dir, { recursive: true })
  const at = (p, sec) => utimesSync(p, sec, sec)
  const unscoped = join(dir, 'session-handoff.md')
  writeFileSync(unscoped, '# Handoff\n\n## Next steps\n\nnone\n')
  at(unscoped, 1_000_000)
  const t0 = Date.now()
  clearHandoffCache()
  assert.strictEqual(handoffFor(cwd, 's15', t0).open, 0, 'the unscoped handoff reads as finished')
  const pane = join(dir, 'session-handoff.pane-s15.md')
  writeFileSync(pane, '# Handoff\n\n## Next steps\n\n1. Add the revenue check.\n2. Prove the digest writes.\n')
  at(pane, 1_000_100)
  const fresh = handoffFor(cwd, 's15', t0 + 1_000)
  assert.strictEqual(normalize(fresh.path), normalize(pane), 'a pane handoff created inside the cache window is the one read')
  assert.strictEqual(fresh.open, 2, 'and its open steps are counted')
  console.log('ok   a handoff CREATED inside the cache window is read, not the older one the cache chose')
  // The absent case is the same shape: a pane cached as "never wrote one" must see its first handoff.
  clearHandoffCache()
  assert.strictEqual(normalize(handoffFor(cwd, 's16', t0).path), normalize(unscoped))
  const pane16 = join(dir, 'session-handoff.pane-s16.md')
  writeFileSync(pane16, '# Handoff\n\n## Next steps\n\n1. One thing.\n')
  at(pane16, 1_000_200)
  assert.strictEqual(normalize(handoffFor(cwd, 's16', t0 + 1_000).path), normalize(pane16), 'a second pane sees its own first handoff at once')
  console.log('ok   a pane whose reading was cached sees its own first handoff at once')
}
