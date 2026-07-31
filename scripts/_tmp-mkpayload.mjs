import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { writeFileSync, readdirSync } from 'node:fs'
buildSync({ absWorkingDir: process.cwd(), entryPoints: ['src/main/split.ts'], bundle: true, format: 'cjs', platform: 'node', outfile: 'C:/Users/Gamer/AppData/Local/Temp/claude/C--Users-Gamer-Desktop-Projects-PaneForge/efc0b880-67bf-43fe-b348-3ec710dfc179/scratchpad/split.cjs' })
const { splitPayload } = createRequire(import.meta.url)('C:/Users/Gamer/AppData/Local/Temp/claude/C--Users-Gamer-Desktop-Projects-PaneForge/efc0b880-67bf-43fe-b348-3ec710dfc179/scratchpad/split.cjs')
const tree = readdirSync('.', { withFileTypes: true }).filter(d => !d.name.startsWith('.') && d.name !== 'node_modules').map(d => d.isDirectory() ? d.name + '/' : d.name)
const p = splitPayload('Add a preferences tab to Settings, add a JSON export of session history, and write a test suite for both.', tree)
writeFileSync('C:/Users/Gamer/AppData/Local/Temp/claude/C--Users-Gamer-Desktop-Projects-PaneForge/efc0b880-67bf-43fe-b348-3ec710dfc179/scratchpad/split-payload.txt', p)
console.log('payload chars:', p.length, '~tokens:', Math.round(p.length / 4))
