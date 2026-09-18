// A build folder's leftover app hands the desk to the installed one, and the six times it
// must not.
//
//   node scripts/stray-launch-test.mjs

import { buildSync } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const OUT = join(ROOT, 'node_modules', '.pf-test')
mkdirSync(OUT, { recursive: true })
const outfile = join(OUT, 'stray-launch.mjs')
buildSync({
  entryPoints: [join(ROOT, 'src/shared/strayLaunch.ts')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node'
})
const { strayLaunch, inBuildFolder, compareVersions, plistVersion } = await import(pathToFileURL(outfile).href)

let failed = 0
const ok = (what, cond, extra = '') => {
  if (!cond) failed++
  console.log(`${cond ? 'ok   ' : 'FAIL '} ${what}${extra ? ` - ${extra}` : ''}`)
}

const DIST = '/Users/robertiuoras/Projects/PaneForge/dist/mac-arm64/PaneForge.app/Contents/MacOS/PaneForge'
const INSTALLED = { path: '/Applications/PaneForge.app', version: '0.8.217' }
const base = { execPath: DIST, version: '0.8.183', profile: '', headless: false, packaged: true, installed: INSTALLED }

// The morning it was written for.
ok('2026-09-18: 0.8.183 from dist/ with 0.8.217 installed goes', strayLaunch(base) === 'go')
ok('same version installed still goes (the build folder is never the driver)',
  strayLaunch({ ...base, version: '0.8.217' }) === 'go')
ok('a newer build under test is left alone',
  strayLaunch({ ...base, version: '0.8.218' }) === 'the installed copy is older')
ok('npm run try carries a profile and is left alone',
  strayLaunch({ ...base, profile: 'dev' }) === 'a named profile')
ok('a headless test copy is left alone',
  strayLaunch({ ...base, headless: true }) === 'headless')
ok('an unpackaged run is left alone',
  strayLaunch({ ...base, packaged: false }) === 'not packaged')
ok('the installed copy itself never hands off',
  strayLaunch({ ...base, execPath: '/Applications/PaneForge.app/Contents/MacOS/PaneForge' }) === 'not a build folder')
ok('no installed copy = this is the only PaneForge',
  strayLaunch({ ...base, installed: null }) === 'no installed copy')
ok('installed path equal to ours is refused before version',
  strayLaunch({ ...base, execPath: '/x/dist/mac-arm64/PaneForge.app/Contents/MacOS/PaneForge', installed: { path: '/x/dist/mac-arm64/PaneForge.app', version: '0.8.1' } }) === 'this is the installed copy')

// The path test knows electron-builder's folders, not every word `dist`.
ok('dist/mac-arm64 is a build folder', inBuildFolder(DIST))
ok('dist/win-unpacked is a build folder', inBuildFolder('C:\\Users\\Gamer\\Desktop\\Projects\\PaneForge\\dist\\win-unpacked\\PaneForge.exe'))
ok('dist/mac is a build folder', inBuildFolder('/a/dist/mac/PaneForge.app/Contents/MacOS/PaneForge'))
ok('a project called dist is not', !inBuildFolder('/Users/x/dist/PaneForge.app/Contents/MacOS/PaneForge'))
ok('the staged update folder is not', !inBuildFolder('/Users/x/Library/Application Support/claude-orchestrator/mac-update/0.8.217/PaneForge.app/Contents/MacOS/PaneForge'))
ok('/Applications is not', !inBuildFolder('/Applications/PaneForge.app/Contents/MacOS/PaneForge'))

ok('0.8.217 > 0.8.183', compareVersions('0.8.217', '0.8.183') > 0)
ok('0.8.9 < 0.8.10 (numeric, not lexical)', compareVersions('0.8.9', '0.8.10') < 0)
ok('v prefix stripped', compareVersions('v0.8.217', '0.8.217') === 0)
ok('1.0 > 0.8.999', compareVersions('1.0', '0.8.999') > 0)

ok('plist version read', plistVersion('<key>CFBundleShortVersionString</key>\n\t<string>0.8.217</string>') === '0.8.217')
ok('plist without it is empty', plistVersion('<key>CFBundleVersion</key><string>1</string>') === '')

console.log(failed ? `\n${failed} FAILED` : '\nall passed')
process.exit(failed ? 1 : 0)
