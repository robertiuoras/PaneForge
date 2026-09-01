// What the installed app is missing, in the words a person would use.
//
// Robert does not want to be asked whether to cut a dev release - the question is
// unanswerable without knowing what the answer would give him. He wants to be TOLD, once
// there is enough in it to be worth installing, what the copy on his machine does not do
// yet. So the suggestion stops being a judgement a session makes from memory and becomes
// a reading: the installed build's version, the commits master carries past it, and how
// many of those a person would notice.
//
//   node scripts/unreleased.mjs          # sentences, and an exit code
//   node scripts/unreleased.mjs --json
//
// Exit 0 = nothing worth installing. Exit 1 = enough to suggest a release. Nothing here
// CUTS one: a release is Robert's call and stays his.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, subjects, versionTags } from './release-notes.mjs'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * How many user-visible changes are worth an install.
 *
 * Three, not one: a single fix that Robert did not report is not worth quitting the app
 * he is working in, and one he DID report ships on its own under the atomic-fix rule
 * without consulting this. Three is the point where the sentence "here is what you are
 * missing" has a list in it rather than an item.
 */
export const ENOUGH = 3

/** Subjects a person would never read as a change to the app. */
const VISIBLE = new Set(['feat', 'fix', 'perf'])

/** The version of the PaneForge a person actually launches, or null. */
export function installedVersion() {
  if (process.platform === 'darwin') {
    const plist = '/Applications/PaneForge.app/Contents/Info.plist'
    if (!existsSync(plist)) return null
    try {
      return execFileSync('defaults', ['read', plist, 'CFBundleShortVersionString'], {
        encoding: 'utf8'
      }).trim()
    } catch {
      return null
    }
  }
  // Windows: electron-builder's per-user install, whose folder is the only place the
  // version is written down without reading the registry.
  const dir = join(
    process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'),
    'Programs',
    'PaneForge'
  )
  const asar = join(dir, 'resources', 'app-update.yml')
  if (!existsSync(asar)) return null
  try {
    const m = /version:\s*([0-9][^\s]*)/.exec(readFileSync(asar, 'utf8'))
    return m ? m[1] : null
  } catch {
    return null
  }
}

/**
 * What master carries that the installed build does not.
 *
 * `null` for `version` means nothing is installed here (a fresh checkout, a CI box), which
 * is not a reason to suggest anything - there is no copy to be behind.
 */
export function behind(version, at = repo) {
  if (!version) return { version: null, changes: [], other: 0, enough: false }
  const tag = versionTags(at).includes(`v${version}`) ? `v${version}` : null
  const range = tag ? `${tag}..HEAD` : 'HEAD'
  const seen = subjects(at, range)
  const changes = []
  let other = 0
  for (const s of seen) {
    const { type, text } = parse(s)
    if (type && VISIBLE.has(type)) changes.push(text)
    else other++
  }
  return { version, changes, other, enough: changes.length >= ENOUGH }
}

if (process.argv[1] && process.argv[1].endsWith('unreleased.mjs')) {
  const state = behind(installedVersion())
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(state, null, 2))
  } else if (!state.version) {
    console.log('No PaneForge installed here, so nothing is behind.')
  } else if (!state.changes.length) {
    console.log(`Installed ${state.version} has everything.`)
  } else {
    const head = state.enough
      ? `Worth a dev release - ${state.version} is missing ${state.changes.length} changes:`
      : `${state.version} is missing ${state.changes.length} - not enough to interrupt for:`
    console.log(head)
    for (const c of state.changes) console.log(`  - ${c}`)
    if (state.other) console.log(`  (and ${state.other} that change nothing a person sees)`)
  }
  process.exit(state.enough ? 1 : 0)
}
