// Put the two copies side by side on the external monitor.
//
// Checking a change means the installed app and the test copy on screen at once, and
// Robert's answer to that is always the same: both on the second monitor, real app on the
// left half, `npm run try` copy on the right. Doing it by hand is two drags every time a
// build is checked, so `npm run try -- --show` does it.
//
//   node scripts/dev-layout.mjs            # place both, if there is a second screen
//   node scripts/dev-layout.mjs --dry      # say what it would do
//
// The installed copy decides whether this is a comparison layout. It must already be on an
// external display. A connected monitor alone must never split the laptop screen.
//
// Refuses rather than guesses:
//  - a copy that is not running is skipped, not waited for;
//  - no accessibility permission: says so and exits 0, since a layout is a nicety and the
//    build it was checking is still on screen.

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const dry = process.argv.includes('--dry')

/** Every screen, in Cocoa coordinates (origin bottom-left, y up). */
function screens() {
  const jxa = `ObjC.import("AppKit"); ObjC.import("CoreGraphics");
const s = $.NSScreen.screens
const out = []
for (let i = 0; i < s.count; i++) {
  const screen = s.objectAtIndex(i)
  const f = screen.frame
  const v = screen.visibleFrame
  const n = ObjC.unwrap(screen.deviceDescription.objectForKey('NSScreenNumber'))
  out.push({
    frame: { x: f.origin.x, y: f.origin.y, w: f.size.width, h: f.size.height },
    visible: { x: v.origin.x, y: v.origin.y, w: v.size.width, h: v.size.height },
    builtin: !!$.CGDisplayIsBuiltin(n)
  })
}
// System Events anchors its top-left coordinates to the primary entry, not whichever
// display currently has focus (mainScreen can be the external monitor).
JSON.stringify({ screens: out, primaryHeight: s.objectAtIndex(0).frame.size.height })`
  return JSON.parse(execFileSync('osascript', ['-l', 'JavaScript', '-e', jxa], { encoding: 'utf8' }))
}

/**
 * Find the external display holding an actual System Events window. Its full frame chooses
 * the display, while its visible frame is returned for placement. System Events is TOP-left,
 * y-down; Cocoa is bottom-left, y-up, so a screen sitting
 * above the laptop has a POSITIVE Cocoa y and a negative System Events y - which is why
 * this conversion is here rather than inline: reading the numbers back without it makes a
 * correct placement look like a bug.
 */
export function externalWorkArea(list, window) {
  if (!window) return null
  let winner = null
  let overlap = 0
  for (const screen of list) {
    const { frame } = screen
    const area = Math.max(0, Math.min(window.x + window.w, frame.x + frame.w) - Math.max(window.x, frame.x))
      * Math.max(0, Math.min(window.y + window.h, frame.y + frame.h) - Math.max(window.y, frame.y))
    if (area > overlap) {
      overlap = area
      winner = screen
    }
  }
  return winner && !winner.builtin ? winner.visible : null
}

/** Every process id running a PaneForge window, told apart by what launched it. */
function copies() {
  const ps = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n')
  const installed = []
  const test = []
  for (const line of ps) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/)
    if (!m) continue
    const [, pid, cmd] = m
    if (/--type=/.test(cmd)) continue // helper processes, not the app
    if (/\/Applications\/PaneForge\.app\/Contents\/MacOS\/PaneForge/.test(cmd)) installed.push(Number(pid))
    // The test copy is Electron run out of this checkout's node_modules.
    else if (/node_modules\/electron\/dist\/Electron\.app\/Contents\/MacOS\/Electron/.test(cmd)) test.push(Number(pid))
  }
  return { installed: installed[0], test: test[0] }
}

/** The visible window rect in System Events coordinates, matching `place`. */
function windowRect(pid) {
  const script = `tell application "System Events"
  set p to first process whose unix id is ${pid}
  tell p
    if (count of windows) is 0 then return ""
    set pos to position of window 1
    set sz to size of window 1
    return (item 1 of pos as text) & "," & (item 2 of pos as text) & "," & (item 1 of sz as text) & "," & (item 2 of sz as text)
  end tell
end tell`
  const parts = execFileSync('osascript', ['-e', script], { encoding: 'utf8' }).trim().split(',').map(Number)
  return parts.length === 4 && parts.every(Number.isFinite) ? { x: parts[0], y: parts[1], w: parts[2], h: parts[3] } : null
}

/** Move and size the front window of one process. Never raises it, never focuses it. */
function place(pid, rect) {
  const script = `tell application "System Events"
  set p to first process whose unix id is ${pid}
  tell p
    if (count of windows) is 0 then return "no window"
    set position of window 1 to {${Math.round(rect.x)}, ${Math.round(rect.y)}}
    set size of window 1 to {${Math.round(rect.w)}, ${Math.round(rect.h)}}
  end tell
end tell
return "ok"`
  return execFileSync('osascript', ['-e', script], { encoding: 'utf8' }).trim()
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.platform !== 'darwin') {
    console.log('dev-layout: macOS only; windows unchanged')
  } else {
  const { installed, test } = copies()
  let installedWindow = null
  try { installedWindow = installed ? windowRect(installed) : null } catch {}
  const { screens: cocoaScreens, primaryHeight } = screens()
  const list = cocoaScreens.map(({ frame, visible, builtin }) => ({
    frame: { ...frame, y: primaryHeight - (frame.y + frame.h) },
    visible: { ...visible, y: primaryHeight - (visible.y + visible.h) },
    builtin
  }))
  const screen = externalWorkArea(list, installedWindow)
  if (!screen) {
    console.log(`dev-layout: installed PaneForge is not on an external display; windows unchanged`)
  } else {
    const half = { w: Math.floor(screen.w / 2), h: screen.h, y: screen.y }
    const left = { x: screen.x, y: half.y, w: half.w, h: half.h }
    const right = { x: screen.x + half.w, y: half.y, w: screen.w - half.w, h: half.h }
    console.log(`dev-layout: external ${screen.w}x${screen.h} at ${screen.x},${screen.y}`)
    for (const [what, pid, rect] of [['PaneForge', installed, left], ['test copy', test, right]]) {
      if (!pid) {
        console.log(`  ${what}: not running, skipped`)
        continue
      }
      if (dry) {
        console.log(`  ${what} (pid ${pid}) -> ${rect.w}x${rect.h} at ${rect.x},${rect.y} (dry)`)
        continue
      }
      try {
        const said = place(pid, rect)
        console.log(`  ${what} (pid ${pid}) -> ${rect.w}x${rect.h} at ${rect.x},${rect.y} ${said}`)
      } catch (e) {
        console.log(`  ${what}: could not be placed (${String(e.message).split('\n')[0]})`)
      }
    }
  }
  }
}
