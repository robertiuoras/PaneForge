// The browser a window suite drives. chrome-headless-shell comes first: it is a bare
// binary, not an app bundle, so macOS never hands it a link Robert clicks. A suite that
// started `/Applications/Google Chrome.app --headless` took those clicks into a window
// nobody could see (chat 7, 2026-09-23). System Chrome stays the fallback.
// Install: npx @puppeteer/browsers install chrome-headless-shell@stable --path ~/.cache/puppeteer
import { existsSync, readdirSync } from 'node:fs'
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

export function testChrome() {
  if (process.env.PF_TEST_CHROME) return process.env.PF_TEST_CHROME
  return (
    headlessShell() ??
    [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
    ].find((p) => existsSync(p))
  )
}
