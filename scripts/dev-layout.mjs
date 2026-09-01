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
// With one screen it splits THAT screen instead. Half a laptop screen was refused here
// until 2026-09-01, on the argument that nobody wants a 720px-wide window; the answer to
// that turned out to be that a checked build is worth more than a wide window, and the
// alternative is two drags by hand every time. The split is of the VISIBLE frame, so the
// menu bar and the dock are left where they are.
//
// Refuses rather than guesses:
//  - a copy that is not running is skipped, not waited for;
//  - no accessibility permission: says so and exits 0, since a layout is a nicety and the
//    build it was checking is still on screen.

import { execFileSync } from 'node:child_process'

const dry = process.argv.includes('--dry')

/** Every screen, in Cocoa coordinates (origin bottom-left, y up). */
function screens() {
  const jxa = `ObjC.import("AppKit");
const s = $.NSScreen.screens
const main = $.NSScreen.mainScreen.frame
const vis = $.NSScreen.mainScreen.visibleFrame
const out = []
for (let i = 0; i < s.count; i++) {
  const f = s.objectAtIndex(i).frame
  out.push({ x: f.origin.x, y: f.origin.y, w: f.size.width, h: f.size.height })
}
JSON.stringify({
  screens: out,
  mainHeight: main.size.height,
  mainVisible: { x: vis.origin.x, y: vis.origin.y, w: vis.size.width, h: vis.size.height }
})`
  return JSON.parse(execFileSync('osascript', ['-l', 'JavaScript', '-e', jxa], { encoding: 'utf8' }))
}

/**
 * The external screen as System Events sees it: origin TOP-left, y growing downwards from
 * the top of the main screen. Cocoa's y grows upwards from its bottom, so a screen sitting
 * above the laptop has a POSITIVE Cocoa y and a negative System Events y - which is why
 * this conversion is here rather than inline: reading the numbers back without it makes a
 * correct placement look like a bug.
 */
function externalRect() {
  const { screens: list, mainHeight, mainVisible } = screens()
  // One screen: split the laptop's own visible frame. Same conversion as below - Cocoa's
  // y is the distance from the BOTTOM, System Events wants the distance from the top.
  if (list.length < 2)
    return {
      x: mainVisible.x,
      y: mainHeight - (mainVisible.y + mainVisible.h),
      w: mainVisible.w,
      h: mainVisible.h,
      only: true
    }
  const main = list.find((s) => s.x === 0 && s.y === 0) ?? list[0]
  const others = list.filter((s) => s !== main)
  // Widest, so a monitor beats a projector nobody is looking at.
  const pick = others.sort((a, b) => b.w * b.h - a.w * a.h)[0]
  return { x: pick.x, y: mainHeight - (pick.y + pick.h), w: pick.w, h: pick.h }
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

const screen = externalRect()

const half = { w: Math.floor(screen.w / 2), h: screen.h, y: screen.y }
const left = { x: screen.x, y: half.y, w: half.w, h: half.h }
const right = { x: screen.x + half.w, y: half.y, w: screen.w - half.w, h: half.h }
const { installed, test } = copies()

console.log(`dev-layout: ${screen.only ? 'this screen' : 'external'} ${screen.w}x${screen.h} at ${screen.x},${screen.y}`)
for (const [what, pid, rect] of [
  ['PaneForge', installed, left],
  ['test copy', test, right]
]) {
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
    // -1719 / "not allowed assistive access" is the only failure worth naming: it is fixed
    // in System Settings, not in this script.
    console.log(`  ${what}: could not be placed (${String(e.message).split('\n')[0]})`)
  }
}
