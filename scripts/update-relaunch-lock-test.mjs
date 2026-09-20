// Exercise the startup race without opening PaneForge.
//
//   node scripts/update-relaunch-lock-test.mjs

import { strict as assert } from 'node:assert'
import { build } from 'esbuild'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const root = fileURLToPath(new URL('..', import.meta.url))
const indexSource = readFileSync(join(root, 'src/main/index.ts'), 'utf8')

function startupBlock(source) {
  const first = source.indexOf("if (!app.requestSingleInstanceLock(launchRequest))")
  const end = source.indexOf('\n/** The usable area', first)
  assert.ok(first >= 0 && end > first, 'could not locate the startup lock block')
  return source.slice(first, end)
}

function runStartup(block, ownsLock) {
  const calls = []
  const context = {
    app: {
      isPackaged: true,
      requestSingleInstanceLock: () => ownsLock,
      releaseSingleInstanceLock: () => calls.push('release'),
      quit: () => calls.push('quit'),
      on: () => calls.push('second-instance')
    },
    launchRequest: {},
    handOffToInstalled: () => {
      calls.push('handoff')
      return { verdict: 'go', installed: '/Applications/PaneForge.app' }
    },
    quitting: () => calls.push('quitting'),
    updateLog: () => calls.push('log'),
    process: { execPath: '/tmp/dist/mac-arm64/PaneForge.app/Contents/MacOS/PaneForge' },
    installStarted: false,
    focusWindow: () => calls.push('focus'),
    isOpenRequest: () => false,
    parseOpenArgs: () => ({}),
    openRequest: () => calls.push('open-request')
  }
  new vm.Script(`{\n${block}\n}`).runInNewContext(context)
  return calls
}

const current = startupBlock(indexSource)
assert.deepEqual(runStartup(current, false), ['quitting', 'quit'],
  'a lock loser must exit without handing control to the installed app')

// The pre-fix ordering is executed with the same stubs to pin the reproduced failure.
const legacy = `
const stray = app.isPackaged ? handOffToInstalled() : null
if (!app.requestSingleInstanceLock(launchRequest)) {
  quitting('another copy already holds the single-instance lock')
  app.quit()
} else if (stray && stray.verdict === 'go') {
  app.quit()
}`
assert.deepEqual(runStartup(legacy, false), ['handoff', 'quitting', 'quit'],
  'the old ordering handed off while it was the lock loser')

// Bundle the real disk-side function against fakes. This tests the normal Mac stray path
// without reading or spawning the actual installed app. Windows intentionally has no
// `installedCopy()` implementation, so running this assertion there can only prove the
// platform guard returned `no installed copy`.
if (process.platform !== 'darwin') {
  console.log('skip  packaged build-folder handoff is Mac-only')
  console.log('update relaunch lock: lock loser exits')
  process.exit(0)
}

const out = join(root, 'node_modules', '.pf-test')
mkdirSync(out, { recursive: true })
const outfile = join(out, 'stray-launch-order.mjs')
const stubs = {
  electron: 'export const app = globalThis.__pfApp',
  'node:child_process': 'export const spawn = (...args) => globalThis.__pfSpawn(...args)',
  'node:fs': 'export const existsSync = (...args) => globalThis.__pfExists(...args); export const readFileSync = (...args) => globalThis.__pfRead(...args)',
  './profile': 'export const headlessMode = () => globalThis.__pfHeadless(); export const profileName = () => globalThis.__pfProfile()'
}
await build({
  entryPoints: [join(root, 'src/main/strayLaunch.ts')], outfile, bundle: true, format: 'esm', platform: 'node',
  plugins: [{ name: 'test-stubs', setup(build) {
    build.onResolve({ filter: /^(electron|node:child_process|node:fs|\.\/profile)$/ }, args => ({ path: args.path, namespace: 'test-stub' }))
    build.onLoad({ filter: /.*/, namespace: 'test-stub' }, args => ({ contents: stubs[args.path], loader: 'js' }))
  }}]
})

const order = []
globalThis.__pfApp = { isPackaged: true, getVersion: () => '0.8.218', releaseSingleInstanceLock: () => order.push(['release']) }
globalThis.__pfExists = () => true
globalThis.__pfRead = () => '<key>CFBundleShortVersionString</key><string>0.8.217</string>'
globalThis.__pfHeadless = () => false
globalThis.__pfProfile = () => ''
globalThis.__pfSpawn = (...args) => {
  order.push(['spawn', ...args.slice(0, 2)])
  return { unref: () => order.push(['unref']) }
}
const execPath = Object.getOwnPropertyDescriptor(process, 'execPath')
Object.defineProperty(process, 'execPath', { configurable: true, value: '/tmp/dist/mac-arm64/PaneForge.app/Contents/MacOS/PaneForge' })
try {
  const { handOffToInstalled } = await import(`${pathToFileURL(outfile).href}?${Date.now()}`)
  const result = handOffToInstalled()
  assert.equal(result.verdict, 'go', 'fake build-folder process should hand off')
  assert.deepEqual(order.map(([event]) => event), ['release', 'spawn', 'unref'],
    'release must precede opening installed app')
} finally {
  Object.defineProperty(process, 'execPath', execPath)
  for (const key of ['__pfApp', '__pfExists', '__pfRead', '__pfHeadless', '__pfProfile', '__pfSpawn']) delete globalThis[key]
}

console.log('update relaunch lock: lock loser exits; normal stray releases then opens installed app')
