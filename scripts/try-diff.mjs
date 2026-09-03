// What this dev copy has that the INSTALLED app does not.
//
// Robert 2026-09-04: "whenever you open dev window please tell me what's different from the
// current dev release so that i can check". A dev window with no list of what to look at is a
// window nobody knows how to test - so `npm run try` prints the list itself rather than
// leaving it to whichever agent happened to open it.
//
// The reading is the INSTALLED build's version, never package.json's: the checkout is by
// definition ahead of what is installed, and comparing it to itself would always say
// "nothing". Installed version unreadable => newest tag, said out loud.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const git = (root, args) =>
  (spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout || '').trim()

// The version of the app a person actually double-clicks, on the machine this runs on.
export function installedVersion() {
  if (process.platform === 'darwin') {
    const plist = '/Applications/PaneForge.app/Contents/Info.plist'
    if (!existsSync(plist)) return null
    const r = spawnSync('defaults', ['read', plist, 'CFBundleShortVersionString'], { encoding: 'utf8' })
    return r.status === 0 ? (r.stdout || '').trim() || null : null
  }
  const exe = join(homedir(), 'AppData', 'Local', 'Programs', 'PaneForge', 'PaneForge.exe')
  if (!existsSync(exe)) return null
  const r = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', `(Get-Item '${exe}').VersionInfo.ProductVersion`],
    { encoding: 'utf8' }
  )
  return r.status === 0 ? (r.stdout || '').trim() || null : null
}

// A subject is written for the next person to READ, and the machine half after the last
// " - " is scaffolding for the commit log. Same trim the What's new card makes.
const words = (subject) => {
  const s = subject.replace(/^(feat|fix|perf|chore|docs|refactor|test)(\([^)]*\))?!?:\s*/i, '')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export function diffLines(root) {
  const installed = installedVersion()
  const tag = installed && git(root, ['tag', '-l', `v${installed}`]) ? `v${installed}` : null
  const base = tag ?? git(root, ['describe', '--tags', '--abbrev=0'])
  if (!base) return { base: null, installed, guessed: false, lines: [] }
  const log = git(root, ['log', '--no-merges', '--format=%s', `${base}..HEAD`])
  const lines = log
    ? log
        .split('\n')
        .filter((s) => /^(feat|fix|perf)(\([^)]*\))?!?:/i.test(s))
        .map(words)
    : []
  return { base, installed, guessed: !tag, lines }
}

export function report(root) {
  const { base, installed, guessed, lines } = diffLines(root)
  if (!base) return 'What is different from the installed app: no release tag here to compare against.'
  const against = installed && !guessed ? `installed ${installed}` : `${base} (installed version could not be read)`
  if (!lines.length) return `Nothing user-visible differs from ${against} - this build is that release plus housekeeping.`
  const head = `What is different from ${against}:`
  return [head, ...lines.map((l) => `  - ${l}`)].join('\n')
}
