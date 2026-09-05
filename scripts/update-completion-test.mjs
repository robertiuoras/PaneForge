import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
const update = source.slice(source.indexOf("ipcMain.handle('agents:update'"), source.indexOf("ipcMain.handle('agents:uninstall'"))
assert.match(update, /execFile\(spec\.bin, \['--version'\]/, 'Codex is queried again after an exit-zero update')
assert.match(update, /const verified = spec\.id !== 'codex' \|\| \(Boolean\(fresh\) && Boolean\(latest\) && !isOutdated\(fresh, latest\)\)/, 'Codex must match its known latest version')
assert.match(update, /if \(completed\) \{[\s\S]*?refreshPath\(\)[\s\S]*?invalidateAgents\(\)/, 'PATH and agent cache refresh after a completed updater')
assert.match(update, /if \(completed && spec\.id === 'codex'\) codexInstalledVersion/, 'Codex refreshes after completion')
assert.match(update, /ok: verified/, 'the final event requires a current verified version')
assert.match(update, /existing binary is still on PATH/, 'a failed update does not falsely say its binary vanished')
assert.match(update, /version could not be verified/, 'a failed version query is explicit')
assert.match(update, /latest release is unknown/, 'unknown latest never reads as up to date')
console.log('update completion: 7 checks passed')
