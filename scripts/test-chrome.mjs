// The browser a window suite drives. chrome-headless-shell comes first: it is a bare
// binary, not an app bundle, so macOS never hands it a link Robert clicks. A suite that
// started `/Applications/Google Chrome.app --headless` took those clicks into a window
// nobody could see (chat 7, 2026-09-23). System Chrome stays the fallback.
// Install: npx @puppeteer/browsers install chrome-headless-shell@stable --path ~/.cache/puppeteer
//
// On Windows full Chrome is NEVER used. Its password manager calls LogonUser(Gamer, "")
// ~40s after start to ask whether the account password is blank; every call is a failed
// Windows sign-in, and 10 in 10 min locks the Gamer account, which takes the PC's ssh
// (and every rbuild, test run and release) down with it: sshd accepts the key, then the
// session resets (claude-memory assistant/pc-badlogon-chrome.md, 2026-09-23). A suite
// held open 58s is one bad sign-in per launch. The headless shell has no password manager.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const exeName = process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell'

function versionOf(folder) {
  // `<platform>-<version>`, e.g. `mac_arm-140.0.7339.82`
  return (folder.split('-').pop() ?? '').split('.').map(Number)
}

function newestFirst(a, b) {
  const va = versionOf(a)
  const vb = versionOf(b)
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const d = (vb[i] || 0) - (va[i] || 0)
    if (d) return d
  }
  return 0
}

function listDir(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

export function headlessShell() {
  const root = join(homedir(), '.cache', 'puppeteer', 'chrome-headless-shell')
  for (const build of listDir(root).sort(newestFirst)) {
    for (const inner of listDir(join(root, build))) {
      if (!inner.startsWith('chrome-headless-shell-')) continue
      const exe = join(root, build, inner, exeName)
      if (existsSync(exe)) return exe
    }
  }
  return undefined
}

const cacheRoot = () => join(homedir(), '.cache', 'puppeteer')

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Windows: fetch the headless shell once. Suites run side by side, so one takes a lock
 * folder and the rest wait for it rather than unpacking into the same place together.
 */
function installHeadlessShell() {
  mkdirSync(cacheRoot(), { recursive: true })
  const lock = join(cacheRoot(), '.pf-install-lock')
  try {
    mkdirSync(lock)
  } catch {
    let stale = false
    try {
      stale = Date.now() - statSync(lock).mtimeMs > 10 * 60_000
    } catch {
      /* gone - the other install finished */
    }
    if (stale) rmSync(lock, { recursive: true, force: true })
    for (let i = 0; i < 300 && existsSync(lock) && !stale; i++) sleepMs(1000)
    return headlessShell()
  }
  try {
    spawnSync(
      'npx',
      ['--yes', '@puppeteer/browsers', 'install', 'chrome-headless-shell@stable', '--path', cacheRoot()],
      { stdio: 'ignore', shell: true, windowsHide: true, timeout: 5 * 60_000 }
    )
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
  return headlessShell()
}

export function testChrome() {
  if (process.env.PF_TEST_CHROME) return process.env.PF_TEST_CHROME
  const shell = headlessShell()
  if (shell) return shell
  if (process.platform === 'win32') return installHeadlessShell()
  return [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'
  ].find((p) => existsSync(p))
}
