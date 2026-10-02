// Whether a Codex pane opening in a folder Codex has never seen still opens on a question.
//
// The rules worth pinning are the REFUSALS: this appends to Codex's own config.toml, so a
// reading that says "write" when the file already answers duplicates a TOML table (Codex
// then refuses to start at all), and an "untrusted" the person chose must never be flipped.
// Header shapes are copied from real files: the Mac's and the PC's ~/.codex/config.toml,
// Codex 0.156.1, 2026-09-24.
//
//   node scripts/codex-trust-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-codex-trust-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

function load(entry, name) {
  const out = join(work, `${name}.cjs`)
  buildSync({ absWorkingDir: root, entryPoints: [entry], bundle: true, format: 'cjs', platform: 'node', outfile: out })
  return createRequire(import.meta.url)(out)
}

const { withCodexTrust, codexProjectKey } = load('src/shared/codexTrust.ts', 'shared')
const { trustCodexFolder } = load('src/main/codexTrust.ts', 'main')

let checks = 0
const is = (got, want, why) => {
  assert.deepEqual(got, want, `${why}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`)
  checks++
}

const MAC = `model = "gpt-6-astra"

[projects."/Users/robertiuoras/Projects/assistant"]
trust_level = "trusted"

[hooks.state."/Users/robertiuoras/.codex/hooks.json:pre_tool_use:0:0"]
trusted_hash = "sha256:abc"
`
const PC = `model = "gpt-6-astra"\r\n\r\n[projects.'c:\\users\\gamer\\desktop\\projects']\r\ntrust_level = "trusted"\r\n`

// --- a folder Codex has not seen is added, and nothing else in the file moves ----------
is(
  withCodexTrust(MAC, '/Users/robertiuoras/Projects/app', false),
  `${MAC.trimEnd()}\n\n[projects."/Users/robertiuoras/Projects/app"]\ntrust_level = "trusted"\n`,
  'Mac: double-quoted, case kept, appended after everything else'
)
is(
  withCodexTrust(PC, 'C:\\Users\\Gamer\\Desktop\\Projects\\app\\', true),
  `${PC.trimEnd()}\r\n\r\n[projects.'c:\\users\\gamer\\desktop\\projects\\app']\r\ntrust_level = "trusted"\r\n`,
  'PC: lowercased literal string, trailing slash dropped, CRLF kept'
)
is(
  withCodexTrust(null, '/Users/new/Projects/first', false),
  '[projects."/Users/new/Projects/first"]\ntrust_level = "trusted"\n',
  'no config.toml yet (new machine): a file holding just this folder'
)
is(withCodexTrust('', 'C:/Work', true), "[projects.'c:\\work']\ntrust_level = \"trusted\"\n", 'forward slashes on Windows are Codex backslashes')
is(
  withCodexTrust(null, "C:\\it's here", true),
  '[projects."c:\\\\it\'s here"]\ntrust_level = "trusted"\n',
  'a quote in a Windows path cannot go in a literal string: escaped basic string instead'
)
is(
  withCodexTrust(null, '/Users/me/say "hi"', false),
  '[projects."/Users/me/say \\"hi\\""]\ntrust_level = "trusted"\n',
  'a double quote in a Mac path is escaped'
)

// --- the refusals ----------------------------------------------------------------------
is(withCodexTrust(MAC, '/Users/robertiuoras/Projects/assistant', false), null, 'already listed: nothing written')
is(withCodexTrust(MAC, '/Users/robertiuoras/Projects/assistant/', false), null, 'already listed, trailing slash: nothing written')
is(withCodexTrust(PC, 'C:\\USERS\\Gamer\\Desktop\\Projects', true), null, 'Windows match ignores case, as Codex does')
const untrusted = `[projects."/Users/me/secret"]\ntrust_level = "untrusted"\n`
is(withCodexTrust(untrusted, '/Users/me/secret', false), null, "the person's own untrusted answer is never flipped")
is(withCodexTrust(untrusted, '/Users/me/secret/sub', false), null, 'nothing inside an untrusted folder is trusted')
is(
  typeof withCodexTrust(untrusted, '/Users/me/secretive', false),
  'string',
  'a sibling that only shares a prefix is not inside it'
)
is(withCodexTrust('projects = { "/a" = { trust_level = "trusted" } }\n', '/b', false), null, 'inline projects table: an appended table would collide')
is(withCodexTrust('[projects]\n"/a".trust_level = "trusted"\n', '/b', false), null, 'bare [projects] table: same')
is(withCodexTrust(MAC, 'relative/dir', false), null, 'a relative path matches nothing')
is(withCodexTrust(MAC, '/Users/me/two\nlines', false), null, 'a path with a newline is never written into TOML')
is(codexProjectKey('C:\\', true), 'c:\\', 'a drive root keeps its backslash')

// --- the disk half ----------------------------------------------------------------------
const home = join(work, 'codex-home')
const file = join(home, 'config.toml')
is(trustCodexFolder('/Users/new/Projects/first', file, false), true, 'missing folder and file: both created')
is(readFileSync(file, 'utf8'), '[projects."/Users/new/Projects/first"]\ntrust_level = "trusted"\n', 'and the file is the one table')
is(trustCodexFolder('/Users/new/Projects/first', file, false), false, 'second launch in the same folder writes nothing')
writeFileSync(file, MAC)
is(trustCodexFolder('/Users/robertiuoras/Projects/app', file, false), true, 'an existing file is appended to')
ok(readFileSync(file, 'utf8').startsWith(MAC.trimEnd()), 'with every byte before the new table kept')
ok(!existsSync(`${file}.pf-${process.pid}`), 'no temp file left behind')

function ok(v, why) {
  assert.ok(v, why)
  checks++
}

rmSync(work, { recursive: true, force: true })
console.log(`codex-trust: ${checks} checks passed`)
