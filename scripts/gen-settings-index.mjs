// Writes src/shared/settingsIndex.ts from the Settings dialog's own source.
// `npm run gen:settings`; `npm run test:settingsearch` fails when the two disagree.
import { readSettings, render } from './settings-index.mjs'
import { writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const out = resolve(dirname(fileURLToPath(import.meta.url)), '../src/shared/settingsIndex.ts')
const settings = readSettings()
writeFileSync(out, render(settings))
console.log(`settings index: ${settings.length} settings -> ${out}`)
