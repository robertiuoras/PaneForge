// One answer to "which key is the app's command modifier here", shared by the shortcut
// handlers and by every place a shortcut is printed on screen.
//
// macOS puts app commands on Cmd and leaves Ctrl to the shell: Ctrl+C interrupts an
// agent, Ctrl+A jumps to the start of the line, Ctrl+T transposes two characters. So the
// two modifiers are NOT interchangeable - accepting Ctrl+T on a Mac "as well" would eat
// a keystroke the terminal wants. On Windows and Linux it is Ctrl, as it has always been.

export const isMac = navigator.userAgent.includes('Mac')
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
