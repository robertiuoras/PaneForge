// Does a new pane still open on "do you trust the files in this folder?"
//
//   npm run test:trust
//
// src/main/claudeTrust.ts copies a folder's trust down from the nearest ancestor that
// already has it, so opening `<repo>/backend` in a repo you have worked in all week
// starts working instead of waiting on a prompt nobody is there to answer. The rules
// that matter are the ones it must NOT break: never overwrite a folder that has its own
// settings, and never invent trust for a folder with no trusted ancestor.
//
// It runs against a throwaway CLAUDE_CONFIG_DIR, never the real ~/.claude.json.

import { buildSync } from 'esbuild'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'pf-trust-'))
let failed = 0

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
  if (!ok) failed++
}

// The module is TypeScript and has no Electron imports, so one esbuild pass is enough
// to run it directly - no need to boot the app to test a pure function.
// esbuild's own API, not its CLI: the .bin entry is a shell script on macOS/Linux and a
// .cmd on Windows, each needing its own spawn dance. The API needs none of it.
const built = join(work, 'claudeTrust.mjs')
buildSync({
  entryPoints: [join(root, 'src', 'main', 'claudeTrust.ts')],
  format: 'esm',
  outfile: built
})

const cfgDir = join(work, 'claude')
mkdirSync(cfgDir, { recursive: true })
process.env.CLAUDE_CONFIG_DIR = cfgDir
const cfgFile = join(cfgDir, '.claude.json')

const repo = join(work, 'repo')
const sub = join(repo, 'backend')
const owned = join(repo, 'owned')
const stranger = join(work, 'stranger')
for (const d of [repo, sub, owned, stranger]) mkdirSync(d, { recursive: true })

function writeConfig(projects) {
  writeFileSync(cfgFile, JSON.stringify({ projects }, null, 2), 'utf8')
}
const read = () => JSON.parse(readFileSync(cfgFile, 'utf8'))

const { ensureTrusted } = await import(pathToFileURL(built).href)

// 1. A subfolder of a trusted repo inherits it.
writeConfig({
  [repo]: { hasTrustDialogAccepted: true, allowedTools: ['Bash(ls:*)'], history: ['secret'] }
})
ensureTrusted(sub)
const after = read().projects
check('subfolder inherits trust', after[sub]?.hasTrustDialogAccepted === true)
check('subfolder inherits allowedTools', JSON.stringify(after[sub]?.allowedTools) === '["Bash(ls:*)"]')
check('the ancestor\'s prompt history is not copied', after[sub]?.history === undefined)
check('both slash forms are written', Boolean(after[sub.replace(/\\/g, '/')]))

// 2. A folder that already has its own entry is never touched.
writeConfig({
  [repo]: { hasTrustDialogAccepted: true, allowedTools: ['Bash(ls:*)'] },
  [owned]: { hasTrustDialogAccepted: false, allowedTools: [] }
})
ensureTrusted(owned)
check('a folder with its own settings is left alone', read().projects[owned].hasTrustDialogAccepted === false)

// 3. No trusted ancestor means the prompt still happens - trust is never invented.
writeConfig({ [repo]: { hasTrustDialogAccepted: true } })
ensureTrusted(stranger)
check('an unrelated folder gets nothing', read().projects[stranger] === undefined)

// 4. An ancestor that was explicitly NOT trusted does not count as one.
writeConfig({ [repo]: { hasTrustDialogAccepted: false } })
ensureTrusted(sub)
check('an untrusted ancestor grants nothing', read().projects[sub] === undefined)

// 5. A broken config file must not stop a pane from starting.
writeFileSync(cfgFile, '{ not json', 'utf8')
let threw = false
try {
  ensureTrusted(sub)
} catch {
  threw = true
}
check('an unreadable config throws nothing', !threw)

rmSync(work, { recursive: true, force: true })
console.log(failed ? `\n${failed} failed` : '\nAll trust cases pass')
process.exit(failed ? 1 : 0)
