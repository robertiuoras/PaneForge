// What installLaneHooks() may and may not do to a user's ~/.claude/settings.json.
//
// This is the riskiest file in the lane system, because it is the only one that writes to
// a file the app does not own. Every hook on the machine lives there - not just lanes -
// so a bad merge does not turn lanes off, it turns everything off. Hence: never stack a
// duplicate, never touch a registration somebody made by hand, never rewrite a file that
// failed to parse, and never leave a half-written one behind.
//
// laneHooks.ts imports electron, so it is bundled here against a stub rather than run
// inside the app: the merge is plain data work and deserves a test that takes 2 seconds.
//
// Run: node scripts/lane-hooks-test.mjs

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const work = mkdtempSync(join(tmpdir(), 'lane-hooks-'))
let failed = 0

function say(what, ok, detail = '') {
  if (ok) console.log(`ok    ${what}`)
  else {
    failed++
    console.error(`FAIL  ${what}${detail ? `\n      ${detail}` : ''}`)
  }
}

// The app's two facts this module reads. getAppPath() points at the checkout, so
// hookScript() resolves to the real scripts/lane-hook.mjs that ships beside the engine.
const stub = join(work, 'electron-stub.mjs')
writeFileSync(
  stub,
  `export const app = { isPackaged: false, getAppPath: () => ${JSON.stringify(REPO)} }\n`,
  'utf8'
)

const bundle = join(work, 'laneHooks.mjs')
// esbuild's bin/ entry is a JS shim only on Windows; on macOS it is the native binary,
// and `node <native binary>` is a SyntaxError. The library API is the same build on
// every platform, so use it directly.
const { buildSync } = await import('esbuild')
buildSync({
  entryPoints: [join(REPO, 'src', 'main', 'laneHooks.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  alias: { electron: stub },
  outfile: bundle
})

/** Run installLaneHooks() with a throwaway home, and hand back what it did and wrote. */
function run(home, settings) {
  mkdirSync(join(home, '.claude'), { recursive: true })
  const file = join(home, '.claude', 'settings.json')
  if (settings !== undefined) writeFileSync(file, typeof settings === 'string' ? settings : JSON.stringify(settings, null, 2), 'utf8')
  const r = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `import { installLaneHooks } from ${JSON.stringify(pathToFileURL(bundle).href)}\nconsole.log(installLaneHooks())`],
    { encoding: 'utf8', timeout: 30_000, env: { ...process.env, USERPROFILE: home, HOME: home } }
  )
  let json
  try {
    json = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    json = null
  }
  return { said: (r.stdout ?? '').trim(), err: r.stderr ?? '', settings: json, raw: existsSync(file) ? readFileSync(file, 'utf8') : '' }
}

/** Every lane-hook command in a settings object, flattened. */
const laneCommands = (s) =>
  Object.values(s?.hooks ?? {}).flatMap((groups) =>
    (groups ?? []).flatMap((g) => (g.hooks ?? []).map((h) => h.command).filter((c) => c?.includes('lane-hook.mjs')))
  )

// ---------------------------------------------------------------- fresh machine

const fresh = join(work, 'fresh')
const a = run(fresh, {})
say('a fresh machine gets the hooks installed', /installed ->/.test(a.said), a.said + a.err)
say('all four events are wired', laneCommands(a.settings).length === 4, JSON.stringify(laneCommands(a.settings)))
say(
  'each event gets its own arg',
  // Not endsWith: every command we write carries the --installed-by=paneforge marker
  // after the event, which is how an upgrade recognises its own entries.
  ['--event=prompt', '--event=pretool', '--event=end'].every((arg) => laneCommands(a.settings).some((c) => c.includes(arg))),
  JSON.stringify(laneCommands(a.settings))
)
say(
  'the edit guard carries its matcher',
  (a.settings.hooks.PreToolUse ?? []).some((g) => /Edit\|Write/.test(g.matcher ?? '')),
  JSON.stringify(a.settings.hooks.PreToolUse)
)

// ---------------------------------------------------------------- run twice

const b = run(fresh, undefined) // same home, whatever the first run left
say('running again changes nothing', /already installed/.test(b.said), b.said + b.err)
say('and does not stack a second copy', laneCommands(b.settings).length === 4, JSON.stringify(laneCommands(b.settings)))

// ---------------------------------------------------------------- app moved

const moved = join(work, 'moved')
run(moved, {})
const stale = JSON.parse(readFileSync(join(moved, '.claude', 'settings.json'), 'utf8'))
for (const groups of Object.values(stale.hooks))
  for (const g of groups) for (const h of g.hooks ?? []) if (h.command.includes('lane-hook.mjs')) h.command = h.command.replace(REPO.replace(/\\/g, '/'), 'C:/Old/Location')
const c = run(moved, stale)
say('an upgrade repoints the old entries', /installed ->/.test(c.said), c.said + c.err)
say('without leaving the old path behind', !laneCommands(c.settings).some((x) => x.includes('C:/Old/Location')), JSON.stringify(laneCommands(c.settings)))
say('and still exactly four', laneCommands(c.settings).length === 4, JSON.stringify(laneCommands(c.settings)))

// ---------------------------------------------------------------- hand-wired machine

const mine = join(work, 'handwired')
const d = run(mine, {
  hooks: {
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node "C:/Users/Someone/notes/paneforge-lane-hook.mjs" --event=prompt' }] }]
  }
})
say("someone else's wiring is left alone", /already wired elsewhere/.test(d.said), d.said + d.err)
say('and nothing of ours is added beside it', laneCommands(d.settings).length === 1, JSON.stringify(laneCommands(d.settings)))

// ---------------------------------------------------------------- other people's hooks

const shared = join(work, 'shared')
const e = run(shared, {
  model: 'opus',
  hooks: {
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node "C:/x/unrelated.mjs"' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'node "C:/x/stop.mjs"' }] }]
  }
})
say('unrelated hooks survive', /unrelated\.mjs/.test(e.raw) && /stop\.mjs/.test(e.raw), e.said)
say('unrelated settings survive', e.settings?.model === 'opus', e.raw.slice(0, 120))
say('and ours joins the existing group, not a new one', (e.settings.hooks.UserPromptSubmit ?? []).length === 1, JSON.stringify(e.settings.hooks.UserPromptSubmit))

// ---------------------------------------------------------------- broken settings

const broken = join(work, 'broken')
const f = run(broken, '{ this is not json')
say('an unparseable settings.json is refused, not rewritten', /not valid JSON/.test(f.said), f.said + f.err)
say('and is left byte-for-byte', f.raw === '{ this is not json', JSON.stringify(f.raw))

// ---------------------------------------------------------------- opt out

const off = join(work, 'optout')
mkdirSync(join(off, '.claude'), { recursive: true })
writeFileSync(join(off, '.claude', 'settings.json'), '{}', 'utf8')
const g = spawnSync(
  process.execPath,
  ['--input-type=module', '-e', `import { installLaneHooks } from ${JSON.stringify(pathToFileURL(bundle).href)}\nconsole.log(installLaneHooks())`],
  { encoding: 'utf8', timeout: 30_000, env: { ...process.env, USERPROFILE: off, HOME: off, PANEFORGE_NO_LANE_HOOKS: '1' } }
)
say('PANEFORGE_NO_LANE_HOOKS opts out', /skipped/.test(g.stdout ?? ''), (g.stdout ?? '') + (g.stderr ?? ''))
say('and writes nothing', readFileSync(join(off, '.claude', 'settings.json'), 'utf8') === '{}')

try {
  rmSync(work, { recursive: true, force: true })
} catch {
  /* disposable */
}

if (failed) {
  console.error(`\n${failed} case(s) failed`)
  process.exit(1)
}
console.log('\nlane hooks: all cases behaved')
