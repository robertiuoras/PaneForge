import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
const update = source.slice(source.indexOf("ipcMain.handle('agents:update'"), source.indexOf("ipcMain.handle('agents:uninstall'"))
assert.match(update, /execFile\(spec\.bin, \['--version'\]/, 'Codex is queried again after an exit-zero update')
assert.match(update, /const succeeded = code === 0 && found && !locked && \(spec\.id !== 'codex' \|\| \(Boolean\(fresh\) && fresh !== before\)\)/, 'stale Codex exits do not count as success')
assert.match(update, /if \(succeeded\) \{[\s\S]*?refreshPath\(\)[\s\S]*?invalidateAgents\(\)/, 'PATH and agent cache refresh only after success')
assert.match(update, /if \(succeeded && spec\.id === 'codex'\) codexInstalledVersion/, 'Codex verifies a fresh binary only after success')
assert.match(update, /ok: succeeded/, 'the event cannot mark a nonzero updater successful')
assert.match(update, /existing binary is still on PATH/, 'a failed update does not falsely say its binary vanished')
console.log('update completion: 6 checks passed')
