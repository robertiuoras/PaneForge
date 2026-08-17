// npm run test:winshortcut
//
// The Desktop shortcut is the only thing on this desk that opens PaneForge, so both halves
// of this decision are load-bearing and they fail in opposite directions: never recreating
// it reads as "the app uninstalled itself", and recreating it from a `npm run try` copy
// points the Desktop at a folder the next build deletes.
//
// The negatives are the half worth having. A passing "it makes the shortcut" tells you
// nothing about the three cases where it must not.

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-winshortcut-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const outfile = join(work, 'winshortcut.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/winShortcut.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile
})
const { desktopShortcutVerdict } = createRequire(import.meta.url)(outfile)

const INSTALLED = 'C:\\Users\\Gamer\\AppData\\Local\\Programs\\claude-orchestrator\\PaneForge.exe'
const facts = (over = {}) => ({
  platform: 'win32',
  packaged: true,
  exePath: INSTALLED,
  linkExists: false,
  wanted: true,
  ...over
})

// The case this exists for: an installed Windows copy whose Desktop link is gone.
const gone = desktopShortcutVerdict(facts())
assert.equal(gone.make, true, 'a missing link on an installed copy must be recreated')
assert.match(gone.reason, /missing/)

// Present is the ordinary launch, and it must not rewrite the file - a rewritten .lnk
// loses a pin, an icon override and any arguments somebody put on it (admin mode does
// exactly that, and re-pointing it every launch would undo admin mode silently).
assert.equal(desktopShortcutVerdict(facts({ linkExists: true })).make, false, 'an existing link is left alone')

// The three refusals.
assert.equal(desktopShortcutVerdict(facts({ platform: 'darwin' })).make, false, 'macOS has no Desktop .lnk')
assert.equal(desktopShortcutVerdict(facts({ wanted: false })).make, false, 'turned off means off')
assert.equal(desktopShortcutVerdict(facts({ packaged: false })).make, false, 'never from `electron .`')

// The one that would be found months later: a `npm run try` copy runs a packaged build out
// of `dist\win-unpacked`, which the NEXT build deletes. A Desktop shortcut pointing there
// is worse than no shortcut, because it looks fine until it is pressed.
const tryCopy = desktopShortcutVerdict(
  facts({ exePath: 'C:\\Users\\Gamer\\Desktop\\Projects\\PaneForge\\dist\\win-unpacked\\PaneForge.exe' })
)
assert.equal(tryCopy.make, false, 'a dist/ copy must never claim the Desktop shortcut')
assert.match(tryCopy.reason, /installed/)

// Case only: Windows paths are not case sensitive and `Programs` has been seen lowercased
// by tools that rebuild the path.
assert.equal(
  desktopShortcutVerdict(facts({ exePath: INSTALLED.toLowerCase() })).make,
  true,
  'the installed-path test must not be case sensitive'
)

console.log('winshortcut: ok')
