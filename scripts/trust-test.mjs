// Does a new pane still open on "do you trust the files in this folder?"
//
//   npm run test:trust
//
// src/main/claudeTrust.ts copies a folder's trust down from the nearest ancestor that
// already has it, so opening `<repo>/backend` in a repo you have worked in all week
// starts working instead of waiting on a prompt nobody is there to answer. The rules
// that matter are the ones it must NOT break: never overwrite a folder's own settings
// (an untrusted entry only gains trust), and never invent trust for a folder with no
// trusted ancestor.
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

// 2. Claude Code writes its own default entry for a folder the first time it runs there,
// untrusted. That entry must not lock the folder out of its ancestor's trust (2026-09-27:
// every pane in research-lab-d stopped on the prompt): trust turns on, and the folder
// keeps the rest of its own settings.
writeConfig({
  [repo]: { hasTrustDialogAccepted: true, allowedTools: ['Bash(ls:*)'] },
  [owned]: { hasTrustDialogAccepted: false, allowedTools: [], enabledMcpServers: ['computer-use'] }
})
ensureTrusted(owned)
const ownedAfter = read().projects[owned]
check('an untrusted entry under a trusted ancestor becomes trusted', ownedAfter.hasTrustDialogAccepted === true)
check('and keeps its own allowedTools', JSON.stringify(ownedAfter.allowedTools) === '[]', JSON.stringify(ownedAfter))
check('and its own other settings', JSON.stringify(ownedAfter.enabledMcpServers) === '["computer-use"]', JSON.stringify(ownedAfter))

// 2b. A folder already trusted is never rewritten.
const ownTrusted = { hasTrustDialogAccepted: true, allowedTools: ['Bash(own:*)'], lastCost: 2 }
writeConfig({ [repo]: { hasTrustDialogAccepted: true, allowedTools: ['Bash(ls:*)'] }, [owned]: ownTrusted })
ensureTrusted(owned)
check('a folder already trusted is left exactly as it was', JSON.stringify(read().projects[owned]) === JSON.stringify(ownTrusted))

// 2c. An untrusted entry with no trusted ancestor stays untrusted.
writeConfig({ [repo]: { hasTrustDialogAccepted: false }, [owned]: { hasTrustDialogAccepted: false, allowedTools: [] } })
ensureTrusted(owned)
check('an untrusted entry with no trusted ancestor stays untrusted', read().projects[owned].hasTrustDialogAccepted === false)

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
