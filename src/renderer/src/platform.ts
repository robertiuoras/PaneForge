// One answer to "which key is the app's command modifier here", shared by the shortcut
// handlers and by every place a shortcut is printed on screen.
//
// macOS puts app commands on Cmd and leaves Ctrl to the shell: Ctrl+C interrupts an
// agent, Ctrl+A jumps to the start of the line, Ctrl+T transposes two characters. So the
// two modifiers are NOT interchangeable - accepting Ctrl+T on a Mac "as well" would eat
// a keystroke the terminal wants. On Windows and Linux it is Ctrl, as it has always been.

/**
 * ...and an iPhone is not a Mac, however its user agent reads.
 *
 * Safari on iOS announces itself as `(iPhone; CPU iPhone OS 18_5 like Mac OS X)` and an
 * iPad as `(Macintosh; ...)` outright, so `includes('Mac')` is TRUE on both - and every
 * shortcut this app prints went out as `⌘ T` to a device with no ⌘ key and, usually, no
 * keyboard at all. Measured 2026-08-29 against the phone client at 390x844 under a real
 * iPhone user agent: the home screen drew `⌘ T` and `⌘ K`.
 *
 * The touch test is what separates the two, because the UA cannot: a Mac never reports a
 * coarse pointer and an iPad always does, whichever name it gives itself.
 */
export const isMac =
  navigator.userAgent.includes('Mac') &&
  !/iPhone|iPad|iPod/.test(navigator.userAgent) &&
  !(navigator.maxTouchPoints > 1 && !window.matchMedia('(pointer: fine)').matches)
// Read off the UA like `isMac`, so a phone looking at a Windows desk reports its own
// platform and hides a switch that only means something at the desk. That is the right
// way round for a Desktop shortcut, and the wrong way round for anything a phone should
// be able to change - check before reusing it.
export const isWindows = navigator.userAgent.includes('Windows')

/** True when this event carries the app's command modifier for this platform. */
export function modKey(e: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
}

/** How the modifier is written: "⌘ T" on a Mac, "Ctrl T" everywhere else. */
export const MOD = isMac ? '⌘' : 'Ctrl'

/** The same for a shortcut written out in prose or in the shortcuts list. */
export function keyLabel(text: string): string {
  if (!isMac) return text
  return text.replace(/\bCtrl\b/g, '⌘').replace(/\bAlt\b/g, '⌥')
}
