// The Obsidian vault reader: a real fixture vault on disk, walked and turned into a
// graph, plus the refusal shapes (missing folder, not a folder, no notes).
//
//   node scripts/vault-test.mjs

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'pf-vault-test-'))

writeFileSync(
  join(work, 'electron-stub.cjs'),
  `module.exports={
    app:{getApplicationNameForProtocol:()=>'Obsidian'},
    shell:{openExternal:()=>Promise.resolve()}
  }`
)

buildSync({
  absWorkingDir: root,
  entryPoints: ['src/main/vault.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: join(work, 'vault.bundle.cjs'),
  alias: { electron: join(work, 'electron-stub.cjs') }
})

const v = createRequire(join(work, 'x.cjs'))('./vault.bundle.cjs')

const fail = []
let total = 0
const ok = (c, n, detail) => {
  total++
  console.log((c ? 'ok   ' : 'FAIL ') + n)
  if (!c) {
    if (detail !== undefined) console.log('     ', detail)
    fail.push(n)
  }
}

// --- a real fixture vault: three notes, real [[wikilinks]], one unresolved -----------
const vaultDir = join(work, 'vault')
mkdirSync(join(vaultDir, 'projects'), { recursive: true })
writeFileSync(
  join(vaultDir, 'Alpha.md'),
  '# Alpha\n\nSee [[Beta]] and [[projects/Gamma]]. Also #idea.\n'
)
writeFileSync(join(vaultDir, 'projects', 'Gamma.md'), '# Gamma\n\nLinked from [[Alpha]].\n')
writeFileSync(
  join(vaultDir, 'projects', 'Delta.md'),
  '# Delta\n\nMentions [[Not Written Yet]], a note nobody has created.\n'
)

const info = v.vaultInfo(vaultDir)
ok(info !== null, 'a real vault answers non-null')
ok(info.notes === 3, 'three .md files counted', info.notes)
ok(!info.error, 'no error on a real vault', info.error)
ok(info.appInstalled === true, 'the stubbed protocol handler reads as installed')

const graph = v.vaultGraph(vaultDir)
ok(graph.nodes.length === 5, '3 real notes + 2 unresolved links (Beta, Not Written Yet) all draw', graph.nodes.length)
const beta = graph.nodes.find((n) => n.title === 'Beta')
ok(Boolean(beta), 'the unresolved [[Beta]] link kept its own node', JSON.stringify(graph.nodes.map((n) => n.title)))
ok(beta?.degree === 1, 'the unresolved node still carries a degree from the link pointing at it', beta?.degree)
const notWritten = graph.nodes.find((n) => n.title === 'Not Written Yet')
ok(Boolean(notWritten), 'a link written before its note still draws as a node')
ok(graph.links.length === 4, 'four link pairs: Alpha->Beta, Alpha->Gamma, Gamma->Alpha, Delta->Not Written Yet', graph.links.length)
const alpha = graph.nodes.find((n) => n.title === 'Alpha')
ok(alpha?.degree === 3, 'Alpha is named from two notes and links out to two, degree 3', alpha?.degree)

// --- dedupe: the same path handed in twice is one node, not two ---------------------
const dupe = v.vaultInfo(vaultDir)
ok(dupe.notes === 3, 're-reading the same vault reports the same count, not doubled', dupe.notes)

// --- refusals SAY why, they do not read as an empty vault ---------------------------
const missing = v.vaultInfo(join(work, 'does-not-exist'))
ok(Boolean(missing?.error), 'a folder that does not exist carries an error', JSON.stringify(missing))

const notADir = join(work, 'plain-file.md')
writeFileSync(notADir, 'not a folder')
const fileAsVault = v.vaultInfo(notADir)
ok(Boolean(fileAsVault?.error), 'a path that is a file, not a folder, carries an error', JSON.stringify(fileAsVault))

const emptyDir = join(work, 'empty-vault')
mkdirSync(emptyDir, { recursive: true })
const empty = v.vaultInfo(emptyDir)
ok(Boolean(empty?.error), 'a folder with no .md files carries an error, never a silent empty graph', JSON.stringify(empty))
ok(empty.notes === 0, 'and reports zero notes', empty.notes)

// --- an empty/missing vaultPath answers null, not a thrown error --------------------
ok(v.vaultInfo('') === null, 'no vault configured answers null')
ok(v.vaultGraph('').nodes.length === 0, 'graph on an unset path is empty, not a crash')

v.stopVaultWatch()
rmSync(work, { recursive: true, force: true })
console.log(`\nvault: ${total - fail.length}/${total} checks passed`)
process.exit(fail.length ? 1 : 0)
