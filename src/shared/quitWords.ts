// When nothing in the app asked to quit, which of the three it was.
//
// `main/index.ts` names every quit the app decides for itself. What was left was one
// sentence for everything else - "Cmd-Q, the app menu, or a signal from the OS" - and on
// 2026-08-21 that sentence was read for real, after nine panes closed with no cause, and
// it separated none of them. A signal cannot be caught (Chromium takes SIGTERM below the
// JS layer, so `process.on('SIGTERM')` never runs - measured), but the three are told
// apart by WHERE THE SCREEN WAS: a Cmd-Q or an app-menu Quit can only be typed at a
// frontmost window, while a `pkill`, an `osascript ... quit`, a launchd job or a logout
// all arrive while somebody is looking at something else.
//
// It is evidence, never a verdict. The useful half is the negative - "this did not come
// from this keyboard" - so the wording says that and never names a culprit.

/**
 * Generous on purpose: on some macOS versions Cmd-Q blurs the window a beat before
 * `before-quit` runs, and calling a real Cmd-Q an outside kill is the worse of the two
 * mistakes - it would send the next person hunting a script that does not exist.
 */
export const FROM_KEYBOARD_MS = 4000

const KEYBOARD = 'a window of ours had focus, so this reads as Cmd-Q or the app menu'

export function quitWhere(focused: boolean, lastFocusAt: number, now: number): string {
  if (focused) return KEYBOARD
  if (!lastFocusAt) return 'no window of ours has ever had focus this run'
  const since = now - lastFocusAt
  if (since < FROM_KEYBOARD_MS) return KEYBOARD
  return (
    `no window of ours has had focus for ${Math.round(since / 1000)}s, so this did NOT come from ` +
    'this keyboard - something asked from outside (pkill, osascript, a launchd job, a logout)'
  )
}
