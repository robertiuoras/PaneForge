// Dragging a highlight in a pane whose CLI has taken the mouse.
//
// Claude Code and Codex both turn mouse reporting on, and xterm then hands the mouse to
// them: `Terminal.ts` refuses to start a selection while `coreMouseService.areMouseEventsActive`
// unless `SelectionService.shouldForceSelection(ev)` says otherwise. That function is the
// whole of this file's reason to exist:
//
//   shouldForceSelection(event) {
//     if (Browser.isMac) return event.altKey && rawOptions.macOptionClickForcesSelection
//     return event.shiftKey
//   }
//
// So the modifier that means "this drag is a selection, not the app's mouse" is NOT the
// same key on the two machines, and `macOptionClickForcesSelection` is off by default.
// The pane marks a plain drag with that modifier before xterm sees the event, which is
// what makes a drag select in an agent pane at all - and it was marking SHIFT only. On
// the Mac that is read by nothing: every drag over a Codex or Claude Code pane went to
// the CLI and selected nothing, on a machine where the whole gesture is how you copy a
// line out of an answer.
//
// `npm run test:forceselect`.

/** What a plain drag must be dressed up as for xterm to select instead of forwarding it. */
export interface ForceKeys {
  shiftKey?: true
  altKey?: true
}

/**
 * The modifiers to stamp on a mousedown so xterm forces a selection.
 *
 * Match xterm's platform predicate, including touch devices reporting MacIntel. Stamp only the key
 * xterm reads: Alt on Windows or Linux starts column selection, so sending both turns a
 * normal multi-line drag into a rectangle there.
 */
export function forceKeys(platform: string): ForceKeys {
  const isMac = ['Macintosh', 'MacIntel', 'MacPPC', 'Mac68K'].includes(platform)
  return isMac ? { altKey: true } : { shiftKey: true }
}

/**
 * Whether xterm would force a selection for this mousedown, given the platform it thinks
 * it is on and whether the pane asked for the mac option-click behaviour. The rule above,
 * repeated here so the test can prove the stamp against it rather than against a comment.
 */
export function wouldForce(
  e: { shiftKey: boolean; altKey: boolean },
  isMac: boolean,
  macOptionClickForcesSelection: boolean
): boolean {
  if (isMac) return e.altKey && macOptionClickForcesSelection
  return e.shiftKey
}
