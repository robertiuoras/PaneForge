/**
 * The nine things a review of v0.8.187 found, pinned so none of them comes back.
 *
 * Most are SOURCE checks on purpose. Each fault is a wiring one - a broadcast that reaches
 * a surface it should not, a handler that runs beside another handler, a value read on
 * every render - and none of them shows up as a wrong answer from a pure function, which
 * is what the rest of the suite is good at. A file is read with readFileSync rather than
 * shelled out to, so this runs on the Windows PC as well.
 *
 *   node scripts/review-fixes-test.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')
let failed = 0
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`)
  if (!ok) failed++
}

// ---------------------------------------------------------------------------
// A phone's own submitted line must not come back to the phone that typed it: its renderer
// already ran the keystrokes through `feedInput`, so a broadcast drew a second rail tag and
// archived a second prompt row for every phone prompt.
const main = read('src/main/index.ts')
const typed = main.slice(main.indexOf("manager.on('typed'"), main.indexOf("manager.on('typed'") + 400)
check(!/(?<![.\w])send\('pane:typed'/.test(typed), "local `pane:typed` never goes through the broadcast")
check(/win!\.webContents\.send\('pane:typed'/.test(typed), 'it goes to the desk window only')
check(/origin/.test(typed), 'and it carries who typed it')

// The remote host's backend write is a person typing on a paired machine's mirror: this
// desk never saw the keystrokes, so it needs telling exactly as a phone's line does.
check(
  /write: \(id, data\) => manager\.write\(id, data, 'phone'\)/.test(main),
  'a line typed on a paired machine is not filed as this desk typing'
)

// ---------------------------------------------------------------------------
// Escape with the copy menu open must not also run App's Escape branch underneath.
const menu = read('src/renderer/src/components/CopyMenu.tsx')
check(
  /Escape[\s\S]{0,400}stopImmediatePropagation\(\)/.test(menu),
  'Escape in the copy menu stops the listeners beside it, not just the phases below'
)
check(!/e\.stopPropagation\(\)\s*$/m.test(menu.slice(menu.indexOf('const key ='), menu.indexOf('window.addEventListener'))),
  'no key branch is left on plain stopPropagation')

// ---------------------------------------------------------------------------
const pane = read('src/renderer/src/components/TerminalPane.tsx')

// A pending slash tag whose marker has been trimmed reports a stale line that never falls
// far enough behind the cursor, so it stayed pending and the scan ran on every frame for
// the life of the pane.
check(/m\.marker\.line < 0/.test(pane), 'a trimmed marker gives its slash tag up')
check(/SLASH_PENDING_MS/.test(pane), 'and so does one that has waited too long')

// A tag whose prompt has aged out of the rail can copy nothing: the menu must not open.
const tagMenu = pane.slice(pane.indexOf('if (!tagMenu) return null'), pane.indexOf('if (!tagMenu) return null') + 400)
check(/items\.length/.test(tagMenu), 'a stale tag opens no empty menu')

// A line the APP typed is not an ask: it must not arm the keeper a second time and must
// not be archived as a prompt somebody made. The tag stays.
check(/noteSubmitted = \(line: string, by: 'person' \| 'app'/.test(pane), 'the pane is told who typed a line')
check(/if \(person && mayClearScreen\(line\)\)/.test(pane), "an app-typed /clear does not arm the keeper twice")
check(/if \(person && text\.length > 1\)\s*\n?\s*api\.promptUsed/.test(pane), 'and is not archived as an ask')

// The nit.
check(!/HANDHELD_MAX/.test(pane), 'the unused import is gone')

// The drafted-message row is first, and it is the one Robert reaches for.
const choices = pane.slice(pane.indexOf('const copyChoices ='), pane.indexOf('const choicesRef'))
check(/add\('draft', 'The drafted message'/.test(choices), 'the copy menu offers the drafted message')
check(
  choices.indexOf("add('draft'") < choices.indexOf("add('reply'"),
  'and offers it before the whole reply'
)

// ---------------------------------------------------------------------------
// The copy menu's rows are read once, when it opens - not on every App render, each of
// which cleaned the whole last turn plus an eighty-row head.
const app = read('src/renderer/src/App.tsx')
check(
  /setCopyMenu\(\{ id: s\.id[^}]*items: rows \}\)/.test(app),
  'the copy menu holds its rows from the moment it opens'
)
check(
  !/const items = paneCopyMenu\.get\(copyMenu\.id\)\?\.\(\)/.test(app),
  'and does not read them again while it is open'
)

// ---------------------------------------------------------------------------
// The pet's record of what was working goes with the pet: left standing, switching it back
// on compares live panes against a reading from minutes ago and cheers for nothing.
const mascot = read('src/renderer/src/components/Mascot.tsx')
check(
  /if \(!cfg\.enabled \|\| !drawn\) \{[\s\S]{0,400}moodRef\.current = firstMood\(Date\.now\(\)\)/.test(mascot),
  'a pet nobody is drawing forgets what was working'
)

console.log(failed ? `review fixes: ${failed} FAILED` : 'review fixes: all checks passed')
process.exit(failed ? 1 : 0)
